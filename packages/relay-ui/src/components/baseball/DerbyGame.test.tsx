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
//
// TWO MORE WERE WATCHED IN THE FOLLOW-UP REVIEW PASS, both of which the file
// PREVIOUSLY SURVIVED — each was a live surface with no assertion on it:
//
//   5. `TimingBar`'s contact band: `left: plateP − msToPct(contactMs)`
//      → `plateP + …`, i.e. the band drawn entirely on
//      the LATE side of the crossing                       → 1 fail
//   6. `DerbyGame`'s `contactWindowS(speed, sim.cfg.batSpeedMph)`
//      → `contactWindowS(speed)`                           → 1 fail
//
// ⚠ (6) ALSO FALSIFIED THE FIRST ASSERTION WRITTEN FOR IT.
// `expect(spy).toHaveBeenCalledWith(v, undefined)` MATCHES a one-argument call
// in vitest, so it passed the mutation it existed for. The arguments array's
// LENGTH is what separates `f(v)` from `f(v, undefined)`, and that is what the
// test asserts now — written down because the first version looked right.
//
// FOUR MORE WERE WATCHED TO FAIL in the M2 FEEL pass, when the payout stopped
// being home-run-only and the HUD gained a payout readout and two coaching
// surfaces. Observed against the whole 182-test baseball suite:
//
//   7. the HUD prints a payout on HOME RUNS only (M2's behaviour,
//      i.e. a 405 ft fly reads with no number on it)        → 2 fail
//   8. the contextual coaching line is never rendered        → 1 fail
//   9. the first-run tip never retires (a permanent nag)     → 1 fail
//  10. the first-run tip never shows at all                  → 1 fail
//
// ⚠ (8)–(10) NEEDED A HARNESS FIX BEFORE THEY COULD BE KILLED, and the harness
// gap was worth more than the mutations. `DerbyGame`'s readout comes from a
// `window.setInterval` poll at POLL_MS, and `advance()` only ever pumped
// `requestAnimationFrame` — so `readout` was FROZEN at its mount value in every
// test in this file and nothing depending on the poll could be asserted at all.
// The interval pump below is the fix; it was found by (9) reporting "the tip is
// still nagging" when the tip was correct and the harness could not see the poll
// that retires it.
//
// ⚠ (8) ALSO NEEDED A DIFFERENT SEED, and the reason is stated at the test. The
// coaching line only fires on an in-play ball with the carry to clear the gaps,
// and the pinned fixture seed produces ZERO of those in a session (measured over
// 30 consecutive seeds: 0–7 per session). An assertion left on a seed that
// cannot reach the branch is a test that passes for the wrong reason.
//
// TWO MORE IN THE REVIEW OF THAT PASS — both found by mutating the code rather
// than by reading it, and both had previously survived this file entirely:
//
//  11. `CountChip`'s Score cell: `state.score.toLocaleString()`
//      → `String(state.outs)`, i.e. the scoreboard showing the
//      out count. Was 0 fail; `CountChip` had no test file and
//      the only thing here that touched it was the LABEL
//      `getByText('Round')`                                  → 1 fail
//  12. `describeSwing`'s `inPlay` branch back to M2's numberless
//      `'In play — out'` / `'Off the wall'`. Was 0 fail HERE
//      (only `swingCopy.test.ts` fell), because
//      `kinds.size > 1` is satisfied by {GONE!, Foul ball} —
//      so the assertion whose stated purpose was "the HUD said
//      so for a 405 ft fly" never required the in-play line    → 2 fail
//
// (12) now fails twice over — the running scoreboard check stops matching at
// pitch 10 before the kinds check is reached — so it was re-run with the
// scoreboard assertions temporarily removed to confirm the kinds check bites on
// its own: "no IN-PLAY payout line all session; saw GONE!,Foul ball".

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { DerbyGame } from './DerbyGame';
import type { DerbyGameResult } from './DerbyGame';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';
import { vLen } from '../../lib/baseball/airPhysics';
import { DerbySim } from '../../lib/baseball/derbySim';
import { DERBY_ROUNDS, PITCHES_PER_ROUND } from '../../lib/baseball/derbyRules';
import { contactWindowS } from '../../lib/baseball/contactWindow';

