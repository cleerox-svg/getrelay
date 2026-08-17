import { useEffect, useMemo, useRef, useState, type ComponentProps } from 'react';
import { GolfGame } from './GolfGame';
import type { GolfGameResult } from './GolfGame';
import { GolfDaily } from './GolfDaily';
import { GolfTournaments } from './GolfTournaments';
import { GolfLeaderboard } from './GolfLeaderboard';
import { GolfResultScreen } from './GolfResultScreen';
import { GolfMenu } from './GolfMenu';
import type { GolfSubMode } from './GolfMenu';
import { GolfProfile } from './GolfProfile';
import { GolfShop } from './GolfShop';
import { GolfSeason } from './GolfSeason';
import { GolfWallet } from './GolfWallet';
import { CoinBalance } from './CoinBalance';
import { Avatar } from '../Avatar';
import { RangeGame } from './RangeGame';
import type { RangeGameResult } from './RangeGame';
import CourseGame from './CourseGame';
import { api } from '../../lib/api';
import { useEconomy, useEquippedFrame } from '../../lib/golf/economy';
import { resolveGolfCosmetics } from '../../lib/golf/cosmetics';
import { getCourse } from '../../lib/golf/courses';
import type { GolfCourse } from '../../lib/golf/courses';
import { getPuttCourse } from '../../lib/golf/puttCourses';
import { recordGolfGame, recordRangeGame, setLastPuttCourseId } from '../../lib/golf/stats';
import { dropStalePending, readPending, writePending } from '../../lib/golf/pendingResult';
import { HOLES as GOLF_HOLES, RANGE_BALLS } from '../../lib/golf/tuning';
import { useStore } from '../../lib/store';
import { useGameFlow } from '../../lib/games/useGameFlow';
import { startMusic, stopMusic, duckMusic } from '../../lib/audio';

// What the Course free-screen path is serving. ONE slot with a discriminant,
// replacing five independent flags (dailyActive/dailySeed/tourneyActive/
// tourneyCourse/tourneySeed): "daily AND tournament at once" is UNREPRESENTABLE
// now, not merely avoided by every setter remembering to clear the other flow.
// Each flow carries its OWN course/hole/seed, so it also cannot overwrite the
// player's Course-mode selection.
// ⚠ Those flags were cleared in exactly ONE place — CourseGame's onExit — which
// neither a back GESTURE nor useGameFlow's guarded LEAVE arm calls, so a stale
// flag corrupted a LATER round (a practice hole POSTed as the day's daily; a
// picked hole replaced by the tournament course; a full round posting nowhere).
// The reset therefore lives on the ENTRY side: startGolf(). GolfScreen.test.tsx.
type CourseIntent =
  | { kind: 'normal' }
  | { kind: 'daily'; courseId: string; holeIdx: number; seed: number }
  | { kind: 'tournament'; course: GolfCourse; seed: number };

// Everything about a round that depends on the intent — taken straight off
// CourseGame's own props so the two cannot drift, and built by ONE switch.
type CoursePlan = Omit<ComponentProps<typeof CourseGame>, 'cosmetics' | 'onExit'>;

