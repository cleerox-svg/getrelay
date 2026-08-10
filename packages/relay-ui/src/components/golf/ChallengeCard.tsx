import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Avatar } from '../Avatar';
import CourseGame from './CourseGame';
import { api } from '../../lib/api';
import { getCourse } from '../../lib/golf/courses';
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

  const myTurn = mySide.toPar == null;
  const waiting = mySide.toPar != null && otherSide.toPar == null && ch.status !== 'complete';
  const complete = ch.status === 'complete';

  // Outcome (complete only): win = I hold the winnerId, tie = no winnerId.
  const won = complete && ch.winnerId != null && ch.winnerId === mySide.userId;
  const tied = complete && ch.winnerId == null;
  const lost = complete && !won && !tied;

  const outcomeClass = won ? 'is-win' : lost ? 'is-loss' : 'is-tie';

  function renderPlayer(p: ChallengeParticipant, label: string) {
    return (
      <div className="challenge-player">
        <Avatar src={p.avatarUrl} name={p.displayName} size={32} />
        <div className="challenge-player-meta">
          <span className="challenge-player-name">{p.displayName}</span>
          <span className="challenge-player-role">{label}</span>
        </div>
        <span className="challenge-player-score">
          {p.toPar == null ? '—' : fmtToPar(p.toPar)}
        </span>
      </div>
    );
  }

  return (
    // Stop clicks/taps from bubbling to the chat bubble's onClick (which opens
    // the message-actions sheet) — otherwise every shot inside the CourseGame
    // overlay (a DOM descendant) would pop the sheet and make the round
    // unplayable.
    <div className="challenge-card-wrap" onClick={(e) => e.stopPropagation()}>
      <div className="challenge-card" role="group" aria-label="Golf challenge">
        <div className="challenge-card-head">
          <span className="challenge-card-flag" aria-hidden="true">
            ⛳
          </span>
          <div className="challenge-card-titles">
            <span className="challenge-card-eyebrow">Golf challenge</span>
            <span className="challenge-card-course">{course.name}</span>
          </div>
        </div>

        <div className="challenge-players">
          {renderPlayer(mySide, 'You')}
          <span className="challenge-vs" aria-hidden="true">
            vs
          </span>
          {renderPlayer(otherSide, 'Opponent')}
        </div>

        {myTurn ? (
          <button
            type="button"
            className="challenge-play"
            onClick={() => setPlaying(true)}
          >
            Play your round
          </button>
        ) : waiting ? (
          <div className="challenge-status">
            Waiting for {otherSide.displayName}…
            <span className="challenge-status-score">
              Your round · {mySide.toPar == null ? '—' : fmtToPar(mySide.toPar)}
            </span>
          </div>
        ) : complete ? (
          <div className={`challenge-outcome ${outcomeClass}`}>
            {won ? 'You win' : lost ? 'You lost' : 'Tie'}
          </div>
        ) : null}
      </div>

      {playing
        ? createPortal(
        <CourseGame
          course={course}
          // Challenges are always full-round (created without a hole). Ignore
          // any hole so the round can complete — single-hole mode never fires
          // onRoundComplete, which would strand the challenge on "your turn".
          seed={ch.seed}
          onRoundComplete={(r) => {
            if (submittedRef.current) return;
            submittedRef.current = true;
            // Optimistically record my to-par so the card leaves "your turn"
            // even if the refetch below fails.
            setCh((prev) =>
              prev
                ? ({ ...prev, [prev.mine]: { ...prev[prev.mine], toPar: r.toPar } } as Challenge)
                : prev,
            );
            // Record the challenge result AND count the round on the golfcourse
            // board/profile (matches GolfScreen's course-mode submit shape).
            Promise.allSettled([
              api.submitChallengeResult(id, r.toPar),
              api.submitGameScore({
                game: 'golfcourse',
                course: r.courseId,
                toPar: r.toPar,
                rounds: r.holes,
                bestStreak: 0,
                score: 0,
              }),
            ])
              .then(() => api.getChallenge(id))
              .then((res) => setCh(res.challenge))
              .catch(() => undefined)
              .finally(() => setPlaying(false));
          }}
          onExit={() => setPlaying(false)}
        />,
            document.body,
          )
        : null}
    </div>
  );
}
