// @vitest-environment jsdom
//
// THE WHOLE PAUSE LOOP, END TO END, WITH THE REAL `CourseGame` AND THE REAL
// `CoursePauseSheet`.
//
// This is the coupling the guarded-free opt-in creates and the one thing neither
// side can verify alone: `useGameFlow` decides to set `paused`, `GolfScreen`
// decides to forward it, and `CourseGame` decides to render a sheet. Wire any two
// of those three and the round FREEZES WITH NO SHEET — a black-hole state with no
// way to resume and no way out but a second back press, strictly worse than the
// unguarded exit it replaced. `GolfScreen.test.tsx` cannot see it, because it
// stubs `CourseGame` and can only assert that the round is still mounted.
//
// So this file stubs only `CourseGL` (the `three` scene — the same seam
// `CourseGame.test.tsx` uses) and drives the real components:
//
//   full round → back → sheet up, round alive → Resume → sheet gone, round alive
//              → back → sheet again → End round → menu
//
// It also pins that the sheet is reachable ONLY where progress can be lost:
// single-hole play must not be able to raise it, because that session exits on
// one press and a sheet would never be shown a second press to dismiss it.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { GolfScreen } from './GolfScreen';
import { getCourse } from '../../lib/golf/courses';

// The Three.js scene. Everything else below the HUD is real: CourseSim over real
// terrain, the card, the accuracy bar, the sheet.
vi.mock('./CourseGL', () => ({ default: () => null }));

// Holes nominated as "holed out", by hole id → strokes. The sim is SUBCLASSED,
// not replaced (the same seam CourseGame.test.tsx uses): real terrain, real ball,
// real getState, with only `holed`/`strokes` forced for a nominated hole. Actually
// holing a putt would mean driving pointer drags through a WebGL scene this test
// does not own; what is under test is what happens to a CARDED hole when the
// round is ended from the sheet.
const holedAt = vi.hoisted(() => new Map<number, number>());
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

const spies = vi.hoisted(() => ({
  getDaily: vi.fn(),
  getDailyLeaderboard: vi.fn(),
  getTournament: vi.fn(),
  submitGameScore: vi.fn(),
  postDailyResult: vi.fn(),
  postTournamentResult: vi.fn(),
  getGolfRecords: vi.fn(),
  postGolfRecords: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: spies }));

vi.mock('./GolfMenu', () => ({
  GolfMenu: ({ onStart }: { onStart: (m: string, a?: string) => void }) => (
    <div>
      <button type="button" onClick={() => onStart('course', 'augusta')}>
        pick full round
      </button>
      <button type="button" onClick={() => onStart('course', 'augusta#11')}>
        pick hole 12
      </button>
    </div>
  ),
}));

vi.mock('./GolfDaily', () => ({ GolfDaily: () => null }));
vi.mock('./GolfTournaments', () => ({ GolfTournaments: () => null }));
vi.mock('./GolfGame', () => ({ GolfGame: () => null }));
vi.mock('./RangeGame', () => ({ RangeGame: () => null }));
vi.mock('./GolfLeaderboard', () => ({ GolfLeaderboard: () => null }));
vi.mock('./GolfProfile', () => ({ GolfProfile: () => null }));
vi.mock('./GolfShop', () => ({ GolfShop: () => null }));
vi.mock('./GolfSeason', () => ({ GolfSeason: () => null }));
vi.mock('./GolfWallet', () => ({ GolfWallet: () => null }));
vi.mock('./CoinBalance', () => ({ CoinBalance: () => null }));
vi.mock('../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../lib/audio', () => ({
  startMusic: () => undefined,
  stopMusic: () => undefined,
  duckMusic: () => undefined,
  play: () => undefined,
  // The sheet carries a MuteButton, which reads this.
  useAudioPrefs: () => [{ muted: false, sfx: true, music: true }, () => undefined],
}));
vi.mock('../../lib/store', () => {
  const state = { me: { displayName: 'Tester' }, setImmersive: () => undefined };
  return { useStore: (sel: (s: typeof state) => unknown) => sel(state) };
});
vi.mock('../../lib/golf/economy', () => {
  const state = {
    catalog: [],
    equipped: { ball: 'ball_classic', trail: 'trail_none', frame: 'frame_none' },
    balance: 0,
    ensureCosmetics: async () => undefined,
    ensureWallet: async () => undefined,
  };
  return {
    useEconomy: (sel: (s: typeof state) => unknown) => sel(state),
    useEquippedFrame: () => undefined,
  };
});

