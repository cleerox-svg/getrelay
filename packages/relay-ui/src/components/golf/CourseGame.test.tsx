// @vitest-environment jsdom
//
// THE ROUND MUST BE REPORTED BY THE GAME, NOT BY A BUTTON.
//
// `onRoundComplete` is the only channel by which a finished full round reaches
// the outside world: `GolfScreen` turns it into a `golfcourse` leaderboard row,
// and `GolfTournaments` turns it into the POST that keeps a player's event entry
// alive. It used to fire from inside `revealScorecard()`, i.e. only if the player
// pressed "See scorecard" — while the button immediately beside it ("Menu", same
// card, near-equal visual weight) called `onExit` straight through. Tapping the
// more innocuous-looking of the two silently destroyed the whole round: no row,
// no acknowledgement, no error, and in a tournament no entry.
//
// So the assertions below are deliberately phrased around the ORDER of events:
// the report must already have happened by the time either button exists, and
// pressing either one afterwards must not produce a second.
//
// HOW THIS DRIVES A HOLE-OUT. `CourseSim` is subclassed, not replaced — the real
// terrain, the real ball and the real `getState()` all still run, and the test
// only forces `holed`/`strokes` for a nominated hole id. Actually holing a putt
// takes a sequence of pointer drags through a WebGL scene the HUD does not own,
// which would make this a rendering test; what the HUD owns is "when the sim says
// the last hole is done, report it", and that is what is pinned.
//
// FOUR MUTATIONS WERE WATCHED TO FAIL against this file, and one to SURVIVE:
//
//   1. the report moved back inside `revealScorecard()`,
//      i.e. the shipped bug restored                          → 4 fail
//   2. the report effect drops its `roundReportedRef` guard    → 1 fail
//   3. `card.length < course.holes.length` → `card.length < 1`,
//      i.e. reporting on the FIRST hole-out of the round       → 2 fail
//   4. the report moved INTO the carding effect, reading the
//      pre-`setCard` array                                    → 2 fail
//   5. the effect's `single` guard removed                    → 0 fail
//
// ⚠ (2) FAILED ONLY AFTER A TEST WAS ADDED FOR IT. Every assertion written first
// passed the guard's deletion, because `card` stops changing once the round is
// over and the effect simply never runs twice. The bug is real anyway —
// `onRoundComplete` is in the dep array and every caller passes an inline arrow —
// so the parent-re-render test below exists specifically to kill it (3 reports).
//
// ⚠ (4) IS THE REASON THE TOTALS ARE ASSERTED AND NOT JUST THE CALL COUNT. The
// obvious first version of this fix fires inside the carding effect, where `card`
// is still the PREVIOUS render's array — so it reports a round missing the final
// hole's strokes (`holes: 1, strokes: 4` for a played 2-hole round), calls
// exactly once, and passes any test that only counts calls.
//
// ⚠ (5) SURVIVES BY DESIGN, AND THAT IS RECORDED RATHER THAN PAPERED OVER. The
// effect's `single` guard is defence in depth: the CARDING effect already refuses
// to card in single-hole mode, so `card` is permanently empty there and the
// `card.length === 0` guard is what actually stops the report. Both are kept —
// the day someone cards in single mode, the direct guard is the one that holds.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import CourseGame from './CourseGame';
import { getCourse, type GolfCourse } from '../../lib/golf/courses';

// Holes nominated as "holed out", by hole id → the stroke count to report. The
// subclassed sim below reads this; the test writes it to stand on a green.
const holedAt = new Map<number, number>();

vi.mock('./CourseGL', () => ({ default: () => null }));

