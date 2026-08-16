// @vitest-environment jsdom
//
// THE FIXTURE PROOF. This suite exists to assert one property the charter owes
// the shared screenshot harness: **`DerbyGame` mounts and plays a whole session
// without the app shell and without WebGL.**
//
// A HUD that can only stand up inside <App> — with a router, a store, an
// authenticated session and a live GL context — is a HUD the visual gate cannot
// photograph, and golf is shaping the harness's fixture seam around what both
// games actually need. So the mount below passes NOTHING but props: no
// `<MemoryRouter>`, no store provider, no `<Suspense>` of its own, no canvas.
// `StadiumGL` is `lazy()`, so under a test that never flushes the import it
// simply never resolves and `apiRef` stays null for the whole run — which is the
// same state as a slow network, and the game has to work in it.
//
// It also pins the thing a type-check cannot see: `swing()` is called with TRUE
// PHYSICAL seconds, so a tap taken `x` ms of WALL clock after release must reach
// the sim as `x × PITCH_TEMPO` ms. Get the direction of that multiply wrong and
// every test still compiles, every table still prints, and every swing in the
// shipped game is a whiff.
//
// FOUR MUTATIONS WERE WATCHED TO FAIL in the M2c review pass — applied, this
// file plus `BaseballScreen.test.tsx` run, then reverted:
//
//   1. the unmount net reports `onFinish` again (the abandon
//      path and the natural finish back in one function)   → 3 fail
//   2. `swingNow`'s `trueS < 0` wind-up guard removed       → 1 fail
//   3. `ZoneReticle` latches `swungRef` on a REFUSED tap    → 1 fail
//   4. `TimingBar` back to a hand-copied CONTACT_MS = 26.4  → 1 fail
//
// (3) is the one that was not predicted. Ignoring a wind-up tap in `swingNow`
// left the pitch burned anyway, because the input surface had already latched
// its one-shot on the refusal — so `onSwing` now reports whether the game took
// the tap. "The guard is in the HUD" and "the pitch survives" turned out to be
// two claims, and only the second is the bug.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DerbyGame } from './DerbyGame';
import type { DerbyGameResult } from './DerbyGame';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';
import { vLen } from '../../lib/baseball/airPhysics';
import { DerbySim } from '../../lib/baseball/derbySim';
import { DERBY_ROUNDS, PITCHES_PER_ROUND, contactWindowS } from '../../lib/baseball/derbyRules';

/** Mirrors `DerbyGame`'s own lead-in. Not exported by it; kept in step by hand. */
const PITCH_LEAD_MS = 380;

const { submitSpy } = vi.hoisted(() => ({
  submitSpy: vi.fn(
    async (_body: { score: number; rounds: number; bestStreak: number; game: string }) => ({
      ok: true,
    }),
  ),
}));
vi.mock('../../lib/api', () => ({ api: { submitGameScore: submitSpy } }));
vi.mock('../../lib/audio', () => ({ play: vi.fn(), unlockAudio: vi.fn() }));

// A hand-cranked clock + rAF pump. `performance.now` IS the play clock, so
// driving it directly is how a whole 24-pitch session runs in milliseconds.
let now = 0;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  now = 0;
  frames = [];
  submitSpy.mockClear();
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
    frames.push(cb);
    return frames.length;
  });
  vi.stubGlobal('cancelAnimationFrame', () => undefined);
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
    const due = frames;
    frames = [];
    act(() => {
      for (const cb of due) cb(now);
    });
  }
}

const surface = () => document.querySelectorAll('div[style*="touch-action"]')[0] as HTMLElement;

function tap(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  });
}

