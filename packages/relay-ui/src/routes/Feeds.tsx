import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Block, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { api } from '../lib/api';
import { getCourse } from '../lib/golf/courses';
import { useStore } from '../lib/store';
import type {
  ChallengeFeedEvent,
  ContactStatus,
  FeedEvent,
  GameFeedEvent,
  GameId,
  RecordFeedEvent,
  RecordMetric,
} from '../lib/types';

// /feeds is the social surface: contact statuses merged with notable game
// activity across every game — Fog/Tune runs, golf rounds, head-to-head golf
// challenges and longest-shot records — newest first. Match-sport scores
// still live on their own /sports tab; this reads as "what my contacts have
// been up to" in the arcade.
export function Feeds() {
  const me = useStore((s) => s.me);
  const [events, setEvents] = useState<FeedEvent[]>([]);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    api
      .listFeed()
      .then((r) => setEvents(r.events ?? statusesToEvents(r.statuses)))
      .catch(() => undefined)
      .finally(() => setLoaded(true));
  }, []);

  // Re-render the "2h ago" labels on a slow tick so a feed left open
  // doesn't freeze its timestamps.
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick((n) => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  // Whether any non-status activity is present, to gate the "only standout
  // runs show up" footnote.
  const hasGames = useMemo(() => events.some((e) => e.kind !== 'status'), [events]);

  return (
    <Page>
      <Navbar
        title={<BrandTitle />}
        left={
          <Link to="/profile" className="px-3">
            <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={30} />
          </Link>
        }
      />

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Updates</h1>

      <Block className="text-sm !mt-3 !mb-2" style={{ color: 'var(--text-dim)' }}>
        Statuses and game highlights from your contacts. Set your own status from{' '}
        <Link to="/profile" style={{ color: 'var(--accent)' }}>
          Profile
        </Link>
        .
      </Block>

      {!loaded ? null : events.length === 0 ? (
        <Block className="text-center !mt-4" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">Nothing here yet</div>
          <div className="text-sm">
            Set a status in Profile, play a game in{' '}
            <Link to="/games" style={{ color: 'var(--accent)' }}>
              Games
            </Link>
            , or add contacts to see theirs here.
          </div>
        </Block>
      ) : (
        <div className="feed-list">
          {events.map((e) => (
            <FeedRow key={e.id} e={e} meId={me?.id} />
          ))}
        </div>
      )}

      {loaded && hasGames ? (
        <Block className="text-xs !mt-1" style={{ color: 'var(--text-dim)' }}>
          Only standout activity shows up here — a first game, a personal best, a
          low round, a challenge result, or a new record. You can stop sharing
          yours from{' '}
          <Link to="/profile" style={{ color: 'var(--accent)' }}>
            Profile
          </Link>
          .
        </Block>
      ) : null}
    </Page>
  );
}

// One feed row. Status events lead with the contact's Avatar (identity is the
// point); game/challenge/record events lead with a tinted glyph tile and carry
// the actor's name inside the title, matching the approved Feeds mock.
function FeedRow({ e, meId }: { e: FeedEvent; meId: string | undefined }) {
  if (e.kind === 'status') {
    return (
      <Link to={eventHref(e)} className="feed-row">
        <Avatar src={e.avatarUrl} name={e.displayName} size={44} />
        <div className="feed-row-main">
          <div className="feed-row-title">
            {e.displayName}
            {e.mine ? <span className="feed-row-you">(you)</span> : null}
          </div>
          <div className="feed-row-sub">{e.statusMessage}</div>
          <div className="feed-row-when">{relativeTime(e.at)}</div>
        </div>
      </Link>
    );
  }

  const parts =
    e.kind === 'game'
      ? gameParts(e)
      : e.kind === 'challenge'
        ? challengeParts(e, meId)
        : recordParts(e);

  return (
    <Link to={eventHref(e)} className="feed-row">
      <GlyphTile kind={glyphKindFor(e)} />
      <div className="feed-row-main">
        <div className="feed-row-title">{parts.title}</div>
        {parts.sub ? <div className="feed-row-sub">{parts.sub}</div> : null}
        <div className="feed-row-when">{relativeTime(e.at)}</div>
      </div>
      {parts.chip ? (
        <span className={`feed-chip is-${parts.chip.tone}`}>{parts.chip.label}</span>
      ) : null}
    </Link>
  );
}

