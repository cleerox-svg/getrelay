import { useEffect, useRef, useState } from 'react';
import { FogPausePrompt } from '../fog/FogPausePrompt';
import { useTuneClip } from './TuneClip';
import { TuneVisualizer } from './TuneVisualizer';
import { api } from '../../lib/api';
import { buildTuneRound } from '../../lib/tune/sources';
import type { TuneGenreId, TuneMode, TuneRound } from '../../lib/tune/sources';
import { recordTuneGame } from '../../lib/tune/stats';
import { skinVars } from '../../lib/tune/skins';
import type { TuneSkin } from '../../lib/tune/skins';
import {
  LOAD_TIMEOUT_MS,
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

// Reveal dwell before the next round: long enough to read the answer,
// longer after a wrong guess (there's a title + artist + artwork to take
// in).
const REVEAL_CORRECT_MS = 1400;
const REVEAL_WRONG_MS = 2200;

// The scored 8-round audio game. Each round: a shrinking-length song
// preview and four title choices. Points scale with how much of the clip
// was still UNHEARD when the correct guess landed — the audio analogue of
// Fog's "how much fog was left". Structural sibling of GuessGame.
export function TuneGame({ onFinish, genre, mode, paused, onResume, skin, skins, onSkinChange }: Props) {
  const usedRef = useRef(new Set<string>());
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
  // Single "reported" gate consulted by EVERY way a game can end.
  const reportedRef = useRef(false);
  const scoreRef = useRef(0);
  const bestStreakRef = useRef(0);
  // Banked remainders so a pause resumes the clocks in place.
  const roundLeftRef = useRef(ROUND_TIMEOUT_MS);
  const revealMsRef = useRef(REVEAL_CORRECT_MS);
  const revealLeftRef = useRef<number | null>(null);

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

  // First round + prefetch of the second.
  useEffect(() => {
    let cancelled = false;
    const gen = loadGenRef.current;
    buildTuneRound(usedRef.current, optsRef.current).then((r) => {
      if (cancelled || gen !== loadGenRef.current) return;
      if (!r) {
        handleNoRound();
        return;
      }
      setRound(r);
      setPhase('play');
      if (ROUNDS > 1) nextPromiseRef.current = buildTuneRound(usedRef.current, optsRef.current);
    });
    return () => {
      cancelled = true;
      if (advanceTimerRef.current != null) window.clearTimeout(advanceTimerRef.current);
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

  // Reveal → next round. Effect-driven so pausing mid-reveal freezes the
  // dwell instead of snapping ahead when the sheet closes.
  useEffect(() => {
    if (phase !== 'reveal') return;
    const ms = revealLeftRef.current ?? revealMsRef.current;
    revealLeftRef.current = ms;
    if (paused) return;
    const armedAt = Date.now();
    const t = window.setTimeout(() => advanceRef.current(), ms);
    advanceTimerRef.current = t;
    return () => {
      window.clearTimeout(t);
      advanceTimerRef.current = null;
      revealLeftRef.current = Math.max(0, ms - (Date.now() - armedAt));
    };
  }, [phase, roundIdx, paused]);

  // Freeze the clip whenever we leave the play phase or the game is
  // paused. secondsHeard is preserved so the meter and scoring hold.
  useEffect(() => {
    if (phase !== 'play' || paused) clip.pause();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, paused]);

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
    const gen = loadGenRef.current;
    const p = nextPromiseRef.current ?? buildTuneRound(usedRef.current, optsRef.current);
    nextPromiseRef.current = null;
    p.then((r) => {
      if (gen !== loadGenRef.current) return;
      if (!r) {
        // Mid-game: >=1 round is banked, so end with a results screen.
        finishNow();
        return;
      }
      setRound(r);
      setPhase('play');
      if (idx + 1 < ROUNDS) nextPromiseRef.current = buildTuneRound(usedRef.current, optsRef.current);
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
    revealMsRef.current = correct ? REVEAL_CORRECT_MS : REVEAL_WRONG_MS;
    revealLeftRef.current = null;
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

  // The reveal timeout must call the LATEST advance() — score/streak set
  // above land after handleGuess returns.
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const potentialPts = roundPoints(unheardFrac, streak);
  const wrongReveal = phase === 'reveal' && picked !== null && picked !== round?.answer;

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
    <div className="tune-skin px-4" style={skinVars(skin)}>
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
                    ▶ Apple Music
                  </a>
                ) : null}
                <a
                  href={`https://open.spotify.com/search/${encodeURIComponent(
                    `${round.title} ${round.artist}`,
                  )}`}
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
            <>
              <div
                className="tune-readout"
                style={{ width: '100%', fontSize: 13, minHeight: 20 }}
              >
                {statusText}
              </div>
              {/* Play / retry button — the ONLY place audio starts, always
                  inside this tap so mobile autoplay allows it. */}
              <button
                type="button"
                onClick={() => clip.play()}
                disabled={paused || clip.ended}
                className="tune-btn font-bold"
                style={{
                  width: 84,
                  height: 84,
                  fontSize: 30,
                  borderRadius: 'var(--tune-play-radius)',
                  opacity: paused ? 0.6 : 1,
                }}
                aria-label={clip.playing ? 'Playing' : 'Play clip'}
              >
                {clip.playing ? '❚❚' : '▶'}
              </button>
            </>
          )}
        </div>

        {/* Decorative spectrum analyzer — animates only while a clip is
            actually playing, idles otherwise. Not a real FFT. */}
        <TuneVisualizer active={phase === 'play' && clip.playing} />
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

      {/* Choices */}
      <div className="grid grid-cols-2 gap-2 pt-1">
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
                minHeight: 48,
              }}
            >
              {choice || '…'}
            </button>
          );
        })}
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
