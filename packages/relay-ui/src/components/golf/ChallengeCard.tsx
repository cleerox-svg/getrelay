import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../Avatar';
import CourseGame from './CourseGame';
import { api } from '../../lib/api';
import { getCourse } from '../../lib/golf/courses';
import { useEconomy } from '../../lib/golf/economy';
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
  const [failed, setFailed] = useState(false);
  const [playing, setPlaying] = useState(false);
  // One-shot: a round's result is submitted at most once, even though
  // CourseGame's "Play round again" resets its own onRoundComplete guard.
  const submittedRef = useRef(false);
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

  if (failed) {
    return <span className="challenge-chip">Challenge unavailable</span>;
  }
  if (!ch) {
    return <span className="challenge-chip">Loading challenge…</span>;
  }

  const mySide: ChallengeParticipant = ch[ch.mine];
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

  // Shared one-shot submit for both the full-round (onRoundComplete) and the
  // single-hole (onHoleComplete) callbacks: record the challenge to-par,
  // optimistically clear "your turn", count the play on the golfcourse board,
  // then refetch. `rounds` is the completed round's holes, or 1 for a hole.
  function submitResult(courseId: string, toPar: number, rounds: number) {
    if (submittedRef.current) return;
    submittedRef.current = true;
    // Optimistically record my to-par so the card leaves "your turn" even if
    // the refetch below fails.
    setCh((prev) =>
      prev
        ? ({ ...prev, [prev.mine]: { ...prev[prev.mine], toPar } } as Challenge)
        : prev,
    );
    // Always settle the challenge. Only a FULL round also counts on the shared
    // golfcourse board/profile — a single challenge hole's to-par isn't
    // comparable to a full round (it would outrank real rounds and inflate
    // rounds-played), so single-hole challenges settle the head-to-head only.
    const tasks: Promise<unknown>[] = [api.submitChallengeResult(id, toPar)];
    if (rounds > 1) {
      tasks.push(
        api.submitGameScore({
          game: 'golfcourse',
          course: courseId,
          toPar,
          rounds,
          bestStreak: 0,
          score: 0,
        }),
      );
    }
    Promise.allSettled(tasks)
      .then(() => api.getChallenge(id))
      .then((res) => {
        setCh(res.challenge);
        // If this submission SETTLED the match, the worker may have credited me
        // coins — a win OR a tie both pay the viewer (a loss pays 0, but a
        // refresh is harmless). The card only renders challenges I'm in, so any
        // completion is a completion I participate in: force-refresh the wallet
        // so the hub coin chip reflects the new balance. ensureWallet swallows
        // its own errors, so this is a no-op when unauthed / offline.
        if (res.challenge.status === 'complete') {
          void ensureWallet(true);
        }
      })
      .catch(() => undefined)
      .finally(() => setPlaying(false));
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
  const stateText = myTurn ? 'Your turn' : waiting ? 'Waiting' : complete ? 'Final' : '';
  const stateClass = myTurn ? 'is-turn' : waiting ? 'is-wait' : 'is-done';

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

          {myTurn ? (
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