export function GolfScreen({ onExitToHub }: { onExitToHub: () => void }) {
  // startFree vs startFreeGuarded is a per-SESSION safety decision, not a style
  // one — see the launch sites below and useGameFlow's own header.
  const {
    screen,
    setScreen,
    paused,
    setPaused,
    startGame,
    startFree,
    startFreeGuarded,
    consumeHistoryEntry,
  } = useGameFlow();
  // Golf has two flows behind one chiclet: Phase-1 putting and the Phase-2
  // driving range (open practice + scored Target Challenge). golfMode picks
  // which the shared guess/free/results choreography renders; it's only
  // changed from the golf menu, frozen once a game is running.
  const [golfMode, setGolfMode] = useState<GolfSubMode>('putt');
  const [golfClub, setGolfClub] = useState<string | undefined>(undefined);
  // Which course is loaded in Course mode, and (single-hole play) which hole
  // index to start on. Set from the golf menu's encoded course arg; undefined
  // holeIdx means play the full round from hole 1.
  const [golfCourseId, setGolfCourseId] = useState<string | undefined>(undefined);
  const [golfHoleIdx, setGolfHoleIdx] = useState<number | undefined>(undefined);
  // Which Mini-Golf course is loaded and (single-hole play) which hole to start
  // on. Set from the golf menu's encoded putt arg; undefined holeIdx means play
  // the full round from hole 1. Mirrors the Course-mode course/hole state above.
  const [golfPuttCourseId, setGolfPuttCourseId] = useState<string | undefined>(undefined);
  const [golfPuttHoleIdx, setGolfPuttHoleIdx] = useState<number | undefined>(undefined);
  const [golfResult, setGolfResult] = useState<GolfGameResult | null>(null);
  const [golfRangeResult, setGolfRangeResult] = useState<RangeGameResult | null>(null);
  const [serverBest, setServerBest] = useState<number | null>(null);
  const [lbKey, setLbKey] = useState(0);

  // Daily Challenge + Rapid Tournament play, both through the Course free screen
  // (see CourseIntent). A finished score is PERSISTED (lib/golf/pendingResult)
  // before GolfDaily / GolfTournaments POST it, so holing out and then leaving no
  // longer drops it silently: the next mount reads it back, opens on the tab that
  // owns it and submits it — exactly once, even if the previous mount died
  // mid-request. dailyStreak/tourneyOpen feed the Arena tab's 🔥 / 🏆 chips.
  const [intent, setIntent] = useState<CourseIntent>({ kind: 'normal' });
  const [dailyPending, setDailyPending] = useState(() => readPending('daily'));
  const [tourneyPending, setTourneyPending] = useState(() => readPending('tournament'));
  const [dailyStreak, setDailyStreak] = useState<number | null>(null);
  const [dailyRefresh, setDailyRefresh] = useState(0);
  const [tourneyOpen, setTourneyOpen] = useState(false);

  // Golf hub top-level tab (Play / Arena / Clubhouse) plus the inner segmented
  // controls for the two grouped tabs, and the Ranks board selector.
  //  • Arena groups everything timed/ranked: Daily / Events / Ranks.
  //  • Clubhouse groups the player's identity + economy: Profile / Locker (the
  //    cosmetics shop) / Season / Wallet — dissolving the old standalone Locker.
  // A pending result steers the OPENING tab to its owner: that component is what
  // POSTs it, so landing on Play would leave the score unsubmitted again.
  const [subTab, setSubTab] = useState<'play' | 'arena' | 'clubhouse'>(
    dailyPending || tourneyPending ? 'arena' : 'play',
  );
  const [arenaSeg, setArenaSeg] = useState<'daily' | 'events' | 'ranks'>(
    tourneyPending ? 'events' : 'daily',
  );
  const [clubSeg, setClubSeg] = useState<'profile' | 'locker' | 'season' | 'wallet'>(
    'profile',
  );
  const [board, setBoard] = useState<'golf' | 'golfcourse' | 'golfrange'>('golfcourse');

  // Golf economy: cache the equipped cosmetics + wallet once so the render seam
  // (below) and the hub header chip are ready before the first round. The
  // resolved GolfCosmetics is memoised on [catalog, equipped] for a STABLE
  // identity — the GL scenes read it once at build, so a new object each render
  // would needlessly churn. Default equip → an empty object → the stock look.
  const me = useStore((s) => s.me);
  const catalog = useEconomy((s) => s.catalog);
  const equipped = useEconomy((s) => s.equipped);
  const balance = useEconomy((s) => s.balance);
  const ensureCosmetics = useEconomy((s) => s.ensureCosmetics);
  const ensureWallet = useEconomy((s) => s.ensureWallet);
  const frame = useEquippedFrame();
  const cosmetics = useMemo(
    () => resolveGolfCosmetics(catalog, equipped),
    [catalog, equipped],
  );
  useEffect(() => {
    void ensureCosmetics();
    void ensureWallet();
  }, [ensureCosmetics, ensureWallet]);

  const submittedGolfRef = useRef<GolfGameResult | null>(null);
  const submittedGolfRangeRef = useRef<RangeGameResult | null>(null);

  const setImmersive = useStore((s) => s.setImmersive);
  // Full-bleed 3D golf runs immersive: the range (challenge on `guess`,
  // practice on `free`) AND the mini-golf putting round (challenge on
  // `guess`, golfMode 'putt') hide the app chrome so the scene owns the
  // whole viewport. Cleared on exit AND on unmount so leaving the tab by
  // any path restores the chrome.
  const immersive =
    (screen === 'guess' && (golfMode === 'range-challenge' || golfMode === 'putt')) ||
    screen === 'free';
  useEffect(() => {
    setImmersive(immersive);
    return () => setImmersive(false);
  }, [immersive, setImmersive]);

  // Background music. Active play is the immersive 3D scenes: the scored guess
  // screen (putt / range-challenge) and the free screen (course / range-
  // practice). The hub/menu + results screens get the fuller menu track; during
  // play we DUCK the same pad so it sits under the SFX. The engine only actually
  // sounds after an unlock gesture (deferred start), so this logs no autoplay
  // warning even though it runs on mount. Leaving golf unmounts this component →
  // the cleanup stops the music (covers onExitToHub and any exit path).
  const inRound = screen === 'guess' || screen === 'free';
  useEffect(() => {
    startMusic(inRound ? 'round' : 'menu');
    duckMusic(inRound);
  }, [inRound]);
  useEffect(() => () => stopMusic(), []);

  // Golf twin of Fog's submit effect. Records to golf stats and submits
  // with game:'golf'. Same exactly-once guard, same partial-run rules
  // (roundsPlayed 1..HOLES are valid; a 0-hole game never lands here).
  useEffect(() => {
    if (
      screen !== 'results' ||
      !golfResult ||
      golfResult.roundsPlayed < 1 ||
      submittedGolfRef.current === golfResult
    )
      return;
    submittedGolfRef.current = golfResult;
    recordGolfGame(golfResult.score, golfResult.bestStreak);
    // Mini-golf submits its to-par as board metadata on the 'golf' board
    // (course stays undefined → the server's null / mini-golf bucket). The
    // Profile card reads the 'golfcourse' board, so this figure isn't shown
    // there today; it's stored for future per-board breakdowns.
    const toPar = golfResult.perHole.reduce((s, h) => s + (h.strokes - h.par), 0);
    api
      .submitGameScore({
        score: golfResult.score,
        rounds: golfResult.roundsPlayed,
        bestStreak: golfResult.bestStreak,
        game: 'golf',
        toPar,
      })
      .then((r) => {
        setServerBest(r.best);
        setLbKey((k) => k + 1);
      })
      .catch(() => undefined);
  }, [screen, golfResult]);

  // Driving-range Target Challenge twin. Records to the SEPARATE range
  // stats and submits on the 'golfrange' board; same exactly-once guard and
  // partial-run rules (roundsPlayed = balls hit, 1..RANGE_BALLS).
  useEffect(() => {
    if (
      golfMode !== 'range-challenge' ||
      screen !== 'results' ||
      !golfRangeResult ||
      golfRangeResult.roundsPlayed < 1 ||
      submittedGolfRangeRef.current === golfRangeResult
    )
      return;
    submittedGolfRangeRef.current = golfRangeResult;
    recordRangeGame(golfRangeResult.score, golfRangeResult.bestStreak);
    api
      .submitGameScore({
        score: golfRangeResult.score,
        rounds: golfRangeResult.roundsPlayed,
        bestStreak: golfRangeResult.bestStreak,
        game: 'golfrange',
      })
      .then((r) => {
        setServerBest(r.best);
        setLbKey((k) => k + 1);
      })
      .catch(() => undefined);
  }, [screen, golfMode, golfRangeResult]);

  // Lightweight streak read for the Arena tab's 🔥 chip so a returning player
  // sees their run before opening the tab. Best-effort (unauthed / offline just
  // leaves it null → no chip); re-read after a daily round is submitted.
  //
  // It is also the one place that learns TODAY's seed without opening the tab, so
  // it evicts a pending score played on an earlier challenge (offline through the
  // rollover). Left alone, that record could never be filed correctly — the POST
  // body carries no date — and would steer the opening tab to Arena forever.
  useEffect(() => {
    let cancelled = false;
    api
      .getDaily()
      .then((d) => {
        if (cancelled) return;
        setDailyStreak(d.streak.current);
        if (dropStalePending('daily', d.seed)) setDailyPending(null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dailyRefresh]);

  // Lightweight tournament read for the tab's 🏆 chip: highlight when there's a
  // live event the player hasn't entered yet (msLeft>0 && no entry). Best-effort
  // (unauthed / offline just leaves it false → no chip); re-read after a round.
  // Evicts a round played on a CLOSED event for the same reason (see above).
  useEffect(() => {
    let cancelled = false;
    api
      .getTournament()
      .then((t) => {
        if (cancelled) return;
        setTourneyOpen(t.msLeft > 0 && t.entry == null);
        if (dropStalePending('tournament', t.seed)) setTourneyPending(null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dailyRefresh, tourneyPending]);

  function play() {
    setGolfResult(null);
    setGolfRangeResult(null);
    setServerBest(null);
    startGame();
  }

  // Launch the daily's seeded Course hole (holeIdx is 0-based) through the Course
  // free screen. The intent carries the daily's own course/hole/seed, so it never
  // touches the player's Course-mode selection.
  //
  // ⚠ UNGUARDED, deliberately — do not "fix" this to startFreeGuarded(). One
  // hole never cards (CourseGame only cards in round mode), so there is nothing
  // for the pause sheet's "End round" to bank and nothing a back press destroys:
  // abandoning costs a replay, and the entry is only spent by holing out. A
  // confirm step would be pure friction on the shortest round in the game.
  function startDaily(courseId: string, holeIdx: number, seed: number) {
    setIntent({ kind: 'daily', courseId, holeIdx, seed });
    setGolfMode('course');
    startFree();
  }

  // The seeded 3-hole tournament round. `course` is SYNTHESIZED (in
  // GolfTournaments); with NO startHole it runs as a full round + scorecard —
  // multi-hole progress, so it enters GUARDED: the first back press freezes the
  // round and raises the pause sheet, the second banks the carded holes and
  // leaves. One press at hole 3 of 3 must not be able to destroy the entry.
  function startTournament(course: GolfCourse, seed: number) {
    setIntent({ kind: 'tournament', course, seed });
    setGolfMode('course');
    startFreeGuarded();
  }

  // A finished normal round → the golfcourse board (server derives score from
  // toPar, so we send score:0).
  function postCourseRound(r: { courseId: string; holes: number; toPar: number }) {
    api
      .submitGameScore({
        game: 'golfcourse',
        course: r.courseId,
        toPar: r.toPar,
        rounds: r.holes,
        bestStreak: 0,
        score: 0,
      })
      .then(() => setLbKey((k) => k + 1))
      .catch(() => undefined);
  }

  // THE one switch: every play-shaping prop comes off the same discriminant, so
  // nothing can rewire half a round (a daily hijacking a picked hole's course, a
  // normal round losing its onRoundComplete).
  function coursePlan(): CoursePlan {
    switch (intent.kind) {
      // The seed is passed twice for two different reasons: to CourseGame it
      // replays the conditions, and to writePending it TAGS the score with the
      // challenge it was played on, so a record that outlives the day can never
      // be filed against a later one.
      case 'daily':
        return {
          course: getCourse(intent.courseId),
          startHole: intent.holeIdx,
          seed: intent.seed,
          onHoleComplete: (r) => setDailyPending(writePending('daily', r, intent.seed)),
        };
      case 'tournament':
        return {
          course: intent.course,
          seed: intent.seed,
          onRoundComplete: (r) =>
            setTourneyPending(writePending('tournament', r, intent.seed)),
        };
      case 'normal':
        return {
          course: getCourse(golfCourseId),
          startHole: golfHoleIdx,
          onRoundComplete: postCourseRound,
        };
    }
  }

  // Leaving a Course round by the HUD's back button: land on the tab that owns the
  // round just played, so a captured result POSTs at once. NOT a safety net — a
  // back GESTURE never calls it; that's why startGolf() resets the intent too.
  function exitCourse() {
    setScreen('menu');
    consumeHistoryEntry('free');
    if (intent.kind !== 'normal') {
      setSubTab('arena');
      setArenaSeg(intent.kind === 'daily' ? 'daily' : 'events');
    }
    setIntent({ kind: 'normal' });
  }

  // Golf mode picker → the right flow. Putting and the range Target
  // Challenge both run through the scored guess screen; range Practice is an
  // open, unscored session on the free screen (like Fog's free play).
  function startGolf(mode: GolfSubMode, arg?: string) {
    // Unconditional: whatever special round came before is over, however it was
    // left. THIS is what stops a stale intent corrupting the round being started.
    setIntent({ kind: 'normal' });
    setGolfMode(mode);
    // Set below when THIS launch is a full Course round — the one free-screen
    // session with multi-hole progress a single back press could destroy.
    let fullRound = false;
    if (mode === 'course') {
      // arg encodes the course choice: "<courseId>" for a full round, or
      // "<courseId>#<holeIdx>" (0-based) for single-hole play.
      const [courseId, holeStr] = (arg ?? '').split('#');
      setGolfCourseId(courseId || undefined);
      // Only accept an in-range integer hole index; anything else falls back to a
      // full round (undefined) so CourseGame never builds a sim from a missing hole.
      const idx = holeStr != null && holeStr !== '' ? Number(holeStr) : NaN;
      const holeCount = getCourse(courseId || undefined).holes.length;
      const validIdx = Number.isInteger(idx) && idx >= 0 && idx < holeCount;
      setGolfHoleIdx(validIdx ? idx : undefined);
      fullRound = !validIdx;
    } else if (mode === 'putt') {
      // Same encoding as Course mode, but over the Mini-Golf registry:
      // "<courseId>" = full round, "<courseId>#<holeIdx>" (0-based) = single hole.
      const [courseId, holeStr] = (arg ?? '').split('#');
      const resolved = getPuttCourse(courseId || undefined);
      setGolfPuttCourseId(resolved.id);
      setLastPuttCourseId(resolved.id);
      const idx = holeStr != null && holeStr !== '' ? Number(holeStr) : NaN;
      const validIdx = Number.isInteger(idx) && idx >= 0 && idx < resolved.holes.length;
      setGolfPuttHoleIdx(validIdx ? idx : undefined);
    } else {
      setGolfClub(arg);
    }
    // Only the full Course round is guarded. Range practice is unscored, and
    // single-hole Course play cards nothing — both have nothing to bank, so they
    // keep the one-press exit the free screen has always had.
    if (fullRound) {
      startFreeGuarded();
    } else if (mode === 'range-practice' || mode === 'course') {
      startFree();
    } else {
      play();
    }
  }

  if (screen === 'guess' && golfMode === 'range-challenge') {
    return (
      <RangeGame
        mode="challenge"
        initialClubId={golfClub}
        paused={paused}
        cosmetics={cosmetics}
        // Same guard-entry contract as GuessGame.
        onResume={() => setPaused(false)}
        onFinish={(r) => {
          setPaused(false);
          if (r.roundsPlayed > 0) {
            setGolfRangeResult(r);
            setScreen('results');
          } else {
            setScreen('menu');
          }
          consumeHistoryEntry('guess');
        }}
      />
    );
  }

  if (screen === 'guess') {
    return (
      <GolfGame
        course={getPuttCourse(golfPuttCourseId)}
        startHole={golfPuttHoleIdx}
        paused={paused}
        cosmetics={cosmetics}
        // Same guard-entry contract as GuessGame.
        onResume={() => setPaused(false)}
        onFinish={(r) => {
          setPaused(false);
          if (r.roundsPlayed > 0) {
            setGolfResult(r);
            setScreen('results');
          } else {
            setScreen('menu');
          }
          consumeHistoryEntry('guess');
        }}
      />
    );
  }

  // The 3D course renders full-bleed (its own fixed overlay), so the in-HUD back
  // button takes the place of the boxed back link. course / startHole / seed / the
  // reporting channel are ALL coursePlan() — spread, since CoursePlan IS that set.
  if (screen === 'free' && golfMode === 'course') {
    return (
      <CourseGame
        cosmetics={cosmetics}
        {...coursePlan()}
        // The pause sheet. Only a GUARDED session can ever set `paused` (it is
        // useGameFlow's escalate() that does), so on an unguarded single hole this
        // stays false and no sheet exists — the round is never frozen with no way
        // to resume. Resume clears the freeze; the sheet's "End round" banks the
        // carded holes and leaves through onExit, like the header back button.
        paused={paused}
        onResume={() => setPaused(false)}
        onExit={exitCourse}
      />
    );
  }

  if (screen === 'free') {
    return (
      <RangeGame
        mode="practice"
        initialClubId={golfClub}
        cosmetics={cosmetics}
        onExit={() => {
          setScreen('menu');
          consumeHistoryEntry('free');
        }}
      />
    );
  }

  // Both scored flows share ONE results screen (GolfResultScreen); only the
  // numbers, the early-out wording and the chip row differ.
  if (screen === 'results' && golfMode === 'range-challenge' && golfRangeResult) {
    const r = golfRangeResult;
    return (
      <GolfResultScreen
        score={r.score}
        bestStreak={r.bestStreak}
        serverBest={serverBest}
        earlyNote={
          r.roundsPlayed < RANGE_BALLS
            ? `Ended early — ${r.roundsPlayed}/${RANGE_BALLS} balls`
            : null
        }
        // Per-shot: distance-to-pin, or Splash / Out for a miss.
        chips={r.perShot.map((s) => {
          const miss = s.result === 'water' || s.result === 'fence';
          const label = miss ? (s.result === 'water' ? 'Splash' : 'Out') : `${s.distToPin}yd`;
          return { ok: s.onTarget, label: `${s.onTarget ? '✓' : '✗'} ${label}` };
        })}
        onPlayAgain={() => startGolf('range-challenge', golfClub)}
        onMenu={() => setScreen('menu')}
        board="golfrange"
        refreshKey={lbKey}
      />
    );
  }

  if (screen === 'results' && golfResult) {
    const r = golfResult;
    return (
      <GolfResultScreen
        score={r.score}
        bestStreak={r.bestStreak}
        serverBest={serverBest}
        earlyNote={
          r.roundsPlayed < GOLF_HOLES
            ? `Ended early — ${r.roundsPlayed}/${GOLF_HOLES} holes`
            : null
        }
        // Per-hole: strokes relative to par (E / +1 / −1).
        chips={r.perHole.map((h) => {
          const diff = h.strokes - h.par;
          const label = diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`;
          return { ok: diff <= 0, label: `H${h.hole} ${label}` };
        })}
        onPlayAgain={play}
        onMenu={() => setScreen('menu')}
        refreshKey={lbKey}
      />
    );
  }

  // menu — the golf hub, scoped under .golf-hub so the games-only visual
  // layer (green accent, gold records, painted hero) never touches messenger
  // theming. Three top tabs: Play / Arena / Clubhouse.
  return (
    <div className="px-4 golf-hub">
      {/* Back to the chiclet grid. Pure state — hub↔menu doesn't
          touch history; the in-game back gesture is handled by the
          marker choreography in useGameFlow. */}
      <button
        type="button"
        className="self-start text-sm font-semibold"
        style={{ color: 'var(--golf-accent)', background: 'transparent', border: 0, padding: 0 }}
        onClick={onExitToHub}
      >
        ‹ Games
      </button>

      {/* Hub header chip: the player's framed golf avatar + coin balance,
          surfaced across every tab so coins are always visible. Tapping the
          balance jumps to the Clubhouse's Locker segment (cosmetics shop). The
          frame is the VIEWER's own equipped frame. */}
      <div className="golf-idbar">
        <Avatar src={me?.avatarUrl} name={me?.displayName} size={34} frame={frame} />
        <div className="golf-idbar-name">
          <b>{me?.displayName ?? 'Relay golfer'}</b>
        </div>
        <button
          type="button"
          className="golf-idbar-coins"
          onClick={() => {
            setSubTab('clubhouse');
            setClubSeg('locker');
          }}
          aria-label="Open locker"
        >
          <CoinBalance balance={balance} size="sm" />
        </button>
      </div>

      {/* Top-tab bar (Play / Arena / Clubhouse). The Arena tab carries a small
          🔥N streak chip and a 🏆 live-event chip — both timed/ranked cues now
          live under Arena — so a returning player notices them without opening
          the tab. */}
      <div className="golf-subtabs" role="tablist" aria-label="Golf">
        {(
          [
            ['play', 'Play'],
            ['arena', 'Arena'],
            ['clubhouse', 'Clubhouse'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={subTab === key}
            onClick={() => {
              // Entering Arena, steer to the segment matching the live cue: an
              // open event → Events (so the 🏆 chip is meaningful), else Daily
              // (the streak default). Only on ENTRY — once the player is on
              // Arena, respect the segment they've chosen and don't override it.
              if (key === 'arena' && subTab !== 'arena') {
                setArenaSeg(tourneyOpen ? 'events' : 'daily');
              }
              setSubTab(key);
            }}
          >
            {label}
            {key === 'arena' && dailyStreak != null && dailyStreak > 0 ? (
              <span
                className="ml-1 rounded-full px-1.5 text-[11px] font-bold tabular-nums"
                style={{
                  background: 'color-mix(in srgb, #f0842e 22%, transparent)',
                  color: 'var(--text)',
                }}
              >
                <span aria-hidden="true">🔥</span>
                {dailyStreak}
              </span>
            ) : null}
            {/* Subtle 🏆 chip when a live event awaits the player's entry. */}
            {key === 'arena' && tourneyOpen ? (
              <span
                className="ml-1 rounded-full px-1 text-[11px] font-bold"
                style={{
                  background: 'color-mix(in srgb, var(--golf-accent) 22%, transparent)',
                  color: 'var(--text)',
                }}
                aria-label="Live event"
              >
                <span aria-hidden="true">🏆</span>
              </span>
            ) : null}
          </button>
        ))}
      </div>

      {subTab === 'play' ? <GolfMenu onStart={startGolf} refreshKey={lbKey} /> : null}

      {/* ARENA — everything timed/ranked, split by an inner segmented control
          into Daily / Events / Ranks. */}
      {subTab === 'arena' ? (
        <div className="flex flex-col gap-4">
          <div className="golf-seg" role="tablist" aria-label="Arena section">
            {(
              [
                ['daily', 'Daily'],
                ['events', 'Events'],
                ['ranks', 'Ranks'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={arenaSeg === key}
                onClick={() => setArenaSeg(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {/* pendingResult is the PERSISTED record, so these two are also the retry
              path on a later mount; a slot clears only once its POST resolves. */}
          {arenaSeg === 'daily' ? (
            <GolfDaily
              onPlay={startDaily}
              pendingResult={dailyPending}
              onResultConsumed={() => {
                setDailyPending(null);
                setDailyRefresh((k) => k + 1);
              }}
            />
          ) : null}

          {arenaSeg === 'events' ? (
            <GolfTournaments
              onPlay={startTournament}
              pendingResult={tourneyPending}
              onResultConsumed={() => setTourneyPending(null)}
            />
          ) : null}

          {arenaSeg === 'ranks' ? (
            <div className="flex flex-col gap-4">
              <div className="golf-seg" role="group" aria-label="Board">
                {(
                  [
                    ['golf', 'Mini-Golf'],
                    ['golfcourse', 'Course'],
                    ['golfrange', 'Range'],
                  ] as const
                ).map(([key, label]) => (
                  <button
                    key={key}
                    type="button"
                    aria-pressed={board === key}
                    onClick={() => setBoard(key)}
                  >
                    {label}
                  </button>
                ))}
              </div>
              <GolfLeaderboard game={board} refreshKey={lbKey} />
            </div>
          ) : null}
        </div>
      ) : null}

      {/* CLUBHOUSE — the player's identity + economy, split by an inner
          segmented control into Profile / Locker (cosmetics shop) / Season /
          Wallet. This absorbs the old standalone Locker tab. */}
      {subTab === 'clubhouse' ? (
        <div className="flex flex-col gap-4">
          <div className="golf-seg" role="tablist" aria-label="Clubhouse section">
            {(
              [
                ['profile', 'Profile'],
                ['locker', 'Locker'],
                ['season', 'Season'],
                ['wallet', 'Wallet'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={clubSeg === key}
                onClick={() => setClubSeg(key)}
              >
                {label}
              </button>
            ))}
          </div>

          {clubSeg === 'profile' ? <GolfProfile /> : null}
          {clubSeg === 'locker' ? <GolfShop /> : null}
          {clubSeg === 'season' ? <GolfSeason /> : null}
          {clubSeg === 'wallet' ? <GolfWallet /> : null}
        </div>
      ) : null}
    </div>
  );
}