let back: () => void = () => undefined;
function Nav() {
  const nav = useNavigate();
  back = () => nav(-1);
  return null;
}

function mount() {
  return render(
    <MemoryRouter initialEntries={['/games']}>
      <Nav />
      <GolfScreen onExitToHub={() => undefined} />
    </MemoryRouter>,
  );
}

async function flush() {
  await act(async () => undefined);
}
function click(el: Element) {
  act(() => (el as HTMLElement).click());
}
async function press() {
  act(() => back());
  await flush();
}

/**
 * CourseGame reads the sim through a 120 ms poll, so a forced hole-out does not
 * reach the DOM (or the carding effect) until it ticks. Real timers, because the
 * round also runs rAF and a fake clock would have to drive both.
 */
async function poll() {
  await act(async () => {
    await new Promise((r) => setTimeout(r, 150));
  });
}

/** The pause sheet, or null. Queried by ROLE, as a screen reader would find it. */
const sheet = () => screen.queryByRole('dialog', { name: /Round paused/i });
/**
 * The round's own HUD readout ("Stroke 1 · Tee"), which exists only while
 * CourseGame is mounted and is NOT text the pause sheet or the menu can produce.
 */
const inRound = () => screen.queryByText(/^Stroke \d+ · /) != null;

beforeEach(() => {
  localStorage.clear();
  holedAt.clear();
  for (const s of Object.values(spies)) s.mockReset();
  spies.getDaily.mockResolvedValue({
    date: '2026-08-17',
    game: 'golfcourse',
    course: 'augusta',
    hole: 7,
    seed: 4242,
    today: null,
    streak: { current: 0, best: 0 },
  });
  spies.getDailyLeaderboard.mockResolvedValue({ entries: [] });
  spies.getTournament.mockResolvedValue({
    msLeft: 0,
    entry: null,
    entrants: 0,
    holes: [],
    seed: 555,
  });
  spies.submitGameScore.mockResolvedValue({ best: 0 });
  spies.getGolfRecords.mockResolvedValue({
    records: { longestDrive: null, closestToPin: null, longestPutt: null },
  });
  spies.postGolfRecords.mockResolvedValue({
    records: { longestDrive: null, closestToPin: null, longestPutt: null },
    improved: { longestDrive: false, closestToPin: false, longestPutt: false },
  });
});

afterEach(() => {
  cleanup();
});

