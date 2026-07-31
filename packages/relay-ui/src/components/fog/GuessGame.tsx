import { useEffect, useRef, useState } from 'react';
import { FogCanvas } from './FogCanvas';
import type { FogCanvasHandle } from './FogCanvas';
import { buildRound } from '../../lib/fog/sources';
import type { FogCategory, FogRound } from '../../lib/fog/sources';
import {
  GUESS_BRUSH_PX,
  ROUNDS,
  ROUND_TIMEOUT_MS,
  budgetPx,
  refogAlpha,
  roundPoints,
} from '../../lib/fog/tuning';

export interface GameResult {
  score: number;
  bestStreak: number;
  rounds: number;
  perRound: { fogPct: number; correct: boolean }[];
}

interface Props {
  category: FogCategory;
  onFinish: (result: GameResult) => void;
}

type Phase = 'loading' | 'play' | 'reveal';

// The scored 8-round game. Each round: a fresh pane of fog over a new
// mystery image, a shrinking wipe budget, fog creeping back in, and
// four choices. Points scale with how much fog was still on the glass
// when the correct guess landed.
export function GuessGame({ category, onFinish }: Props) {
  const canvasRef = useRef<FogCanvasHandle | null>(null);
  const usedRef = useRef(new Set<string>());
  const nextPromiseRef = useRef<Promise<FogRound> | null>(null);
  const perRoundRef = useRef<GameResult['perRound']>([]);
  const advanceTimerRef = useRef<number | null>(null);

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

  // First round + prefetch of the second. Prefetching keeps the
  // between-round pause down to the reveal animation on decent
  // networks.
  useEffect(() => {
    let cancelled = false;
    buildRound(category, usedRef.current).then((r) => {
      if (cancelled) return;
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
  // round can't stall the game.
  useEffect(() => {
    if (phase !== 'play') return;
    const t = window.setTimeout(() => handleGuess(null), ROUND_TIMEOUT_MS);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [phase, roundIdx]);

  function advance() {
    const idx = roundIdx + 1;
    if (idx >= ROUNDS) {
      onFinish({
        score,
        bestStreak,
        rounds: ROUNDS,
        perRound: perRoundRef.current.slice(),
      });
      return;
    }
    setPhase('loading');
    setRound(null);
    setPicked(null);
    setLastPoints(null);
    setRoundIdx(idx);
    const p = nextPromiseRef.current ?? buildRound(category, usedRef.current);
    nextPromiseRef.current = null;
    p.then((r) => {
      setRound(r);
      setBudget(budgetPx(idx + 1));
      setFogPct(1);
      setPhase('play');
      if (idx + 1 < ROUNDS) nextPromiseRef.current = buildRound(category, usedRef.current);
    });
  }

  function handleGuess(choice: string | null) {
    if (phase !== 'play' || !round) return;
    // Freeze the fog fraction at the moment of the guess — the meter
    // keeps draining via refog otherwise.
    const pct = canvasRef.current?.getFogPct() ?? 0;
    const correct = choice != null && choice === round.answer;
    canvasRef.current?.clearFog(); // full reveal either way
    setPicked(choice);
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
    advanceTimerRef.current = window.setTimeout(
      () => advanceRef.current(),
      correct ? 1100 : 1700,
    );
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
      </div>

      <div className={wrongReveal ? 'ping-shake relative' : 'relative'}>
        <FogCanvas
          ref={canvasRef}
          imageUrl={round?.imageUrl ?? null}
          refogRate={refogAlpha(roundNo)}
          brushSizePx={GUESS_BRUSH_PX}
          brushHardness="soft"
          fogDensity={1}
          wipeEnabled={phase === 'play' && budget > 0}
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
              disabled={phase !== 'play' || !choice}
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
    </div>
  );
}
