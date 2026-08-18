// @vitest-environment jsdom
//
// A REJECTED SUBMIT MUST NOT LOSE THE ROUND.
//
// Golf shipped five submit paths written as `.catch(() => undefined)` (and one
// as `Promise.allSettled(...).then(refetch)`, which is worse — `allSettled`
// never rejects, so the failure was not even reachable). In every one of them a
// rejected POST discarded a round the player had actually played, with no
// retry, no local record and nothing shown.
//
// ⚠ SO THE REJECTION IS THE PRIMARY CASE IN EVERY TEST BELOW. The happy path is
// asserted once, at the end, as a sanity check. Three separate times on this
// project a promise's rejected arm shipped unexercised and cost real user data;
// a suite that only proves the resolved arm works is how that keeps happening.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const spies = vi.hoisted(() => ({
  submitGameScore: vi.fn(),
  submitChallengeResult: vi.fn(),
}));
vi.mock('../api', () => ({ api: spies }));

import {
  enqueuePendingScore,
  flushPendingScores,
  pendingScoresFor,
  readPendingScores,
  submitGameScoreDurably,
  submitPendingScore,
  type GameScoreBody,
} from './pendingScore';

const ROUND: GameScoreBody = {
  game: 'golfcourse',
  course: 'augusta',
  toPar: -3,
  rounds: 18,
  bestStreak: 0,
  score: 0,
};

// Ids come from a persisted counter. Bumping its base per test keeps the
// module-scope in-flight map (which is deliberately NOT reset between tests —
// that is what makes once-only survive a remount) from seeing a reused id.
let seqBase = 1000;

beforeEach(() => {
  localStorage.clear();
  seqBase += 1000;
  localStorage.setItem('relay.golfPendingSeq', String(seqBase));
  spies.submitGameScore.mockReset();
  spies.submitChallengeResult.mockReset();
});

describe('pendingScore — a failed board submit is recoverable', () => {
  it('⚠ keeps the round on disk when the POST REJECTS', async () => {
    spies.submitGameScore.mockRejectedValue(new Error('500'));

    await expect(submitGameScoreDurably(ROUND)).rejects.toThrow('500');

    const queued = readPendingScores();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: 'game', body: ROUND });
  });

  it('⚠ retries the rejected round on the next flush, and it lands', async () => {
    spies.submitGameScore.mockRejectedValueOnce(new Error('offline'));
    await expect(submitGameScoreDurably(ROUND)).rejects.toThrow('offline');
    expect(readPendingScores()).toHaveLength(1);

    // The "next mount": nothing but the persisted entry survives.
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 9 });
    await flushPendingScores();

    expect(spies.submitGameScore).toHaveBeenCalledTimes(2);
    expect(spies.submitGameScore).toHaveBeenNthCalledWith(2, ROUND);
    expect(readPendingScores()).toEqual([]);
  });

  it('⚠ keeps a rejected CHALLENGE result, addressable by its challenge', async () => {
    spies.submitChallengeResult.mockRejectedValue(new Error('403'));
    const entry = enqueuePendingScore({ kind: 'challenge', challengeId: 'ch1', toPar: 2 });

    await expect(submitPendingScore(entry)).rejects.toThrow('403');

    expect(pendingScoresFor('ch1')).toMatchObject([{ kind: 'challenge', toPar: 2 }]);
    expect(pendingScoresFor('other')).toEqual([]);
  });

  it('⚠ retries only what failed when one of two entries rejects', async () => {
    // The full-round challenge shape: the head-to-head result AND the board row.
    spies.submitChallengeResult.mockRejectedValueOnce(new Error('down'));
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 1 });
    const a = enqueuePendingScore({ kind: 'challenge', challengeId: 'ch2', toPar: 0 });
    const b = enqueuePendingScore({ kind: 'game', body: ROUND });

    const settled = await Promise.allSettled([submitPendingScore(a), submitPendingScore(b)]);
    // Inspecting the settled array is the whole point — allSettled never rejects.
    expect(settled.map((r) => r.status)).toEqual(['rejected', 'fulfilled']);

    expect(readPendingScores()).toMatchObject([{ kind: 'challenge', challengeId: 'ch2' }]);

    spies.submitChallengeResult.mockResolvedValue({ challenge: {} });
    await flushPendingScores();
    expect(spies.submitChallengeResult).toHaveBeenCalledTimes(2);
    expect(spies.submitGameScore).toHaveBeenCalledTimes(1); // not re-sent
    expect(readPendingScores()).toEqual([]);
  });

  it('⚠ issues ONE request per attempt even when two callers race it', async () => {
    // A card that remounts mid-flight reads the same entry back off disk as a
    // DIFFERENT object with the SAME id. A per-mount identity ref cannot see it.
    let settle: (v: unknown) => void = () => undefined;
    spies.submitGameScore.mockReturnValue(new Promise((res) => (settle = res)));

    const entry = enqueuePendingScore({ kind: 'game', body: ROUND });
    const first = submitPendingScore(entry);
    const reread = readPendingScores()[0]!;
    expect(reread).not.toBe(entry);
    const second = submitPendingScore(reread);

    settle({ ok: true, best: 4 });
    await Promise.all([first, second]);

    expect(spies.submitGameScore).toHaveBeenCalledTimes(1);
    expect(readPendingScores()).toEqual([]);
  });

  it('⚠ releases the claim on failure, so the same entry can be retried', async () => {
    spies.submitGameScore.mockRejectedValueOnce(new Error('boom'));
    const entry = enqueuePendingScore({ kind: 'game', body: ROUND });
    await expect(submitPendingScore(entry)).rejects.toThrow('boom');

    // Same entry object, same id — a persisted in-flight claim would strand it.
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 7 });
    await submitPendingScore(entry);
    expect(spies.submitGameScore).toHaveBeenCalledTimes(2);
    expect(readPendingScores()).toEqual([]);
  });

  it('caps the queue, dropping the OLDEST rather than the round just played', async () => {
    spies.submitGameScore.mockRejectedValue(new Error('offline'));
    for (let i = 0; i < 30; i += 1) {
      await expect(submitGameScoreDurably({ ...ROUND, toPar: i })).rejects.toThrow();
    }
    const q = readPendingScores();
    expect(q).toHaveLength(24);
    expect(q[0]).toMatchObject({ body: { toPar: 6 } });
    expect(q[23]).toMatchObject({ body: { toPar: 29 } });
  });

  it('sanity: a resolved POST leaves nothing queued', async () => {
    spies.submitGameScore.mockResolvedValue({ ok: true, best: 12 });
    await expect(submitGameScoreDurably(ROUND)).resolves.toEqual({ ok: true, best: 12 });
    expect(readPendingScores()).toEqual([]);
  });
});