// Fallback for an older worker that only returns `statuses`. Produces the
// same shape the new endpoint would, minus any game events.
function statusesToEvents(statuses: ContactStatus[]): FeedEvent[] {
  return statuses
    .map(
      (s): FeedEvent => ({
        id: `status:${s.userId}`,
        kind: 'status',
        userId: s.userId,
        displayName: s.displayName,
        pin: s.pin,
        avatarUrl: s.avatarUrl,
        mine: s.mine,
        at: s.updatedAt,
        statusMessage: s.statusMessage,
      }),
    )
    .sort((a, b) => b.at - a.at);
}

// Routing by kind. A status opens the contact who set it (or Profile for your
// own — the only place to change it). Every game/challenge/record event opens
// the Games hub: there's no deep-link into a specific game screen (each game is
// selected by state inside /games), so linking the hub beats guessing the
// wrong game.
function eventHref(e: FeedEvent): string {
  if (e.kind === 'status') {
    return e.mine ? '/profile' : `/contacts/${encodeURIComponent(e.userId)}`;
  }
  return '/games';
}

// ---- Copy helpers ----

// Display name for every game id. No existing map covers all five (the Games
// hub in Games.tsx only lists fog/tune/golf), so this is the single source here.
const GAME_NAMES: Record<GameId, string> = {
  fog: 'Fog',
  tune: 'Tune',
  golf: 'Golf',
  golfrange: 'Golf Range',
  golfcourse: 'Golf Course',
};
const gameName = (g: string): string => GAME_NAMES[g as GameId] ?? 'Games';

const isGolfGame = (g: string): boolean =>
  g === 'golf' || g === 'golfrange' || g === 'golfcourse';

// Format a to-par relative to par: 0 → "E", +n, −n (true minus). Mirrors the
// ChallengeCard / CourseGame scorecard so every golf surface reads the same.
function fmtToPar(n: number): string {
  if (n === 0) return 'E';
  return n > 0 ? `+${n}` : `−${-n}`;
}

type Chip = { label: string; tone: 'win' | 'tie' | 'gold' };
type RowParts = { title: string; sub: string | null; chip: Chip | null };

function gameParts(e: GameFeedEvent): RowParts {
  const who = e.mine ? 'You' : e.displayName;
  const gn = gameName(e.game);
  const golf = isGolfGame(e.game);
  const toPar = e.toPar ?? null;
  const score = (e.score ?? 0).toLocaleString();

  let predicate: string;
  let sub: string | null = null;
  let chip: Chip | null = null;

  switch (e.badge) {
    case 'first':
      predicate = `started playing ${gn}`;
      sub = golf ? null : `${score} points`;
      break;
    case 'best':
      predicate = 'set a new personal best';
      if (golf) {
        sub = toPar != null ? `${gn} · ${fmtToPar(toPar)} on the round` : gn;
        if (toPar != null) chip = { label: fmtToPar(toPar), tone: toPar < 0 ? 'gold' : 'tie' };
      } else {
        sub = `${gn} · ${score}`;
      }
      break;
    case 'underpar':
      predicate = toPar != null ? `carded ${fmtToPar(toPar)} on the round` : 'carded an under-par round';
      sub = gn;
      if (toPar != null) chip = { label: fmtToPar(toPar), tone: 'gold' };
      break;
    case 'perfect':
      predicate = `played a perfect ${gn} game`;
      sub = `${e.rounds} rounds · no misses`;
      break;
    case 'streak':
      predicate = `hit a ${e.bestStreak}-in-a-row streak`;
      sub = `${gn} · ${score}`;
      break;
    default:
      predicate = `played ${gn}`;
  }

  return { title: `${who} ${predicate}`, sub, chip };
}

