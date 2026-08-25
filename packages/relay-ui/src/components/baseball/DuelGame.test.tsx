// @vitest-environment jsdom
//
// THE DUEL'S FIXTURE PROOF, and the three things about it that no type-check and
// no printed table can see.
//
//   1. THE MOUND'S INPUT → A `PitchCommand`. A placement in CSS pixels and a
//      stop on a sweeping bar become an intended plate location in REPORT feet
//      plus a signed error in [−1, 1]. Every step of that is arithmetic with a
//      sign in it, and a wrong one produces a game that runs perfectly and aims
//      the wrong way.
//   2. THE HALVES ALTERNATE, and the whole input surface swaps with them. The
//      duel is the first mode in this game where the player's controls change
//      mid-session; a HUD that kept the mound up while the AI pitched would
//      simply never let him bat.
//   3. IT MOUNTS ON PROPS ALONE — no router, no store, no WebGL. `StadiumGL` is
//      `lazy()`, so under a test that never flushes the import it never
//      resolves and `apiRef` stays null for the whole run, which is the same
//      state as a slow network. The game has to work in it.
//
// ⚠ AND `servePitch()` IS NEVER CALLED BARE ON THE HUMAN'S MOUND. `DuelSim`
// THROWS in that case, deliberately — a duel that pitched itself would be a
// mode. The assertion is on the ARGUMENTS ARRAY'S LENGTH, not on the value:
// `toHaveBeenCalledWith(undefined)` matches a zero-argument call in vitest, and
// `DerbyGame.test.tsx` records that exact trap swallowing the mutation it was
// written for.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DuelGame } from './DuelGame';
import { DuelSim } from '../../lib/baseball/duelSim';
import { aimAtPoint } from './shared/moundAim';
import { PITCH_LEAD_MS } from './shared/playClock';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';

vi.mock('../../lib/audio', () => ({ play: vi.fn(), unlockAudio: vi.fn() }));

/** `AccuracyBar`'s own side-to-side period, ms. Mirrored by hand from that file. */
const SWEEP_MS = 950;

const SEED = 20260823;

/** The mound panel's stubbed screen rect. See the `getBoundingClientRect` note. */
const PANEL_W = 227;
const PANEL_H = 288;
const PANEL_CX = 200;
const PANEL_CY = 420;

let now = 0;
let frames: FrameRequestCallback[] = [];
let intervals: { id: number; cb: () => void; period: number; due: number }[] = [];
let nextIntervalId = 1;

beforeEach(() => {
  now = 0;
  frames = [];
  intervals = [];
  nextIntervalId = 1;
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
  // jsdom has `PointerEvent` but no pointer CAPTURE. The aim surface calls it
  // on every `pointerdown`, so without this the very first gesture throws.
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  // ⚠ AND jsdom LAYS NOTHING OUT, so every rect is 0×0 at the origin. The mound
  // panel maps a client point RELATIVE TO ITS OWN CENTRE, so the centre has to
  // be a real number or the whole mapping collapses onto (0, 0) and every
  // assertion below would be about a rect that does not exist. Stated, not
  // inherited: the panel sits at (PANEL_CX, PANEL_CY).
  Element.prototype.getBoundingClientRect = () =>
    ({
      left: PANEL_CX - PANEL_W / 2,
      top: PANEL_CY - PANEL_H / 2,
      width: PANEL_W,
      height: PANEL_H,
      right: PANEL_CX + PANEL_W / 2,
      bottom: PANEL_CY + PANEL_H / 2,
      x: PANEL_CX - PANEL_W / 2,
      y: PANEL_CY - PANEL_H / 2,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

/** Advance the wall clock by `ms`, running one animation frame per step. */
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

const mound = () => document.querySelector('[data-mound-surface]') as HTMLElement | null;
const bar = () => document.querySelector('[data-accuracy-marker]') as HTMLElement | null;

/**
 * Every full-bleed pointer-capture layer currently in the DOM.
 *
 * ⚠ THERE MUST BE EXACTLY ONE, and counting them is the only way to say so.
 * `ZoneReticle`'s header states the rule — two stacked full-bleed layers is how
 * a tap goes to the wrong one and the swing the player is sure they made never
 * reaches the sim — and the duel is the first mode with two candidates. A HUD
 * that rendered the batter's surface through the pitching half would also hand
 * the player the AI batter's reticle, which is a live layer with an opinion
 * about somebody else's swing. Every one of them sets `touch-action: none`.
 */
const layers = () => document.querySelectorAll('div[style*="touch-action"]');

function pointer(el: HTMLElement, type: string, x = 0, y = 0) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: x, clientY: y }),
    );
  });
}

