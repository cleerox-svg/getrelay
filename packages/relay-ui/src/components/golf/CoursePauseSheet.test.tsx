// @vitest-environment jsdom
//
// PAUSING A COURSE ROUND, AND NOT LOSING IT.
//
// Two independent failures are pinned here, because they are the two ways a
// paused round can still be destroyed:
//
//  1. A PAUSE THAT DOESN'T PAUSE. `CourseGame` drives two clocks it does not own
//     — `CourseGL`'s fixed-step loop (`sim.substep`) and `AccuracyBar`'s tap
//     -timing sweep. Freezing only the first looks completely correct on screen
//     (the ball is still, the sheet is up) and then fires a RANDOM-timed shot the
//     instant the player resumes, because the marker never stopped sweeping. So
//     the sweep is asserted by watching the marker actually stop moving, not by
//     checking that a prop was passed.
//  2. A PARTIAL ROUND THROWN AWAY. `card` is component state; before this change
//     walking off hole 7 of 9 discarded six carded holes in silence, while
//     `GolfGame` and `RangeGame` both banked a partial run on unmount. The report
//     must carry SIX holes — not seven (the hole in progress was never carded)
//     and not zero.
//
// ⚠ WHY THE SIM-FREEZE ASSERTION HAS TWO HALVES. `CourseGL` needs WebGL, so it is
// mocked, which means nothing in this environment calls `sim.substep` at all — a
// test that only watched the ball would pass with the pause deleted entirely.
// What `CourseGame` actually owns is "hand `paused` to the component that owns the
// loop", so that is asserted directly off the recorded props; the OTHER half — "…
// and that flag really does stop the integrator" — is asserted by READING
// `CourseGL.tsx` rather than importing it, so the invariant cannot agree with a
// broken implementation by construction.
//
// NINE MUTATIONS WERE WATCHED TO FAIL against this file (counts are failures in
// THIS file; (5) additionally fails 2 in CourseGame.test.tsx):
//   1. `<AccuracyBar paused={paused}>` → `<AccuracyBar>`            → 1 fail
//   2. `paused={armed || st.holed || paused}` → `armed || st.holed` → 1 fail
//   3. `reportCard` drops its `c.length < 1` guard                  → 1 fail
//   4. `reportCard` drops the `roundReportedRef` one-shot           → 2 fail
//   5. `reportCard` reports `c.length + 1` holes                    → 4 fail
//   6. the unmount safety net deleted                              → 1 fail
//   7. the unmount net reads `card` instead of `cardRef.current`    → 1 fail
//   8. CourseGL's `if (!pausedRef.current)` guard deleted           → 1 fail
//   9. the pause sheet's in-progress row labelled as a carded row   → 2 fail

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import CourseGame from './CourseGame';
import { endRoundNote } from './CoursePauseSheet';
import { getCourse, type GolfCourse } from '../../lib/golf/courses';

// Forced sim state, by hole id: `holedAt` holes the ball out in N strokes,
// `strokesAt` puts N strokes on a hole still being played.
const holedAt = new Map<number, number>();
const strokesAt = new Map<number, number>();

// Every render of the (mocked) scene, so the test can read the `paused` flag
// CourseGame handed the component that owns the sim loop, and grab the live sim.
interface GlRender {
  paused?: boolean;
  onArm?: () => void;
  sim: { fireArmed: (e: number) => void };
}
const glRenders = vi.hoisted(() => [] as GlRender[]);

vi.mock('./CourseGL', () => ({
  default: (p: GlRender) => {
    glRenders.push(p);
    return null;
  },
}));

vi.mock('../../lib/golf/courseSim', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/golf/courseSim')>();
  class TestSim extends mod.CourseSim {
    override getState(): import('../../lib/golf/courseSim').CourseState {
      const s = super.getState();
      const holed = holedAt.get(this.hole.id);
      if (holed != null) return { ...s, holed: true, strokes: holed };
      const strokes = strokesAt.get(this.hole.id);
      return strokes == null ? s : { ...s, strokes };
    }
  }
  return { ...mod, CourseSim: TestSim };
});

const getRecordsSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    records: { longestDrive: null, closestToPin: null, longestPutt: null },
  })),
);
const postRecordsSpy = vi.hoisted(() =>
  vi.fn(async () => ({
    records: { longestDrive: null, closestToPin: null, longestPutt: null },
    improved: { longestDrive: false, closestToPin: false, longestPutt: false },
  })),
);
vi.mock('../../lib/api', () => ({
  api: { getGolfRecords: getRecordsSpy, postGolfRecords: postRecordsSpy },
}));

/** A round of `n` real Augusta holes, so every hole is real terrain data. */
function courseOf(n: number): GolfCourse {
  const src = getCourse('augusta');
  const holes = src.holes.slice(0, n);
  return {
    id: `test-${n}`,
    name: 'Test Course',
    holes,
    par: holes.reduce((a, h) => a + h.par, 0),
    yards: holes.reduce((a, h) => a + h.yards, 0),
  };
}

// CourseGame reads the sim through a 120 ms setInterval poll, so nothing the sim
// says reaches the DOM (or the effects) until the poll ticks. The poll is STOPPED
// while paused, which is itself part of the contract.
const POLL_MS = 120;
function poll(times = 2) {
  for (let i = 0; i < times; i++) act(() => void vi.advanceTimersByTime(POLL_MS));
}

/** Hole out the first `n` holes in `strokes` each, advancing between them. */
function playHoles(course: GolfCourse, n: number, strokes: (i: number) => number) {
  for (let i = 0; i < n; i++) {
    holedAt.set(course.holes[i]!.id, strokes(i));
    poll();
    act(() => screen.getByText('Next hole').click());
  }
}

const marker = () => document.querySelector('[data-accuracy-marker]') as HTMLElement | null;
const lastGl = () => glRenders[glRenders.length - 1]!;

// The 3D scene is lazy() imported so `three` stays out of the main chunk, which
// means even the MOCKED module resolves a microtask after the first render (the
// Suspense fallback renders first). Flush that before reading anything the scene
// was handed — otherwise the assertions silently depend on an earlier test in the
// file having warmed the module cache.
async function settle() {
  await act(async () => {});
}

