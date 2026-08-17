// @vitest-environment jsdom
//
// THE CAMERA SEAM. `DerbyGame.test.tsx` is the FIXTURE proof — it mounts the HUD
// with no router, no store and no WebGL, and depends on `StadiumGL`'s `lazy()`
// import never resolving so that `apiRef` stays null for the whole run. That is
// the right shape for everything it asserts, and it is exactly the wrong shape
// for this: the camera is the one thing the HUD says only THROUGH that handle,
// so a suite whose premise is "the handle is null" cannot see a word of it.
//
// So this file mocks `./StadiumGL` with a stub that hands back a recording API
// on mount. Nothing else changes; the sim, the clock pump and the play loop are
// the real ones. The two files are the two halves of the same question — "does
// the HUD work without a renderer" and "does it drive the renderer correctly" —
// and merging them would mean one of the two premises had to go.
//
// WHAT IS PINNED HERE, and all three are LIVE SURFACES with nothing else on
// them:
//
//   • the batter camera is held THROUGH contact. Non-negotiable: that frame is
//     what the player times the swing against.
//   • a ball worth watching pulls back to the deck; a ball that is not, does
//     not. `FOLLOW_MIN_HANG_S` exists because the ease has a LENGTH.
//   • the camera comes home when the play ENDS, inside the result hold, not when
//     the next aim begins.
//
// MUTATIONS WATCHED TO FAIL are logged at the bottom.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DerbyGame } from './DerbyGame';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';

const { submitSpy, modes } = vi.hoisted(() => ({
  submitSpy: vi.fn(async () => ({ ok: true })),
  /** Every `setMode` the HUD has asked for, in order. */
  modes: [] as string[],
}));

vi.mock('../../lib/api', () => ({ api: { submitGameScore: submitSpy } }));
vi.mock('../../lib/audio', () => ({ play: vi.fn(), unlockAudio: vi.fn() }));

