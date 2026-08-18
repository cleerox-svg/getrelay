// @vitest-environment jsdom
//
// A REJECTED CHALLENGE SUBMIT MUST NOT RENDER THE ROUND AS UNPLAYED.
//
// The card used to do:
//
//   Promise.allSettled([api.submitChallengeResult(id, toPar), …])
//     .then(() => api.getChallenge(id))
//     .then((res) => setCh(res.challenge))
//     .catch(() => undefined)
//
// `Promise.allSettled` NEVER REJECTS. So a rejected `submitChallengeResult`
// flowed straight into the `.then()`, the card refetched, the server said
// "unplayed", and the card re-rendered the player's score as `—` with a "Play
// your round" button — as though the round had never happened. Nothing was
// persisted on this path, so the round was gone: no retry, no local record, no
// message. The trailing `.catch(() => undefined)` swallowed the refetch failure
// on top.
//
// ⚠ THE REJECTION IS THE PRIMARY CASE HERE. Every test but the last drives a
// FAILING POST, because the resolved arm is the only arm that was ever
// exercised and that is precisely why this shipped.
//
// WHAT IS ASSERTED IS WHAT THE PLAYER SEES — the rendered card — plus the calls
// that reach `api`. Nothing imports `pendingScore` to check its own bookkeeping
// agrees with itself.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { ChallengeCard } from './ChallengeCard';
import type { Challenge } from '../../lib/types';

const spies = vi.hoisted(() => ({
  getChallenge: vi.fn(),
  submitChallengeResult: vi.fn(),
  submitGameScore: vi.fn(),
}));
vi.mock('../../lib/api', () => ({ api: spies }));

// CourseGame, reduced to the two completion channels the card wires up. The
// buttons stand in for holing out; nothing else about the round matters here.
vi.mock('./CourseGame', () => ({
  default: (p: {
    onHoleComplete?: (r: { courseId: string; toPar: number }) => void;
    onRoundComplete?: (r: { courseId: string; toPar: number; holes: number }) => void;
  }) => (
    <div>
      {p.onHoleComplete ? (
        <button type="button" onClick={() => p.onHoleComplete!({ courseId: 'augusta', toPar: 2 })}>
          hole out
        </button>
      ) : null}
      {p.onRoundComplete ? (
        <button
          type="button"
          onClick={() => p.onRoundComplete!({ courseId: 'augusta', toPar: -1, holes: 18 })}
        >
          finish round
        </button>
      ) : null}
    </div>
  ),
}));

vi.mock('../Avatar', () => ({ Avatar: () => null }));
vi.mock('../../lib/golf/economy', () => {
  const state = { ensureWallet: async () => undefined };
  return { useEconomy: (sel: (s: typeof state) => unknown) => sel(state) };
});

/** An open challenge, my move, single hole (hole index 6 of Augusta). */
function open(overrides: Partial<Challenge> = {}): Challenge {
  return {
    id: 'ch-1',
    game: 'golfcourse',
    course: 'augusta',
    hole: 6,
    seed: 77,
    status: 'pending',
    challenger: { userId: 'me', displayName: 'Me', avatarUrl: null, toPar: null },
    opponent: { userId: 'them', displayName: 'Them', avatarUrl: null, toPar: null },
    winnerId: null,
    mine: 'challenger',
    createdAt: 0,
    ...overrides,
  };
}

beforeEach(() => {
  localStorage.clear();
  // Fresh id space per test: ids are drawn from a persisted counter and the
  // once-only claim map is module scope (deliberately — that is what survives a
  // remount), so reusing an id across tests would alias a settled claim.
  localStorage.setItem('relay.golfPendingSeq', String(Math.floor(Math.random() * 1e6) + 1e6));
  spies.getChallenge.mockReset();
  spies.submitChallengeResult.mockReset();
  spies.submitGameScore.mockReset();
  spies.getChallenge.mockResolvedValue({ challenge: open() });
  spies.submitGameScore.mockResolvedValue({ ok: true, best: 0 });
});

afterEach(cleanup);

async function flush() {
  await act(async () => undefined);
}

function click(label: string) {
  act(() => (screen.getByText(label) as HTMLElement).click());
}

/** The score chip rendered for the viewer's own side. */
function myScore(): string {
  return screen.getAllByText(/^(—|E|\+\d+|−\d+)$/)[0]?.textContent ?? '';
}

