// @vitest-environment jsdom
//
// THE MOUND'S TWO GESTURES, and the thing between them that the pure mapping
// test cannot reach: WHEN the mapping is sampled, and whether the player can see
// the result.
//
// ⚠ THIS FILE EXISTS BECAUSE THE LAST CONTROL FAILED AS A GRAMMAR, NOT AS MATH.
// `moundAim.test.ts` passed every assertion it made about the slingshot and the
// slingshot was still unplayable: the owner tapped, a tap was a zero-length
// pull, and every pitch went middle-middle. No test of a pure function can see
// that, because the defect was in which gesture produced which call. So the
// claims here are about the GESTURE and the SIGHT of it:
//
//   • a tap, on its own, aims where it landed — never at the centre;
//   • the chosen spot is MARKED before the sweep and STILL MARKED during it,
//     because the player times the release against a spot they can see;
//   • the two arms of the A/B genuinely differ, and differ only in sampling.
//
// ⚠ AND THE MARK'S POSITION IS READ AS A NUMBER, not as the presence of an
// element. A mark that renders at the wrong place is a mark that lies about the
// pitch, and "an element with this attribute exists" is exactly the assertion
// this repo has already watched a mutant walk through.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import type { PitchCommand } from '../../../lib/baseball/ai';
import { ZONE_BOTTOM_FT, ZONE_TOP_FT } from '../../../lib/baseball/zone';
import { MoundControl } from './MoundControl';
import { ZONE_HALF_H_PX, ZONE_HALF_W_PX, aimAtPoint, pointOfAim } from './moundAim';
import { saveMoundGesture } from './prefs';

const PANEL_W = 227;
const PANEL_H = 288;
const CX = 300;
const CY = 500;
const CENTRE_H = (ZONE_BOTTOM_FT + ZONE_TOP_FT) / 2;

