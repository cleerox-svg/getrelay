import { useEffect, useRef, useState } from 'react';
import { FogPausePrompt } from '../fog/FogPausePrompt';
import { useTuneClip } from './TuneClip';
import { TuneVisualizer } from './TuneVisualizer';
import { api } from '../../lib/api';
import { buildTuneRound, getSessionPool } from '../../lib/tune/sources';
import type { TuneGenreId, TuneMode, TuneRound } from '../../lib/tune/sources';
import { recordTuneGame } from '../../lib/tune/stats';
import { skinVars } from '../../lib/tune/skins';
import type { TuneSkin } from '../../lib/tune/skins';
import {
  LOAD_TIMEOUT_MS,
  REVEAL_IDLE_MS,
  ROUNDS,
  ROUND_TIMEOUT_MS,
  clipLenMs,
  roundPoints,
} from '../../lib/tune/tuning';
import '../../styles/tune-skin.css';

export interface TuneGameResult {
  score: number;
  bestStreak: number;
  // Completed rounds. ROUNDS for a full game; 1..ROUNDS-1 when ended
  // early; 0 when nothing was completed — callers must record/submit
  // NOTHING for a 0-round game.
  roundsPlayed: number;
  // Seconds of the clip heard at guess time + hit/miss, per round.
  perRound: { secondsHeard: number; correct: boolean }[];
}

interface Props {
  onFinish: (result: TuneGameResult) => void;
  // Which seed pool rounds are drawn from and what the player guesses.
  // Chosen on the menu; fixed for the run (the menu freezes the choice).
  genre: TuneGenreId;
  mode: TuneMode;
  // Freeze the run and show the pause sheet. Owned by the parent because
  // the back gesture that raises it is a history event (see routes/
  // Fog.tsx); identical contract to GuessGame.
  paused: boolean;
  onResume: () => void;
  // Active player skin (design tokens). The chrome, readout, transport
  // button, visualizer and choices all render from these — see
  // lib/tune/skins.ts.
  skin: TuneSkin;
  // Optional in-player skin switcher: when both are supplied a small
  // "cycle skin" control appears in the titlebar so the look can change
  // live mid-game. The parent owns persistence.
  skins?: readonly TuneSkin[];
  onSkinChange?: (id: string) => void;
}

type Phase = 'loading' | 'play' | 'reveal' | 'unavailable';

// A right swipe on the reveal must travel this far (px) AND be more
// horizontal than vertical to advance. A tap barely moves, so it stays
// well under the threshold and never advances — link/button taps keep
// working. (See the reveal pointer handlers.)
const REVEAL_SWIPE_PX = 60;

// A preview URL that errors on load (dead / expired / geo-blocked) is
// swapped for a fresh track in place. Cap the swaps per round so a streak
// of bad URLs can't loop forever — after this many failures we fall
// through to the normal no-round handling.
const MAX_REPLACE_ATTEMPTS = 2;

// When an advance's round build resolves null mid-game, retry this many
// more times before ending the run. With the shared track pool a retry
// almost always resolves instantly; these extra tries only matter for a
// genuine transient network/throttle miss. The loading-phase LOAD_TIMEOUT_MS
// failsafe is what ultimately bounds the wait — these delays just space the
// retries out; each retry's build is itself network-bound.
const ADVANCE_RETRIES = 2;
const ADVANCE_RETRY_DELAY_MS = 600;

