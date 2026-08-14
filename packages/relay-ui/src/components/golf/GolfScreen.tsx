import { useEffect, useRef, useState } from 'react';
import { GolfGame } from './GolfGame';
import type { GolfGameResult } from './GolfGame';
import { GolfDaily } from './GolfDaily';
import { GolfTournaments } from './GolfTournaments';
import { GolfLeaderboard } from './GolfLeaderboard';
import { GolfMenu } from './GolfMenu';
import type { GolfSubMode } from './GolfMenu';
import { GolfProfile } from './GolfProfile';
import { RangeGame } from './RangeGame';
import type { RangeGameResult } from './RangeGame';
import CourseGame from './CourseGame';
import { api } from '../../lib/api';
import { getCourse } from '../../lib/golf/courses';
import type { GolfCourse } from '../../lib/golf/courses';
import { getPuttCourse } from '../../lib/golf/puttCourses';
import { recordGolfGame, recordRangeGame, setLastPuttCourseId } from '../../lib/golf/stats';
import { HOLES as GOLF_HOLES, RANGE_BALLS } from '../../lib/golf/tuning';
import { useStore } from '../../lib/store';
import { useGameFlow } from '../../lib/games/useGameFlow';
import { startMusic, stopMusic, duckMusic } from '../../lib/audio';