describe('DerbyGame — the fixture seam', () => {
  it('mounts with props alone: no router, no store, no WebGL', () => {
    render(<DerbyGame seed={20260816} />);
    // The lazy scene never resolves here, so the Suspense fallback is what is
    // on screen — and the HUD is fully alive beside it.
    expect(screen.getByText('Building the park…')).toBeTruthy();
    expect(screen.getByText('Pitch it in')).toBeTruthy();
    expect(screen.getByText('Round')).toBeTruthy();
  });

  it('serves, and the play clock advances without the renderer', () => {
    render(<DerbyGame seed={20260816} />);
    act(() => screen.getByText('Pitch it in').click());
    expect(screen.queryByText('Pitch it in')).toBeNull();
    expect(screen.getByText('TAP TO SWING')).toBeTruthy();

    // Past release + the whole flight + the tail, with nobody swinging: the
    // loop must auto-take. If this hangs, the game waited for `apiRef`.
    advance(2000);
    expect(screen.getByText(/Took a strike|^Ball$/)).toBeTruthy();
  });

  it('⚠ a tap reaches the sim in TRUE PHYSICAL seconds, not wall seconds', () => {
    // The one arithmetic bug that no type and no printed table would catch.
    // Serve, wait a known WALL interval past release, tap, and read back the
    // timing error the SIM recorded. It must be the wall interval scaled by
    // PITCH_TEMPO — a multiply — measured against the plate crossing.
    render(<DerbyGame seed={20260816} />);
    act(() => screen.getByText('Pitch it in').click());

    const WALL_AFTER_RELEASE_MS = 560;
    advance(PITCH_LEAD_MS + WALL_AFTER_RELEASE_MS, 4);
    tap(surface());
    advance(16, 8);

    const trueS = (WALL_AFTER_RELEASE_MS / 1000) * PITCH_TEMPO;
    // The served pitch's crossing time, read off the HUD's own error readout.
    const text = document.body.textContent ?? '';
    const m = /([+-]?\d+) ms/.exec(text);
    expect(m, `no signed timing error on screen; body was:\n${text}`).toBeTruthy();
    const shownMs = Number(m![1]);

    // 560 ms of wall at tempo 0.55 is 308 ms of true flight — which is BEFORE a
    // ~410 ms crossing, so the error must be NEGATIVE (early) and of order
    // −100 ms. Divide instead of multiply and this would be 560/0.55 = 1018 ms,
    // i.e. +600 ms late; there is no tolerance that confuses the two.
    expect(trueS).toBeCloseTo(0.308, 3);
    expect(shownMs).toBeLessThan(0);
    expect(shownMs).toBeGreaterThan(-200);
    // And the frame granularity is the only slack: 4 ms of wall is 2.2 ms true.
    expect(Math.abs(shownMs)).toBeGreaterThan(50);
  });

  it('plays a whole session and reports a result, all from props', () => {
    let result: DerbyGameResult | null = null;
    render(<DerbyGame seed={20260816} onFinish={(r) => (result = r)} />);

    const total = DERBY_ROUNDS * PITCHES_PER_ROUND;
    for (let i = 0; i < total; i++) {
      const btn = screen.queryByText('Pitch it in');
      expect(btn, `no Pitch button on pitch ${i + 1}`).toBeTruthy();
      act(() => btn!.click());
      // Tap at PITCH_LEAD_MS + the wall time a ~0.41 s crossing takes at tempo
      // 0.55 (745 ms), so most pitches in the mix land inside the ±26.4 ms
      // contact window and the HOME RUN path — contact, the camera cut, the
      // batted flight, the ExitVelo tag — is actually exercised. Tapping at a
      // fixed 700 ms was 25 ms early on every pitch and scored zero all
      // session, which passed while testing none of it.
      advance(PITCH_LEAD_MS + 745, 4);
      tap(surface());
      advance(14000, 48);
    }

    expect(result).not.toBeNull();
    const r = result as unknown as DerbyGameResult;
    expect(r.roundsPlayed).toBe(DERBY_ROUNDS);
    expect(r.score).toBeGreaterThanOrEqual(0);
    expect(r.bestStreak).toBeGreaterThanOrEqual(0);
    // ⚠ TEETH. Without this the suite passes on a session of 24 whiffs, i.e.
    // having never once run `commit`'s contact branch, the camera cut or the
    // batted-flight hand-off — which is most of what this file is here to hold.
    expect(r.homeRuns).toBeGreaterThan(0);
    expect(r.score).toBeGreaterThan(0);
    expect(r.bestFt).toBeGreaterThan(300);
    // eslint-disable-next-line no-console
    console.log(
      `\n[FIXTURE] a full ${DERBY_ROUNDS}×${PITCHES_PER_ROUND} derby, headless, no WebGL:\n` +
        `  score ${r.score}  HR ${r.homeRuns}  barrels ${r.barrels}  ` +
        `longest ${r.bestFt.toFixed(1)} ft  best streak ${r.bestStreak}\n`,
    );
  });

  it('⚠ a tap during the WIND-UP is not a swing', () => {
    // `serve()` sets stage 'flight' immediately, but the play clock is negative
    // until PITCH_LEAD_MS and the ball is not drawn. Guarding on the stage alone
    // let a tap 100 ms into the wind-up be clamped to t = 0 and resolved as a
    // ~456 ms EARLY whiff against a ball still in the pitcher's hand — burning
    // the pitch. Reachable by a plain double-tap on "Pitch it in": that button
    // unmounts on serve and ZoneReticle's full-bleed layer is live underneath.
    //
    // ⚠ THE SECOND HALF OF THIS TEST IS THE HALF THAT FOUND SOMETHING. Ignoring
    // the tap in `swingNow` was not enough on its own: `ZoneReticle`'s
    // `swungRef` is a one-shot per flight, so the refused tap still LATCHED the
    // input surface and the real swing 1 s later never arrived — the pitch was
    // burned by a different mechanism, with the auto-take firing at the tail.
    // `onSwing` now returns whether the game took the tap, and the surface
    // latches only on a yes. Written down because "the guard is in the HUD" and
    // "the pitch is not burned" are two claims and only the second is the bug.
    render(<DerbyGame seed={20260816} />);
    act(() => screen.getByText('Pitch it in').click());

    advance(100, 4);
    tap(surface());
    advance(8, 4);
    // Nothing resolved: no signed error, and the sweep is still running.
    expect(document.body.textContent).toContain('TAP TO SWING');
    expect(/[+-]?\d+ ms (LATE|EARLY)/.test(document.body.textContent ?? '')).toBe(false);

    // …and the pitch is NOT burned — the same tap after release still swings.
    advance(PITCH_LEAD_MS + 745 - 108, 4);
    tap(surface());
    advance(16, 8);
    expect(/[+-]?\d+ ms/.test(document.body.textContent ?? '')).toBe(true);
  });

  it('⚠ the drawn contact band IS the sim\'s window, not a copy of it', () => {
    // `TimingBar` used to paint `const CONTACT_MS = 26.4`, a number that existed
    // in `lib/baseball` only as a `console.log` in `derbySim.test.ts`. Its own
    // header promised "nothing here may widen it; it is drawn, not set" and
    // nothing enforced that. This is the enforcement: mirror the served pitch
    // with a second sim on the same seed, derive the window from it, and read
    // the band's width straight out of the DOM.
    render(<DerbyGame seed={20260816} />);
    act(() => screen.getByText('Pitch it in').click());

    const mirror = new DerbySim({ seed: 20260816 });
    const pr = mirror.servePitch();
    const halfMs = contactWindowS(vLen(pr.plate.v)) * 1000;
    // TimingBar's own span: the crossing plus a 14 % tail.
    const spanS = pr.flightTimeS * 1.14;
    const expectedPct = ((2 * halfMs) / 1000 / spanS) * 100;

    // The contact band is the translucent-white one; the barrel band is the
    // green gradient and the marker is 4 px wide.
    const band = [...document.querySelectorAll<HTMLElement>('div[style*="position: absolute"]')].find(
      (el) => el.style.background === 'rgba(255, 255, 255, 0.16)',
    );
    expect(band, 'no contact band drawn').toBeTruthy();
    expect(Number.parseFloat(band!.style.width)).toBeCloseTo(expectedPct, 6);
    // …and it is not the old constant. 26.4 ms was seed 7's fastball; this pitch
    // is a different row of the mix, so a hard-coded band would be visibly wrong.
    expect(Math.abs(halfMs - 26.4)).toBeGreaterThan(0.05);
  });

  it('⚠ unmounting mid-session BANKS the run and does NOT report a finish', () => {
    // The abandon path. Golf's nets bank directly and never call back into the
    // parent ("No setState here — the whole route may be unmounting"); this file
    // funnelled both paths through one `finish()`, so walking out of a derby
    // told the parent the session was OVER. `BaseballScreen.test.tsx` measures
    // what that did to the player; this is the unit-level statement of it.
    let finished = 0;
    const { unmount } = render(<DerbyGame seed={20260816} onFinish={() => (finished += 1)} />);
    act(() => screen.getByText('Pitch it in').click());
    advance(PITCH_LEAD_MS + 745, 4);
    tap(surface());
    advance(14000, 48);

    unmount();
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect(submitSpy.mock.calls[0]![0].rounds).toBe(1);
    expect(finished).toBe(0);
  });

  it('a session with NO pitch thrown banks nothing at all', () => {
    // The other half of the net's guard, and the reason it is not simply "always
    // submit on unmount": opening the derby and backing straight out is not a
    // score of zero, it is not a game.
    let finished = 0;
    const { unmount } = render(<DerbyGame seed={20260816} onFinish={() => (finished += 1)} />);
    unmount();
    expect(submitSpy).not.toHaveBeenCalled();
    expect(finished).toBe(0);
  });

  it('the same seed replays the same session through the HUD', () => {
    const run = () => {
      let result: DerbyGameResult | null = null;
      render(<DerbyGame seed={4242} onFinish={(r) => (result = r)} />);
      for (let i = 0; i < DERBY_ROUNDS * PITCHES_PER_ROUND; i++) {
        act(() => screen.getByText('Pitch it in').click());
        advance(PITCH_LEAD_MS + 745, 4);
        tap(surface());
        advance(14000, 48);
      }
      cleanup();
      return result as unknown as DerbyGameResult;
    };
    const a = run();
    now = 0;
    frames = [];
    const b = run();
    expect(b).toEqual(a);
  });
});