beforeEach(() => {
  localStorage.clear();
  Element.prototype.setPointerCapture = () => undefined;
  Element.prototype.releasePointerCapture = () => undefined;
  // jsdom lays nothing out, so the panel's rect has to be stated or the mapping
  // collapses onto (0, 0). The panel is centred on (CX, CY).
  Element.prototype.getBoundingClientRect = () =>
    ({
      left: CX - PANEL_W / 2,
      top: CY - PANEL_H / 2,
      width: PANEL_W,
      height: PANEL_H,
      right: CX + PANEL_W / 2,
      bottom: CY + PANEL_H / 2,
      x: CX - PANEL_W / 2,
      y: CY - PANEL_H / 2,
      toJSON: () => ({}),
    }) as DOMRect;
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const surface = () => document.querySelector('[data-mound-surface]') as HTMLElement;
const markEl = () => document.querySelector('[data-mound-mark]') as HTMLElement | null;
const barEl = () => document.querySelector('[data-accuracy-marker]') as HTMLElement | null;

function pointer(el: HTMLElement, type: string, dx: number, dy: number) {
  act(() => {
    el.dispatchEvent(
      new PointerEvent(type, { bubbles: true, pointerId: 1, clientX: CX + dx, clientY: CY + dy }),
    );
  });
}

/**
 * The mark's offset from the panel centre, in px, read off the DOM.
 *
 * ⚠ IT PARSES THE `calc()` AND FAILS IF IT CANNOT. Returning 0 on no-match would
 * turn a marker that stopped being positioned at all into a marker that agrees
 * with the centre, and the centre is the exact wrong answer this slice removes.
 */
function markOffset(): { dxPx: number; dyPx: number } {
  const el = markEl();
  expect(el, 'no mark in the panel').toBeTruthy();
  const num = (v: string, axis: string) => {
    // jsdom normalises `calc(50% + -33px)` to `calc(50% - 33px)`, so the SIGN is
    // read from the operator, not from the number.
    const m = /calc\(50% ([+-]) ([\d.]+)px\)/.exec(v);
    expect(m, `the mark's ${axis} is not a positioned calc(): ${v}`).toBeTruthy();
    return Number(m![2]) * (m![1] === '-' ? -1 : 1);
  };
  return { dxPx: num(el!.style.left, 'left'), dyPx: num(el!.style.top, 'top') };
}

function mount(over: Partial<Parameters<typeof MoundControl>[0]> = {}) {
  const onAim = vi.fn();
  const onPitch = vi.fn<(c: PitchCommand) => void>();
  render(
    <MoundControl pitchId="ff" onSelect={vi.fn()} onAim={onAim} onPitch={onPitch} {...over} />,
  );
  return { onAim, onPitch };
}

describe('MoundControl — a tap is a location', () => {
  it('⚠ ONE TAP, OFF CENTRE, IS AN OFF-CENTRE PITCH — the reported bug', () => {
    const { onAim } = mount();
    // Upper-right of the panel: high, and inside to the duel's right-handed
    // batter (REPORT −x, the third-base side — `moundAim.test.ts` argues it).
    const DX = +50;
    const DY = -60;
    pointer(surface(), 'pointerdown', DX, DY);

    expect(onAim).toHaveBeenCalledTimes(1);
    const [x, h] = onAim.mock.calls[0]!;
    const want = aimAtPoint(DX, DY);
    expect(x).toBeCloseTo(want.x, 10);
    expect(h).toBeCloseTo(want.h, 10);
    // Said as baseball, because "x is −0.4" is not a claim anyone can check
    // against the complaint: HIGH, and INSIDE, and not the middle of anything.
    expect(h).toBeGreaterThan(CENTRE_H + 0.3);
    expect(x).toBeLessThan(-0.25);
    // ⚠ AND THE SLINGSHOT'S ANSWER WOULD HAVE BEEN THE CENTRE. A pull-based
    // control fed one `pointerdown` and no movement has a zero delta, so it aims
    // dead centre — the pitch the owner threw every time. Nail it down.
    expect(Math.hypot(x!, h! - CENTRE_H)).toBeGreaterThan(0.5);
  });

  it('the mark is visible BEFORE the sweep, where the tap landed', () => {
    mount();
    expect(markEl(), 'a mark before anything was placed').toBeNull();
    pointer(surface(), 'pointerdown', -40, 70);
    const want = pointOfAim(aimAtPoint(-40, 70));
    const got = markOffset();
    expect(got.dxPx).toBeCloseTo(want.dxPx, 6);
    expect(got.dyPx).toBeCloseTo(want.dyPx, 6);
    // …and it is drawn at the tap, which is only interesting because the mapping
    // in between is mirrored: the raw px and the drawn px are the same point.
    expect(got.dxPx).toBeCloseTo(-40, 6);
    expect(got.dyPx).toBeCloseTo(70, 6);
    // Nothing has been thrown yet: placing is not releasing.
    expect(barEl()).toBeNull();
  });

  it('⚠ AND IT IS STILL THERE THROUGH THE SWEEP, AT THE SAME PLACE', () => {
    // Half the reported defect was that the aim step looked like it did nothing.
    // The player times the release against the spot they chose, so the spot has
    // to survive the phase change — including the panel not sliding when the
    // chips change state, which a reflowing column would do.
    const { onPitch } = mount();
    pointer(surface(), 'pointerdown', 62, -33);
    const before = markOffset();
    pointer(surface(), 'pointerup', 62, -33);

    expect(barEl(), 'the sweep never armed').toBeTruthy();
    const during = markOffset();
    expect(during.dxPx).toBeCloseTo(before.dxPx, 10);
    expect(during.dyPx).toBeCloseTo(before.dyPx, 10);

    // And the command carries that same spot.
    act(() => barEl()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(onPitch).toHaveBeenCalledTimes(1);
    const cmd = onPitch.mock.calls[0]![0];
    const want = aimAtPoint(62, -33);
    expect(cmd.intentX).toBeCloseTo(want.x, 10);
    expect(cmd.intentH).toBeCloseTo(want.h, 10);
    expect(cmd.id).toBe('ff');
  });

  it('paused: no placement, no arming', () => {
    const { onAim } = mount({ paused: true });
    pointer(surface(), 'pointerdown', 30, 30);
    pointer(surface(), 'pointerup', 30, 30);
    expect(onAim).not.toHaveBeenCalled();
    expect(markEl()).toBeNull();
    expect(barEl()).toBeNull();
  });
});

describe('⚠ A/B — the switch selects a different gesture', () => {
  // TEMPORARY, and it goes when one arm does. `prefs.ts` carries the recipe.
  const DOWN: [number, number] = [-20, 40];
  const MOVED: [number, number] = [55, -70];

  it('`tap`: the finger may slide, and the aim stays where it went down', () => {
    saveMoundGesture('tap');
    const { onAim } = mount();
    pointer(surface(), 'pointerdown', ...DOWN);
    pointer(surface(), 'pointermove', ...MOVED);

    // ⚠ THE CALL COUNT IS THE ASSERTION. A tap samples ONCE. If `move` ever
    // stopped checking the gesture, this arm would silently become the other
    // one and every other test in this file would still pass.
    expect(onAim).toHaveBeenCalledTimes(1);
    const want = aimAtPoint(...DOWN);
    expect(onAim.mock.calls[0]![0]).toBeCloseTo(want.x, 10);
    const mark = markOffset();
    expect(mark.dxPx).toBeCloseTo(DOWN[0], 6);
    expect(mark.dyPx).toBeCloseTo(DOWN[1], 6);
  });

  it('`drag`: the mark follows the finger, and the lift locks it', () => {
    saveMoundGesture('drag');
    const { onAim, onPitch } = mount();
    pointer(surface(), 'pointerdown', ...DOWN);
    pointer(surface(), 'pointermove', ...MOVED);

    expect(onAim).toHaveBeenCalledTimes(2);
    const want = aimAtPoint(...MOVED);
    expect(onAim.mock.calls[1]![0]).toBeCloseTo(want.x, 10);
    expect(onAim.mock.calls[1]![1]).toBeCloseTo(want.h, 10);
    const mark = markOffset();
    expect(mark.dxPx).toBeCloseTo(MOVED[0], 6);
    expect(mark.dyPx).toBeCloseTo(MOVED[1], 6);

    // The two arms end at genuinely different pitches for the same gesture —
    // which is what makes this a comparison and not a preference about wording.
    expect(Math.abs(want.x - aimAtPoint(...DOWN).x)).toBeGreaterThan(0.5);

    pointer(surface(), 'pointerup', ...MOVED);
    act(() => barEl()!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })));
    expect(onPitch.mock.calls[0]![0].intentX).toBeCloseTo(want.x, 10);
  });

  it('the toggle flips the gesture inside the duel, and persists it', () => {
    saveMoundGesture('tap');
    const { onAim } = mount();
    act(() => screen.getByLabelText('Aim by drag').click());
    expect(localStorage.getItem('relay.bb.moundgesture')).toBe('drag');

    // …and the very next gesture is the OTHER one, with no remount in between.
    pointer(surface(), 'pointerdown', ...DOWN);
    pointer(surface(), 'pointermove', ...MOVED);
    expect(onAim).toHaveBeenCalledTimes(2);
    expect(onAim.mock.calls[1]![0]).toBeCloseTo(aimAtPoint(...MOVED).x, 10);
  });
});

describe('MoundControl — the panel is the zone, at the mapping’s scale', () => {
  it('the drawn box is the mapping’s own box', () => {
    // What the player taps and what the sim is told cannot disagree, and the one
    // way to keep that true is for the drawn rectangle to be sized from the same
    // constants the mapping divides by. A box drawn at some other size would put
    // its corner somewhere that is not the corner of the zone.
    mount();
    const zone = document.querySelector('[data-mound-zone]') as HTMLElement;
    expect(zone.style.width).toBe(`${2 * ZONE_HALF_W_PX}px`);
    expect(zone.style.height).toBe(`${2 * ZONE_HALF_H_PX}px`);
    // Tapping that corner is the corner of the CALLED zone — `moundAim.test.ts`
    // asserts the call; this asserts that the pixels the player aims at are it.
    const corner = aimAtPoint(ZONE_HALF_W_PX, -ZONE_HALF_H_PX);
    expect(corner.h).toBeCloseTo(ZONE_TOP_FT, 10);
  });
});