function challengeParts(e: ChallengeFeedEvent, meId: string | undefined): RowParts {
  const decisive = e.winnerId != null;
  const winner = decisive
    ? e.challenger.userId === e.winnerId
      ? e.challenger
      : e.opponent
    : null;
  const loser = winner
    ? winner.userId === e.challenger.userId
      ? e.opponent
      : e.challenger
    : null;

  let title: string;
  let chip: Chip;
  if (winner && loser) {
    const iWon = meId != null && winner.userId === meId;
    const iLost = meId != null && loser.userId === meId;
    if (iWon) {
      title = `You beat ${loser.displayName}`;
      chip = { label: 'WIN', tone: 'win' };
    } else if (iLost) {
      title = `${winner.displayName} beat you`;
      chip = { label: 'LOST', tone: 'tie' };
    } else {
      title = `${winner.displayName} beat ${loser.displayName}`;
      const a = e.challenger.toPar;
      const b = e.opponent.toPar;
      const margin = a != null && b != null ? Math.abs(a - b) : null;
      chip = margin != null && margin > 0 ? { label: `Win · ${margin}`, tone: 'win' } : { label: 'Final', tone: 'tie' };
    }
  } else {
    // Tie (winnerId null). Phrase from the viewer's seat when they played.
    if (e.mine && meId != null) {
      const other = e.challenger.userId === meId ? e.opponent : e.challenger;
      title = `You tied ${other.displayName}`;
    } else {
      title = `${e.challenger.displayName} tied ${e.opponent.displayName}`;
    }
    chip = { label: 'TIE', tone: 'tie' };
  }

  // Sub-line: <Course> · Hole N · <game> challenge. Resolve the course id to a
  // display name via the shared golf course registry when present.
  const bits: string[] = [];
  if (e.course != null) {
    const c = getCourse(e.course);
    bits.push(c.name);
    if (e.hole != null) bits.push(`Hole ${c.holes[e.hole]?.id ?? e.hole + 1}`);
  } else if (e.hole != null) {
    bits.push(`Hole ${e.hole + 1}`);
  }
  bits.push(`${gameName(e.game)} challenge`);

  return { title, sub: bits.join(' · '), chip };
}

const RECORD_VERB: Record<RecordMetric, string> = {
  drive: 'set a longest drive',
  closest: 'got closest to the pin',
  putt: 'sank the longest putt',
};

function recordParts(e: RecordFeedEvent): RowParts {
  const who = e.mine ? 'You' : e.displayName;
  const bits = [`${e.valueYards} yd`];
  if (e.hole != null) bits.push(`Hole ${e.hole}`);
  return {
    title: `${who} ${RECORD_VERB[e.metric] ?? 'set a record'}`,
    sub: bits.join(' · '),
    chip: { label: `${e.valueYards} yd`, tone: 'gold' },
  };
}

// Fog/Tune events wear the game glyph (blue-tinted); every golf-family game,
// challenge and record wears the flag (green-tinted).
function glyphKindFor(e: FeedEvent): 'golf' | 'fog' {
  if (e.kind === 'game') return isGolfGame(e.game) ? 'golf' : 'fog';
  return 'golf';
}

function relativeTime(at: number): string {
  if (!at) return '';
  const secs = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (secs < 60) return 'now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

// The glyph tile that leads a game/challenge/record row (mock's `.fglyph`).
// Golf → flag emoji on a green tint; Fog/Tune → the condensation mark on an
// accent tint, so a score row is distinguishable from a status at a glance.
function GlyphTile({ kind }: { kind: 'golf' | 'fog' }) {
  return (
    <span className={`feed-glyph feed-glyph--${kind}`} aria-hidden="true">
      {kind === 'golf' ? '⛳' : <FogGlyph />}
    </span>
  );
}

function FogGlyph() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
      <path
        d="M4 8h16M4 12h16M4 16h10"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2.5"
        strokeLinecap="round"
      />
    </svg>
  );
}
