import { useRef, useState } from 'react';
import { GOLF_COURSES, getCourse } from '../../lib/golf/courses';
import { ApiError, api } from '../../lib/api';
import { useStore } from '../../lib/store';

interface Props {
  // Who we're challenging.
  opponentId: string;
  opponentName: string;
  // When we're ALREADY inside the 1:1 chat (composer flow) pass its id so the
  // challenge message drops into this chat without opening/creating one. Omit it
  // (games-hub flow) and we open/reuse the 1to1 chat via the store.
  chatId?: string;
  // Seed the course selection (e.g. the games hub's featured course). Falls back
  // to the first course.
  initialCourseId?: string;
  onClose: () => void;
  // Fired after the `relay://challenge/<id>` message is sent, with the chat id it
  // landed in — callers use this to navigate to the chat (games hub) or no-op
  // (already in the chat).
  onSent?: (chatId: string) => void;
}

// The shared "start a golf challenge" bottom sheet: pick a course, full round vs
// a single hole (default single hole, hole 0), then create the challenge and
// drop the `relay://challenge/<id>` message on the store send path. Used by both
// the games-hub GolfMenu (after an opponent is chosen) and the 1:1 chat composer
// (opponent is the peer you're talking to).
export function NewChallengeSheet({
  opponentId,
  opponentName,
  chatId,
  initialCourseId,
  onClose,
  onSent,
}: Props) {
  const openOneToOne = useStore((s) => s.openOneToOne);
  const sendText = useStore((s) => s.sendText);

  const [courseId, setCourseId] = useState<string>(() => {
    return initialCourseId && GOLF_COURSES.some((c) => c.id === initialCourseId)
      ? initialCourseId
      : GOLF_COURSES[0]!.id;
  });
  const [mode, setMode] = useState<'full' | 'single'>('single');
  const [holeIdx, setHoleIdx] = useState(0);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // If the challenge was created but sending the chat message failed (e.g.
  // openOneToOne threw), a retry must REUSE this id rather than mint a second
  // orphan challenge server-side.
  const createdRef = useRef<string | null>(null);

  const course = getCourse(courseId);

  // Keep the hole index valid when switching courses (holes count varies).
  const pickCourse = (id: string) => {
    setCourseId(id);
    setHoleIdx((i) => Math.min(i, Math.max(0, getCourse(id).holes.length - 1)));
  };

  const create = async () => {
    if (creating) return;
    setCreating(true);
    setError(null);
    try {
      // Reuse an already-created challenge on retry so a failed chat-open
      // doesn't leave a trail of orphan challenges.
      if (!createdRef.current) {
        const { challenge } = await api.createChallenge({
          opponentId,
          game: 'golfcourse',
          course: courseId,
          hole: mode === 'single' ? holeIdx : undefined,
        });
        createdRef.current = challenge.id;
      }
      const cid = chatId ?? (await openOneToOne(opponentId));
      sendText(cid, `relay://challenge/${createdRef.current}`);
      onClose();
      onSent?.(cid);
    } catch (e) {
      setError(
        e instanceof ApiError && e.status === 403
          ? `You can only challenge your contacts. Add ${opponentName} first.`
          : 'Could not start the challenge. Try again.',
      );
      setCreating(false);
    }
  };

  return (
    <div
      className="challenge-picker-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={`Challenge ${opponentName} to golf`}
      onClick={() => {
        if (!creating) onClose();
      }}
    >
      <div className="challenge-picker-sheet" onClick={(e) => e.stopPropagation()}>
        <div className="challenge-picker-head">
          <span>Challenge {opponentName}</span>
          <button
            type="button"
            className="challenge-picker-close"
            aria-label="Close"
            onClick={() => {
              if (!creating) onClose();
            }}
          >
            ×
          </button>
        </div>
        <div className="challenge-picker-sub">
          {mode === 'full'
            ? `Full round · ${course.name}`
            : `${course.name} · Hole ${course.holes[holeIdx]?.id ?? holeIdx + 1}`}
        </div>

        {/* Course picker. */}
        <div className="challenge-courses" role="radiogroup" aria-label="Choose a course">
          {GOLF_COURSES.map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={courseId === c.id}
              className={`challenge-course-chip${courseId === c.id ? ' is-on' : ''}`}
              disabled={creating}
              onClick={() => pickCourse(c.id)}
            >
              {c.name}
            </button>
          ))}
        </div>

        {/* Length: full round vs a single hole. */}
        <div className="challenge-len" role="radiogroup" aria-label="Challenge length">
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'full'}
            className={`challenge-len-chip${mode === 'full' ? ' is-on' : ''}`}
            disabled={creating}
            onClick={() => setMode('full')}
          >
            Full round
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={mode === 'single'}
            className={`challenge-len-chip${mode === 'single' ? ' is-on' : ''}`}
            disabled={creating}
            onClick={() => setMode('single')}
          >
            Single hole
          </button>
        </div>

        {mode === 'single' ? (
          <div className="challenge-holes" role="radiogroup" aria-label="Choose a hole">
            {course.holes.map((h, i) => (
              <button
                key={h.id}
                type="button"
                role="radio"
                aria-checked={holeIdx === i}
                className={`challenge-hole-chip${holeIdx === i ? ' is-on' : ''}`}
                disabled={creating}
                onClick={() => setHoleIdx(i)}
              >
                {h.id}
                {h.name ? <span className="challenge-hole-name"> · {h.name}</span> : null}
              </button>
            ))}
          </div>
        ) : null}

        {error ? <div className="challenge-picker-error">{error}</div> : null}

        <button
          type="button"
          className="challenge-confirm"
          disabled={creating}
          onClick={create}
        >
          <span className="g-sheen" aria-hidden="true" />
          {creating ? 'Sending…' : 'Send challenge'}
        </button>
      </div>
    </div>
  );
}