vi.mock('../../lib/golf/courseSim', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../lib/golf/courseSim')>();
  class TestSim extends mod.CourseSim {
    override getState(): import('../../lib/golf/courseSim').CourseState {
      const s = super.getState();
      const strokes = holedAt.get(this.hole.id);
      return strokes == null ? s : { ...s, holed: true, strokes };
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

/** A 2-hole round cut from a real course, so every hole is real terrain data. */
function twoHoleCourse(): GolfCourse {
  const src = getCourse('augusta');
  const holes = src.holes.slice(0, 2);
  return {
    id: 'test-two',
    name: 'Test Two',
    holes,
    par: holes.reduce((a, h) => a + h.par, 0),
    yards: holes.reduce((a, h) => a + h.yards, 0),
  };
}

// `CourseGame` reads the sim through a 120 ms `setInterval` poll, so nothing the
// sim says reaches the DOM (or the effects) until the poll ticks.
const POLL_MS = 120;
function poll(times = 2) {
  for (let i = 0; i < times; i++) act(() => void vi.advanceTimersByTime(POLL_MS));
}

beforeEach(() => {
  holedAt.clear();
  getRecordsSpy.mockClear();
  postRecordsSpy.mockClear();
  vi.useFakeTimers();
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('CourseGame — the completed round reports itself', () => {
  it('reports the full round on the FINAL hole-out, before any button exists', () => {
    const course = twoHoleCourse();
    const onRoundComplete = vi.fn();
    render(<CourseGame course={course} seed={7} onRoundComplete={onRoundComplete} />);

    // Hole 1 in 4. Carded, but the round is not over — nothing is reported yet.
    holedAt.set(course.holes[0]!.id, 4);
    poll();
    expect(screen.getByText('Next hole')).toBeTruthy();
    expect(onRoundComplete).not.toHaveBeenCalled();

    act(() => screen.getByText('Next hole').click());
    holedAt.set(course.holes[1]!.id, 6);
    poll();

    // THE POINT: the round is already reported, and the scorecard has not been
    // opened — "See scorecard" is still sitting there unpressed.
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
    expect(screen.getByText('See scorecard')).toBeTruthy();
    expect(onRoundComplete).toHaveBeenCalledWith({
      courseId: 'test-two',
      holes: 2,
      strokes: 10,
      par: course.par,
      toPar: 10 - course.par,
    });
  });

  it('is safe to tap "Menu" on the final hole — reported once, never twice', () => {
    const course = twoHoleCourse();
    const onRoundComplete = vi.fn();
    const onExit = vi.fn();
    render(
      <CourseGame
        course={course}
        seed={7}
        onRoundComplete={onRoundComplete}
        onExit={onExit}
      />,
    );

    holedAt.set(course.holes[0]!.id, 5);
    poll();
    act(() => screen.getByText('Next hole').click());
    holedAt.set(course.holes[1]!.id, 5);
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);

    // The exit path the bug ran through. It must still exit, and must not be
    // the thing that reports (nor a second report).
    const menu = screen.getAllByText('Menu');
    act(() => menu[menu.length - 1]!.click());
    poll();
    expect(onExit).toHaveBeenCalledTimes(1);
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  // ⚠ THE ASSERTION THAT MAKES `roundReportedRef` LOAD-BEARING IN THE EFFECT.
  // Deleting the ref guard passed every other test in this file, because `card`
  // stops changing once the round is over and the effect simply never re-runs.
  // It is still a real bug: `onRoundComplete` is in the dep array and every
  // caller (`GolfScreen`, `GolfTournaments`) passes an INLINE arrow, so one
  // parent re-render is a fresh identity, a fresh effect run and a second
  // leaderboard row for the same round.
  it('reports once even when the parent re-renders with a fresh callback identity', () => {
    const course = twoHoleCourse();
    const onRoundComplete = vi.fn();
    const el = () => (
      <CourseGame course={course} seed={7} onRoundComplete={(r) => onRoundComplete(r)} />
    );
    const { rerender } = render(el());

    holedAt.set(course.holes[0]!.id, 4);
    poll();
    act(() => screen.getByText('Next hole').click());
    holedAt.set(course.holes[1]!.id, 4);
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);

    act(() => rerender(el()));
    poll();
    act(() => rerender(el()));
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it('does not double-report when the scorecard is then revealed', () => {
    const course = twoHoleCourse();
    const onRoundComplete = vi.fn();
    render(<CourseGame course={course} seed={7} onRoundComplete={onRoundComplete} />);

    holedAt.set(course.holes[0]!.id, 3);
    poll();
    act(() => screen.getByText('Next hole').click());
    holedAt.set(course.holes[1]!.id, 3);
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);

    act(() => screen.getByText('See scorecard').click());
    poll();
    expect(screen.getByText('Scorecard')).toBeTruthy();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);
  });

  it('reports a SECOND time after "Play round again" — the one-shot ref resets', () => {
    const course = twoHoleCourse();
    const onRoundComplete = vi.fn();
    render(<CourseGame course={course} seed={7} onRoundComplete={onRoundComplete} />);

    holedAt.set(course.holes[0]!.id, 4);
    poll();
    act(() => screen.getByText('Next hole').click());
    holedAt.set(course.holes[1]!.id, 4);
    poll();
    act(() => screen.getByText('See scorecard').click());
    expect(onRoundComplete).toHaveBeenCalledTimes(1);

    // A fresh round: the card is emptied, so the guard must let the next
    // completion through — and must not fire off the emptied card.
    holedAt.clear();
    act(() => screen.getByText('Play round again').click());
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(1);

    holedAt.set(course.holes[0]!.id, 7);
    poll();
    act(() => screen.getByText('Next hole').click());
    holedAt.set(course.holes[1]!.id, 7);
    poll();
    expect(onRoundComplete).toHaveBeenCalledTimes(2);
    expect(onRoundComplete).toHaveBeenLastCalledWith(
      expect.objectContaining({ holes: 2, strokes: 14 }),
    );
  });

  it('never reports a "round" in single-hole play — that path is onHoleComplete', () => {
    const course = twoHoleCourse();
    const onRoundComplete = vi.fn();
    const onHoleComplete = vi.fn();
    render(
      <CourseGame
        course={course}
        startHole={1}
        seed={7}
        onRoundComplete={onRoundComplete}
        onHoleComplete={onHoleComplete}
      />,
    );

    holedAt.set(course.holes[1]!.id, 3);
    poll();
    expect(onHoleComplete).toHaveBeenCalledTimes(1);
    expect(onRoundComplete).not.toHaveBeenCalled();

    // And the single-hole exit path stays clean too.
    const menu = screen.getAllByText('Menu');
    act(() => menu[menu.length - 1]!.click());
    poll();
    expect(onRoundComplete).not.toHaveBeenCalled();
  });
});
