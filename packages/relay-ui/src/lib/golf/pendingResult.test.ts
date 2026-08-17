// @vitest-environment jsdom
//
// The pending-result store's own edge cases. The BEHAVIOURAL guard for the bug
// this module exists to fix lives in `components/golf/GolfScreen.test.tsx`, which
// deliberately imports nothing from here — it drives the real screen and counts
// requests. This file covers the cases that guard cannot reach: a corrupt record,
// a superseded attempt, and a POST that fails.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearPending,
  dropStalePending,
  readPending,
  submitPendingResult,
  writePending,
} from './pendingResult';

// Today's challenge seed, i.e. the tag every record below was played on.
const TAG = 4242;

beforeEach(() => {
  localStorage.clear();
});

describe('pendingResult — the store', () => {
  it('round-trips a score and gives every attempt a distinct id', () => {
    const a = writePending('daily', { strokes: 4, toPar: 0 }, TAG);
    expect(readPending('daily')).toEqual(a);
    expect(a.tag).toBe('4242');
    expect(readPending('tournament')).toBeNull();

    // A replay supersedes the earlier attempt, with a new id.
    const b = writePending('daily', { strokes: 3, toPar: -1 }, TAG);
    expect(b.id).not.toBe(a.id);
    expect(readPending('daily')).toEqual(b);

    // The two kinds are independent slots, sharing the id sequence.
    const t = writePending('tournament', { strokes: 12, toPar: 0 }, 'evt-9');
    expect(t.id).not.toBe(b.id);
    expect(readPending('daily')).toEqual(b);
  });

  it('treats an unparseable or half-written record as empty', () => {
    writePending('daily', { strokes: 4, toPar: 0 }, TAG);
    localStorage.setItem('relay.golfPendingDaily', '{not json');
    expect(readPending('daily')).toBeNull();
    localStorage.setItem('relay.golfPendingDaily', JSON.stringify({ strokes: 4 }));
    expect(readPending('daily')).toBeNull();
  });

  // A record with no tag can only come from the build before tagging existed,
  // and there is no safe guess for which challenge it belongs to.
  it('rejects an UNTAGGED record rather than risk filing it against today', () => {
    localStorage.setItem(
      'relay.golfPendingDaily',
      JSON.stringify({ id: 1, strokes: 4, toPar: 0 }),
    );
    expect(readPending('daily')).toBeNull();
  });

  it('clears only the attempt it was told to clear', () => {
    const first = writePending('daily', { strokes: 6, toPar: 2 }, TAG);
    const second = writePending('daily', { strokes: 4, toPar: 0 }, TAG);

    // A late POST for the SUPERSEDED attempt must not delete the newer one.
    clearPending('daily', first.id);
    expect(readPending('daily')).toEqual(second);

    clearPending('daily', second.id);
    expect(readPending('daily')).toBeNull();
  });
});

describe('pendingResult — evicting a record from an earlier challenge', () => {
  it('drops a record whose tag does not match the live challenge', () => {
    writePending('daily', { strokes: 2, toPar: -2 }, 'yesterday');
    expect(dropStalePending('daily', TAG)).toBe(true);
    expect(readPending('daily')).toBeNull();
  });

  it('keeps a record played on the live challenge, and reports nothing to do', () => {
    const rec = writePending('daily', { strokes: 4, toPar: 0 }, TAG);
    expect(dropStalePending('daily', TAG)).toBe(false);
    expect(readPending('daily')).toEqual(rec);
    // Numbers and strings name the same challenge.
    expect(dropStalePending('daily', '4242')).toBe(false);
    expect(readPending('daily')).toEqual(rec);
  });

  it('is a no-op on an empty slot, and never touches the OTHER kind', () => {
    const t = writePending('tournament', { strokes: 12, toPar: 0 }, 'evt-9');
    expect(dropStalePending('daily', TAG)).toBe(false);
    expect(dropStalePending('daily', 'anything')).toBe(false);
    expect(readPending('tournament')).toEqual(t);
    expect(dropStalePending('tournament', 'evt-10')).toBe(true);
    expect(readPending('tournament')).toBeNull();
  });
});

describe('pendingResult — submitting', () => {
  it('posts the score and clears the record only after the POST resolves', async () => {
    const rec = writePending('daily', { strokes: 4, toPar: 0 }, TAG);
    let settle!: (v: string) => void;
    const post = vi.fn(() => new Promise<string>((res) => (settle = res)));

    const p = submitPendingResult(rec, post);
    expect(post).toHaveBeenCalledWith({ strokes: 4, toPar: 0 });
    // Still pending: nothing has reached the server yet.
    expect(readPending('daily')).toEqual(rec);

    settle('ok');
    await expect(p).resolves.toBe('ok');
    expect(readPending('daily')).toBeNull();
  });

  it('hands a second caller the SAME in-flight promise — one request', async () => {
    const rec = writePending('daily', { strokes: 4, toPar: 0 }, TAG);
    let settle!: (v: string) => void;
    const post = vi.fn(() => new Promise<string>((res) => (settle = res)));

    // The remount case: a fresh read of the same record, so object identity is
    // no help — only the id is.
    const again = readPending('daily')!;
    expect(again).not.toBe(rec);

    const first = submitPendingResult(rec, post);
    const second = submitPendingResult(again, post);
    expect(post).toHaveBeenCalledTimes(1);
    settle('ok');
    await expect(Promise.all([first, second])).resolves.toEqual(['ok', 'ok']);
  });

  it('releases the claim when the POST fails, so it can be retried', async () => {
    const rec = writePending('daily', { strokes: 5, toPar: 1 }, TAG);
    const post = vi
      .fn<(s: { strokes: number; toPar: number }) => Promise<string>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce('ok');

    await expect(submitPendingResult(rec, post)).rejects.toThrow('offline');
    // Kept, because it never landed.
    expect(readPending('daily')).toEqual(rec);

    await expect(submitPendingResult(rec, post)).resolves.toBe('ok');
    expect(post).toHaveBeenCalledTimes(2);
    expect(readPending('daily')).toBeNull();
  });

  it('lets a NEW attempt overtake one already in flight', async () => {
    const first = writePending('tournament', { strokes: 14, toPar: 2 }, 'evt-9');
    let settleFirst!: (v: string) => void;
    const post = vi.fn(
      (s: { strokes: number; toPar: number }) =>
        new Promise<string>((res) => {
          if (s.strokes === 14) settleFirst = res;
          else res('second');
        }),
    );

    const a = submitPendingResult(first, post);
    const second = writePending('tournament', { strokes: 11, toPar: -1 }, 'evt-9');
    await expect(submitPendingResult(second, post)).resolves.toBe('second');
    expect(post).toHaveBeenCalledTimes(2);
    // The second attempt landed, so the slot is empty...
    expect(readPending('tournament')).toBeNull();

    // ...and the first one resolving late must not resurrect or re-clear anything.
    settleFirst('first');
    await a;
    expect(readPending('tournament')).toBeNull();
  });
});
