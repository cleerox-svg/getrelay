// Load-state primitives shared by the golf client's cached fetches.
//
// WHY THIS EXISTS. The economy store used to track each slice with a single
// `loaded: boolean` that was set to true in BOTH the success and the failure
// arm:
//
//     try { const w = await api.getWallet(); set({ balance: w.balance, loaded: true }); }
//     catch { set({ loaded: true }); }          // ← balance stays null
//
// A failed fetch therefore looked exactly like a successful empty one, and the
// `if (loaded) return` guard meant it NEVER retried for the rest of the
// session. A 670-coin wallet rendered as a dash, every shop item rendered
// "Need more coins", and an owned+equipped ball skin rendered as not owned —
// all with no error anywhere on screen. Three states were being squashed into
// one bit, so the UI could not tell "you have nothing" from "we don't know".
//
// `LoadState` keeps them apart. Only 'ready' means the data in the store is the
// server's answer; 'error' is retryable and must be SURFACED, never rendered as
// a confident empty/zero.

/**
 * Where a cached remote slice is in its lifecycle.
 *
 *  - `idle`    — never attempted.
 *  - `loading` — a request is in flight.
 *  - `ready`   — the store holds the server's answer.
 *  - `error`   — the last attempt failed (or timed out). RETRYABLE, and the UI
 *                must say so rather than render the empty default as fact.
 */
export type LoadState = 'idle' | 'loading' | 'ready' | 'error';

/** True only when the slice's data is known-good. */
export function isReady(s: LoadState): boolean {
  return s === 'ready';
}

/** True while the very first attempt is still outstanding (nothing to show). */
export function isFirstLoad(s: LoadState): boolean {
  return s === 'idle' || s === 'loading';
}

/**
 * How long a cached golf fetch may hang before it is treated as failed.
 *
 * Without this, a request that never settles is indistinguishable from one
 * still on its way: the spinner stays up forever and there is no error and no
 * retry affordance. 12s is well past a slow-mobile round trip and well short of
 * a user deciding the screen is broken.
 */
export const GOLF_FETCH_TIMEOUT_MS = 12_000;

export class TimeoutError extends Error {
  constructor(ms: number) {
    super(`timed out after ${ms}ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Reject with a `TimeoutError` if `p` has not settled within `ms`.
 *
 * The underlying request is NOT cancelled (the api client takes no signal) —
 * this only bounds how long the UI waits before showing a retryable error. A
 * late success is discarded, which is correct: by then the caller has already
 * moved to 'error' and a Retry will refetch.
 */
export function withTimeout<T>(p: Promise<T>, ms: number = GOLF_FETCH_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutError(ms)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
