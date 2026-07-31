import { useEffect, useRef, useState } from 'react';
import { FogCanvas } from './FogCanvas';
import type { FogCanvasHandle } from './FogCanvas';
import { FogPausePrompt } from './FogPausePrompt';
import { api } from '../../lib/api';
import { buildRound } from '../../lib/fog/sources';
import type { FogCategory, FogRound } from '../../lib/fog/sources';
import { recordFogGame } from '../../lib/fog/stats';
import {
  GUESS_BRUSH_PX,
  LOAD_TIMEOUT_MS,
  ROUNDS,
  ROUND_TIMEOUT_MS,
  budgetPx,
  refogAlpha,
  roundPoints,
} from '../../lib/fog/tuning';

export interface GameResult {
  score: number;
  bestStreak: number;
  // Completed rounds. ROUNDS for a full game; 1..ROUNDS-1 when the game
  // was ended early (End pill / the pause sheet's "End game"); 0 when nothing was
  // completed — callers must record/submit NOTHING for a 0-round game.
  roundsPlayed: number;
  perRound: { fogPct: number; correct: boolean }[];
}

interface Props {
  category: FogCategory;
  onFinish: (result: GameResult) => void;
  // Freeze the run and show the pause sheet. Owned by the parent
  // because the back gesture that raises it is a history event (see
  // routes/Fog.tsx); the sheet's Resume button calls onResume, its
  // "End game" button goes through the same finishNow funnel as the
  // header End pill.
  // Both are required and travel together on purpose: a `paused` with
  // no way back out would hard-lock the run (Resume, the scrim and
  // Escape would all be dead), which the type system should refuse.
  paused: boolean;
  onResume: () => void;
}

type Phase = 'loading' | 'play' | 'reveal';

// Reveal dwell before the next round: long enough to read the right
// answer, longer after a wrong guess.
const REVEAL_CORRECT_MS = 1100;
const REVEAL_WRONG_MS = 1700;

