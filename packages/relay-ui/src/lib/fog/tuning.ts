// Every tunable number for the Fog mini game lives here so difficulty
// can be rebalanced without spelunking through the engine or the
// components. Scoring MUST mirror the worker-side clamps on
// POST /game/score (max 8 rounds, max 2000 points per round) — if the
// client could produce more, the server would silently clip it and the
// local "best" would disagree with the leaderboard.

export const ROUNDS = 8;

// Wipe budget in CSS pixels of finger travel per round. Shrinks ~7%
// per round so late rounds force guessing from smaller peepholes.
export function budgetPx(round: number): number {
  return Math.round(2400 * Math.pow(0.93, round - 1));
}

// Re-fog alpha applied per 100ms tick (see REFOG_TICK_MS). Grows with
// the round number: early rounds barely steam back up, late rounds
// close the peephole while you hesitate.
export function refogAlpha(round: number): number {
  return 0.008 + 0.004 * (round - 1);
}

// Engine tick cadence for the refog fill. Coarser than rAF on purpose:
// one pattern fill per 100ms is cheap; one per frame is not (low-end
// Android WebView).
export const REFOG_TICK_MS = 100;

// Fixed brush size in guess mode — the free-play slider doesn't apply
// here so everyone competes with the same finger.
export const GUESS_BRUSH_PX = 44;

// Failsafe: a round that gets no guess for 45s counts as wrong. Keeps
// an abandoned tab from holding a "perfect fog" round open forever.
export const ROUND_TIMEOUT_MS = 45_000;

// Failsafe: a round build stuck in the loading phase for this long is
// abandoned and replaced with a bundled-pack round. buildRound bounds
// its own network steps, but the loading screen must never be able to
// sit on "Fogging up the window…" forever.
export const LOAD_TIMEOUT_MS = 15_000;

// Per-round score clamp — mirrors the server (score <= rounds * 2000).
export const MAX_ROUND_POINTS = 2000;
export const STREAK_STEP = 0.1;
export const STREAK_CAP = 2.0;

// Correct guess: more remaining fog = more points (you guessed from
// less information), floored at 100 so a full wipe still pays a bit.
// `streak` is the streak count BEFORE this correct answer.
export function roundPoints(fogPct: number, streak: number): number {
  const base = Math.max(100, Math.round(1000 * fogPct));
  const mult = Math.min(STREAK_CAP, 1 + STREAK_STEP * streak);
  return Math.min(MAX_ROUND_POINTS, Math.round(base * mult));
}