describe('ChallengeCard — a failed submit is not an unplayed round', () => {
  it('⚠ does NOT re-render the round as unplayed when submitChallengeResult REJECTS', async () => {
    spies.submitChallengeResult.mockRejectedValue(new Error('500'));

    render(<ChallengeCard id="ch-1" />);
    await flush();
    click('Play your round');
    click('hole out');
    await flush();

    // The bug: the server still says unplayed, and the old card believed it.
    expect(spies.getChallenge).toHaveBeenLastCalledWith('ch-1');
    expect(screen.queryByText('Play your round')).toBeNull();
    expect(myScore()).toBe('+2');
    // And it says so, rather than pretending the match is simply waiting.
    expect(screen.getByText('Not saved')).toBeTruthy();
    expect(screen.queryByText('Waiting')).toBeNull();
    expect(screen.getByText('Retry')).toBeTruthy();
  });

  it('⚠ Retry re-sends the SAME round and clears the failure', async () => {
    spies.submitChallengeResult.mockRejectedValueOnce(new Error('offline'));

    render(<ChallengeCard id="ch-1" />);
    await flush();
    click('Play your round');
    click('hole out');
    await flush();
    expect(screen.getByText('Not saved')).toBeTruthy();

    spies.submitChallengeResult.mockResolvedValue({ challenge: open() });
    spies.getChallenge.mockResolvedValue({
      challenge: open({
        challenger: { userId: 'me', displayName: 'Me', avatarUrl: null, toPar: 2 },
      }),
    });
    click('Retry');
    await flush();

    expect(spies.submitChallengeResult).toHaveBeenCalledTimes(2);
    expect(spies.submitChallengeResult).toHaveBeenLastCalledWith('ch-1', 2);
    expect(screen.queryByText('Not saved')).toBeNull();
    expect(screen.getByText('Waiting')).toBeTruthy();
  });

  it('⚠ a REMOUNT recovers the round: it is retried and still reads as played', async () => {
    spies.submitChallengeResult.mockRejectedValue(new Error('offline'));

    const first = render(<ChallengeCard id="ch-1" />);
    await flush();
    click('Play your round');
    click('hole out');
    await flush();
    first.unmount();

    // Scrolling the chat rail away and back. The server has never heard of this
    // round, so everything the new card knows comes off disk.
    spies.submitChallengeResult.mockClear();
    render(<ChallengeCard id="ch-1" />);
    await flush();

    expect(spies.submitChallengeResult).toHaveBeenCalledWith('ch-1', 2);
    expect(myScore()).toBe('+2');
    expect(screen.queryByText('Play your round')).toBeNull();
    expect(screen.getByText('Not saved')).toBeTruthy();
  });

  it('⚠ surfaces a rejected BOARD submit on a full-round challenge too', async () => {
    // The challenge settles but the golfcourse leaderboard row does not. That
    // rejection lived inside the same allSettled array and was equally invisible.
    spies.getChallenge.mockResolvedValue({ challenge: open({ hole: null }) });
    spies.submitChallengeResult.mockResolvedValue({ challenge: open({ hole: null }) });
    spies.submitGameScore.mockRejectedValue(new Error('clamped'));

    render(<ChallengeCard id="ch-1" />);
    await flush();
    click('Play your round');
    click('finish round');
    await flush();

    expect(screen.getByText('Not saved')).toBeTruthy();

    spies.submitGameScore.mockResolvedValue({ ok: true, best: 3 });
    click('Retry');
    await flush();
    // The challenge half already landed, so only the board row goes again.
    expect(spies.submitChallengeResult).toHaveBeenCalledTimes(1);
    expect(spies.submitGameScore).toHaveBeenCalledTimes(2);
    expect(screen.queryByText('Not saved')).toBeNull();
  });

  it('⚠ a failed REFETCH after a SUCCESSFUL submit is not reported as a lost round', async () => {
    spies.submitChallengeResult.mockResolvedValue({ challenge: open() });
    render(<ChallengeCard id="ch-1" />);
    await flush();
    spies.getChallenge.mockRejectedValue(new Error('offline'));
    click('Play your round');
    click('hole out');
    await flush();

    // The round DID land — a stale view must not claim otherwise.
    expect(screen.queryByText('Not saved')).toBeNull();
    expect(screen.queryByText('Retry')).toBeNull();
    expect(myScore()).toBe('+2');
  });

  it('sanity: a resolved submit shows the settled match and nothing queued', async () => {
    spies.submitChallengeResult.mockResolvedValue({ challenge: open() });
    spies.getChallenge
      .mockResolvedValueOnce({ challenge: open() })
      .mockResolvedValue({
        challenge: open({
          status: 'complete',
          winnerId: 'me',
          challenger: { userId: 'me', displayName: 'Me', avatarUrl: null, toPar: 0 },
        }),
      });

    render(<ChallengeCard id="ch-1" />);
    await flush();
    click('Play your round');
    click('hole out');
    await flush();

    expect(screen.getByText('Final')).toBeTruthy();
    expect(screen.getByText('You win')).toBeTruthy();
    expect(screen.queryByText('Not saved')).toBeNull();
  });
});