// The stub renderer. It reports ready on its first effect and records every
// camera mode it is asked for; it draws nothing and needs no canvas.
//
// ⚠ IT RECORDS THE `mode` PROP, AND THE FIRST VERSION RECORDED `api.setMode`
// INSTEAD — which `DerbyGame` never calls, so the recorder stayed EMPTY and two
// of the four tests below passed on an empty array. `DerbyGame` drives the
// camera by setting React state, which becomes the `mode` prop; it is
// `StadiumGL`'s own `useEffect([mode])` that turns that into `api.setMode`. A
// recorder pointed at the wrong end of that chain is a suite that cannot fail,
// which is what the sweep test's "no swing produced a fly" was really reporting.
vi.mock('./StadiumGL', () => {
  const React = require('react') as typeof import('react');
  return {
    __esModule: true,
    default: ({
      mode,
      onReady,
    }: {
      mode: string;
      onReady?: (api: Record<string, unknown>) => void;
    }) => {
      React.useEffect(() => {
        modes.push(mode);
      }, [mode]);
      React.useEffect(() => {
        onReady?.({
          setMode: () => undefined,
          setReticle: () => undefined,
          setAiming: () => undefined,
          setFlight: () => undefined,
          setBallTime: () => undefined,
          ballScreen: () => null,
        });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);
      return null;
    },
  };
});

const PITCH_LEAD_MS = 380;
const SWING_WALL_MS = Math.round((0.41 / PITCH_TEMPO) * 1000);

let now = 0;
let frames: FrameRequestCallback[] = [];
let intervals: { id: number; cb: () => void; period: number; due: number }[] = [];
let nextIntervalId = 1;

beforeEach(() => {
  now = 0;
  frames = [];
  intervals = [];
  nextIntervalId = 1;
  modes.length = 0;
  submitSpy.mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
  vi.stubGlobal('setInterval', (cb: () => void, ms: number) => {
    const id = nextIntervalId++;
    intervals.push({ id, cb, period: Math.max(1, ms), due: now + Math.max(1, ms) });
    return id;
  });
  vi.stubGlobal('clearInterval', (id: number) => {
    intervals = intervals.filter((t) => t.id !== id);
  });
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/**
 * Resolve the `lazy()` renderer. `DerbyGame` imports `StadiumGL` through
 * `lazy()` inside a `<Suspense>`, so even a mocked module arrives on a
 * microtask — without this the stub's effect never runs and `modes` stays empty,
 * which is exactly the state `DerbyGame.test.tsx` deliberately keeps it in.
 */
async function mountScene() {
  await act(async () => {
    await Promise.resolve();
  });
}

function advance(ms: number, stepMs = 8) {
  for (let done = 0; done < ms; done += stepMs) {
    now += stepMs;
    const dueFrames = frames;
    frames = [];
    const dueTimers = intervals.filter((t) => t.due <= now);
    for (const t of dueTimers) t.due = now + t.period;
    act(() => {
      for (const cb of dueFrames) cb(now);
      for (const t of dueTimers) t.cb();
    });
  }
}

const surface = () => document.querySelectorAll('div[style*="touch-action"]')[0] as HTMLElement;

function tap(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  });
}

/**
 * Play one pitch and swing at `swingWallMs`. Returns the mode calls made from
 * the swing onward, which is the only window any of this is about.
 */
function swingOnce(swingWallMs: number) {
  act(() => screen.getByText('Pitch it in').click());
  advance(PITCH_LEAD_MS);
  advance(swingWallMs);
  // ⚠ CAPTURED BEFORE THE TAP, NOT AFTER IT, AND THE FIRST DRAFT READ IT AFTER.
  // `tap()` runs inside `act()`, which flushes the state update AND the effect,
  // so a length read afterwards already includes the pull-back — the ordering
  // claim it was supposed to support was unfalsifiable. This index is the last
  // frame on which the player had not yet swung.
  const preTap = modes.length;
  tap(surface());
  return { preTap };
}

describe('DerbyGame — the camera', () => {
  it('HOLDS the batter camera through the wind-up and the whole flight to the plate', async () => {
    // ⚠ NON-NEGOTIABLE. This is the frame the player times the swing against;
    // any camera motion before the tap would break the one skill the game has.
    // Asserted over the entire live window — the 380 ms wind-up plus the whole
    // 0.41 s crossing at playback tempo — rather than at one instant.
    render(<DerbyGame seed={20260816} />);
    await mountScene();
    advance(50);
    expect(modes).toEqual(['batter']);
    act(() => screen.getByText('Pitch it in').click());
    advance(PITCH_LEAD_MS + SWING_WALL_MS, 4);
    expect(modes).toEqual(['batter']);
  });

  it('pulls back to the deck for a long fly, and comes home when the play ends', async () => {
    render(<DerbyGame seed={20260816} />);
    await mountScene();
    advance(50);
    // Sweep swing timings until one produces a fly long enough to earn the
    // pull-back. Pinning a single wall offset would make this a test of the
    // seed rather than of the rule.
    let found = false;
    for (let i = 0; i < 12 && !found; i++) {
      modes.length = 0;
      const { preTap } = swingOnce(SWING_WALL_MS + (i - 6) * 4);
      // ⚠ THE ORDERING, MEASURED AT THE TAP. Whatever happens later, the camera
      // was still on `batter` for every frame BEFORE the tap: `commit()` asks
      // for the pull-back only after `sim.swing()` has returned a ball.
      expect(modes.slice(0, preTap).filter((m) => m !== 'batter')).toEqual([]);
      // ⚠ WALK THE PLAY IN 100 ms CHUNKS AND TIME TWO EVENTS AGAINST EACH
      // OTHER, because their SEPARATION is the assertion. Deleting `endPlay`'s
      // `setMode('batter')` used to fail 0 of 3 tests here: `nextPitch` set it
      // too, 1500 ms later, with the aim UI already up and the camera still
      // sliding home under a reticle the player was being asked to aim at. A
      // check that only asks "did it come back" cannot tell those apart. This
      // one measures the gap.
      let returnedAt = -1;
      let aimAt = -1;
      for (let c = 0; c < 130 && aimAt < 0; c++) {
        advance(100, 16);
        if (returnedAt < 0 && modes.includes('flight') && modes.lastIndexOf('batter') > modes.indexOf('flight')) {
          returnedAt = c;
        }
        if (screen.queryByText('Pitch it in')) aimAt = c;
      }
      if (modes.includes('flight')) {
        found = true;
        expect(returnedAt, 'the camera never came home').toBeGreaterThanOrEqual(0);
        expect(aimAt, 'the next aim never came up').toBeGreaterThanOrEqual(0);
        // At least a second of the result hold between the camera starting home
        // and the player being asked to aim again. RESULT_HOLD_MS is 1500.
        expect(aimAt - returnedAt).toBeGreaterThanOrEqual(10);
        expect(modes[modes.length - 1]).toBe('batter');
      }
    }
    expect(found, 'no swing in the sweep produced a fly worth following').toBe(true);
  });

  it('leaves the camera alone for a swing that produces no flight at all', async () => {
    render(<DerbyGame seed={20260816} />);
    await mountScene();
    advance(50);
    modes.length = 0;
    // A tap 250 ms of wall clock before the crossing is a whiff: no batted ball,
    // so nothing to follow and no reason to move. The `r.flight` guard is what
    // makes that true; without it the camera swoops to the deck to watch a bat
    // pass through empty air.
    swingOnce(Math.max(0, SWING_WALL_MS - 250));
    // ⚠ ASSERTED HERE, BEFORE THE RESULT HOLD EXPIRES. The first draft checked
    // for the whiff line AFTER `advance(4000)`, by which time `nextPitch()` had
    // cleared `last` and the readout with it — so the guard that this swing is
    // really a whiff was reading an empty screen.
    advance(32, 8);
    expect(screen.queryByText(/miss/i), 'this swing was meant to be a whiff').toBeTruthy();
    advance(4000, 16);
    expect(modes).not.toContain('flight');
  });
});

// ---------------------------------------------------------------------------
// MUTATIONS WATCHED TO FAIL — applied to `DerbyGame.tsx`, this file run, then
// reverted. Counts are of failing tests in THIS file.
//
//   (1) `setMode('flight')` moved ABOVE `sim.swing()` in the tap
//       handler, i.e. the camera moves before contact resolves    → 1 fail
//   (2) `endPlay`'s `setMode('batter')` deleted (the camera never
//       comes home; the next aim happens from the upper deck)     → 1 fail
//   (2b) the return moved BACK into `nextPitch` — i.e. it happens,
//       but 1500 ms late, under a live aim reticle                → 1 fail
//   (3) `FOLLOW_MIN_HANG_S` raised to 99 (nothing ever earns the
//       pull-back — the defect the owner reported, restored)      → 1 fail
//   (4) the `r.flight` guard dropped so a whiff switches camera    → 1 fail
//
// ⚠ (2) SURVIVED ITS FIRST ASSERTION — 0 of 3 — and that is why (2b) exists and
// why `nextPitch` no longer sets the mode. Two calls covered one case: deleting
// the one that matters left the other doing the job at the wrong moment, and a
// check that only asked "did the camera come back" could not tell them apart.
// The assertion now measures the GAP between the return and the next aim, which
// is the property that was actually wanted.
//
// ⚠ AND TWO OF THIS FILE'S OWN ASSERTIONS WERE HOLLOW BEFORE THEY WERE FIXED:
// the stub recorded `api.setMode` (which `DerbyGame` never calls) instead of the
// `mode` PROP, so the recorder stayed empty and two tests passed on `[]`; and the
// "no camera motion before the tap" index was read AFTER `act()` had already
// flushed the tap's state update. Both are noted at their sites.
// ---------------------------------------------------------------------------