// The scored 8-round game. Each round: a fresh pane of fog over a new
// mystery image, a shrinking wipe budget, fog creeping back in, and
// four choices. Points scale with how much fog was still on the glass
// when the correct guess landed.
export function GuessGame({ category, onFinish, paused, onResume }: Props) {
  const canvasRef = useRef<FogCanvasHandle | null>(null);
  const usedRef = useRef(new Set<string>());
  const nextPromiseRef = useRef<Promise<FogRound> | null>(null);
  const perRoundRef = useRef<GameResult['perRound']>([]);
  const advanceTimerRef = useRef<number | null>(null);
  // Bumped by the loading failsafe to orphan a stuck buildRound — its
  // late resolution must not clobber the fallback round.
  const loadGenRef = useRef(0);
  // Single "reported" gate consulted by EVERY way a game can end —
  // natural finish, the header End pill, the pause sheet's "End game",
  // and the unmount safety net — so a score is never recorded or
  // submitted twice.
  const reportedRef = useRef(false);
  const scoreRef = useRef(0);
  const bestStreakRef = useRef(0);
  // Banked remainders for the two running clocks, so a pause resumes
  // them where they stopped instead of restarting them.
  const roundLeftRef = useRef(ROUND_TIMEOUT_MS);
  const revealMsRef = useRef(REVEAL_CORRECT_MS);
  const revealLeftRef = useRef<number | null>(null);

  const [roundIdx, setRoundIdx] = useState(0); // 0-based
  const [round, setRound] = useState<FogRound | null>(null);
  const [phase, setPhase] = useState<Phase>('loading');
  const [score, setScore] = useState(0);
  const [streak, setStreak] = useState(0);
  const [bestStreak, setBestStreak] = useState(0);
  const [budget, setBudget] = useState(budgetPx(1));
  const [fogPct, setFogPct] = useState(1);
  const [picked, setPicked] = useState<string | null>(null);
  const [lastPoints, setLastPoints] = useState<number | null>(null);

  const roundNo = roundIdx + 1;
  // Keep the latest progress readable from the unmount safety net (its
  // cleanup closure is from the first render, so state won't do).
  scoreRef.current = score;
  bestStreakRef.current = bestStreak;

  // First round + prefetch of the second. Prefetching keeps the
  // between-round pause down to the reveal animation on decent
  // networks.
  useEffect(() => {
    let cancelled = false;
    const gen = loadGenRef.current;
    buildRound(category, usedRef.current).then((r) => {
      if (cancelled || gen !== loadGenRef.current) return;
      setRound(r);
      setBudget(budgetPx(1));
      setPhase('play');
      if (ROUNDS > 1) nextPromiseRef.current = buildRound(category, usedRef.current);
    });
    return () => {
      cancelled = true;
      if (advanceTimerRef.current != null) window.clearTimeout(advanceTimerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 45s failsafe: no guess counts as a wrong guess so an abandoned
  // round can't stall the game. Pause-aware: tearing down (pause, or
  // leaving the play phase) banks the time left, re-arming uses that
  // remainder — a pause neither gifts nor steals round time.
  useEffect(() => {
    if (phase !== 'play') {
      // loading/reveal aren't on the clock. The next play phase (next
      // round, or this one again after the load failsafe) starts fresh.
      roundLeftRef.current = ROUND_TIMEOUT_MS;
      return;
    }
    if (paused) return; // frozen — keep whatever the cleanup banked
    const ms = roundLeftRef.current;
    const armedAt = Date.now();
    const t = window.setTimeout(() => handleGuess(null), ms);
    return () => {
      window.clearTimeout(t);
      roundLeftRef.current = Math.max(0, ms - (Date.now() - armedAt));
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundIdx, paused]);

  // Reveal → next round. Effect-driven (not a bare setTimeout in
  // handleGuess) for the same reason as the round clock: pausing mid
  // reveal must freeze the dwell instead of snapping to the next round
  // the moment the sheet closes.
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

  // Loading failsafe: buildRound bounds each network step, but if a
  // build still hangs, orphan it and serve a bundled-pack round (local
  // assets — can't hang) so "Fogging up the window…" is never forever.
  // Not pause-aware on purpose: loading is fetch progress, not game
  // progress (an in-flight buildRound resolves while paused anyway),
  // and the round clock only starts once the play phase begins.
  useEffect(() => {
    if (phase !== 'loading') return;
    const t = window.setTimeout(() => {
      const gen = ++loadGenRef.current;
      nextPromiseRef.current = null;
      buildRound('pack', usedRef.current).then((r) => {
        if (gen !== loadGenRef.current) return;
        setRound(r);
        setBudget(budgetPx(roundIdx + 1));
        setFogPct(1);
        setPhase('play');
      });
    }, LOAD_TIMEOUT_MS);
    return () => window.clearTimeout(t);
  }, [phase, roundIdx]);

  // Ends the game right now with whatever rounds are complete. The
  // natural finish (after the last reveal), the header End pill and
  // the pause sheet's "End game" all funnel through here; the parent
  // decides results-vs-menu from roundsPlayed.
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

  // Abandon safety net: unmounted mid-game (route change, tab switch,
  // navbar link, or the second back press while paused — which drops
  // straight to the Fog menu) with >=1 completed round and nothing
  // reported yet: record the partial score directly. No setState here:
  // the whole route may be unmounting. The POST is fire-and-forget;
  // local stats always update.
  useEffect(() => {
    return () => {
      if (reportedRef.current) return;
      const rounds = perRoundRef.current.length;
      if (rounds < 1) return; // never record/submit a 0-round game
      reportedRef.current = true;
      recordFogGame(scoreRef.current, bestStreakRef.current);
      api
        .submitGameScore({
          score: scoreRef.current,
          rounds,
          bestStreak: bestStreakRef.current,
        })
        .catch(() => undefined);
    };
  }, []);

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
    setRoundIdx(idx);
    const gen = loadGenRef.current;
    const p = nextPromiseRef.current ?? buildRound(category, usedRef.current);
    nextPromiseRef.current = null;
    p.then((r) => {
      if (gen !== loadGenRef.current) return;
      setRound(r);
      setBudget(budgetPx(idx + 1));
      setFogPct(1);
      setPhase('play');
      if (idx + 1 < ROUNDS) nextPromiseRef.current = buildRound(category, usedRef.current);
    });
  }

  function handleGuess(choice: string | null) {
    if (phase !== 'play' || !round || paused) return;
    // Freeze the fog fraction at the moment of the guess — the meter
    // keeps draining via refog otherwise.
    const pct = canvasRef.current?.getFogPct() ?? 0;
    const correct = choice != null && choice === round.answer;
    canvasRef.current?.clearFog(); // full reveal either way
    setPicked(choice);
    // Hand the dwell to the reveal effect: full duration, nothing
    // banked from a previous round.
    revealMsRef.current = correct ? REVEAL_CORRECT_MS : REVEAL_WRONG_MS;
    revealLeftRef.current = null;
    setPhase('reveal');
    perRoundRef.current.push({ fogPct: pct, correct });
    if (correct) {
      const pts = roundPoints(pct, streak);
      setLastPoints(pts);
      setScore((s) => s + pts);
      const ns = streak + 1;
      setStreak(ns);
      setBestStreak((b) => Math.max(b, ns));
    } else {
      setStreak(0);
    }
  }

  // The reveal timeout must call the LATEST advance() — the score /
  // streak state set above lands in a re-render after handleGuess
  // returns, and a directly-captured advance would report pre-guess
  // values to onFinish on the final round.
  const advanceRef = useRef(advance);
  advanceRef.current = advance;

  const budgetTotal = budgetPx(roundNo);
  const budgetFrac = budgetTotal > 0 ? Math.max(0, budget) / budgetTotal : 0;
  const wrongReveal = phase === 'reveal' && picked !== null && picked !== round?.answer;

  return (
    <div className="px-4">
      {/* Round / score / streak header */}
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
        {/* Ends the game on the spot, no confirmation — it's an
            explicit tap, unlike the back gesture (which pauses first,
            and only leaves on a second press).
            Results if >=1 round is done, straight back to the menu
            otherwise (also the escape hatch from a stuck loading
            screen). */}
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

      <div className={wrongReveal ? 'ping-shake relative' : 'relative'}>
        <FogCanvas
          ref={canvasRef}
          imageUrl={round?.imageUrl ?? null}
          refogRate={refogAlpha(roundNo)}
          brushSizePx={GUESS_BRUSH_PX}
          brushHardness="soft"
          fogDensity={1}
          wipeEnabled={phase === 'play' && budget > 0 && !paused}
          paused={paused}
          onWipe={(len) => setBudget((b) => Math.max(0, b - len))}
          onFogPct={setFogPct}
        />
        {phase === 'loading' ? (
          <div
            className="absolute inset-0 flex items-center justify-center text-sm"
            style={{ color: 'var(--text-dim)' }}
          >
            Fogging up the window…
          </div>
        ) : null}
      </div>

      {/* Wipe budget meter + fog HUD */}
      <div className="flex items-center gap-3 pt-2 pb-1">
        <div
          className="flex-1 h-[6px] rounded-full overflow-hidden"
          style={{ background: 'var(--bubble-them)' }}
          aria-label="wipe budget"
        >
          <div
            className="h-full rounded-full"
            style={{
              width: `${Math.round(budgetFrac * 100)}%`,
              background: budgetFrac > 0.25 ? 'var(--accent)' : 'var(--ping)',
              transition: 'width 120ms linear',
            }}
          />
        </div>
        <span className="text-xs tabular-nums" style={{ color: 'var(--text-dim)' }}>
          fog {Math.round(fogPct * 100)}%
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
              className="rounded-xl px-3 py-3 text-sm font-semibold text-center"
              style={{
                border: '1px solid var(--separator)',
                background: isAnswer
                  ? 'var(--online)'
                  : isWrongPick
                    ? 'var(--ping)'
                    : 'var(--card-bg)',
                color: isAnswer || isWrongPick ? '#FFFFFF' : 'var(--text)',
                opacity: phase === 'loading' ? 0.4 : 1,
                minHeight: 48,
              }}
            >
              {choice || '…'}
            </button>
          );
        })}
      </div>

      {/* Pause sheet. The game stays mounted and visible underneath —
          frozen, not ended — so Resume is a true continue. "End game"
          is the same finishNow funnel as the header End pill. */}
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