export function GolfScreen({ onExitToHub }: { onExitToHub: () => void }) {
  const { screen, setScreen, paused, setPaused, startGame, startFree, consumeHistoryEntry } =
    useGameFlow();
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
  // Golf hub sub-tab (Daily / Tournaments / Play / Profile / Ranks) and the Ranks
  // board selector.
  const [subTab, setSubTab] = useState<
    'daily' | 'tourneys' | 'play' | 'profile' | 'ranks'
  >('play');
  const [board, setBoard] = useState<'golf' | 'golfcourse' | 'golfrange'>('golfcourse');

  // Daily Challenge play. When active, the Course free-screen path plays the
  // daily's seeded single hole (reusing the friend-challenge wiring: CourseGame
  // gets course + startHole + seed) and reports the finished score via
  // onHoleComplete. dailyPendingResult is handed to GolfDaily, which POSTs it and
  // shows the updated streak; dailyStreak feeds the small 🔥 chip on the tab.
  const [dailyActive, setDailyActive] = useState(false);
  const [dailySeed, setDailySeed] = useState<number | undefined>(undefined);
  const [dailyPendingResult, setDailyPendingResult] = useState<
    { strokes: number; toPar: number } | null
  >(null);
  const [dailyStreak, setDailyStreak] = useState<number | null>(null);
  const [dailyRefresh, setDailyRefresh] = useState(0);

  // Rapid Tournament play. When active, the Course free-screen path plays the
  // SYNTHESIZED 3-hole course (see synthTournamentCourse) as a FULL round (no
  // startHole → round mode + scorecard) with the event's seed, and reports the
  // finished ROUND total via onRoundComplete. tourneyPendingResult is handed to
  // GolfTournaments, which POSTs it and shows the updated rank; tourneyOpen feeds
  // the small 🏆 chip on the tab.
  const [tourneyActive, setTourneyActive] = useState(false);
  const [tourneyCourse, setTourneyCourse] = useState<GolfCourse | null>(null);
  const [tourneySeed, setTourneySeed] = useState<number | undefined>(undefined);
  const [tourneyPendingResult, setTourneyPendingResult] = useState<
    { toPar: number; strokes: number } | null
  >(null);
  const [tourneyOpen, setTourneyOpen] = useState(false);
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

  // Lightweight streak read for the Daily tab's 🔥 chip so a returning player
  // sees their run before opening the tab. Best-effort (unauthed / offline just
  // leaves it null → no chip); re-read after a daily round is submitted.
  useEffect(() => {
    let cancelled = false;
    api
      .getDaily()
      .then((d) => {
        if (!cancelled) setDailyStreak(d.streak.current);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dailyRefresh]);

  // Lightweight tournament read for the tab's 🏆 chip: highlight when there's a
  // live event the player hasn't entered yet (msLeft>0 && no entry). Best-effort
  // (unauthed / offline just leaves it false → no chip); re-read after a round.
  useEffect(() => {
    let cancelled = false;
    api
      .getTournament()
      .then((t) => {
        if (!cancelled) setTourneyOpen(t.msLeft > 0 && t.entry == null);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [dailyRefresh, tourneyPendingResult]);

  function play() {
    setGolfResult(null);
    setGolfRangeResult(null);
    setServerBest(null);
    startGame();
  }

  // Launch the daily's seeded Course hole through the existing Course free-screen
  // path. holeIdx is the 0-based index into the course's holes. dailyActive
  // rewires that path to report via onHoleComplete (single-hole) instead of the
  // golfcourse-board onRoundComplete.
  function startDaily(courseId: string, holeIdx: number, seed: number) {
    setDailyActive(true);
    setGolfMode('course');
    setGolfCourseId(courseId);
    setGolfHoleIdx(holeIdx);
    setDailySeed(seed);
    startFree();
  }

  // GolfDaily consumed a submitted result — clear it so it can't re-POST, and
  // refresh the tab's streak chip.
  function consumeDailyResult() {
    setDailyPendingResult(null);
    setDailyRefresh((k) => k + 1);
  }

  // Launch the seeded 3-hole tournament round through the Course free-screen
  // path. `course` is the SYNTHESIZED 3-hole GolfCourse (built in
  // GolfTournaments); playing it with NO startHole triggers full-round mode +
  // scorecard, and tourneyActive rewires the round-complete callback to capture
  // the ROUND total instead of posting to the golfcourse board.
  function startTournament(course: GolfCourse, seed: number) {
    setTourneyActive(true);
    setGolfMode('course');
    setTourneyCourse(course);
    setTourneySeed(seed);
    startFree();
  }

  // GolfTournaments consumed a submitted result — clear it so it can't re-POST,
  // and refresh the tab chip.
  function consumeTournamentResult() {
    setTourneyPendingResult(null);
  }

  // Golf mode picker → the right flow. Putting and the range Target
  // Challenge both run through the scored guess screen; range Practice is an
  // open, unscored session on the free screen (like Fog's free play).
  function startGolf(mode: GolfSubMode, arg?: string) {
    setGolfMode(mode);
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
    if (mode === 'range-practice' || mode === 'course') {
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

  if (screen === 'free') {
    // The 3D range / course render full-bleed (their own fixed overlay),
    // so the in-HUD back button takes the place of the boxed back link.
    return golfMode === 'course' ? (
      <CourseGame
        // Tournament: play the SYNTHESIZED 3-hole course; otherwise the selected
        // (or daily's) real course.
        course={tourneyActive && tourneyCourse ? tourneyCourse : getCourse(golfCourseId)}
        // Tournament plays a FULL round (no startHole → round mode + scorecard);
        // daily/normal keep their single-hole/round selection.
        startHole={tourneyActive ? undefined : golfHoleIdx}
        // Daily/tournament rounds replay the SAME conditions via the seed (wind).
        // The daily reports the finished hole via onHoleComplete (single-hole);
        // the tournament and normal rounds report the full round below.
        seed={dailyActive ? dailySeed : tourneyActive ? tourneySeed : undefined}
        onHoleComplete={
          dailyActive
            ? (r) => setDailyPendingResult({ strokes: r.strokes, toPar: r.toPar })
            : undefined
        }
        // Full-round completion. Tournament → capture the ROUND total for
        // GolfTournaments to POST (NOT the golfcourse board, so no double-post).
        // Otherwise → submit to the golfcourse board (server derives the score
        // from toPar; we send score:0). Skipped for the daily (single hole).
        onRoundComplete={
          tourneyActive
            ? (r) => setTourneyPendingResult({ toPar: r.toPar, strokes: r.strokes })
            : dailyActive
              ? undefined
              : (r) => {
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
        }
        onExit={() => {
          setScreen('menu');
          consumeHistoryEntry('free');
          // Returning from a daily round → back to the Daily tab; clear the
          // active flag so a subsequent normal Course round wires correctly.
          if (dailyActive) setDailyActive(false);
          // Returning from a tournament round → clear the active flag so a
          // subsequent normal Course round wires correctly (GolfTournaments,
          // which remounts on the Tournaments tab, POSTs the captured result).
          if (tourneyActive) setTourneyActive(false);
        }}
      />
    ) : (
      <RangeGame
        mode="practice"
        initialClubId={golfClub}
        onExit={() => {
          setScreen('menu');
          consumeHistoryEntry('free');
        }}
      />
    );
  }

  if (screen === 'results' && golfMode === 'range-challenge' && golfRangeResult) {
    return (
      <div className="px-4 flex flex-col gap-4">
        <div
          className="rounded-2xl p-5 text-center"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
        >
          <div className="text-xs font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
            FINAL SCORE
          </div>
          <div className="text-[40px] font-bold tabular-nums fog-pop" style={{ color: 'var(--text)' }}>
            {golfRangeResult.score.toLocaleString()}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Best streak x{golfRangeResult.bestStreak}
            {serverBest != null ? (
              <span className="ml-2 font-semibold" style={{ color: 'var(--accent)' }}>
                Best: {serverBest.toLocaleString()}
              </span>
            ) : null}
          </div>
          {golfRangeResult.roundsPlayed < RANGE_BALLS ? (
            <div className="text-xs pt-1" style={{ color: 'var(--text-dim)' }}>
              Ended early — {golfRangeResult.roundsPlayed}/{RANGE_BALLS} balls
            </div>
          ) : null}
          {/* Per-shot chips: distance-to-pin, or Splash / Out for a miss. */}
          <div className="flex flex-wrap justify-center gap-1.5 pt-3">
            {golfRangeResult.perShot.map((s, i) => {
              const miss = s.result === 'water' || s.result === 'fence';
              const label = miss ? (s.result === 'water' ? 'Splash' : 'Out') : `${s.distToPin}yd`;
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold tabular-nums"
                  style={{
                    background: s.onTarget
                      ? 'color-mix(in srgb, var(--online) 18%, transparent)'
                      : 'color-mix(in srgb, var(--ping) 15%, transparent)',
                    color: s.onTarget ? 'var(--online)' : 'var(--ping)',
                  }}
                >
                  {s.onTarget ? '✓' : '✗'} {label}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-xl py-3 text-[15px] font-bold"
            style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
            onClick={() => startGolf('range-challenge', golfClub)}
          >
            Play again
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl py-3 text-[15px] font-bold"
            style={{
              background: 'var(--card-bg)',
              color: 'var(--text)',
              border: '1px solid var(--separator)',
            }}
            onClick={() => setScreen('menu')}
          >
            Menu
          </button>
        </div>

        <GolfLeaderboard refreshKey={lbKey} game="golfrange" />
      </div>
    );
  }

  if (screen === 'results' && golfResult) {
    return (
      <div className="px-4 flex flex-col gap-4">
        <div
          className="rounded-2xl p-5 text-center"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
        >
          <div className="text-xs font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
            FINAL SCORE
          </div>
          <div className="text-[40px] font-bold tabular-nums fog-pop" style={{ color: 'var(--text)' }}>
            {golfResult.score.toLocaleString()}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
            Best streak x{golfResult.bestStreak}
            {serverBest != null ? (
              <span className="ml-2 font-semibold" style={{ color: 'var(--accent)' }}>
                Best: {serverBest.toLocaleString()}
              </span>
            ) : null}
          </div>
          {golfResult.roundsPlayed < GOLF_HOLES ? (
            <div className="text-xs pt-1" style={{ color: 'var(--text-dim)' }}>
              Ended early — {golfResult.roundsPlayed}/{GOLF_HOLES} holes
            </div>
          ) : null}
          {/* Per-hole chips: strokes relative to par (E / +1 / -1). */}
          <div className="flex flex-wrap justify-center gap-1.5 pt-3">
            {golfResult.perHole.map((h, i) => {
              const diff = h.strokes - h.par;
              const label = diff === 0 ? 'E' : diff > 0 ? `+${diff}` : `${diff}`;
              const under = diff <= 0;
              return (
                <span
                  key={i}
                  className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-bold tabular-nums"
                  style={{
                    background: under
                      ? 'color-mix(in srgb, var(--online) 18%, transparent)'
                      : 'color-mix(in srgb, var(--ping) 15%, transparent)',
                    color: under ? 'var(--online)' : 'var(--ping)',
                  }}
                >
                  H{h.hole} {label}
                </span>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            className="flex-1 rounded-xl py-3 text-[15px] font-bold"
            style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
            onClick={play}
          >
            Play again
          </button>
          <button
            type="button"
            className="flex-1 rounded-xl py-3 text-[15px] font-bold"
            style={{
              background: 'var(--card-bg)',
              color: 'var(--text)',
              border: '1px solid var(--separator)',
            }}
            onClick={() => setScreen('menu')}
          >
            Menu
          </button>
        </div>

        <GolfLeaderboard refreshKey={lbKey} />
      </div>
    );
  }

  // menu — the golf hub, scoped under .golf-hub so the games-only visual
  // layer (green accent, gold records, painted hero) never touches messenger
  // theming. Three sub-tabs: Play / Profile / Ranks.
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

      {/* Sub-tab bar (Daily / Play / Profile / Ranks). The Daily tab carries a
          small 🔥N chip when the player has a live streak, so a returning player
          notices it without opening the tab. */}
      <div className="golf-subtabs" role="tablist" aria-label="Golf">
        {(
          [
            ['daily', 'Daily'],
            ['tourneys', 'Tournaments'],
            ['play', 'Play'],
            ['profile', 'Profile'],
            ['ranks', 'Ranks'],
          ] as const
        ).map(([key, label]) => (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={subTab === key}
            onClick={() => setSubTab(key)}
          >
            {label}
            {key === 'daily' && dailyStreak != null && dailyStreak > 0 ? (
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
            {key === 'tourneys' && tourneyOpen ? (
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

      {subTab === 'daily' ? (
        <GolfDaily
          onPlay={startDaily}
          pendingResult={dailyPendingResult}
          onResultConsumed={consumeDailyResult}
        />
      ) : null}

      {subTab === 'tourneys' ? (
        <GolfTournaments
          onPlay={startTournament}
          pendingResult={tourneyPendingResult}
          onResultConsumed={consumeTournamentResult}
        />
      ) : null}

      {subTab === 'play' ? <GolfMenu onStart={startGolf} refreshKey={lbKey} /> : null}

      {subTab === 'profile' ? <GolfProfile /> : null}

      {subTab === 'ranks' ? (
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
  );
}
