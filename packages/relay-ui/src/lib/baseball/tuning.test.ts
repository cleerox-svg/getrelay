// The MIRROR GUARD: `tuning.ts`'s score clamps against the worker's own.
//
// ⚠ THE COMMENT WAS THE ONLY THING HOLDING THIS. `tuning.ts` says MAX_ROUNDS and
// MAX_POINTS_PER_ROUND are "MIRRORED FROM THE WORKER. Do not diverge", and until
// this file existed nothing checked. The failure mode is the nastiest kind: a
// scoring change that lets a great round pay 2500 points ships fine, plays fine,
// and then silently 400s on submit for exactly the players who had a good game —
// because `packages/relay-worker/src/games.ts` REJECTS rather than truncates.
//
// ⚠ A SOURCE-TEXT READ, NOT AN IMPORT, AND THAT IS DELIBERATE. Importing the
// worker module would couple two packages that DEPLOY INDEPENDENTLY and would
// drag worker code (Hono, D1 types, the env shape) into the UI's module graph
// and therefore into its bundle analysis. Reading the file and regexing the two
// constants keeps the coupling where it belongs — in a test — and is the same
// shape `budget.test.ts` and `determinism.test.ts` already use on UI sources.
//
// ⚠ GUARD THE GUARD. A regex that stops matching would make this pass vacuously,
// which is the one outcome worse than a divergence, so the match itself is
// asserted before the comparison and the file is asserted to exist and to be
// non-trivial.

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_POINTS_PER_ROUND, MAX_ROUNDS, MAX_SUBMITTABLE_SCORE } from './tuning';

const SIM_DIR = dirname(fileURLToPath(import.meta.url));
const WORKER_GAMES = join(SIM_DIR, '..', '..', '..', '..', 'relay-worker', 'src', 'games.ts');

describe('tuning — the worker mirror', () => {
  it('MAX_ROUNDS and MAX_POINTS_PER_ROUND equal the worker’s, read from its source', () => {
    expect(existsSync(WORKER_GAMES), `worker source not found at ${WORKER_GAMES}`).toBe(true);
    const text = readFileSync(WORKER_GAMES, 'utf8');
    expect(text.length).toBeGreaterThan(500);

    const read = (name: string): number | null => {
      const m = new RegExp(`export\\s+const\\s+${name}\\s*=\\s*(-?\\d+)\\s*;`).exec(text);
      return m ? Number(m[1]) : null;
    };
    const rounds = read('MAX_ROUNDS');
    const perRound = read('MAX_POINTS_PER_ROUND');

    // Guard the guard: a rename or a reformat on the worker side must fail HERE
    // as "the regex stopped matching", not pass as "nothing to compare".
    expect(rounds, 'MAX_ROUNDS not found in the worker source — regex stale?').not.toBeNull();
    expect(
      perRound,
      'MAX_POINTS_PER_ROUND not found in the worker source — regex stale?',
    ).not.toBeNull();
    // …and prove the reader can fail, on a name that is definitely not there.
    expect(read('MAX_ROUNDS_THAT_DO_NOT_EXIST')).toBeNull();

    console.log(
      `\n[MIRROR] worker games.ts   MAX_ROUNDS ${rounds}   MAX_POINTS_PER_ROUND ${perRound}\n` +
        `         ui tuning.ts      MAX_ROUNDS ${MAX_ROUNDS}   MAX_POINTS_PER_ROUND ${MAX_POINTS_PER_ROUND}\n` +
        `         product ${MAX_SUBMITTABLE_SCORE} — the score the worker will 400 above.\n` +
        `         The worker REJECTS, it does not clamp. Change both in one PR.`,
    );

    expect(rounds).toBe(MAX_ROUNDS);
    expect(perRound).toBe(MAX_POINTS_PER_ROUND);
    // The derived one is derived, not typed a third time.
    expect(MAX_SUBMITTABLE_SCORE).toBe(MAX_ROUNDS * MAX_POINTS_PER_ROUND);
  });
});