/** Place the aim at (dx, dy) px from the panel's centre, and let go. */
function place(dx: number, dy: number) {
  const el = mound();
  expect(el, 'no mound surface — the pitching half is not up').toBeTruthy();
  pointer(el!, 'pointerdown', PANEL_CX + dx, PANEL_CY + dy);
  pointer(el!, 'pointerup', PANEL_CX + dx, PANEL_CY + dy);
}

/** Throw one pitch from the mound and let the play run out to the next aim. */
function throwOne(sweepMs = 200) {
  place(-30, 20);
  advance(sweepMs, 8);
  const marker = bar();
  expect(marker, 'the sweep never armed').toBeTruthy();
  pointer(marker!, 'pointerdown');
  // Wind-up + the whole flight at tempo + the batted ball's hang + the result
  // hold. Deliberately generous: the loop ends the play on its own clock.
  advance(PITCH_LEAD_MS + 9000, 16);
}

describe('DuelGame — the fixture seam', () => {
  it('mounts with props alone: no router, no store, no WebGL', () => {
    render(<DuelGame seed={SEED} />);
    expect(screen.getByText('Building the park…')).toBeTruthy();
    // ⚠ `humanBats` DEFAULTS TO `home`, SO THE PLAYER PITCHES FIRST. The top of
    // the first is the away side batting, which is the AI. The mound is up and
    // the batter's button is not.
    expect(mound()).toBeTruthy();
    expect(screen.queryByText('Step in')).toBeNull();
    expect(screen.getByLabelText('4-Seam Fastball')).toBeTruthy();
    // …and the mound is the ONLY live capture layer. See `layers`.
    expect(layers()).toHaveLength(1);
  });
});

describe('DuelGame — the mound: a gesture becomes a PitchCommand', () => {
  it('⚠ the placement and the sweep reach the sim as TWO NUMBERS, in the sim’s units', () => {
    const serve = vi.spyOn(DuelSim.prototype, 'servePitch');
    render(<DuelGame seed={SEED} />);

    // A placement with BOTH components non-zero and unequal, chosen so that the
    // normalised (u, v) and the REPORT (x, h) are four different numbers —
    // passing `u` where `x` was meant would otherwise be invisible.
    const DX = -45;
    const DY = 25;
    const aim = aimAtPoint(DX, DY);
    expect(Math.abs(aim.u - aim.x)).toBeGreaterThan(0.1);
    expect(Math.abs(aim.v - aim.h)).toBeGreaterThan(0.1);

    place(DX, DY);
    // The sweep is armed but nothing has been thrown: a placement is not a pitch.
    expect(serve).not.toHaveBeenCalled();
    expect(bar()).toBeTruthy();

    // Stop the marker at a KNOWN phase. `AccuracyBar` runs a triangle wave of
    // period SWEEP_MS from the instant it mounted, so the elapsed wall time
    // fixes the stop exactly — which is what makes this an assertion about the
    // mapping and not about a random number.
    const ELAPSED_MS = 712;
    advance(ELAPSED_MS, 8);
    pointer(bar()!, 'pointerdown');

    const expectedStop = (ELAPSED_MS / SWEEP_MS - 0.5) * 2;
    expect(serve).toHaveBeenCalledTimes(1);
    // ⚠ THE ARGUMENT COUNT IS THE ASSERTION, not just the value: the sim throws
    // on a bare call from the human's mound, and a mutant that dropped the
    // command would be caught by the throw only if the HUD did not swallow it.
    expect(serve.mock.calls[0]).toHaveLength(1);
    const cmd = serve.mock.calls[0]![0]!;
    expect(cmd.id).toBe('ff');
    expect(cmd.intentX).toBeCloseTo(aim.x, 10);
    expect(cmd.intentH).toBeCloseTo(aim.h, 10);
    expect(cmd.stopError).toBeCloseTo(expectedStop, 6);
    // …and it is a real, signed error inside the sim's contract, not a 0 that
    // would make every assertion above pass on an inert control.
    expect(Math.abs(cmd.stopError)).toBeGreaterThan(0.2);
    expect(cmd.stopError).toBeGreaterThanOrEqual(-1);
    expect(cmd.stopError).toBeLessThanOrEqual(1);

    // eslint-disable-next-line no-console
    console.log(
      `\n[MOUND → SIM]  placed (${DX}, ${DY}) px from centre  →  intent x ${cmd.intentX.toFixed(3)} ft, ` +
        `h ${cmd.intentH.toFixed(3)} ft  ·  stop ${cmd.stopError.toFixed(4)} after ${ELAPSED_MS} ms\n`,
    );
  });

  it('the selected pitch is the one thrown', () => {
    const serve = vi.spyOn(DuelSim.prototype, 'servePitch');
    render(<DuelGame seed={SEED} />);
    act(() => screen.getByLabelText('Sweeper').click());
    place(0, 0);
    advance(120, 8);
    pointer(bar()!, 'pointerdown');
    expect(serve.mock.calls[0]![0]!.id).toBe('st');
  });

  it('a released aim cannot be re-placed, and the pitch fires exactly once', () => {
    const serve = vi.spyOn(DuelSim.prototype, 'servePitch');
    render(<DuelGame seed={SEED} />);
    place(-20, 0);
    const aim = aimAtPoint(-20, 0);
    advance(100, 8);

    // ⚠ THE PANEL STAYS UP THROUGH THE SWEEP — that is the point of it, since the
    // player is timing a release against a spot they chose — so it is INERTNESS
    // that has to be asserted now, not absence. A live second surface under the
    // bar is how a stray touch re-aims a pitch already released.
    const panel = mound();
    expect(panel, 'the panel vanished with the sweep — the mark went with it').toBeTruthy();
    expect(panel!.style.pointerEvents).toBe('none');
    pointer(panel!, 'pointerdown', PANEL_CX + 60, PANEL_CY - 60);

    const marker = bar()!;
    pointer(marker, 'pointerdown');
    pointer(marker, 'pointerdown');
    expect(serve).toHaveBeenCalledTimes(1);
    // …and what it threw is what was placed BEFORE the sweep, not the stray.
    expect(serve.mock.calls[0]![0]!.intentX).toBeCloseTo(aim.x, 10);
    expect(serve.mock.calls[0]![0]!.intentH).toBeCloseTo(aim.h, 10);
  });
});

