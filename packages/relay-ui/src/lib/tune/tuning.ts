// Every tunable number for the "Guess the Tune" mini game lives here so
// difficulty can be rebalanced without spelunking through the audio
// engine or the components. Scoring MUST mirror the worker-side clamps
// on POST /game/score (max 8 rounds, max 2000 points per round) — if the
// client could produce more, the server would silently clip it and the
// local "best" would disagree with the leaderboard. This is the audio
// sibling of lib/fog/tuning.ts and stays deliberately parallel to it.

export const ROUNDS = 8;

// Maximum clip length (ms) the player is allowed to hear before the
// audio caps out. Ramps ~10s (round 1) down to ~5s (round 8) — the audio
// analogue of fog's budgetPx shrink, so late rounds force a call from
// less to go on. Guessing early (less heard) is worth more; letting the
// whole clip play burns the "unheard" bonus to zero.
export function clipLenMs(round: number): number {
  return Math.round(10_000 * Math.pow(0.906, round - 1));
}

// Failsafe: a round that gets no guess for 45s counts as wrong. Keeps an
// abandoned tab from holding a round open forever.
export const ROUND_TIMEOUT_MS = 45_000;

// The reveal screen is advanced MANUALLY (a Next button or a right
// swipe) so the player has time to read the answer and tap the Listen /
// Spotify links. This is a long IDLE failsafe, not a fast auto-advance:
// if the reveal is abandoned and nothing is tapped for this long, the
// game advances on its own so a walked-away run still ends. Pause-aware
// (banked while the pause sheet is up), exactly like ROUND_TIMEOUT_MS.
export const REVEAL_IDLE_MS = 30_000;

// Failsafe: a round build stuck in the loading phase for this long is
// abandoned. buildTuneRound bounds its own network steps, but the
// loading screen must never sit on "Finding a tune…" forever. Unlike
// Fog there is no bundled fallback, so a timeout ends/aborts the game
// (see TuneGame) rather than serving a local round.
//
// This is an intentional HARD bound: it is deliberately shorter than
// buildTuneRound's full retry budget (up to a few seed attempts × the
// per-attempt network timeout), so on a slow-but-working network we fail
// fast to the "unavailable" screen instead of making the player stare at
// a spinner for the whole worst-case retry window. Bounding the wait
// matters more here than squeezing out the last retry.
export const LOAD_TIMEOUT_MS = 15_000;

// Per-round score clamp — mirrors the server (score <= rounds * 2000).
export const MAX_ROUND_POINTS = 2000;
export const STREAK_STEP = 0.1;
export const STREAK_CAP = 2.0;

// Correct guess: more of the clip still UNHEARD = more points (you named
// it from less), floored at 100 so guessing after the clip fully plays
// still pays a bit. `unheardFrac` = 1 - secondsHeard/maxClipSeconds,
// clamped to [0,1] by the caller. `streak` is the streak count BEFORE
// this correct answer. Mirror of fog's roundPoints with fogPct →
// unheardFrac.
export function roundPoints(unheardFrac: number, streak: number): number {
  const base = Math.max(100, Math.round(1000 * unheardFrac));
  const mult = Math.min(STREAK_CAP, 1 + STREAK_STEP * streak);
  return Math.min(MAX_ROUND_POINTS, Math.round(base * mult));
}