describe('the guarded Course round pauses with a VISIBLE sheet', () => {
  it('back → sheet up and round alive → Resume → sheet gone → back → sheet → End round → menu', async () => {
    mount();
    click(screen.getByText('pick full round'));
    await flush();

    // In the round, nothing raised.
    expect(inRound()).toBe(true);
    expect(sheet()).toBeNull();

    // PRESS 1. The whole point: a sheet the player can actually see, naming the
    // course and the hole, with the round still mounted behind it.
    await press();
    const up = sheet();
    expect(up).not.toBeNull();
    expect(up!.textContent).toMatch(/Augusta National/);
    expect(up!.textContent).toMatch(/Hole 1 of 18/);
    expect(screen.getByRole('button', { name: 'Resume' })).toBeTruthy();
    expect(screen.getByText('End round')).toBeTruthy();
    expect(inRound()).toBe(true);

    // RESUME. A true continue: the sheet goes, the round is still there, and
    // nothing has been reported.
    click(screen.getByRole('button', { name: 'Resume' }));
    await flush();
    expect(sheet()).toBeNull();
    expect(inRound()).toBe(true);
    expect(spies.submitGameScore).not.toHaveBeenCalled();

    // And the escalation RE-ARMS: the next press must pause again, not leave.
    await press();
    expect(sheet()).not.toBeNull();
    expect(inRound()).toBe(true);

    // END ROUND leaves through the same exit as the header back button.
    click(screen.getByText('End round'));
    await flush();
    expect(sheet()).toBeNull();
    expect(inRound()).toBe(false);
    expect(screen.getByText('pick full round')).toBeTruthy();
    // No hole was ever carded, so there is nothing to bank and no phantom row is
    // posted to the board.
    expect(spies.submitGameScore).not.toHaveBeenCalled();
  });

  it('a SECOND back press leaves — never a trap, and it banks too', async () => {
    mount();
    click(screen.getByText('pick full round'));
    await flush();
    const first = getCourse('augusta').holes[0]!;
    holedAt.set(first.id, 5);
    await poll();

    await press();
    expect(sheet()).not.toBeNull();
    await press();
    expect(sheet()).toBeNull();
    expect(inRound()).toBe(false);
    expect(screen.getByText('pick full round')).toBeTruthy();
    // Leaving by the ARM rather than the button banks the same way (CourseGame's
    // unmount safety net), through the same submit, exactly once.
    expect(spies.submitGameScore).toHaveBeenCalledTimes(1);
    expect(spies.submitGameScore).toHaveBeenCalledWith(
      expect.objectContaining({ game: 'golfcourse', rounds: 1, toPar: 5 - first.par }),
    );
  });

  // The inverse guarantee. Single-hole play exits on ONE press, so if it could
  // pause, the sheet would appear at the same instant the screen unmounted — or
  // worse, freeze a round whose exit had already been consumed.
  it('single-hole play never raises the sheet — it exits on one press', async () => {
    mount();
    click(screen.getByText('pick hole 12'));
    await flush();
    expect(inRound()).toBe(true);

    await press();
    expect(sheet()).toBeNull();
    expect(inRound()).toBe(false);
    expect(screen.getByText('pick hole 12')).toBeTruthy();
  });

  // THE PAYOFF FOR GUARDING AT ALL, end to end through GolfScreen: a hole that
  // was played and carded reaches the LEADERBOARD when the player ends the round
  // from the sheet. Before the guard, one back press unmounted the round; before
  // CourseGame's safety net, the unmount discarded the card. Both halves have to
  // be connected to GolfScreen's golfcourse submit for the hole to count, and
  // nothing below this level can see all three.
  it('End round BANKS the carded holes to the golfcourse board', async () => {
    mount();
    click(screen.getByText('pick full round'));
    await flush();

    // Hole 1 in 4, carded by the poll.
    const first = getCourse('augusta').holes[0]!;
    holedAt.set(first.id, 4);
    await poll();

    await press();
    const up = sheet()!;
    expect(up).not.toBeNull();
    // The sheet says what ending costs, and it says one hole is safe.
    expect(up.textContent).toMatch(/Thru 1/);
    expect(up.textContent).toMatch(/Banks 1 hole/);

    click(screen.getByText('End round'));
    await flush();
    expect(inRound()).toBe(false);
    expect(spies.submitGameScore).toHaveBeenCalledTimes(1);
    expect(spies.submitGameScore).toHaveBeenCalledWith({
      game: 'golfcourse',
      course: 'augusta',
      toPar: 4 - first.par,
      rounds: 1,
      bestStreak: 0,
      score: 0,
    });
  });

  // Round two of a session. `enterFree` resets `paused`, so the guard cannot
  // arrive pre-paused — which would make press 1 take the LEAVE arm and destroy
  // the round without a sheet. (useGameFlow owns the reset; this pins the
  // behaviour a player would actually hit through golf's own screens.)
  it('pauses again on the NEXT round of the same session', async () => {
    mount();
    click(screen.getByText('pick full round'));
    await flush();
    await press();
    expect(sheet()).not.toBeNull();
    click(screen.getByText('End round'));
    await flush();
    expect(inRound()).toBe(false);

    click(screen.getByText('pick full round'));
    await flush();
    expect(sheet()).toBeNull();
    await press();
    expect(sheet()).not.toBeNull();
    expect(inRound()).toBe(true);
  });
});