describe('DuelGame — the halves alternate', () => {
  it('⚠ the whole input surface swaps when the half turns over', () => {
    const serve = vi.spyOn(DuelSim.prototype, 'servePitch');
    render(<DuelGame seed={SEED} />);
    expect(mound()).toBeTruthy();

    // Pitch the top of the first out. Every pitch is a real one through the real
    // sim — three outs arrive when they arrive.
    let thrown = 0;
    for (; thrown < 40 && mound(); thrown++) throwOne(150 + thrown * 37);

    // eslint-disable-next-line no-console
    console.log(`\n[DUEL HALVES]  the player's first half on the mound took ${thrown} pitches\n`);
    expect(thrown, 'the half never ended in 40 pitches').toBeLessThan(40);

    // The mound is gone and the batter's box is up — and there is still exactly
    // ONE live capture layer, now the other one.
    expect(mound()).toBeNull();
    expect(screen.getByText('Step in')).toBeTruthy();
    expect(layers()).toHaveLength(1);
    // The chip's inning cell has flipped to the bottom half.
    const inn = [...document.querySelectorAll('span')].find((s) => s.textContent === 'Inn');
    expect(inn?.nextElementSibling?.textContent).toBe('B1');

    // ⚠ AND NOW THE SIM IS ASKED WITH NO COMMAND. On the human's half at bat the
    // AI on the mound decides for itself, and handing it the player's last
    // gesture would be the player pitching to himself. The arguments array's
    // LENGTH is the only thing that separates `serve()` from `serve(undefined)`.
    const before = serve.mock.calls.length;
    act(() => screen.getByText('Step in').click());
    expect(serve.mock.calls.length).toBe(before + 1);
    expect(serve.mock.calls[before]).toHaveLength(0);

    // Every pitch of the half just played DID carry one.
    for (let i = 0; i < before; i++) expect(serve.mock.calls[i]).toHaveLength(1);

    // ⚠ AND THE BATTER'S TAP REACHES THE SIM IN TRUE PHYSICAL SECONDS. The duel
    // shares `playClock.trueTimeOf` with the derby, and the derby's suite is
    // what caught the divide-instead-of-multiply mutant — but "the shared module
    // is guarded" is a claim about the derby's wiring, not this one's. A HUD
    // that reached for its own wall clock here would pass every assertion above.
    const WALL_AFTER_RELEASE_MS = Math.round((0.308 / PITCH_TEMPO) * 1000);
    advance(PITCH_LEAD_MS + WALL_AFTER_RELEASE_MS, 4);
    const surface = layers()[0] as HTMLElement;
    pointer(surface, 'pointerdown');
    advance(32, 8);

    // 308 ms of true flight is BEFORE any crossing in the arsenal (0.38–0.47 s),
    // so the signed error must be NEGATIVE and of order −100 ms. Dividing would
    // hand the sim 0.68 s at 0.45 — hundreds of ms LATE, and there is no
    // tolerance that confuses the two.
    const m = /([+-]?\d+) ms/.exec(document.body.textContent ?? '');
    expect(m, 'no signed timing error on screen after the swing').toBeTruthy();
    const shownMs = Number(m![1]);
    expect(shownMs).toBeLessThan(-40);
    expect(shownMs).toBeGreaterThan(-400);
  }, 60000);
});
