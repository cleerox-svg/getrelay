// The golf hub's ONE channel onto the shared leaderboard (`game_scores`).
//
// Every board submit `GolfScreen` makes — Mini-Golf, the range Target
// Challenge, and a full Course round — goes through `postScore` here, together
// with the two pieces of state that render the answer (`serverBest` on the
// results screen, `lbKey` to refetch the board).
//
// ⚠ WHY IT IS DURABLE. All three used to be
// `api.submitGameScore(...).catch(() => undefined)`: the LOCAL personal best
// survived (`recordGolfGame`/`recordRangeGame` write first) but the board entry
// was dropped, and the exactly-once ref in each effect meant it was never
// retried on that mount. `submitGameScoreDurably` writes the entry to disk
// BEFORE the POST, so a rejection leaves it queued; the mount effect below
// flushes the queue. That flush is also the ONLY retry available to
// `GolfGame`/`RangeGame`'s unmount "abandon safety net", which banks a partial
// round from a cleanup function and therefore cannot hold state or render an
// error of its own (`DerbyGame`'s bank()/finish() split, same constraint).
//
// It is why the rejection may be ignored in `postScore` — the round is on disk
// and will be retried — and not the old silent drop.
//
// `serverBest` is set by every caller, including the Course round, which has no
// results screen. That is safe because the only route to the screen that RENDERS
// it is `GolfScreen.play()`, which calls `resetBest()` before starting.
//
// WHY IT LIVES IN ITS OWN FILE. `GolfScreen.tsx` is at its `budget.test.ts`
// grandfathered size and may only shrink. That ratchet exists to push exactly
// this kind of self-contained wiring out of the 750-line component.

import { useCallback, useEffect, useState } from 'react';
import {
  flushPendingScores,
  submitGameScoreDurably,
  type GameScoreBody,
} from '../../lib/golf/pendingScore';

export interface BoardSubmit {
  /** The server's personal best for the board just submitted to, or null. */
  serverBest: number | null;
  /** Bumped once a submit answers, so a mounted leaderboard refetches. */
  lbKey: number;
  /** Submit a finished game to its board. Never throws; never loses the entry. */
  postScore: (body: GameScoreBody) => void;
  /** Clear the displayed best when a NEW game starts. */
  resetBest: () => void;
}

export function useBoardSubmit(): BoardSubmit {
  const [serverBest, setServerBest] = useState<number | null>(null);
  const [lbKey, setLbKey] = useState(0);

  // Retry anything a previous mount failed to send. See the header.
  useEffect(() => {
    void flushPendingScores();
  }, []);

  const postScore = useCallback((body: GameScoreBody) => {
    submitGameScoreDurably(body).then(
      (r) => {
        setServerBest(r.best);
        setLbKey((k) => k + 1);
      },
      () => undefined,
    );
  }, []);

  const resetBest = useCallback(() => setServerBest(null), []);

  return { serverBest, lbKey, postScore, resetBest };
}
