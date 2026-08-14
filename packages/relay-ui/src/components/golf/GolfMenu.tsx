import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  getGolfStats,
  getRangeStats,
  getLastCourseId,
  setLastCourseId,
  getLastPuttCourseId,
  setLastPuttCourseId,
} from '../../lib/golf/stats';
import { CLUBS, DEFAULT_CLUB_ID } from '../../lib/golf/clubs';
import { GOLF_COURSES, getCourse } from '../../lib/golf/courses';
import type { GolfCourse } from '../../lib/golf/courses';
import { PUTT_COURSES } from '../../lib/golf/puttCourses';
import type { PuttCourse } from '../../lib/golf/puttCourses';
import { Avatar } from '../Avatar';
import { HoleThumb } from './HoleThumb';
import { NewChallengeSheet } from './NewChallengeSheet';
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
  // The hole map-card the user last picked (course single-hole grid), purely for
  // the selected/Fairway highlight + radio aria-checked; picking still starts the
  // hole immediately (behavior unchanged from the old chips).
  const [pickedHoleIdx, setPickedHoleIdx] = useState<number | null>(null);

  // Mini-Golf course picker — mirrors the Course-mode picker above but over
  // PUTT_COURSES, with its OWN expand toggle, highlighted course (seeded from
  // the persisted last mini course) and single-hole chip target.
  const [puttExpanded, setPuttExpanded] = useState(false);
  const [selectedPuttCourseId, setSelectedPuttCourseId] = useState<string>(() => {
    const last = getLastPuttCourseId();
    return last && PUTT_COURSES.some((c) => c.id === last) ? last : PUTT_COURSES[0]!.id;
  });
  const [pickPuttHoleFor, setPickPuttHoleFor] = useState<string | null>(null);

  // Challenge-a-friend flow: pick an opponent from the contact list, then hand
  // off to the shared NewChallengeSheet (course / length / hole + create+send).
  // On send it opens (or reuses) the 1to1 chat, drops a `relay://challenge/<id>`
  // message on the SAME send path as the composer, then lands in that chat so
  // the challenger can play their round from the card.
  const nav = useNavigate();
  const contacts = useStore((s) => s.contacts);
  const loadContacts = useStore((s) => s.loadContacts);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Contacts aren't fetched for this screen otherwise, so pull them in (mirrors
  // NewGroup / Contacts) and track the in-flight state so the picker can show
  // "Loading…" instead of a false "no contacts" while the request is pending.
  const [contactsLoading, setContactsLoading] = useState(false);
  // Opponent chosen from the list; once set we render the shared challenge sheet.
  const [opponent, setOpponent] = useState<Contact | null>(null);

  useEffect(() => {
    if (contacts.length === 0) {
      setContactsLoading(true);
      loadContacts()
        .catch(() => undefined)
        .finally(() => setContactsLoading(false));
    }
    // Load once on mount, matching the NewGroup / Contacts idiom.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Open the opponent picker fresh (clear any prior selection).
  const openChallengePicker = () => {
    setOpponent(null);
    setPickerOpen(true);
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

  // Mini-Golf start handlers — the same encoding contract as Course mode, but
  // through onStart('putt', …): "<id>" = full round, "<id>#<holeIdx>" = single
  // hole (0-based). GolfScreen parses it and threads the resolved PuttCourse
  // into GolfGame. The chosen mini course is persisted for next time.
  const startPuttRound = (c: PuttCourse) => {
    setLastPuttCourseId(c.id);
    onStart('putt', c.id);
  };
  const startPuttHole = (c: PuttCourse, idx: number) => {
    setLastPuttCourseId(c.id);
    onStart('putt', `${c.id}#${idx}`);
  };

  const togglePuttPicker = () => setPuttExpanded((e) => !e);

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
            onClick={openChallengePicker}
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
                      setPickedHoleIdx(null);
                    }}
                    className={`golf-course flex flex-col text-left${active ? ' is-active' : ''}`}
                    style={{ borderRadius: 12, padding: 12 }}
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
                          className="golf-cta flex-1 rounded-xl py-2.5 text-[14px] font-bold"
                          onClick={() => startFullRound(c)}
                        >
                          <span className="g-sheen" aria-hidden="true" />
                          Full round
                        </button>
                        <button
                          type="button"
                          className={`golf-toggle flex-1 rounded-xl py-2.5 text-[14px] font-bold${
                            pickHoleFor === c.id ? ' is-armed' : ''
                          }`}
                          onClick={() => {
                            setPickedHoleIdx(null);
                            setPickHoleFor((p) => (p === c.id ? null : c.id));
                          }}
                        >
                          Single hole
                        </button>
                      </div>

                      {pickHoleFor === c.id ? (
                        <div
                          className="golf-holegrid"
                          role="radiogroup"
                          aria-label={`Choose a hole on ${c.name}`}
                        >
                          {c.holes.map((h, i) => {
                            const sel = pickedHoleIdx === i;
                            const hasWater = h.hazards.some((z) => z.kind === 'water');
                            const hasSand = h.hazards.some((z) => z.kind === 'bunker');
                            return (
                              <button
                                key={h.id}
                                type="button"
                                role="radio"
                                aria-checked={sel}
                                className={`golf-holecard${sel ? ' is-sel' : ''}`}
                                onClick={() => {
                                  setPickedHoleIdx(i);
                                  startSingleHole(c, i);
                                }}
                              >
                                <span className="golf-holecard-thumb">
                                  <HoleThumb hole={h} size={112} detail />
                                  <span className="golf-holecard-num">{h.id}</span>
                                  {hasWater || hasSand ? (
                                    <span className="golf-holecard-hzs">
                                      {hasSand ? (
                                        <span
                                          className="golf-holecard-hz sand"
                                          title="Bunker"
                                        />
                                      ) : null}
                                      {hasWater ? (
                                        <span
                                          className="golf-holecard-hz water"
                                          title="Water hazard"
                                        />
                                      ) : null}
                                    </span>
                                  ) : null}
                                </span>
                                <span className="golf-holecard-cap">
                                  <span className="golf-holecard-name">
                                    {h.name ?? `Hole ${h.id}`}
                                  </span>
                                  <span className="golf-holecard-meta">
                                    Par {h.par} · {h.yards} yd
                                  </span>
                                </span>
                              </button>
                            );
                          })}
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
        <button
          type="button"
          className="golf-mode mini"
          aria-expanded={puttExpanded}
          onClick={togglePuttPicker}
        >
          <span className="g-cap" aria-hidden="true">
            <span className="g-pin" />
            <span className="g-ball" />
          </span>
          <span className="g-mbody">
            <b>Mini-Golf</b>
            <p>Themed short courses. Drag to aim, release to putt.</p>
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
            <p>Real 3D. Carry the water to island pins.</p>
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
            <p>Full 3D round, or a single hole.</p>
          </span>
        </button>
      </div>

      {/* ---- Mini-Golf course picker (revealed by the Mini-Golf mode tile) ---- */}
      {puttExpanded ? (
        <div
          className="flex flex-col gap-3 rounded-2xl p-3"
          style={{ background: 'var(--bubble-them)' }}
        >
          <div className="text-[10px] font-bold tracking-wider" style={{ color: 'var(--text-dim)' }}>
            CHOOSE A MINI-GOLF COURSE
          </div>
          <div className="flex flex-col gap-2">
            {PUTT_COURSES.map((c) => {
              const active = c.id === selectedPuttCourseId;
              return (
                <div key={c.id} className="flex flex-col gap-2">
                  <button
                    type="button"
                    onClick={() => {
                      setSelectedPuttCourseId(c.id);
                      setPickPuttHoleFor(null);
                    }}
                    className={`golf-course flex flex-col text-left${active ? ' is-active' : ''}`}
                    style={{ borderRadius: 12, padding: 12 }}
                  >
                    <div className="text-[14px] font-bold" style={{ color: 'var(--text)' }}>
                      {c.name}
                    </div>
                    <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                      {c.theme}
                    </div>
                    <div className="text-[11px] pt-0.5" style={{ color: 'var(--text-dim)' }}>
                      {c.holes.length} holes · par {c.par}
                    </div>
                  </button>

                  {active ? (
                    <div className="flex flex-col gap-2 pl-1">
                      <div className="flex gap-2">
                        <button
                          type="button"
                          className="golf-cta flex-1 rounded-xl py-2.5 text-[14px] font-bold"
                          onClick={() => startPuttRound(c)}
                        >
                          <span className="g-sheen" aria-hidden="true" />
                          Full round
                        </button>
                        <button
                          type="button"
                          className={`golf-toggle flex-1 rounded-xl py-2.5 text-[14px] font-bold${
                            pickPuttHoleFor === c.id ? ' is-armed' : ''
                          }`}
                          onClick={() =>
                            setPickPuttHoleFor((p) => (p === c.id ? null : c.id))
                          }
                        >
                          Single hole
                        </button>
                      </div>

                      {pickPuttHoleFor === c.id ? (
                        <div className="flex flex-wrap gap-1.5">
                          {c.holes.map((h, i) => (
                            <button
                              key={i}
                              type="button"
                              className="golf-chip"
                              onClick={() => startPuttHole(c, i)}
                            >
                              {i + 1}
                              {h.name ? (
                                <span style={{ opacity: 0.6 }}> · {h.name}</span>
                              ) : (
                                <span style={{ opacity: 0.6 }}> · par {h.par}</span>
                              )}
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
                    className={`golf-chip${active ? ' is-on' : ''}`}
                    onClick={() => setClubId(c.id)}
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
              className="golf-cta flex-1 rounded-xl py-3 text-[15px] font-bold"
              onClick={() => onStart('range-challenge', clubId)}
            >
              <span className="g-sheen" aria-hidden="true" />
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

      {/* ---- Opponent picker (choose who to challenge) ---- */}
      {pickerOpen ? (
        <div
          className="challenge-picker-backdrop"
          role="dialog"
          aria-modal="true"
          aria-label="Challenge a friend"
          onClick={() => setPickerOpen(false)}
        >
          <div className="challenge-picker-sheet" onClick={(e) => e.stopPropagation()}>
            <div className="challenge-picker-head">
              <span>Challenge a friend</span>
              <button
                type="button"
                className="challenge-picker-close"
                aria-label="Close"
                onClick={() => setPickerOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="challenge-picker-sub">Pick who to challenge</div>

            {contactsLoading ? (
              <div className="challenge-picker-empty">Loading contacts…</div>
            ) : contacts.length === 0 ? (
              <div className="challenge-picker-empty">
                No contacts yet — add one in Contacts
              </div>
            ) : (
              <div className="challenge-picker-list">
                {contacts.map((c) => (
                  <button
                    key={c.id}
                    type="button"
                    className="challenge-picker-row"
                    onClick={() => {
                      setOpponent(c);
                      setPickerOpen(false);
                    }}
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

      {/* ---- Shared challenge sheet (course / length / hole + send) ---- */}
      {opponent ? (
        <NewChallengeSheet
          opponentId={opponent.id}
          opponentName={opponent.alias ?? opponent.displayName}
          initialCourseId={selectedCourseId}
          onClose={() => setOpponent(null)}
          onSent={(chatId) => nav(`/chats/${encodeURIComponent(chatId)}`)}
        />
      ) : null}
    </div>
  );
}
