import { Link } from 'react-router-dom';
import type { SportsGame, SportsTeam } from '../lib/types';

interface Props {
  game: SportsGame;
}

function leagueAccent(league: SportsGame['league']): { bg: string; chip: string } {
  // Canadiens red / Blue Jays blue for the league chip.
  if (league === 'NHL') return { bg: '#AF1E2D', chip: '#FFFFFF' };
  return { bg: '#134A8E', chip: '#FFFFFF' };
}

function TeamRow({
  team,
  ourSide,
  isOurs,
  showScore,
}: {
  team: SportsTeam;
  ourSide: 'home' | 'away';
  isOurs: boolean;
  showScore: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '4px 0',
        opacity: showScore && team.score == null ? 0.6 : 1,
      }}
    >
      {team.logo ? (
        <img
          src={team.logo}
          alt=""
          width={28}
          height={28}
          style={{ width: 28, height: 28, objectFit: 'contain' }}
          onError={(e) => {
            (e.currentTarget as HTMLImageElement).style.visibility = 'hidden';
          }}
        />
      ) : (
        <span
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            width: 28,
            height: 28,
            borderRadius: 999,
            background: 'var(--bubble-them, #E5E5EA)',
            fontSize: 11,
            fontWeight: 700,
          }}
        >
          {team.abbr || '?'}
        </span>
      )}
      <span
        style={{
          flex: 1,
          minWidth: 0,
          fontSize: 14,
          fontWeight: isOurs ? 700 : 500,
          overflow: 'hidden',
          whiteSpace: 'nowrap',
          textOverflow: 'ellipsis',
        }}
      >
        {team.name}
        <span
          aria-hidden
          style={{
            marginLeft: 8,
            fontSize: 11,
            fontWeight: 500,
            color: 'var(--text-dim)',
          }}
        >
          {ourSide === 'home' && isOurs
            ? 'HOME'
            : ourSide === 'away' && isOurs
              ? 'AWAY'
              : ''}
        </span>
      </span>
      {showScore ? (
        <span
          style={{
            fontSize: 22,
            fontWeight: 700,
            fontVariantNumeric: 'tabular-nums',
            minWidth: 28,
            textAlign: 'right',
          }}
        >
          {team.score ?? '–'}
        </span>
      ) : null}
    </div>
  );
}

export function SportsCard({ game }: Props) {
  const accent = leagueAccent(game.league);
  const isOurHome = game.ourSide === 'home';
  const isLive = game.status === 'live';
  const isFinal = game.status === 'final';
  const showScore = isLive || isFinal;
  const canDrillDown = !!game.id;

  const card = (
    <div
      style={{
        border: '1px solid var(--separator, rgba(0,0,0,0.08))',
        borderRadius: 14,
        padding: '12px 14px',
        background: 'var(--card-bg, #FFFFFF)',
        marginTop: 10,
        cursor: canDrillDown ? 'pointer' : 'default',
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          marginBottom: 8,
        }}
      >
        <span
          style={{
            background: accent.bg,
            color: accent.chip,
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: 0.6,
            padding: '2px 8px',
            borderRadius: 999,
          }}
        >
          {game.league}
        </span>
        {isLive ? (
          <span
            className="sports-live-dot"
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 4,
              fontSize: 11,
              fontWeight: 700,
              color: 'var(--ping, #FF3B30)',
              letterSpacing: 0.4,
            }}
          >
            <span
              aria-hidden
              style={{
                width: 8,
                height: 8,
                borderRadius: 999,
                background: 'var(--ping, #FF3B30)',
                display: 'inline-block',
              }}
            />
            LIVE
          </span>
        ) : null}
        <span
          style={{
            marginLeft: 'auto',
            fontSize: 12,
            color: 'var(--text-dim)',
            fontWeight: 600,
          }}
        >
          {game.statusDetail}
        </span>
      </div>

      <TeamRow
        team={game.awayTeam}
        ourSide={game.ourSide}
        isOurs={!isOurHome}
        showScore={showScore}
      />
      <TeamRow
        team={game.homeTeam}
        ourSide={game.ourSide}
        isOurs={isOurHome}
        showScore={showScore}
      />

      {game.venue ? (
        <div
          style={{
            marginTop: 6,
            fontSize: 11,
            color: 'var(--text-dim)',
          }}
        >
          {game.venue}
        </div>
      ) : null}
    </div>
  );

  if (!canDrillDown) return card;
  return (
    <Link
      to={`/sports/${game.league.toLowerCase()}/${encodeURIComponent(game.id)}`}
      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      {card}
    </Link>
  );
}