beforeEach(() => {
  holedAt.clear();
  strokesAt.clear();
  glRenders.length = 0;
  getRecordsSpy.mockClear();
  postRecordsSpy.mockClear();
  // requestAnimationFrame/performance are NOT in vitest's default toFake set, and
  // the accuracy sweep runs on both — without them the marker would be driven by
  // jsdom's real 16 ms timer and the sweep could not be observed deterministically.
  vi.useFakeTimers({
    toFake: [
      'setTimeout',
      'clearTimeout',
      'setInterval',
      'clearInterval',
      'Date',
      'performance',
      'requestAnimationFrame',
      'cancelAnimationFrame',
    ],
  });
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CourseGame — paused freezes the round', () => {
  it('stops the accuracy sweep dead, and lets it continue from where it stopped', async () => {
    const course = courseOf(9);
    const el = (paused: boolean) => <CourseGame course={course} seed={7} paused={paused} />;
    const { rerender } = render(el(false));
    await settle();
    poll();

    // Arm a shot: the scene raises onArm when the slingshot is released, which is
    // what mounts the strike beat.
    act(() => lastGl().onArm!());
    expect(marker()).toBeTruthy();

    // Playing: the marker sweeps.
    act(() => void vi.advanceTimersByTime(300));
    const running = marker()!.style.left;
    act(() => void vi.advanceTimersByTime(300));
    const laterWhilePlaying = marker()!.style.left;
    expect(laterWhilePlaying).not.toBe(running);

    // Paused: it must not move — a marker still sweeping behind the sheet fires a
    // random-timed shot on resume.
    act(() => rerender(el(true)));
    const atPause = marker()!.style.left;
    act(() => void vi.advanceTimersByTime(2000));
    expect(marker()!.style.left).toBe(atPause);

    // …and a tap while paused must not fire the armed shot either.
    const fired = vi.spyOn(lastGl().sim, 'fireArmed');
    fireEvent.pointerDown(screen.getByText('Tap to strike').parentElement!.parentElement!);
    expect(fired).not.toHaveBeenCalled();

    // Resumed: it moves again, from where it stopped (the phase persisted).
    act(() => rerender(el(false)));
    act(() => void vi.advanceTimersByTime(300));
    expect(marker()!.style.left).not.toBe(atPause);
  });

  it('hands `paused` to the component that owns the sim loop, and takes it back', async () => {
    const course = courseOf(9);
    const el = (paused: boolean) => <CourseGame course={course} seed={7} paused={paused} />;
    const { rerender } = render(el(false));
    await settle();
    poll();
    expect(lastGl().paused).toBe(false);

    act(() => rerender(el(true)));
    expect(lastGl().paused).toBe(true);

    act(() => rerender(el(false)));
    expect(lastGl().paused).toBe(false);
  });

  // ⚠ THE OTHER HALF OF THE SIM-FREEZE PROOF, and deliberately written by READING
  // the scene rather than importing it: an assertion that imported CourseGL could
  // only ever agree with whatever CourseGL does. If the integrator ever steps
  // outside this guard, the flag above becomes decorative and this fails.
  it('CourseGL steps the sim ONLY inside its `paused` guard', () => {
    const src = readFileSync(path.join(__dirname, 'CourseGL.tsx'), 'utf8');

    // The prop is what feeds the ref the loop reads.
    expect(src).toContain('pausedRef.current = paused;');

    const calls = [...src.matchAll(/sim\.substep\(/g)].map((m) => m.index!);
    expect(calls, 'the fixed-step integrator should have exactly one call site').toHaveLength(1);

    const guard = src.lastIndexOf('if (!pausedRef.current) {', calls[0]!);
    expect(guard, 'no `if (!pausedRef.current) {` precedes sim.substep()').toBeGreaterThan(-1);

    // Walk braces from the guard and check the call lands before it closes.
    let depth = 0;
    let close = -1;
    for (let i = src.indexOf('{', guard); i < src.length; i++) {
      if (src[i] === '{') depth++;
      else if (src[i] === '}') {
        depth--;
        if (depth === 0) {
          close = i;
          break;
        }
      }
    }
    expect(close).toBeGreaterThan(calls[0]!);
  });
});

describe('CourseGame — the pause sheet', () => {
  it('shows the carded holes plus a DIM row for the hole in progress', () => {
    const course = courseOf(9);
    const el = (paused: boolean) => <CourseGame course={course} seed={7} paused={paused} />;
    const { rerender } = render(el(false));

    playHoles(course, 6, (i) => 4 + (i % 2));
    strokesAt.set(course.holes[6]!.id, 3);
    poll();
    act(() => rerender(el(true)));

    // Six carded rows — and the seventh hole is NOT one of them.
    expect(screen.getAllByLabelText(/^Hole \d+$/)).toHaveLength(6);
    expect(screen.getByLabelText(`Hole ${course.holes[6]!.id} in progress`)).toBeTruthy();
    expect(screen.getByText('in play')).toBeTruthy();
    // The card's own total, off the six holes only.
    const strokes = 4 + 5 + 4 + 5 + 4 + 5;
    const par = course.holes.slice(0, 6).reduce((a, h) => a + h.par, 0);
    expect(screen.getByText(`${strokes}`)).toBeTruthy();
    expect(screen.getByText(`(+${strokes - par})`)).toBeTruthy();
  });

  it('Resume returns to play with the card intact', () => {
    const course = courseOf(9);
    const onResume = vi.fn();
    const onRoundComplete = vi.fn();
    const el = (paused: boolean) => (
      <CourseGame
        course={course}
        seed={7}
        paused={paused}
        onResume={onResume}
        onRoundComplete={onRoundComplete}
      />
    );
    const { rerender } = render(el(false));

    playHoles(course, 2, () => 5);
    poll();
    act(() => rerender(el(true)));
    expect(screen.getByText('Resume')).toBeTruthy();

    act(() => screen.getByText('Resume').click());
    expect(onResume).toHaveBeenCalledTimes(1);
    // The owner clears `paused`; the sheet goes, the round is still there and
    // nothing was reported.
    act(() => rerender(el(false)));
    expect(screen.queryByText('Resume')).toBeNull();
    poll();
    const thruPar = course.holes.slice(0, 2).reduce((a, h) => a + h.par, 0);
    expect(screen.getByText(`Thru 2 · +${10 - thruPar}`)).toBeTruthy();
    expect(onRoundComplete).not.toHaveBeenCalled();

    // Pause again: the same two holes are still carded.
    act(() => rerender(el(true)));
    expect(screen.getAllByLabelText(/^Hole \d+$/)).toHaveLength(2);
  });

  it('says what "End round" costs, truthfully', () => {
    const course = courseOf(9);
    const el = (paused: boolean) => <CourseGame course={course} seed={7} paused={paused} />;
    const { rerender } = render(el(false));

    playHoles(course, 6, () => 4);
    strokesAt.set(course.holes[6]!.id, 3);
    poll();
    act(() => rerender(el(true)));

    expect(
      screen.getByText(`Banks 6 holes · hole ${course.holes[6]!.id} (3 strokes) won't count`),
    ).toBeTruthy();
  });

  it('notes exactly what it will bank — including nothing', () => {
    // Pure, so it is asserted directly rather than through six rendered holes.
    expect(endRoundNote({ banked: 0, inProgress: { hole: 1, par: 4, strokes: 1 } })).toBe(
      "Nothing to bank yet · hole 1 (1 stroke) won't count",
    );
    expect(endRoundNote({ banked: 1, inProgress: { hole: 2, par: 5, strokes: 0 } })).toBe(
      "Banks 1 hole · hole 2 (0 strokes) won't count",
    );
    expect(endRoundNote({ banked: 6, inProgress: { hole: 7, par: 4, strokes: 3 } })).toBe(
      "Banks 6 holes · hole 7 (3 strokes) won't count",
    );
    // No hole in progress (paused on top of the hole-out card): the "won't count"
    // clause MUST go — hole 9 just did count.
    expect(endRoundNote({ banked: 9 })).toBe('Banks 9 holes');
  });

  it('claims nothing about a hole that is already carded', () => {
    const course = courseOf(2);
    const el = (paused: boolean) => <CourseGame course={course} seed={7} paused={paused} />;
    const { rerender } = render(el(false));

    // Hole 1 holed and carded, still standing on the hole-out card.
    holedAt.set(course.holes[0]!.id, 4);
    poll();
    act(() => rerender(el(true)));

    expect(screen.getByText('Banks 1 hole')).toBeTruthy();
    expect(screen.queryByText('in play')).toBeNull();
    expect(screen.getAllByLabelText(/^Hole \d+$/)).toHaveLength(1);
  });
});

describe('CourseGame — a partial round is banked, not discarded', () => {
  it('ending at hole 7 of 9 banks SIX holes, and not the hole in progress', () => {
    const course = courseOf(9);
    const onRoundComplete = vi.fn();
    const onExit = vi.fn();
    const el = (paused: boolean) => (
      <CourseGame
        course={course}
        seed={7}
        paused={paused}
        onRoundComplete={onRoundComplete}
        onExit={onExit}
      />
    );
    const { rerender } = render(el(false));

    playHoles(course, 6, () => 5);
    strokesAt.set(course.holes[6]!.id, 3);
    poll();
    expect(onRoundComplete).not.toHaveBeenCalled();

    act(() => rerender(el(true)));
    act(() => screen.getByText('End round').click());

    const par = course.holes.slice(0, 6).reduce((a, h) => a + h.par, 0);
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
    expect(onRoundComplete).toHaveBeenCalledWith({
      courseId: course.id,
      holes: 6,
      strokes: 30, // 6 × 5 — the 3 strokes on hole 7 are NOT in it
      par,
      toPar: 30 - par,
    });
    // And it leaves through the same door the header back button uses.
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('banks the partial round when the screen is simply unmounted mid-round', () => {
    const course = courseOf(9);
    const onRoundComplete = vi.fn();
    const { unmount } = render(
      <CourseGame course={course} seed={7} onRoundComplete={onRoundComplete} />,
    );

    playHoles(course, 3, () => 6);
    strokesAt.set(course.holes[3]!.id, 2);
    poll();
    expect(onRoundComplete).not.toHaveBeenCalled();

    // A route change / tab switch / the second back press while paused.
    act(() => unmount());
    const par = course.holes.slice(0, 3).reduce((a, h) => a + h.par, 0);
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
    expect(onRoundComplete).toHaveBeenCalledWith({
      courseId: course.id,
      holes: 3,
      strokes: 18,
      par,
      toPar: 18 - par,
    });
  });

  it('never reports a 0-hole round', () => {
    const course = courseOf(9);
    const onRoundComplete = vi.fn();
    const el = (paused: boolean) => (
      <CourseGame course={course} seed={7} paused={paused} onRoundComplete={onRoundComplete} />
    );
    const { rerender, unmount } = render(el(false));
    poll();

    act(() => rerender(el(true)));
    expect(screen.getByText(/Nothing to bank yet/)).toBeTruthy();
    act(() => screen.getByText('End round').click());
    act(() => unmount());
    expect(onRoundComplete).not.toHaveBeenCalled();
  });

  it('a partial report and a FULL report can never both fire', () => {
    const course = courseOf(2);
    const onRoundComplete = vi.fn();
    const el = (paused: boolean) => (
      <CourseGame course={course} seed={7} paused={paused} onRoundComplete={onRoundComplete} />
    );
    const { rerender, unmount } = render(el(false));

    // Hole 1 carded, hole 2 in progress → end the round: a 1-hole partial.
    playHoles(course, 1, () => 4);
    poll();
    act(() => rerender(el(true)));
    act(() => screen.getByText('End round').click());
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
    expect(onRoundComplete).toHaveBeenLastCalledWith(expect.objectContaining({ holes: 1 }));

    // Now finish hole 2 anyway (the owner had not torn the screen down yet). The
    // FULL-round report must NOT also fire: one round, one row.
    act(() => rerender(el(false)));
    holedAt.set(course.holes[1]!.id, 4);
    poll();
    act(() => unmount());
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it('a completed round is not re-reported by the pause sheet or the unmount net', () => {
    const course = courseOf(2);
    const onRoundComplete = vi.fn();
    const el = (paused: boolean) => (
      <CourseGame course={course} seed={7} paused={paused} onRoundComplete={onRoundComplete} />
    );
    const { rerender, unmount } = render(el(false));

    playHoles(course, 1, () => 4);
    holedAt.set(course.holes[1]!.id, 5);
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
    expect(onRoundComplete).toHaveBeenLastCalledWith(
      expect.objectContaining({ holes: 2, strokes: 9 }),
    );

    act(() => rerender(el(true)));
    act(() => screen.getByText('End round').click());
    act(() => unmount());
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it('single-hole play banks nothing — that path is onHoleComplete', () => {
    const course = courseOf(9);
    const onRoundComplete = vi.fn();
    const onHoleComplete = vi.fn();
    const el = (paused: boolean) => (
      <CourseGame
        course={course}
        startHole={2}
        seed={7}
        paused={paused}
        onRoundComplete={onRoundComplete}
        onHoleComplete={onHoleComplete}
      />
    );
    const { rerender, unmount } = render(el(false));
    strokesAt.set(course.holes[2]!.id, 2);
    poll();

    act(() => rerender(el(true)));
    act(() => screen.getByText('End round').click());
    act(() => unmount());
    expect(onRoundComplete).not.toHaveBeenCalled();
    expect(onHoleComplete).not.toHaveBeenCalled();
  });
});
