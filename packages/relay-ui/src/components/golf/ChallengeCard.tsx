import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../Avatar';
import CourseGame from './CourseGame';
import { api } from '../../lib/api';
import { getCourse } from '../../lib/golf/courses';
import { useEconomy } from '../../lib/golf/economy';
import {
  enqueuePendingScore,
  pendingScoresFor,
  readPendingScores,
  submitPendingScore,
  type PendingScoreEntry,
} from '../../lib/golf/pendingScore';
import type { Challenge, ChallengeParticipant } from '../../lib/types';

// Format a to-par relative to par: 0 → "E", positive → "+n", negative → "−n"
// (true minus sign). Mirrors CourseGame's toPar() so the card and the round
// scorecard read the same.
function fmtToPar(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${-n}`;
}

// A live card for an async golf challenge, rendered in the chat text rail from
// a `relay://challenge/<id>` message. Fetches the challenge on mount and lets
// the player run their round straight from the card via a CourseGame overlay —
// no cross-tab navigation.
export function ChallengeCard({ id }: { id: string }) {
  const [ch, setCh] = useState<Challenge | null>(null);
  // A to-par the player has PLAYED but the server has not acknowledged. Held
  // separately from `ch` so a refetch cannot wipe it, and so a stranded entry
  // picked up on a later mount still reads as played instead of as `—`.
  const [pendingToPar, setPendingToPar] = useState<number | null>(null);
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  // Did the round the player just finished actually REACH the server?
  // 'unsaved' is the state that used to be invisible — the card refetched and
  // re-rendered a `—` as though nothing had been played. See runSubmit().
  const [save, setSave] = useState<'idle' | 'saving' | 'unsaved'>('idle');
  // One-shot: a round's result is CAPTURED at most once, even though
  // CourseGame's "Play round again" resets its own onRoundComplete guard.
  // Retrying a failed submit re-sends the SAME persisted entries; it never
  // re-captures, so this stays latched.
  const submittedRef = useRef(false);
  // The persisted entries for the round just played, so Retry re-submits those
  // exact attempts (same ids → the once-only claim still holds).
  const queuedRef = useRef<PendingScoreEntry[]>([]);
  // Wallet refresh after a win-completing submit so the hub coin chip updates.
  // Pulled as a stable action ref (no re-render subscription); degrades
  // gracefully when the economy store is empty (unauthed / offline).
  const ensureWallet = useEconomy((s) => s.ensureWallet);

  useEffect(() => {
    let cancelled = false;
    api
      .getChallenge(id)
      .then((r) => {
        if (!cancelled) setCh(r.challenge);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [id]);

  // A round from an EARLIER mount whose POST failed and is still on disk. Show
  // it as played and retry it — otherwise the server's "unplayed" answer would
  // render `—` over a round the player actually finished.
  useEffect(() => {
    const queued = pendingScoresFor(id);
    const mine = queued.find((e) => e.kind === 'challenge');
    if (!mine) return;
    queuedRef.current = queued;
    submittedRef.current = true;
    setPendingToPar(mine.kind === 'challenge' ? mine.toPar : null);
    void runSubmit(queued);
    // runSubmit is a stable function declaration in this component's body.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id]);

  if (failed) {
    return <span className="challenge-chip">Challenge unavailable</span>;
  }
  if (!ch) {
    return <span className="challenge-chip">Loading challenge…</span>;
  }

  const serverSide: ChallengeParticipant = ch[ch.mine];
  // Until the server has my score, an unsent-but-played to-par stands in for it.
  const mySide: ChallengeParticipant =
    serverSide.toPar == null && pendingToPar != null
      ? { ...serverSide, toPar: pendingToPar }
      : serverSide;
  const otherSide: ChallengeParticipant =
    ch[ch.mine === 'challenger' ? 'opponent' : 'challenger'];
  const course = getCourse(ch.course ?? undefined);

  // Single-hole challenge when a hole index is present. Label uses the hole's
  // display id/name when available, else a 1-based fallback.
  const isSingleHole = ch.hole != null;
  const holeMeta = isSingleHole ? course.holes[ch.hole!] : undefined;
  const holeLabel = isSingleHole
    ? `${course.name} · Hole ${holeMeta?.id ?? ch.hole! + 1}`
    : course.name;

  // A single-hole challenge whose hole this client's course data doesn't have
  // (crafted payload, or course-data drift between independently-deployed UIs)
  // can't be played safely — CourseGame would build a sim from an undefined
  // hole and crash the card. Refuse it instead.
  if (isSingleHole && !holeMeta) {
    return <span className="challenge-chip">Challenge unavailable</span>;
  }

  const myTurn = mySide.toPar == null;
  const waiting = mySide.toPar != null && otherSide.toPar == null && ch.status !== 'complete';
  const complete = ch.status === 'complete';
  const winnerId = ch.winnerId;

  // Outcome (complete only): win = I hold the winnerId, tie = no winnerId.
  const won = complete && ch.winnerId != null && ch.winnerId === mySide.userId;
  const tied = complete && ch.winnerId == null;
  const lost = complete && !won && !tied;

  const outcomeClass = won ? 'is-win' : lost ? 'is-loss' : 'is-tie';

  // Nominal stake on the LIVE card. Optional/additive from the worker — only
  // surface the stake line when it's a positive number (older builds omit it).
  const stake = ch.rewardCoins ?? 0;
  const hasStake = stake > 0;

  // Coins the viewer ACTUALLY got when it settled (0 on a loss or a daily-capped
  // win). The completed headline reads THIS, not the nominal stake, so a capped
  // win never shows a coin figure the player didn't receive.
  const awarded = ch.rewardCoinsAwarded ?? 0;
  const gotCoins = awarded > 0;

  // Outcome headline: append the coins actually credited only when > 0. A loss
  // never pays; a win or (paying) tie shows "+N coins".
  const outcomeText = won
    ? gotCoins
      ? `You won  ·  +${awarded} coins`
      : 'You win'
    : lost
      ? 'You lost'
      : gotCoins
        ? `Tie  ·  +${awarded} coins`
        : 'Tie';

  // Shared one-shot capture for both the full-round (onRoundComplete) and the
  // single-hole (onHoleComplete) callbacks. `rounds` is the completed round's
  // holes, or 1 for a hole.
  function submitResult(courseId: string, toPar: number, rounds: number) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    setPendingToPar(toPar);
    // PERSIST BEFORE THE POST. Everything below can fail; nothing below can
    // lose the round. Always settle the challenge — only a FULL round also
    // counts on the shared golfcourse board/profile, because a single
    // challenge hole's to-par isn't comparable to a full round (it would
    // outrank real rounds and inflate rounds-played).
    const queued = [enqueuePendingScore({ kind: 'challenge', challengeId: id, toPar })];
    if (rounds > 1) {
      queued.push(
        enqueuePendingScore({
          kind: 'game',
          body: {
            game: 'golfcourse',
            course: courseId,
            toPar,
            rounds,
            bestStreak: 0,
            score: 0,
          },
        }),
      );
    }
    queuedRef.current = queued;
    void runSubmit(queued);
  }

  // Submit (or RE-submit) persisted entries and inspect every settled result.
  //
  // ⚠ `Promise.allSettled` NEVER REJECTS. This used to be
  // `allSettled(tasks).then(refetch).catch(() => undefined)`, so a rejected
  // `submitChallengeResult` flowed into the `.then()`, the refetch answered
  // "unplayed", and the card rendered `—` for a round that had been played and
  // was now gone. A `rejected` entry is a failure and is treated as one here.
  async function runSubmit(queued: PendingScoreEntry[]) {
    setSave('saving');
    // Only what is still ON DISK. A Retry after a partial failure must not
    // re-POST the half that already landed.
    const live = readPendingScores();
    const todo = queued.filter((e) => live.some((l) => l.id === e.id));
    const settled = await Promise.allSettled(todo.map((e) => submitPendingScore(e)));
    setPlaying(false);
    if (settled.some((r) => r.status === 'rejected')) {
      // Every failed entry is still on disk. Surface it and offer Retry.
      setSave('unsaved');
      return;
    }
    setSave('idle');
    // Refetch to pick up the settled match. A failure HERE is a stale VIEW, not
    // a lost round — the result did land — so it must not claim otherwise.
    try {
      const res = await api.getChallenge(id);
      setCh(res.challenge);
      // A completion may have credited me coins (a win OR a tie pays the
      // viewer). Force-refresh the wallet so the hub chip agrees. ensureWallet
      // swallows its own errors, so this no-ops when unauthed / offline.
      if (res.challenge.status === 'complete') void ensureWallet(true);
    } catch {
      /* the next mount refetches */
    }
  }

  // Colour the mono score chip by state: pending "—" is dim; a submitted score
  // reads neutral (even) until the match settles, then the winner's score is
  // emerald (good) and the loser's salmon (bad); a tie leaves both even.
  function scoreState(p: ChallengeParticipant): 'good' | 'even' | 'bad' | 'pend' {
    if (p.toPar == null) return 'pend';
    if (complete && winnerId != null) {
      return p.userId === winnerId ? 'good' : 'bad';
    }
    return 'even';
  }

  function renderPlayer(p: ChallengeParticipant, label: string) {
    return (
      <div className="challenge-player">
        <Avatar src={p.avatarUrl} name={p.displayName} size={32} />
        <div className="challenge-player-meta">
          <span className="challenge-player-name">{p.displayName}</span>
          <span className="challenge-player-role">{label}</span>
        </div>
        <span className={`challenge-player-score is-${scoreState(p)}`}>
          {p.toPar == null ? '—' : fmtToPar(p.toPar)}
        </span>
      </div>
    );
  }

  // State pill: my move → "Your turn", I've played and I'm waiting → "Waiting",
  // settled → "Final". Mirrors the myTurn/waiting/complete derivation above.
  // A round that did not reach the server outranks all of them — "Waiting" over
  // an unsent score would be a lie, and it is the state the old code hid.
  const unsaved = save === 'unsaved';
  const stateText = unsaved
    ? 'Not saved'
    : myTurn
      ? 'Your turn'
      : waiting
        ? 'Waiting'
        : complete
          ? 'Final'
          : '';
  const stateClass = unsaved
    ? 'is-unsaved'
    : myTurn
      ? 'is-turn'
      : waiting
        ? 'is-wait'
        : 'is-done';

  // The opponent has locked in a score while the match is still open (the usual
  // async flow: challenger plays first, then it's my turn) — surface that.
  const otherLabel =
    otherSide.toPar != null && !complete ? 'Played · locked in' : 'Opponent';

  return (
    // Stop clicks/taps from bubbling to the chat bubble's onClick (which opens
    // the message-actions sheet) — otherwise every shot inside the CourseGame
    // overlay (a DOM descendant) would pop the sheet and make the round
    // unplayable.
    <div className="challenge-card-wrap" onClick={(e) => e.stopPropagation()}>
      <div className="challenge-card" role="group" aria-label="Golf challenge">
        <div className="challenge-turf" aria-hidden="true">
          <div className="challenge-fair" />
          <span className="challenge-turf-flag">⛳</span>
        </div>

        <div className="challenge-pad">
          <div className="challenge-card-head">
            <div className="challenge-card-titles">
              <span className="challenge-card-eyebrow">Golf challenge</span>
              <span className="challenge-card-course">{holeLabel}</span>
            </div>
            {stateText ? (
              <span className={`challenge-state ${stateClass}`}>{stateText}</span>
            ) : null}
          </div>

          <div className="challenge-meta">
            <span className="challenge-meta-chip">Match play</span>
            <span className="challenge-meta-chip">
              Seed <span className="challenge-meta-mono">#{ch.seed}</span>
            </span>
          </div>

          <div className="challenge-players">
            {renderPlayer(mySide, 'You')}
            <span className="challenge-vs" aria-hidden="true">
              vs
            </span>
            {renderPlayer(otherSide, otherLabel)}
          </div>

          {/* Stake line — the coins on the line while the match is live. */}
          {!complete && hasStake ? (
            <div className="challenge-stake">
              <span aria-hidden="true">🏆</span> Playing for {stake} coins
            </div>
          ) : null}

          {unsaved ? (
            <div className="challenge-unsaved" role="alert">
              <span>
                Your round{pendingToPar != null ? ` (${fmtToPar(pendingToPar)})` : ''} didn’t
                reach the server. It’s saved on this device.
              </span>
              <button
                type="button"
                className="challenge-retry"
                onClick={() => void runSubmit(queuedRef.current)}
              >
                Retry
              </button>
            </div>
          ) : save === 'saving' ? (
            <div className="challenge-wait">Saving your round…</div>
          ) : myTurn ? (
            <button
              type="button"
              className="challenge-play"
              onClick={() => setPlaying(true)}
            >
              <span aria-hidden="true">⛳</span> Play your round
            </button>
          ) : waiting ? (
            <div className="challenge-wait">
              Waiting for {otherSide.displayName}…
            </div>
          ) : complete ? (
            <div className={`challenge-outcome ${outcomeClass}`}>
              {outcomeText}
            </div>
          ) : null}
        </div>
      </div>

      {playing
        ? createPortal(
        <CourseGame
          course={course}
          // Single-hole challenge: play just the chosen hole and submit on
          // onHoleComplete. Full-round challenge: play the whole course and
          // submit on onRoundComplete. Both funnel to the same one-shot submit.
          {...(isSingleHole ? { startHole: ch.hole! } : {})}
          seed={ch.seed}
          onRoundComplete={
            isSingleHole
              ? undefined
              : (r) => submitResult(r.courseId, r.toPar, r.holes)
          }
          onHoleComplete={
            isSingleHole
              ? (r) => submitResult(r.courseId, r.toPar, 1)
              : undefined
          }
          onExit={() => setPlaying(false)}
        />,
            document.body,
          )
        : null}
    </div>
  );
}
