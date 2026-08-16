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

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DerbyGame } from './DerbyGame';
import type { DerbyGameResult } from './DerbyGame';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';
import { DERBY_ROUNDS, PITCHES_PER_ROUND } from '../../lib/baseball/derbyRules';

/** Mirrors `DerbyGame`'s own lead-in. Not exported by it; kept in step by hand. */
const PITCH_LEAD_MS = 380;

vi.mock('../../lib/api', () => ({ api: { submitGameScore: vi.fn(async () => ({ ok: true })) } }));
vi.mock('../../lib/audio', () => ({ play: vi.fn(), unlockAudio: vi.fn() }));

// A hand-cranked clock + rAF pump. `performance.now` IS the play clock, so
// driving it directly is how a whole 24-pitch session runs in milliseconds.
let now = 0;
let frames: FrameRequestCallback[] = [];

beforeEach(() => {
  now = 0;
  frames = [];
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
