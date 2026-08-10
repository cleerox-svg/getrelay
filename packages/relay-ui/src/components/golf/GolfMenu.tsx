import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getGolfStats,
  getRangeStats,
  getLastCourseId,
  setLastCourseId,
} from '../../lib/golf/stats';
import { CLUBS, DEFAULT_CLUB_ID } from '../../lib/golf/clubs';
import { GOLF_COURSES, getCourse } from '../../lib/golf/courses';
import type { GolfCourse } from '../../lib/golf/courses';
import { Avatar } from '../Avatar';
import { api } from '../../lib/api';
import { useStore } from '../../lib/store';
import type { Contact } from '../../lib/types';

// The two flows behind the single "Golf" chiclet: Phase-1 putting and the
// Phase-2 driving range (open practice or the scored Target Challenge).
export type GolfSubMode = 'putt' | 'range-practice' | 'range-challenge' | 'course';

interface Props {
  onStart: (mode: GolfSubMode, clubId?: string) => void;
  // Bump to re-read local personal bests after a submit lands.
  refreshKey: number;
}

// Small play triangle used on the hero CTA.
function PlayIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <path d="M8 5v14l11-7z" />
    </svg>
  );
}

// The Play tab of the golf hub, rebuilt "broadcast"-style: a painted course
// hero for the selected course with a big PLAY ROUND CTA and a Change-course
// affordance (the existing full course picker), a compact local-bests strip,
// and a mode strip (Mini-Golf / Driving Range / Course). All onStart(...)
// call contracts and the club/course selection logic are preserved from the
// original menu — this is a visual/layout rebuild, not a behavior change.
export function GolfMenu({ onStart, refreshKey }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [clubId, setClubId] = useState(DEFAULT_CLUB_ID);

  // Course picker: expand toggle, the highlighted course (seeded from the last
  // played), and — when "Single hole" is chosen — which course's hole chips show.
  const [courseExpanded, setCourseExpanded] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState<string>(() => {
    const last = getLastCourseId();
    return last && GOLF_COURSES.some((c) => c.id === last) ? last : GOLF_COURSES[0]!.id;
  });
  const [pickHoleFor, setPickHoleFor] = useState<string | null>(null);

  // Challenge-a-friend flow: opponent picker overlay + create state. Creating a
  // challenge opens (or reuses) the 1to1 chat, drops a `relay://challenge/<id>`
  // message on the SAME send path as the composer, then lands in that chat so
  // the challenger can play their round from the card.
  const nav = useNavigate();
  const contacts = useStore((s) => s.contacts);
  const openOneToOne = useStore((s) => s.openOneToOne);
  const sendText = useStore((s) => s.sendText);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [challengeError, setChallengeError] = useState<string | null>(null);

  const challengeFriend = async (contact: Contact) => {
    if (creating) return;
    setCreating(true);
    setChallengeError(null);
    try {
      const { challenge } = await api.createChallenge({
        opponentId: contact.id,
        game: 'golfcourse',
        course: selectedCourseId,
      });
      const chatId = await openOneToOne(contact.id);
      sendText(chatId, `relay://challenge/${challenge.id}`);
      setPickerOpen(false);
      nav(`/chats/${encodeURIComponent(chatId)}`);
    } catch {
      setChallengeError('Could not start the challenge. Try again.');
    } finally {
      setCreating(false);
    }
  };

  // Local personal bests for the stat strip. Re-read on refreshKey so a fresh
  // submit updates the strip without a network round-trip (works offline too).
  const puttStats = useMemo(() => getGolfStats(), [refreshKey]);
  const rangeStats = useMemo(() => getRangeStats(), [refreshKey]);
  const hasLocalStats = puttStats.gamesPlayed > 0 || rangeStats.gamesPlayed > 0;

  const heroCourse = getCourse(selectedCourseId);

  // Course-start handlers. The course choice is threaded through onStart's
  // existing optional string arg using the encoding contract the Fog pass
  // parses: "<courseId>" = full round, "<courseId>#<holeIdx>" = single hole
  // (holeIdx 0-based). The last-played course is persisted for next time.
  const startFullRound = (c: GolfCourse) => {
    setLastCourseId(c.id);
    onStart('course', c.id);
  };
  const startSingleHole = (c: GolfCourse, idx: number) => {
    setLastCourseId(c.id);
    onStart('course', `${c.id}#${idx}`);
  };

  const toggleCoursePicker = () => setCourseExpanded((e) => !e);

  return (
    <div className="flex flex-col gap-4">
      {/* ---- Broadcast course hero for the selected course ---- */}
      <div className="golf-hero">
        <div className="golf-hero-art" aria-hidden="true">
          <span className="g-sun" />
          <span className="g-fairway" />
          <span className="g-bunker" />
          <span className="g-water" />
          <span className="g-green" />
          <span className="g-flag" />
        </div>
        <div className="golf-hero-grad" aria-hidden="true" />
        <div className="golf-hero-tag">
          <span>Featured course</span>
          <span className="g-par">
            PAR {heroCourse.par} · {heroCourse.yards.toLocaleString()} YD
          </span>
        </div>
        <div className="golf-hero-body">
          {heroCourse.location ? <p className="golf-hero-loc">{heroCourse.location}</p> : null}
          <h2 className="golf-hero-title">{heroCourse.name}</h2>
          <div className="golf-hero-meta">
            <span>
              <b>{heroCourse.holes.length}</b> holes
            </span>
            <span>
              par <b>{heroCourse.par}</b>
            </span>
            <span>
              <b>{heroCourse.yards.toLocaleString()}</b> yd
            </span>
          </div>
          <div className="golf-play-row">
            <button
              type="button"
              className="golf-play"
              onClick={() => startFullRound(heroCourse)}
            >
              <span className="g-sheen" aria-hidden="true" />
              <PlayIcon />
              Play round
            </button>
            <button
              type="button"
              className="golf-change"
              aria-expanded={courseExpanded}
              onClick={toggleCoursePicker}
            >
              {courseExpanded ? 'Close' : 'Change course'}
            </button>
          </div>
          <button
            type="button"
            className="golf-challenge-cta"
            onClick={() => {
              setChallengeError(null);
              setPickerOpen(true);
            }}
          >
            <span aria-hidden="true">⛳</span>
            Challenge a friend
          </button>
        </div>
      </div>

      {/* ---- Course picker (revealed by Change course / the Course mode) ---- */}
      {courseExpanded ? (
        <div
          className="flex flex-col gap-3 rounded-2xl p-3"
          style={{ background: 'var(--bubble-them)' }}
        >
          <div className="text-[10px] font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
            CHOOSE A COURSE
          </div>
          <div className="flex flex-col gap-2">
            {GOLF_COURSES.map((c) => {
              const active = c.id === selectedCourseId;
              return (
                <div key={c.id} className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedCourseId(c.id);
                      setPickHoleFor(null);
                    }}
                    className="flex flex-col text-left"
                    style={{
                      border: `1px solid ${active ? 'var(--accent)' : 'var(--separator)'}`,
                      background: 'var(--card-bg)',
                      borderRadius: 12,
                      padding: 12,
                    }}
                  >
                    <div className="text-[14px] font-bold" style={{ color: 'var(--text)' }}>
                      {c.name}
                    </div>
                    {c.location ? (
                      <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                        {c.location}
                      </div>
                    ) : null}
                    <div className="text-[11px] pt-0.5" style={{ color: 'var(--text-dim)' }}>
                      {c.holes.length} holes · par {c.par} · {c.yards.toLocaleString()} yd
                    </div>
                  </button>

                  {active ? (
                    <div className="flex flex-col gap-2 pl-1">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="flex-1 rounded-xl py-2.5 text-[14px] font-bold"
                          style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
                          onClick={() => startFullRound(c)}
                        >
                          Full round
                        </button>
                        <button
                          type="button"
                          className="flex-1 rounded-xl py-2.5 text-[14px] font-bold"
                          style={{
                            background: pickHoleFor === c.id ? 'var(--accent)' : 'var(--card-bg)',
                            color: pickHoleFor === c.id ? '#FFFFFF' : 'var(--text)',
                            border: '1px solid var(--separator)',
                          }}
                          onClick={() => setPickHoleFor((p) => (p === c.id ? null : c.id))}
                        >
                          Single hole
                        </button>
                      </div>

                      {pickHoleFor === c.id ? (
                        <div className="flex flex-wrap gap-1.5">
                          {c.holes.map((h, i) => (
                            <button
                              key={h.id}
                              type="button"
                              onClick={() => startSingleHole(c, i)}
                              style={{
                                border: '1px solid var(--separator)',
                                background: 'var(--card-bg)',
                                color: 'var(--text)',
                                borderRadius: 10,
                                padding: '5px 9px',
                                fontSize: 12,
                                fontWeight: 600,
                              }}
                            >
                              {h.id}
                              {h.name ? <span style={{ opacity: 0.6 }}> · {h.name}</span> : null}
                            </button>
                          ))}
                        </div>
                      ) : null}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </div>
      ) : null}

      {/* ---- Local personal-bests strip ---- */}
      {hasLocalStats ? (
        <div className="golf-statstrip">
          <div className="golf-stat">
            <span>Mini-golf best</span>
            <b className="under">{puttStats.bestScore.toLocaleString()}</b>
            <small>
              {puttStats.gamesPlayed} game{puttStats.gamesPlayed === 1 ? '' : 's'}
            </small>
          </div>
          <div className="golf-stat">
            <span>Range best</span>
            <b className="under">{rangeStats.bestScore.toLocaleString()}</b>
            <small>
              {rangeStats.gamesPlayed} game{rangeStats.gamesPlayed === 1 ? '' : 's'}
            </small>
          </div>
          <div className="golf-stat">
            <span>Best streak</span>
            <b>×{Math.max(puttStats.bestStreak, rangeStats.bestStreak)}</b>
            <small>on this device</small>
          </div>
        </div>
      ) : null}

      {/* ---- Mode strip ---- */}
      <div className="golf-sec-h">
        <h3>Ways to play</h3>
      </div>
      <div className="golf-modes">
        <button type="button" className="golf-mode mini" onClick={() => onStart('putt')}>
          <span className="g-cap" aria-hidden="true">
            <span className="g-pin" />
            <span className="g-ball" />
          </span>
          <span className="g-mbody">
            <b>Mini-Golf</b>
            <p>Six top-down holes. Drag back to aim, release to putt.</p>
          </span>
        </button>

        <button
          type="button"
          className="golf-mode range"
          aria-expanded={expanded}
          onClick={() => setExpanded((e) => !e)}
        >
          <span className="g-cap" aria-hidden="true">
            <span className="g-ball" />
          </span>
          <span className="g-mbody">
            <b>Driving Range</b>
            <p>Real 3D. Carry the water, land the island targets.</p>
          </span>
        </button>

        <button
          type="button"
          className="golf-mode course"
          aria-expanded={courseExpanded}
          onClick={toggleCoursePicker}
        >
          <span className="g-cap" aria-hidden="true">
            <span className="g-pin" />
            <span className="g-ball" />
          </span>
          <span className="g-mbody">
            <b>Course</b>
            <p>Full 3D round with a scorecard, or a single hole.</p>
          </span>
        </button>
      </div>

      {/* ---- Driving-range expansion: starting club + Practice / Challenge ---- */}
      {expanded ? (
        <div
          className="flex flex-col gap-3 rounded-2xl p-3"
          style={{ background: 'var(--bubble-them)' }}
        >
          {/* Starting club (changeable in-game too). */}
          <div>
            <div
              className="text-[10px] font-bold tracking-wider pb-1.5"
              style={{ color: 'var(--text-dim)' }}
            >
              STARTING CLUB
            </div>
            <div className="flex flex-wrap gap-1.5">
              {CLUBS.map((c) => {
                const active = c.id === clubId;
                return (
                  <button
                    key={c.id}
                    type="button"
                    onClick={() => setClubId(c.id)}
                    style={{
                      border: '1px solid var(--separator)',
                      background: active ? 'var(--accent)' : 'var(--card-bg)',
                      color: active ? '#FFFFFF' : 'var(--text)',
                      borderRadius: 999,
                      padding: '5px 10px',
                      fontSize: 12,
                      fontWeight: 600,
                    }}
                  >
                    {c.name}
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex gap-2">
            <button
              type="button"
              className="flex-1 rounded-xl py-3 text-[15px] font-bold"
              style={{ background: 'var(--accent)', color: '#FFFFFF', border: 0 }}
              onClick={() => onStart('range-challenge', clubId)}
            >
              Target Challenge
            </button>
            <button
              type="button"
              className="flex-1 rounded-xl py-3 text-[15px] font-bold"
              style={{
                background: 'var(--card-bg)',
                color: 'var(--text)',
                border: '1px solid var(--separator)',
              }}
              onClick={() => onStart('range-practice', clubId)}
            >
              Practice
            </button>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            Target Challenge: 8 balls at random island pins — closest to the flag scores. Practice:
            unlimited balls, no scoring.
          </div>
        </div>
      ) : null}

      {/* ---- Opponent picker (challenge a friend) ---- */}
      {pickerOpen ? (
        <div
          className="challenge-picker-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Challenge a friend"
          onClick={() => {
            if (!creating) setPickerOpen(false);
          }}
        >
          <div className="challenge-picker-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="challenge-picker-head">
              <span>Challenge a friend</span>
              <button
                type="button"
                className="challenge-picker-close"
                aria-label="Close"
                onClick={() => {
                  if (!creating) setPickerOpen(false);
                }}
              >
                ×
              </button>
            </div>
            <div className="challenge-picker-sub">
              Full round · {getCourse(selectedCourseId).name}
            </div>
            {challengeError ? (
              <div className="challenge-picker-error">{challengeError}</div>
            ) : null}
            {contacts.length === 0 ? (
              <div className="challenge-picker-empty">Add a contact to challenge them</div>
            ) : (
              <div className="challenge-picker-list">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="challenge-picker-row"
                    disabled={creating}
                    onClick={() => challengeFriend(c)}
                  >
                    <Avatar src={c.avatarUrl} name={c.alias ?? c.displayName} size={36} />
                    <span className="challenge-picker-name">{c.alias ?? c.displayName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
