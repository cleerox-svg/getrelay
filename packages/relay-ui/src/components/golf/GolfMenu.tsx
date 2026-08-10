import { useState } from 'react';
import { GolfLeaderboard } from './GolfLeaderboard';
import { getGolfStats, getRangeStats, getLastCourseId, setLastCourseId } from '../../lib/golf/stats';
import { CLUBS, DEFAULT_CLUB_ID } from '../../lib/golf/clubs';
import { GOLF_COURSES } from '../../lib/golf/courses';
import type { GolfCourse } from '../../lib/golf/courses';

// The two flows behind the single "Golf" chiclet: Phase-1 putting and the
// Phase-2 driving range (open practice or the scored Target Challenge).
export type GolfSubMode = 'putt' | 'range-practice' | 'range-challenge' | 'course';

interface Props {
  onStart: (mode: GolfSubMode, clubId?: string) => void;
  // Bump to refetch the leaderboard after a submit.
  refreshKey: number;
}

// The Golf mode picker, lifted out of routes/Fog.tsx to keep the route
// lean. Two cards — Mini-Golf and Driving Range; the range expands to a
// Practice / Target Challenge choice plus a starting club. Below sits a
// board toggle (putting vs range) with the matching personal-best line and
// leaderboard. Styling reuses the CSS-var chip/card idiom from Fog.
export function GolfMenu({ onStart, refreshKey }: Props) {
  const [expanded, setExpanded] = useState(false);
  const [clubId, setClubId] = useState(DEFAULT_CLUB_ID);
  // Which board the personal-best line + leaderboard show.
  const [board, setBoard] = useState<'golf' | 'golfrange'>('golf');

  // Course picker: expand toggle, the highlighted course (seeded from the last
  // played), and — when "Single hole" is chosen — which course's hole chips show.
  const [courseExpanded, setCourseExpanded] = useState(false);
  const [selectedCourseId, setSelectedCourseId] = useState<string>(() => {
    const last = getLastCourseId();
    return last && GOLF_COURSES.some((c) => c.id === last) ? last : GOLF_COURSES[0]!.id;
  });
  const [pickHoleFor, setPickHoleFor] = useState<string | null>(null);

  const puttStats = getGolfStats();
  const rangeStats = getRangeStats();
  const stats = board === 'golf' ? puttStats : rangeStats;

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

  const card = (opts: {
    title: string;
    subtitle: string;
    onClick: () => void;
    active?: boolean;
  }) => (
    <button
      type="button"
      onClick={opts.onClick}
      className="flex flex-col text-left"
      style={{
        background: 'var(--card-bg)',
        border: `1px solid ${opts.active ? 'var(--accent)' : 'var(--separator)'}`,
        borderRadius: 16,
        padding: 14,
      }}
    >
      <div className="text-[15px] font-bold" style={{ color: 'var(--text)' }}>
        {opts.title}
      </div>
      <div className="text-[12px] leading-snug pt-0.5" style={{ color: 'var(--text-dim)' }}>
        {opts.subtitle}
      </div>
    </button>
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
        Two ways to play. Putt the mini-golf course, or step onto the driving
        range and bomb it downrange.
      </div>

      <div className="grid grid-cols-1 gap-3">
        {card({
          title: 'Mini-Golf',
          subtitle: 'Six top-down holes. Drag back to aim, release to putt — under par pays the most.',
          onClick: () => onStart('putt'),
        })}
        {card({
          title: 'Driving Range',
          subtitle: 'Real 3D. Pick a club, carry the water, land on the island targets.',
          onClick: () => setExpanded((e) => !e),
          active: expanded,
        })}
        {card({
          title: 'Course · Play a round',
          subtitle:
            'Real 3D courses — Augusta National + Listowel. Play a full round with a scorecard, or a single hole.',
          onClick: () => setCourseExpanded((e) => !e),
          active: courseExpanded,
        })}
      </div>

      {courseExpanded ? (
        <div
          className="flex flex-col gap-3 rounded-2xl p-3"
          style={{ background: 'var(--bubble-them)' }}
        >
          <div
            className="text-[10px] font-bold tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
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
                              {h.name ? (
                                <span style={{ opacity: 0.6 }}> · {h.name}</span>
                              ) : null}
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

      {expanded ? (
        <div className="flex flex-col gap-3 rounded-2xl p-3" style={{ background: 'var(--bubble-them)' }}>
          {/* Starting club (changeable in-game too). */}
          <div>
            <div className="text-[10px] font-bold tracking-wider pb-1.5" style={{ color: 'var(--text-dim)' }}>
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
              style={{ background: 'var(--card-bg)', color: 'var(--text)', border: '1px solid var(--separator)' }}
              onClick={() => onStart('range-practice', clubId)}
            >
              Practice
            </button>
          </div>
          <div className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
            Target Challenge: 8 balls at random island pins — closest to the flag
            scores. Practice: unlimited balls, no scoring.
          </div>
        </div>
      ) : null}

      {/* Board toggle + personal best + leaderboard for the selected board. */}
      <div className="flex rounded-[10px] p-[3px] gap-[3px]" style={{ background: 'var(--bubble-them)' }}>
        {(
          [
            ['golf', 'Mini-Golf'],
            ['golfrange', 'Driving Range'],
          ] as const
        ).map(([key, label]) => {
          const active = board === key;
          return (
            <button
              key={key}
              type="button"
              onClick={() => setBoard(key)}
              className="flex-1 rounded-lg py-[6px] text-[13px] font-bold"
              style={{
                border: 'none',
                background: active ? 'var(--accent)' : 'transparent',
                color: active ? '#FFFFFF' : 'var(--text)',
              }}
            >
              {label}
            </button>
          );
        })}
      </div>

      {stats.gamesPlayed > 0 ? (
        <div className="text-xs text-center" style={{ color: 'var(--text-dim)' }}>
          Personal best {stats.bestScore.toLocaleString()} · streak x{stats.bestStreak} ·{' '}
          {stats.gamesPlayed} game{stats.gamesPlayed === 1 ? '' : 's'}
        </div>
      ) : null}

      <GolfLeaderboard refreshKey={refreshKey} game={board} />
    </div>
  );
}
