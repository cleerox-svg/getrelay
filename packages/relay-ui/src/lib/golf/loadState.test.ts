// Direct unit test for the load-state primitives.
//
// WHY THIS FILE EXISTS. `loadState.ts` is the whole convention — every golf
// screen branches on `isFirstLoad()` / `'error'` and every cached golf fetch is
// bounded by `withTimeout()` — and it had NO direct test. Mutating
// `isFirstLoad` to `s === 'idle'` passed the entire golf suite (26/26 across
// economy.test.ts, GolfShop.test.tsx and GolfClubhouse.test.tsx), because every
// assertion downstream sits behind a polling `findByText` that races straight
// past the transient. The shipped consequence of that mutation is a flash of
// "The pro shop is closed", "No coin activity yet" and "No active season" on
// EVERY mount — the exact false empty-state copy the convention exists to
// prevent, just briefly.
//
// So the states are asserted as a TABLE (every state against every predicate),
// not one arm at a time: a one-sided assertion is what let the profile defect
// ship.
//
// MUTATIONS WATCHED TO FAIL against this file (counts are failures in THIS
// file; the knock-on counts elsewhere are noted because they are the point):
//   1. `isFirstLoad` → `s === 'idle'`   → 2 fail (+1 GolfShop, +2 Clubhouse)
//   2. `isFirstLoad` → `s !== 'ready'`  → 2 fail
//   3. `isReady` → `s !== 'error'`      → 3 fail
//   4. `withTimeout` reduced to `return p` (a pass-through)
//                                       → 4 fail (+1 economy, +1 Clubhouse,
//                                                 +4 GolfArena.load)
//   5. `withTimeout`'s `clearTimeout(timer)` on the success arm removed
//                                       → 1 fail

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  GOLF_FETCH_TIMEOUT_MS,
  TimeoutError,
  isFirstLoad,
  isReady,
  withTimeout,
  type LoadState,
} from './loadState';

const ALL: LoadState[] = ['idle', 'loading', 'ready', 'error'];

afterEach(() => {
  vi.useRealTimers();
});

describe('LoadState predicates — all four states, both directions', () => {
  // The table IS the test: `expected` names every state's answer, so a
  // predicate that widens or narrows by one state fails here rather than
  // silently changing what the UI renders.
  const expected: Record<LoadState, { firstLoad: boolean; ready: boolean }> = {
    idle: { firstLoad: true, ready: false },
    loading: { firstLoad: true, ready: false },
    ready: { firstLoad: false, ready: true },
    error: { firstLoad: false, ready: false },
  };

  it.each(ALL)('%s', (s) => {
    expect(isFirstLoad(s)).toBe(expected[s].firstLoad);
    expect(isReady(s)).toBe(expected[s].ready);
  });

  it('treats LOADING as a first load — not only idle', () => {
    // The mutation that passed 26/26. If 'loading' stops counting as a first
    // load, every golf screen falls through to its EMPTY copy while the first
    // request is still in flight.
    expect(isFirstLoad('loading')).toBe(true);
    expect(isFirstLoad('idle')).toBe(true);
    // …and the other direction: a settled slice is NOT a first load, or the
    // spinner never leaves.
    expect(isFirstLoad('error')).toBe(false);
    expect(isFirstLoad('ready')).toBe(false);
  });

  it('calls only READY ready — an error is not data', () => {
    expect(isReady('ready')).toBe(true);
    expect(isReady('error')).toBe(false);
    expect(isReady('idle')).toBe(false);
    expect(isReady('loading')).toBe(false);
  });
});

describe('withTimeout', () => {
  it('rejects with a TimeoutError once the budget passes', async () => {
    vi.useFakeTimers();
    const hung = withTimeout(new Promise<number>(() => {}));
    const caught = hung.catch((e) => e);
    await vi.advanceTimersByTimeAsync(GOLF_FETCH_TIMEOUT_MS + 1);
    const err = await caught;
    expect(err).toBeInstanceOf(TimeoutError);
    expect(String(err)).toContain(`${GOLF_FETCH_TIMEOUT_MS}`);
  });

  it('does NOT reject before the budget passes', async () => {
    // Positive control for the test above: the timeout must bound a hung
    // request without shortening a merely slow one.
    vi.useFakeTimers();
    let settled: string | null = null;
    const p = withTimeout(new Promise<number>(() => {})).then(
      () => (settled = 'resolved'),
      () => (settled = 'rejected'),
    );
    await vi.advanceTimersByTimeAsync(GOLF_FETCH_TIMEOUT_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(2);
    await p;
    expect(settled).toBe('rejected');
  });

  it('passes a value straight through when it settles in time', async () => {
    await expect(withTimeout(Promise.resolve(670))).resolves.toBe(670);
  });

  it('passes the underlying rejection through unchanged', async () => {
    const boom = new Error('offline');
    await expect(withTimeout(Promise.reject(boom))).rejects.toBe(boom);
    // Not swallowed into a TimeoutError — the caller's error mapping still sees
    // the ApiError it was given.
    await expect(withTimeout(Promise.reject(boom))).rejects.not.toBeInstanceOf(TimeoutError);
  });

  it('honours a custom budget', async () => {
    vi.useFakeTimers();
    const caught = withTimeout(new Promise<number>(() => {}), 50).catch((e) => e);
    await vi.advanceTimersByTimeAsync(51);
    expect(await caught).toBeInstanceOf(TimeoutError);
  });

  it('clears its timer when the request wins, leaving nothing pending', async () => {
    // A leaked timer keeps the event loop (and, in a component, a fake-timer
    // test) alive for 12s after a request that already answered.
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    await withTimeout(Promise.resolve('ok'));
    expect(vi.getTimerCount()).toBe(before);
  });

  it('clears its timer when the request fails', async () => {
    vi.useFakeTimers();
    const before = vi.getTimerCount();
    await withTimeout(Promise.reject(new Error('offline'))).catch(() => undefined);
    expect(vi.getTimerCount()).toBe(before);
  });

  it('discards a LATE success — the caller has already moved to error', async () => {
    vi.useFakeTimers();
    let release: (v: string) => void = () => undefined;
    const outcome: string[] = [];
    const p = withTimeout(new Promise<string>((res) => (release = res))).then(
      (v) => outcome.push(`resolved:${v}`),
      () => outcome.push('rejected'),
    );
    await vi.advanceTimersByTimeAsync(GOLF_FETCH_TIMEOUT_MS + 1);
    await p;
    release('late');
    await vi.advanceTimersByTimeAsync(1);
    expect(outcome).toEqual(['rejected']);
  });
});