/** Mirrors `DerbyGame`'s own lead-in. Not exported by it; kept in step by hand. */
const PITCH_LEAD_MS = 380;

/**
 * The wall interval that lands a tap on a ~0.41 s plate crossing AT THE CURRENT
 * TEMPO — i.e. "swing on the ball", expressed the only way that survives a knob
 * turn.
 *
 * ⚠ EVERY CALL SITE, NOT JUST THE ONES THAT SCORE. Three tests in this file
 * still carried the literal `745` — which is this expression evaluated at the
 * 0.55-era `PITCH_TEMPO` and is 166 ms early at 0.45. They passed anyway,
 * because a bank/abandon/replay test does not care WHICH outcome the swing
 * produced; that is precisely the trap the derived sites next to them were
 * written to warn about, so it is the same constant everywhere now.
 */
const SWING_WALL_MS = Math.round((0.41 / PITCH_TEMPO) * 1000);

const { submitSpy } = vi.hoisted(() => ({
  submitSpy: vi.fn(
    async (_body: { score: number; rounds: number; bestStreak: number; game: string }) => ({
      ok: true,
    }),
  ),
}));
vi.mock('../../lib/api', () => ({ api: { submitGameScore: submitSpy } }));
vi.mock('../../lib/audio', () => ({ play: vi.fn(), unlockAudio: vi.fn() }));

// ⚠ THE ONE WHITE-BOX SEAM IN THIS FILE, and it is here because the ARGUMENT is
// the thing that cannot be seen from outside. `DerbyGame` calls
// `contactWindowS(speed, sim.cfg.batSpeedMph)`, and `batSpeedMph` is `undefined`
// for every shipping config — so dropping the second argument changes NO pixel,
// no number and no test that reads the DOM. It would still be a real bug: the
// field is `DerbySim`'s bat-speed hook (the one every card/fatigue modulator
// reaches for, and `derbySim.test.ts` drives it at 130 mph), so the first config
// that sets it would draw a band from the published swing and be wrong by 6.5 ms
// with the widget's own header promising it never widens the window.
//
// The real function is kept — this wraps it, it does not replace it — so every
// other assertion in the file still runs against the sim's own arithmetic.
const windowSpy = vi.hoisted(() => vi.fn());
vi.mock('../../lib/baseball/contactWindow', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/baseball/contactWindow')>();
  return {
    ...mod,
    contactWindowS: (...args: Parameters<typeof mod.contactWindowS>) => {
      windowSpy(...args);
      return mod.contactWindowS(...args);
    },
  };
});

// A hand-cranked clock + rAF pump. `performance.now` IS the play clock, so
// driving it directly is how a whole 24-pitch session runs in milliseconds.
//
// ⚠ AND AN INTERVAL PUMP, WHICH THIS FILE DID NOT HAVE. `DerbyGame`'s readout —
// the counters `CountChip` shows and the condition that retires the first-run
// coaching tip — comes from a `window.setInterval` poll at POLL_MS, and the
// harness only ever drove `requestAnimationFrame`. So `readout` was frozen at
// its mount value in every test in this file, and NOTHING that depends on the
// poll could be asserted at all: a HUD counter wired to the wrong field would
// have read correctly here forever. Discovered by the coaching test below
// failing with "the tip is still nagging" — the tip was correct and the harness
// could not see the poll that retires it.
let now = 0;
let frames: FrameRequestCallback[] = [];
let intervals: { id: number; cb: () => void; period: number; due: number }[] = [];
let nextIntervalId = 1;