// The scored 8-round audio game. Each round: a shrinking-length song
// preview and four title choices. Points scale with how much of the clip
// was still UNHEARD when the correct guess landed — the audio analogue of
// Fog's "how much fog was left". Structural sibling of GuessGame.
export function TuneGame({ onFinish, genre, mode, paused, onResume, skin, skins, onSkinChange }: Props) {
  const usedRef = useRef(new Set<string>());
  // The SESSION-scoped pool of already-fetched tracks, shared by EVERY build
  // path (initial load, prefetch, advance-retry, dead-preview replace) AND by
  // every other game this session. Because it persists across mounts, round 1
  // of a new game usually resolves from tracks earlier games fetched, with no
  // Deezer call. The in-game "no repeats" guarantee lives in usedRef, which IS
  // fresh per game — so a new game may re-draw a still-fresh pooled track that
  // an earlier game used. Stale (expired-preview) tracks are pruned inside
  // buildTuneRound before any draw.
  const poolRef = useRef(getSessionPool());
  // Tracks the advance-retry setTimeout so a bare unmount (route change that
  // doesn't go through finishNow) can cancel it — otherwise it could fire a
  // stray build after unmount.
  const retryTimerRef = useRef<number | null>(null);
  // Genre/mode are fixed for the run, but capture them in a ref so the
  // build closures (initial effect, prefetch, advance) always read the
  // same values without needing them in dependency arrays.
  const optsRef = useRef({ genre, mode });
  optsRef.current = { genre, mode };
  const nextPromiseRef = useRef<Promise<TuneRound | null> | null>(null);
  const perRoundRef = useRef<TuneGameResult['perRound']>([]);
  const advanceTimerRef = useRef<number | null>(null);
  // Bumped by the loading failsafe to orphan a stuck build — its late
  // resolution must not clobber the game.
  const loadGenRef = useRef(0);
  // How many times the CURRENT round's preview has failed to load and been
  // swapped for a fresh track. Reset when a new round begins (advance /
  // initial load); capped by MAX_REPLACE_ATTEMPTS.
  const replaceAttemptsRef = useRef(0);
  // Single "reported" gate consulted by EVERY way a game can end.
  const reportedRef = useRef(false);
  const scoreRef = useRef(0);
  const bestStreakRef = useRef(0);
  // Banked remainders so a pause resumes the clocks in place.
  const roundLeftRef = useRef(ROUND_TIMEOUT_MS);
  // Banked remaining idle-failsafe time for the current reveal (null =
  // not yet armed / re-arm from full on the next reveal).
  const revealLeftRef = useRef<number | null>(null);
  // Single-advance guard: set the instant an advance is requested (Next,
  // swipe or the idle failsafe), reset when a new reveal opens. Stops any
  // two of those from firing back-to-back and skipping a round.
  const revealAdvancedRef = useRef(false);
  // Pointer-down origin for the reveal swipe-to-advance gesture.
  const swipeStartRef = useRef<{ x: number; y: number } | null>(null);

  const [roundIdx, setRoundIdx] = useState(0); // 0-based
  const [round, setRound] = useState<TuneRound | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [picked, setPicked] = useState<string | null>(null);
  const [lastPoints, setLastPoints] = useState<number | null>(null);
  // Frozen at guess time so the reveal meter doesn't keep decaying.
  const [heardAtGuess, setHeardAtGuess] = useState<number | null>(null);
  // Best-effort EXACT Spotify track link, resolved by the worker during
  // the reveal. Keyed to the round it belongs to so a late resolution can
  // never upgrade a LATER round's link (see the resolve effect below). Null
  // until/unless it resolves — the anchor always falls back to the
  // client-built search URL, so the link is live the instant reveal renders.
  const [spotifyExact, setSpotifyExact] = useState<{ idx: number; url: string } | null>(null);
  // Which round index already kicked off a Spotify resolve — fire at most
  // once per reveal.
  const spotifyFetchedRef = useRef(-1);

  const roundNo = roundIdx + 1;
  scoreRef.current = score;
  bestStreakRef.current = bestStreak;

  // The single audio element for the current round's clip.
  const clip = useTuneClip(phase === 'play' || phase === 'reveal' ? round?.previewUrl ?? null : null, clipLenMs(roundNo));

  const secondsHeard = heardAtGuess ?? clip.secondsHeard;
  const maxSeconds = clip.maxSeconds;
  const unheardFrac = maxSeconds > 0 ? Math.max(0, Math.min(1, 1 - secondsHeard / maxSeconds)) : 1;

  // No offline pack: a build that yields nothing ends the game if any
  // round is banked, otherwise surfaces "unavailable".
  function handleNoRound() {
    if (perRoundRef.current.length >= 1) finishNowRef.current();
    else setPhase('unavailable');
  }

  // A dead / expired / geo-blocked preview URL errored on load during the
  // play phase, before the player guessed. Transparently swap in a FRESH
  // track at the SAME roundIdx — no score penalty, no wasted round, no
  // entry pushed to perRoundRef. Capped by MAX_REPLACE_ATTEMPTS so a run of
  // bad URLs can't loop forever; once exhausted, fall through to the normal
  // no-round handling (end-with-results or "unavailable"). Routing through
  // the 'loading' phase fully tears down the errored element (clip src goes
  // null) and re-arms the loading failsafe, so a hung replacement build is
  // still caught.
  function replaceFailedRound() {
    if (replaceAttemptsRef.current >= MAX_REPLACE_ATTEMPTS) {
      handleNoRound();
      return;
    }
    replaceAttemptsRef.current += 1;
    const gen = ++loadGenRef.current; // orphan any in-flight build
    nextPromiseRef.current = null;
    setPhase('loading');
    setRound(null);
    setPicked(null);
    setHeardAtGuess(null);
    buildTuneRound(usedRef.current, optsRef.current, poolRef.current).then((r) => {
      if (gen !== loadGenRef.current) return;
      if (!r) {
        handleNoRound();
        return;
      }
      setRound(r);
      setPhase('play');
      // Re-warm the next-round prefetch we cleared above.
      if (roundIdx + 1 < ROUNDS) {
        nextPromiseRef.current = buildTuneRound(usedRef.current, optsRef.current, poolRef.current);
      }
    });
  }

  // First round + prefetch of the second. With the persisted session pool this
  // usually resolves instantly from memory; on a genuine cold start during a
  // Deezer throttle the build can come back null, so — like the advance path —
  // we retry a couple times (small delay, same ADVANCE_RETRIES/DELAY constants)
  // before surfacing "unavailable". Every step is gated on cancelled AND
  // loadGenRef so the LOAD_TIMEOUT_MS failsafe (which bumps loadGenRef) can
  // still orphan the whole chain; the retry timer is cleared on unmount. The
  // single attempt chain means we never double-load.
  useEffect(() => {
    let cancelled = false;
    const gen = loadGenRef.current;
    const attemptInitial = (retriesLeft: number) => {
      buildTuneRound(usedRef.current, optsRef.current, poolRef.current).then((r) => {
        if (cancelled || gen !== loadGenRef.current) return;
        if (r) {
          setRound(r);
          setPhase('play');
          if (ROUNDS > 1)
            nextPromiseRef.current = buildTuneRound(
              usedRef.current,
              optsRef.current,
              poolRef.current,
            );
          return;
        }
        if (retriesLeft <= 0) {
          handleNoRound();
          return;
        }
        retryTimerRef.current = window.setTimeout(() => {
          retryTimerRef.current = null;
          if (cancelled || gen !== loadGenRef.current) return;
          attemptInitial(retriesLeft - 1);
        }, ADVANCE_RETRY_DELAY_MS);
      });
    };
    attemptInitial(ADVANCE_RETRIES);
    return () => {
      cancelled = true;
      if (advanceTimerRef.current != null) window.clearTimeout(advanceTimerRef.current);
      if (retryTimerRef.current != null) window.clearTimeout(retryTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 45s failsafe: no guess counts as wrong so an abandoned round can't
  // stall the game. Pause-aware, banks the remaining time on teardown.
  useEffect(() => {
    if (phase !== 'play') {
      roundLeftRef.current = ROUND_TIMEOUT_MS;
      return;
    }
    if (paused) return;
    const ms = roundLeftRef.current;
    const armedAt = Date.now();
    const t = window.setTimeout(() => handleGuess(null), ms);
    return () => {
      window.clearTimeout(t);
      roundLeftRef.current = Math.max(0, ms - (Date.now() - armedAt));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundIdx, paused]);

  // Reveal → next round IDLE failsafe. The player normally advances by
  // hand (Next button / swipe); this only fires if the reveal is left
  // untouched for REVEAL_IDLE_MS. Effect-driven and pause-aware exactly
  // like the play-phase failsafe: pausing mid-reveal banks the remaining
  // time and resumes it in place instead of snapping ahead when the sheet
  // closes. Routed through requestAdvance so it shares the single-advance
  // guard with the Next button and the swipe.
  useEffect(() => {
    if (phase !== 'reveal') return;
    const ms = revealLeftRef.current ?? REVEAL_IDLE_MS;
    revealLeftRef.current = ms;
    if (paused) return;
    const armedAt = Date.now();
    const t = window.setTimeout(() => requestAdvanceRef.current(), ms);
    advanceTimerRef.current = t;
    return () => {
      window.clearTimeout(t);
      advanceTimerRef.current = null;
      revealLeftRef.current = Math.max(0, ms - (Date.now() - armedAt));
    };
  }, [phase, roundIdx, paused]);

  // Best-effort href upgrade: when a round enters the reveal, ask the
  // worker for the EXACT Spotify track link. Fires at most once per reveal
  // (guarded by spotifyFetchedRef). resolveSpotify never rejects, so this
  // is pure enhancement — the anchor renders the search URL immediately and
  // only swaps to the exact link if one comes back for THIS round. The
  // resolution is stamped with `idx`, so a slow reply that lands after we've
  // advanced is ignored by the render (idx !== roundIdx), and the cleanup
  // flag drops it on unmount. It never blocks the reveal→next-round timer.
  useEffect(() => {
    if (phase !== 'reveal' || !round) return;
    if (spotifyFetchedRef.current === roundIdx) return;
    spotifyFetchedRef.current = roundIdx;
    const idx = roundIdx;
    let cancelled = false;
    api.resolveSpotify(round.title, round.artist).then((res) => {
      if (cancelled || res.url == null) return;
      setSpotifyExact({ idx, url: res.url });
    });
    return () => {
      cancelled = true;
    };
  }, [phase, roundIdx, round]);

  // Freeze the clip whenever we leave the play phase or the game is
  // paused. secondsHeard is preserved so the meter and scoring hold.
  useEffect(() => {
    if (phase !== 'play' || paused) clip.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paused]);

  // Recover from a preview that fails to load: if the current clip errored
  // during the play phase and the player hasn't guessed, swap in a fresh
  // track (see replaceFailedRound). Never fires during reveal/loading; the
  // attempt cap lives in replaceFailedRound so it can't loop forever.
  useEffect(() => {
    if (phase !== 'play' || !clip.loadFailed || picked !== null) return;
    replaceFailedRound();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, clip.loadFailed, picked]);

  // Loading failsafe: buildTuneRound bounds each network step, but if a
  // build still hangs, orphan it. With no offline pack the only sane
  // outcomes are "end with what we have" or "unavailable".
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = window.setTimeout(() => {
      loadGenRef.current++; // orphan any in-flight build
      nextPromiseRef.current = null;
      handleNoRound();
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundIdx]);

  // Ends the game right now with whatever rounds are complete.
  function finishNow() {
    if (reportedRef.current) return;
    reportedRef.current = true;
    if (advanceTimerRef.current != null) window.clearTimeout(advanceTimerRef.current);
    loadGenRef.current++; // orphan any in-flight round build
    nextPromiseRef.current = null;
    onFinish({
      score,
      bestStreak,
      roundsPlayed: perRoundRef.current.length,
      perRound: perRoundRef.current.slice(),
    });
  }
  const finishNowRef = useRef(finishNow);
  finishNowRef.current = finishNow;

  // Abandon safety net: unmounted mid-game with >=1 completed round and
  // nothing reported yet — record the partial score directly. The POST is
  // fire-and-forget; local stats always update. Never records a 0-round
  // game.
  useEffect(() => {
    return () => {
      if (reportedRef.current) return;
      const rounds = perRoundRef.current.length;
      if (rounds < 1) return;
      reportedRef.current = true;
      recordTuneGame(scoreRef.current, bestStreakRef.current);
      api
        .submitGameScore({
          score: scoreRef.current,
          rounds,
          bestStreak: bestStreakRef.current,
          game: 'tune',
        })
        .catch(() => undefined);
    };
  }, []);

  // The "unavailable" screen renders no pause sheet, yet the guess-screen
  // history guard is still armed. A back gesture there flips `paused` with
  // nothing to render it, which would deaden every later back (the parent
  // re-arms the marker and settles into its steady state). Treat a back
  // press on this screen as "leave": end the game (0 rounds → no submit)
  // so onFinish consumes the guard and drops us back to the menu.
  useEffect(() => {
    if (phase === 'unavailable' && paused) finishNowRef.current();
  }, [phase, paused]);

  function advance() {
    const idx = roundIdx + 1;
    if (idx >= ROUNDS) {
      finishNow();
      return;
    }
    setPhase('loading');
    setRound(null);
    setPicked(null);
    setLastPoints(null);
    setHeardAtGuess(null);
    setRoundIdx(idx);
    replaceAttemptsRef.current = 0; // fresh budget for the new round
    const gen = loadGenRef.current;
    // First try the prefetched round — with the pool this is usually already
    // resolved from tracks we hold, so the transition is instant.
    const first =
      nextPromiseRef.current ?? buildTuneRound(usedRef.current, optsRef.current, poolRef.current);
    nextPromiseRef.current = null;
    attemptRoundLoad(first, gen, idx, ADVANCE_RETRIES);
  }

  // Resolve a round build for the advance path, retrying on a null result
  // before ending the game. A null build mid-game used to end the game on
  // the spot, so a single throttled Deezer fetch after round 1 killed the
  // run. With the shared pool a retry usually resolves instantly from tracks
  // we already hold; a genuine transient network/throttle miss gets a couple
  // more tries (small delay between them) before we fall back to finishNow().
  // Every step is gated on `gen === loadGenRef.current`, so the loading
  // failsafe, an End tap or a dead-preview replace (all bump loadGenRef) can
  // orphan the whole chain and a newer round can never be clobbered.
  function attemptRoundLoad(
    p: Promise<TuneRound | null>,
    gen: number,
    idx: number,
    retriesLeft: number,
  ) {
    p.then((r) => {
      if (gen !== loadGenRef.current) return;
      if (r) {
        setRound(r);
        setPhase('play');
        if (idx + 1 < ROUNDS)
          nextPromiseRef.current = buildTuneRound(usedRef.current, optsRef.current, poolRef.current);
        return;
      }
      if (retriesLeft <= 0) {
        // Mid-game: >=1 round is banked, so end with a results screen.
        finishNow();
        return;
      }
      retryTimerRef.current = window.setTimeout(() => {
        retryTimerRef.current = null;
        if (gen !== loadGenRef.current) return; // a newer round superseded us
        attemptRoundLoad(
          buildTuneRound(usedRef.current, optsRef.current, poolRef.current),
          gen,
          idx,
          retriesLeft - 1,
        );
      }, ADVANCE_RETRY_DELAY_MS);
    });
  }

  function handleGuess(choice: string | null) {
    if (phase !== 'play' || !round || paused) return;
    // Freeze the clip and the heard-fraction at the moment of the guess.
    const heard = clip.secondsHeard;
    clip.pause();
    setHeardAtGuess(heard);
    const frac = maxSeconds > 0 ? Math.max(0, Math.min(1, 1 - heard / maxSeconds)) : 1;
    const correct = choice != null && choice === round.answer;
    setPicked(choice);
    // Arm a fresh reveal: full idle failsafe, advance guard cleared.
    revealLeftRef.current = null;
    revealAdvancedRef.current = false;
    setPhase('reveal');
    perRoundRef.current.push({ secondsHeard: heard, correct });
    if (correct) {
      const pts = roundPoints(frac, streak);
      setLastPoints(pts);
      setScore((s) => s + pts);
      const ns = streak + 1;
      setStreak(ns);
      setBestStreak((b) => Math.max(b, ns));
    } else {
      setStreak(0);
    }
  }

  // The single entry point every advance goes through: the Next button,
  // the swipe gesture and the idle failsafe all call this. Inert unless a
  // reveal is live and un-paused, and the guard ref makes sure only ONE
  // advance lands per reveal so two triggers can't skip a round.
  function requestAdvance() {
    if (phase !== 'reveal' || paused || revealAdvancedRef.current) return;
    revealAdvancedRef.current = true;
    advance();
  }
  // The idle failsafe fires from a stale effect closure, so it must reach
  // the LATEST requestAdvance — the latest roundIdx/score (advance() reads
  // roundIdx; finishNow(), on the last round, reads score/streak).
  const requestAdvanceRef = useRef(requestAdvance);
  requestAdvanceRef.current = requestAdvance;

  // Swipe-to-advance on the reveal. Record where the pointer went down…
  function onRevealPointerDown(e: React.PointerEvent) {
    // …but not when the drag starts on an interactive element (the Listen /
    // Spotify links or the Next button): a rightward drag begun on a link
    // could otherwise both advance the round AND follow the link.
    if ((e.target as Element).closest?.('a,button')) {
      swipeStartRef.current = null;
      return;
    }
    swipeStartRef.current = { x: e.clientX, y: e.clientY };
  }
  // …and on release, advance only for a decisive, mostly-horizontal
  // rightward drag. A tap moves a few px (< REVEAL_SWIPE_PX) so it never
  // advances, and we never preventDefault, so Next / Listen / Spotify taps
  // still work. requestAdvance's own guards handle phase/pause/dedupe.
  function onRevealPointerUp(e: React.PointerEvent) {
    const start = swipeStartRef.current;
    swipeStartRef.current = null;
    if (!start) return;
    const dx = e.clientX - start.x;
    const dy = e.clientY - start.y;
    if (dx > REVEAL_SWIPE_PX && Math.abs(dx) > Math.abs(dy)) requestAdvance();
  }

  const potentialPts = roundPoints(unheardFrac, streak);
  const wrongReveal = phase === 'reveal' && picked !== null && picked !== round?.answer;
  // The exact Spotify link only counts for the round it was resolved for —
  // a stale resolution stamped with a different index is ignored here.
  const spotifyExactUrl = spotifyExact && spotifyExact.idx === roundIdx ? spotifyExact.url : null;

  // In-player skin switcher — cycles to the next registered skin. Only
  // wired when the parent passes the list + handler.
  function cycleSkin() {
    if (!skins || !onSkinChange || skins.length === 0) return;
    const i = skins.findIndex((s) => s.id === skin.id);
    const next = skins[(i + 1) % skins.length]!;
    onSkinChange(next.id);
  }

  const statusText = clip.needsTap
    ? 'Tap to play'
    : clip.ended
      ? 'Clip finished — make your guess'
      : clip.playing
        ? 'Listening…'
        : clip.started
          ? 'Paused — tap to resume'
          : `Play the clip, then guess the ${mode === 'artist' ? 'artist' : 'title'}`;

  if (phase === 'unavailable') {
    return (
      <div className="px-4">
        <div
          className="rounded-2xl p-6 text-center"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
        >
          <div className="text-[15px] font-semibold" style={{ color: 'var(--text)' }}>
            Couldn’t reach the music service
          </div>
          <div className="text-sm pt-1" style={{ color: 'var(--text-dim)' }}>
            Guess the Tune needs a connection to fetch song previews. Check
            your network and try again.
          </div>
          <button
            type="button"
            onClick={finishNow}
            className="mt-4 rounded-xl px-5 py-2.5 text-sm font-bold"
            style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
          >
            Back to menu
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className="tune-skin tune-game px-4"
      style={skinVars(skin)}
      onPointerDown={phase === 'reveal' ? onRevealPointerDown : undefined}
      onPointerUp={phase === 'reveal' ? onRevealPointerUp : undefined}
      onPointerCancel={() => {
        swipeStartRef.current = null;
      }}
    >
      {/* Round / score / streak header — kept in the app palette (uses
          theme tokens, not tune-* vars) so it reads consistently across
          skins. */}
      <div
        className="flex items-baseline justify-between pb-2 text-sm font-semibold"
        style={{ color: 'var(--text)' }}
      >
        <span>
          Round {roundNo}/{ROUNDS}
        </span>
        <span className="tabular-nums">
          {score.toLocaleString()} pts
          {lastPoints != null ? (
            <span className="fog-pop inline-block ml-1" style={{ color: 'var(--online)' }}>
              +{lastPoints.toLocaleString()}
            </span>
          ) : null}
        </span>
        <span style={{ color: streak > 1 ? 'var(--accent)' : 'var(--text-dim)' }}>
          Streak x{streak}
        </span>
        <button
          type="button"
          onClick={finishNow}
          className="text-xs font-semibold"
          style={{
            color: 'var(--text-dim)',
            background: 'transparent',
            border: '1px solid var(--separator)',
            borderRadius: 999,
            padding: '2px 10px',
          }}
        >
          End
        </button>
      </div>

      {/* Skinned player chrome — the audio analogue of the fog canvas. */}
      <div
        className={wrongReveal ? 'tune-chrome ping-shake' : 'tune-chrome'}
        style={{ padding: 10, display: 'flex', flexDirection: 'column', gap: 10 }}
      >
        <div className="tune-titlebar">
          <span>Relay Tunes</span>
          {skins && onSkinChange ? (
            <button type="button" className="tune-skin-cycle" onClick={cycleSkin}>
              {skin.name} ⟳
            </button>
          ) : (
            <span style={{ fontWeight: 700 }}>{skin.name}</span>
          )}
        </div>

        <div
          style={{
            minHeight: 128,
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 12,
            textAlign: 'center',
          }}
        >
          {phase === 'loading' ? (
            <div className="tune-readout" style={{ width: '100%', letterSpacing: '0.1em' }}>
              LOADING…
            </div>
          ) : phase === 'reveal' && round ? (
            <>
              <img
                src={round.artworkUrl}
                alt=""
                width={84}
                height={84}
                style={{ width: 84, height: 84, borderRadius: 6, objectFit: 'cover' }}
              />
              {/* Reveal shows BOTH title and artist regardless of the
                  guessed field. */}
              <div className="tune-readout" style={{ width: '100%' }}>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{round.title}</div>
                <div className="tune-readout-dim" style={{ fontSize: 13 }}>
                  {round.artist}
                </div>
              </div>
              {/* "Listen to the full song" deep-links. Kept in the APP
                  palette (not skin tokens) so they stay legible on every
                  skin. Text-only labels — no trademarked logos. */}
              <div style={{ display: 'flex', gap: 8, width: '100%', justifyContent: 'center' }}>
                {round.trackViewUrl ? (
                  <a
                    href={round.trackViewUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-xs font-bold"
                    style={{
                      background: 'var(--card-bg)',
                      color: 'var(--text)',
                      border: '1px solid var(--separator)',
                      borderRadius: 999,
                      padding: '6px 12px',
                      textDecoration: 'none',
                    }}
                  >
                    ▶ Listen
                  </a>
                ) : null}
                <a
                  href={
                    spotifyExactUrl ??
                    `https://open.spotify.com/search/${encodeURIComponent(
                      `${round.title} ${round.artist}`,
                    )}`
                  }
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-xs font-bold"
                  style={{
                    background: 'var(--card-bg)',
                    color: 'var(--text)',
                    border: '1px solid var(--separator)',
                    borderRadius: 999,
                    padding: '6px 12px',
                    textDecoration: 'none',
                  }}
                >
                  ▶ Spotify
                </a>
              </div>
            </>
          ) : (
            // Passive status readout only — the Play control now lives in
            // the bottom cluster (thumb zone), see below.
            <div
              className="tune-readout"
              style={{ width: '100%', fontSize: 13, minHeight: 20 }}
            >
              {statusText}
            </div>
          )}
        </div>

        {/* Spectrum analyzer — a purely decorative CSS animation that runs
            whenever a clip is playing (no Web Audio, no CORS). Flares on a
            correct guess. */}
        <TuneVisualizer
          active={phase === 'play' && clip.playing}
          flash={phase === 'reveal' && picked !== null && picked === round?.answer}
        />
      </div>

      {/* Points-if-you-guess-now meter + seconds-heard HUD. Decays as the
          clip plays — the audio analogue of Fog's fog% HUD. */}
      <div className="flex items-center gap-3 pt-2 pb-1">
        <div
          className="tune-meter-track flex-1 h-[8px] overflow-hidden"
          aria-label="points if you guess now"
        >
          <div
            className="h-full"
            style={{
              width: `${Math.round(unheardFrac * 100)}%`,
              background: unheardFrac > 0.25 ? 'var(--tune-accent)' : 'var(--tune-warn)',
              transition: 'width 200ms linear',
              borderRadius: 4,
            }}
          />
        </div>
        <span className="text-xs tabular-nums" style={{ color: 'var(--tune-readout-dim)' }}>
          {phase === 'reveal' ? `${secondsHeard.toFixed(1)}s heard` : `~${potentialPts} pts`}
        </span>
      </div>

      {/* Bottom control cluster — pushed into the thumb zone by
          .tune-game-controls (margin-top:auto) so the primary actions sit
          low on the screen for one-thumb play, while the readout / artwork
          / EQ take the space above. */}
      <div className="tune-game-controls">
        {/* Play / retry — the ONLY place audio starts, always inside this
            tap so mobile autoplay allows it. Relocated from the chrome
            centre to a full-width thumb-friendly transport bar. */}
        {phase === 'play' ? (
          <button
            type="button"
            onClick={() => clip.play()}
            disabled={paused || clip.ended}
            className="tune-btn font-bold"
            style={{
              width: '100%',
              height: 56,
              fontSize: 22,
              borderRadius: 'var(--tune-play-radius)',
              opacity: paused ? 0.6 : 1,
              marginBottom: 10,
            }}
            aria-label={clip.playing ? 'Playing' : 'Play clip'}
          >
            {clip.playing ? '❚❚' : '▶'}
          </button>
        ) : null}

        {/* Choices */}
        <div className="grid grid-cols-2 gap-2">
          {(round?.choices ?? ['', '', '', '']).map((choice, i) => {
            const isAnswer = phase === 'reveal' && round != null && choice === round.answer;
            const isWrongPick = phase === 'reveal' && choice === picked && !isAnswer;
            return (
              <button
                key={`${i}-${choice}`}
                type="button"
                disabled={phase !== 'play' || !choice || paused}
                onClick={() => handleGuess(choice)}
                className="tune-choice px-3 py-3 text-sm font-semibold text-center"
                style={{
                  background: isAnswer
                    ? 'var(--tune-choice-answer-bg)'
                    : isWrongPick
                      ? 'var(--tune-choice-wrong-bg)'
                      : undefined,
                  color: isAnswer
                    ? 'var(--tune-choice-answer-text)'
                    : isWrongPick
                      ? 'var(--tune-choice-wrong-text)'
                      : undefined,
                  opacity: phase === 'loading' ? 0.4 : 1,
                  minHeight: 52,
                }}
              >
                {choice || '…'}
              </button>
            );
          })}
        </div>

        {/* Manual advance. The player controls the reveal — a large,
            full-width tap target sitting clearly BELOW the answer choices
            so it never crowds them. Kept in the APP palette (accent /
            white) rather than skin tokens so it stays a legible primary
            action on every skin, like the "Back to menu" button. Inert
            while paused; a right swipe anywhere on the reveal does the same
            thing. On the final round it ends the game (advance() →
            finishNow), so it reads "See results". */}
        {phase === 'reveal' ? (
          <button
            type="button"
            onClick={requestAdvance}
            disabled={paused}
            className="mt-3 w-full rounded-xl font-bold"
            style={{
              background: 'var(--accent)',
              color: '#FFFFFF',
              border: 0,
              padding: '14px 16px',
              fontSize: 16,
              opacity: paused ? 0.6 : 1,
            }}
          >
            {roundIdx === ROUNDS - 1 ? 'See results' : 'Next'}
          </button>
        ) : null}
      </div>

      {/* Pause sheet: the game stays mounted and frozen underneath. */}
      {paused ? (
        <FogPausePrompt
          roundNo={roundNo}
          rounds={ROUNDS}
          score={score}
          onResume={onResume}
          onEnd={finishNow}
        />
      ) : null}
    </div>
  );
}
