// @vitest-environment jsdom
//
// THE UNMOUNT SAFETY NET MUST NOT LOSE A PARTIAL ROUND EITHER.
//
// `GolfGame`'s cleanup banks the holes already sunk when the round is abandoned
// (route change, tab switch, navbar link, second back press while paused). It
// may not `setState` — the whole route may be unmounting — so it cannot show an
// error, cannot hold a retry, and cannot re-run itself. That constraint is real
// (`DerbyGame` hit exactly this and split `bank()` from `finish()`), and it is
// why the old `api.submitGameScore(...).catch(() => undefined)` here was
// unrecoverable: a rejected POST had nowhere to go.
//
// ⚠ THE REJECTION IS THE PRIMARY CASE. The fix is that the entry is PERSISTED
// before the POST, so the next `GolfScreen` mount can flush it. This test drives
// the abandon with a rejecting POST and then proves the round is still there.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render } from '@testing-library/react';
import { GolfGame } from './GolfGame';
import { flushPendingScores, readPendingScores } from '../../lib/golf/pendingScore';

const spies = vi.hoisted(() => ({ submitGameScore: vi.fn(), submitChallengeResult: vi.fn() }));
vi.mock('../../lib/api', () => ({ api: spies }));

// The scene, reduced to the event channel the round listens on. `sink` is what
// cards a hole; `stroke` is what counts one.
let fire: (e: { type: string }) => void = () => undefined;
vi.mock('./PuttGL', () => ({
  default: (p: { onEvent: (e: { type: string }) => void }) => {
    fire = p.onEvent;
    return null;
  },
}));
vi.mock('./shared/MuteButton', () => ({ MuteButton: () => null }));

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem('relay.golfPendingSeq', String(Math.floor(Math.random() * 1e6) + 1e6));
  spies.submitGameScore.mockReset();
});

afterEach(cleanup);

/** Sink `n` holes at two strokes each, letting the lazy scene resolve first. */
async function playHoles(n: number) {
  await act(async () => undefined);
  for (let i = 0; i < n; i += 1) {
    act(() => {
      fire({ type: 'stroke' });
      fire({ type: 'stroke' });
      fire({ type: 'sink' });
    });
    // The post-sink beat before the next hole mounts.
    await act(async () => {
      vi.advanceTimersByTime(800);
    });
  }
}

describe('GolfGame — abandoning mid-round', () => {
  it('⚠ keeps the partial round when the unmount POST REJECTS, and it lands later', async () => {
    vi.useFakeTimers();
    spies.submitGameScore.mockRejectedValue(new Error('offline'));

    const view = render(
      <GolfGame onFinish={() => undefined} paused={false} onResume={() => undefined} />,
    );
    await playHoles(2);

    // The route goes away mid-round. No state update may happen here.
    const warn = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    view.unmount();
    await act(async () => undefined);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
    vi.useRealTimers();

    expect(spies.submitGameScore).toHaveBeenCalledTimes(1);
    expect(spies.submitGameScore.mock.calls[0]?.[0]).toMatchObject({ game: 'golf', rounds: 2 });

    // The round is still on disk — which is the only thing that can save it,
    // because this path can neither retry nor report.
    const queued = readPendingScores();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'game', body: { game: 'golf', rounds: 2 } });

    // GolfScreen's next mount flushes it.
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 100 });
    await flushPendingScores();
    expect(spies.submitGameScore).toHaveBeenCalledTimes(2);
    expect(readPendingScores()).toEqual([]);
  });

  it('sanity: a resolved unmount POST leaves nothing queued', async () => {
    vi.useFakeTimers();
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 100 });

    const view = render(
      <GolfGame onFinish={() => undefined} paused={false} onResume={() => undefined} />,
    );
    await playHoles(1);
    view.unmount();
    await act(async () => undefined);
    vi.useRealTimers();

    expect(spies.submitGameScore).toHaveBeenCalledTimes(1);
    expect(readPendingScores()).toEqual([]);
  });
});