beforeEach(() => {
  now = 0;
  frames = [];
  intervals = [];
  nextIntervalId = 1;
  submitSpy.mockClear();
  windowSpy.mockClear();
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

const surface = () => document.querySelectorAll('div[style*="touch-action"]')[0] as HTMLElement;

function tap(el: HTMLElement) {
  act(() => {
    el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerId: 1 }));
  });
}

/**
 * One cell of the `CountChip` scoreboard, read out of the DOM: find the label
 * span, return the value span beside it. `CountChip.Cell` renders exactly
 * `<div><span>{k}</span><span>{v}</span></div>`.
 *
 * ⚠ THIS EXISTS BECAUSE THE SCOREBOARD WAS ASSERTED NOWHERE. `CountChip` has no
 * test file of its own, and the only thing in this file that touched it was
 * `getByText('Round')` — the static LABEL. Measured by the reviewer:
 * `v={state.score.toLocaleString()}` → `v={String(state.outs)}`, i.e. the Score
 * cell displaying the out count, failed **0 tests**. Every number the player
 * reads off the top of the screen was live surface with nothing on it.
 */
function chipCell(k: string): string {
  const label = [...document.querySelectorAll('span')].find((s) => s.textContent === k);
  expect(label, `no "${k}" cell on the CountChip`).toBeTruthy();
  const v = label!.nextElementSibling;
  expect(v, `the "${k}" cell has a label and no value`).toBeTruthy();
  return v!.textContent ?? '';
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

    // ⚠ DERIVED FROM THE KNOB. This was a literal 560 ms, which is 308 ms of
    // true flight at PITCH_TEMPO = 0.55 and 252 ms at 0.45 — so turning an
    // explicitly-labelled feel knob broke an assertion that was really about the
    // MULTIPLY. The true instant is what the test means; the wall interval that
    // reaches it is tempo's business.
    const TRUE_AFTER_RELEASE_S = 0.308;
    const WALL_AFTER_RELEASE_MS = Math.round((TRUE_AFTER_RELEASE_S / PITCH_TEMPO) * 1000);
    advance(PITCH_LEAD_MS + WALL_AFTER_RELEASE_MS, 4);
    tap(surface());
    advance(16, 8);

    const trueS = (WALL_AFTER_RELEASE_MS / 1000) * PITCH_TEMPO;
    // The served pitch's crossing time, read off the HUD's own error readout.
    const text = document.body.textContent ?? '';
    const m = /([+-]?\d+) ms/.exec(text);
    expect(m, `no signed timing error on screen; body was:\n${text}`).toBeTruthy();
    const shownMs = Number(m![1]);

    // 308 ms of true flight is BEFORE a ~410 ms crossing, so the error must be
    // NEGATIVE (early) and of order −100 ms. Divide instead of multiply and the
    // sim would be handed `wall / tempo` — 1.52 s at 0.45, i.e. +1100 ms late;
    // there is no tolerance that confuses the two.
    expect(trueS).toBeCloseTo(TRUE_AFTER_RELEASE_S, 2);
    expect(shownMs).toBeLessThan(0);
    expect(shownMs).toBeGreaterThan(-200);
    // And the frame granularity is the only slack: 4 ms of wall is 2.2 ms true.
    expect(Math.abs(shownMs)).toBeGreaterThan(50);
  });

  it('plays a whole session and reports a result, all from props', () => {
    let result: DerbyGameResult | null = null;
    const paidLines = new Set<string>();
    render(<DerbyGame seed={20260816} onFinish={(r) => (result = r)} />);

    // ⚠ THE SCOREBOARD IS CHECKED AGAINST THE PAYOUTS IT PRINTED. `readout` feeds
    // exactly two things — `<CountChip state={readout} />` and the first-run tip
    // — and the chip's five cells had NO DOM assertion anywhere in the suite. So
    // the running total below is accumulated from the HUD's own `+n` strings and
    // compared to the Score cell after every pitch, which ties two independent
    // surfaces together: a cell wired to the wrong field, a payout printed that
    // was never banked, or a bank that paid something the player was not shown
    // are all one failure now. It closes with `result.score`, i.e. the number the
    // leaderboard receives.
    let expectedScore = 0;
    let expectedHr = 0;

    const total = DERBY_ROUNDS * PITCHES_PER_ROUND;
    for (let i = 0; i < total; i++) {
      const btn = screen.queryByText('Pitch it in');
      expect(btn, `no Pitch button on pitch ${i + 1}`).toBeTruthy();
      // The AIM stage, before the pitch: round and pitch are the loop's own
      // arithmetic, so a chip cell reading the wrong counter is visible here.
      expect(chipCell('Round'), `Round cell on pitch ${i + 1}`).toBe(
        `${Math.floor(i / PITCHES_PER_ROUND) + 1}/${DERBY_ROUNDS}`,
      );
      expect(chipCell('Pitch'), `Pitch cell on pitch ${i + 1}`).toBe(
        `${(i % PITCHES_PER_ROUND) + 1}/${PITCHES_PER_ROUND}`,
      );
      act(() => btn!.click());
      // Tap at PITCH_LEAD_MS + the wall time a ~0.41 s crossing takes at the
      // CURRENT tempo, so most pitches in the mix land inside the ±26.4 ms
      // contact window and the HOME RUN path — contact, the camera cut, the
      // batted flight, the ExitVelo tag — is actually exercised. Tapping at a
      // fixed 700 ms was 25 ms early on every pitch and scored zero all
      // session, which passed while testing none of it; a fixed 745 was the
      // same trap one tempo change later, so it is DERIVED now.
      advance(PITCH_LEAD_MS + SWING_WALL_MS, 4);
      tap(surface());
      // ⚠ SAMPLE THE RESULT LINE WHILE IT IS UP. `RESULT_HOLD_MS` is 1500 and
      // the loop below runs 14 s, so by the time the session ends every string
      // this HUD printed is gone — which is how `describeSwing` could be
      // reverted to M2's numberless `'In play — out'` with the whole suite
      // green. The payout the player SEES is the deliverable of the feel pass,
      // so it is sampled rather than inferred from `result.score`.
      // The one result line this pitch printed — sampled, not counted, because
      // it is on screen for RESULT_HOLD_MS and the loop below sees it many times.
      let paid: number | null = null;
      let kind: string | null = null;
      for (let k = 0; k < 14000 / 48; k++) {
        advance(48, 48);
        const line = document.body.textContent ?? '';
        const m = /(GONE!|Off the wall|Caught|Foul ball)[^]{0,24}?\+(\d+)/.exec(line);
        if (m) {
          paidLines.add(`${m[1]}|${m[2]}`);
          kind = m[1]!;
          paid = Number(m[2]);
        }
      }
      if (kind === 'GONE!') expectedHr += 1;
      // Whiffs and takes print no `+n` and bank nothing, which is the same claim
      // from both ends: the chip must not move on them either.
      expectedScore += paid ?? 0;
      expect(chipCell('Score'), `Score cell after pitch ${i + 1}`).toBe(
        expectedScore.toLocaleString(),
      );
      expect(chipCell('HR'), `HR cell after pitch ${i + 1}`).toBe(String(expectedHr));
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
    // ⚠ AND THE HUD SAID SO ON SCREEN, for more than one KIND of swing. M2
    // printed a distance and a payout on a home run only; a 405 ft fly ball read
    // `'In play — out'`, which carries exactly as much information as
    // `'Swing and a miss'` for a ball the payout now pays 87 points for.
    const kinds = new Set([...paidLines].map((l) => l.split('|')[0]));
    expect([...paidLines].length, 'the HUD never printed a payout').toBeGreaterThan(0);
    expect(kinds.has('GONE!'), `home-run line missing; saw ${[...kinds]}`).toBe(true);
    // ⚠ AND SPECIFICALLY THE IN-PLAY LINE, not merely "more than one kind".
    // `kinds.size > 1` is satisfied by {GONE!, Foul ball} — so the assertion
    // whose whole stated purpose is "a 405 ft fly ball now reads with a number
    // on it" did not actually require the in-play line to render at all:
    // reverting `describeSwing`'s `inPlay` branch to M2's numberless text failed
    // `swingCopy.test.ts` and NOT this test. `Caught` and `Off the wall` are the
    // two spellings of that branch.
    expect(
      kinds.has('Caught') || kinds.has('Off the wall'),
      `no IN-PLAY payout line all session; saw ${[...kinds]}`,
    ).toBe(true);
    // ⚠ AND THE SCOREBOARD AGREES WITH THE LEADERBOARD. `expectedScore` was
    // accumulated from the `+n` strings the HUD printed and checked against the
    // Score cell after every pitch; this is the third corner of the same
    // triangle — what `onFinish` reports, i.e. what `bank()` submits.
    expect(r.score).toBe(expectedScore);
    expect(r.homeRuns).toBe(expectedHr);
    // eslint-disable-next-line no-console
    console.log(
      `\n[FIXTURE] a full ${DERBY_ROUNDS}×${PITCHES_PER_ROUND} derby, headless, no WebGL:\n` +
        `  score ${r.score}  HR ${r.homeRuns}  barrels ${r.barrels}  ` +
        `longest ${r.bestFt.toFixed(1)} ft  best streak ${r.bestStreak}\n`,
    );
  });

  it('⚠ the two COACHING surfaces reach the screen', () => {
    // ⚠ BOTH OF THESE WERE DELETABLE WITH THE WHOLE SUITE GREEN, which is the
    // classic shape of a HUD affordance nobody watched fail. They are the entire
    // "teach the shade" half of the M2 feel pass — the measured finding is that
    // dead centre is the WORST viable aim (54 % home runs against 96 % at
    // +0.2 ft) because it is the deepest wall in the park, and that nothing on
    // screen ever said so.
    //
    // ⚠ A DIFFERENT SEED FROM THE REST OF THE FILE, and the reason is stated
    // rather than hidden: the coaching line fires only on an in-play ball with
    // the carry to clear the gaps, and the pinned fixture seed 20260816 happens
    // to produce ZERO of those in a session (measured, over 30 consecutive
    // seeds: 0–7 per session). Picking a seed that reaches the branch is the
    // honest fix; leaving the assertion on a seed that cannot reach it is a
    // test that passes for the wrong reason.
    render(<DerbyGame seed={20260814} />);

    // (a) THE FIRST-RUN TIP is up before a pitch is thrown, and it quotes the
    //     PARK's own two numbers rather than a hard-coded pair.
    expect(screen.getByText(/400 ft to dead centre and 375 to the gaps/)).toBeTruthy();

    // (b) THE CONTEXTUAL LINE fires on a deep out during the session, and
    // (c) THE FIRST-RUN TIP RETIRES ITSELF once the player has hit one out —
    //     the charter's "must not become a permanent nag", enforced by a
    //     condition rather than promised in a comment. Both are sampled in one
    //     pass because both are transient: the result line holds for
    //     RESULT_HOLD_MS and the tip only exists in the AIM stage.
    let coached = 0;
    let homeRuns = 0;
    let tipBeforeFirstHr = 0;
    let tipAfterFirstHr = 0;
    for (let i = 0; i < DERBY_ROUNDS * PITCHES_PER_ROUND; i++) {
      const btn = screen.queryByText('Pitch it in');
      if (!btn) break;
      // The aim stage: is the first-run tip up? That is the question (c) asks,
      // and it has to be asked HERE because the tip is not rendered anywhere
      // else in the loop.
      if (screen.queryByText(/400 ft to dead centre/)) {
        if (homeRuns === 0) tipBeforeFirstHr++;
        else tipAfterFirstHr++;
      }
      act(() => btn.click());
      advance(PITCH_LEAD_MS + SWING_WALL_MS, 4);
      tap(surface());
      let sawHr = false;
      for (let k = 0; k < 14000 / 48; k++) {
        advance(48, 48);
        const line = document.body.textContent ?? '';
        if (line.includes('dead centre is the deep part')) coached++;
        if (line.includes('GONE!')) sawHr = true;
      }
      if (sawHr) homeRuns++;
    }
    expect(coached, 'the coaching line never rendered in a whole session').toBeGreaterThan(0);
    expect(homeRuns, 'no home run in this session — (c) would pass vacuously').toBeGreaterThan(0);
    expect(tipBeforeFirstHr, 'the tip was never up before the first home run').toBeGreaterThan(0);
    expect(tipAfterFirstHr, 'the tip is still nagging after a home run').toBe(0);
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
    advance(PITCH_LEAD_MS + SWING_WALL_MS - 108, 4);
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

    // Grabbed BEFORE this test makes any call of its own, so the entry read
    // below is unambiguously the HUD's.
    const hudCall = windowSpy.mock.calls[0];

    const mirror = new DerbySim({ seed: 20260816 });
    const pr = mirror.servePitch();
    // ⚠ BOTH ARGUMENTS, because `DerbyGame` passes both — see the spy above for
    // why the second one cannot be checked through the DOM. `derbySim.test.ts`
    // drives that parameter at 55 / 71.5 / 130 mph of bat; this states that the
    // HUD asks the CONFIG rather than assuming the published swing.
    const halfMs = contactWindowS(vLen(pr.plate.v), mirror.cfg.batSpeedMph) * 1000;
    // ⚠ THE ARITY IS THE ASSERTION, and `toHaveBeenCalledWith(v, undefined)` is
    // NOT — measured: it matches a one-argument call, so it passed the very
    // mutation it was written to catch. The arguments array is what distinguishes
    // `f(v)` from `f(v, undefined)`.
    expect(hudCall, 'DerbyGame never asked for a contact window').toBeTruthy();
    expect(hudCall).toHaveLength(2);
    expect(hudCall![0]).toBeCloseTo(vLen(pr.plate.v), 12);
    expect(hudCall![1]).toBe(mirror.cfg.batSpeedMph);
    // TimingBar's own span: the crossing plus a 14 % tail.
    const spanS = pr.flightTimeS * 1.14;
    const expectedPct = ((2 * halfMs) / 1000 / spanS) * 100;
    // Where the plate crossing itself falls on that span — the band is CENTRED
    // on it, which is the half of the geometry a width alone cannot see.
    const platePct = (pr.flightTimeS / spanS) * 100;

    // The contact band is the translucent-white one; the barrel band is the
    // green gradient and the marker is 4 px wide.
    const band = [...document.querySelectorAll<HTMLElement>('div[style*="position: absolute"]')].find(
      (el) => el.style.background === 'rgba(255, 255, 255, 0.16)',
    );
    expect(band, 'no contact band drawn').toBeTruthy();
    expect(Number.parseFloat(band!.style.width)).toBeCloseTo(expectedPct, 6);
    // ⚠ AND WHERE IT SITS, NOT JUST HOW WIDE IT IS. A width-only assertion let
    // `left: plateP − msToPct(contactMs)` be mutated to `plateP + …` with all 12
    // baseball tests still green — a correctly-sized band drawn ENTIRELY on the
    // late side of the crossing, i.e. the HUD telling the player to swing ~26 ms
    // late on every pitch. Since `left` now depends on `contactMs`, the sign of
    // that half-width is live surface.
    expect(Number.parseFloat(band!.style.left)).toBeCloseTo(platePct - expectedPct / 2, 6);
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
    advance(PITCH_LEAD_MS + SWING_WALL_MS, 4);
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
        advance(PITCH_LEAD_MS + SWING_WALL_MS, 4);
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
