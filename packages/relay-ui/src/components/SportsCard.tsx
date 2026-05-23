import type React from 'react';
import { Link } from 'react-router-dom';
import type { SportsGame, SportsTeam } from '../lib/types';

interface Props {
  game: SportsGame;
  // The team this card was rendered for. When passed, the detail link
  // includes it so /sports/:league/:id resolves "ourSide" from the
  // viewer's perspective rather than defaulting to MTL / TOR.
  teamKey?: string;
  // Optional label rendered above the card, e.g. "Last game".
  label?: string;
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
          display: 'flex',
          flexDirection: 'column',
          lineHeight: 1.15,
        }}
      >
        <span
          style={{
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
        {team.record ? (
          <span
            style={{
              fontSize: 11,
              color: 'var(--text-dim)',
              fontVariantNumeric: 'tabular-nums',
            }}
          >
            {team.record}
          </span>
        ) : null}
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

export function SportsCard({ game, teamKey, label }: Props) {
  const accent = leagueAccent(game.league);
  const isOurHome = game.ourSide === 'home';
  const isLive = game.status === 'live';
  const isFinal = game.status === 'final';
  const showScore = isLive || isFinal;
  const canDrillDown = !!game.id;

  const card = (
    <div
      className="sports-card"
      style={{
        border: '1px solid var(--separator, rgba(0,0,0,0.08))',
        borderRadius: 14,
        padding: '12px 14px',
        // Slight tonal lift on the card surface (top edge is the base
        // --card-bg, bottom is ~4% darker) so the card reads as a
        // raised tile against the page. Drop shadow + inset highlight
        // come from the .sports-card class in global.css.
        background:
          'linear-gradient(180deg, var(--card-bg, #FFFFFF) 0%, color-mix(in srgb, var(--card-bg, #FFFFFF) 96%, black) 100%)',
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
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
            fontSize: 12,
            color: 'var(--text-dim)',
            fontWeight: 600,
          }}
        >
          {game.broadcast ? (
            // Broadcast pill sits next to the time/inning so the
            // header reads like "SN · 7:00 PM ET" or "TBS · Bot 8th".
            <>
              <span
                style={{
                  background: 'var(--bubble-them, #E5E5EA)',
                  color: 'var(--text)',
                  padding: '1px 6px',
                  borderRadius: 4,
                  fontSize: 10,
                  fontWeight: 700,
                  letterSpacing: 0.3,
                }}
              >
                {game.broadcast}
              </span>
              <span aria-hidden>·</span>
            </>
          ) : null}
          <span>{game.statusDetail}</span>
        </span>
      </div>

      {game.series ? (
        // Prominent playoff context bar between the league header and
        // the matchup — round name + "Game N of M". Mirrors how
        // dedicated sports apps frame postseason cards ("ROUND 3 ·
        // GAME 2"). The natural-language `seriesLabel` continues to
        // appear below the matchup so the score / clinch state reads
        // there at a glance.
        <div
          style={{
            display: 'flex',
            flexWrap: 'wrap',
            alignItems: 'center',
            gap: 8,
            marginBottom: 8,
            paddingBottom: 8,
            borderBottom: '1px solid var(--separator, rgba(0,0,0,0.08))',
          }}
        >
          {game.series.round ? (
            <span
              style={{
                background: accent.bg,
                color: accent.chip,
                fontSize: 10,
                fontWeight: 700,
                letterSpacing: 0.6,
                padding: '2px 8px',
                borderRadius: 999,
                textTransform: 'uppercase',
              }}
            >
              {game.series.round}
            </span>
          ) : null}
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              letterSpacing: 0.6,
              color: 'var(--text)',
              textTransform: 'uppercase',
            }}
          >
            {game.series.gameLabel}
          </span>
        </div>
      ) : null}

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

      {game.series ? (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: 'var(--text-dim)',
          }}
        >
          {game.series.seriesLabel}
        </div>
      ) : null}

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

  // Tiny header label rendered above the card body (e.g. "Last game").
  const wrapper = (children: React.ReactNode) =>
    label ? (
      <div>
        <div
          style={{
            marginTop: 10,
            marginBottom: -4,
            fontSize: 11,
            fontWeight: 700,
            letterSpacing: 0.6,
            color: 'var(--text-dim)',
            textTransform: 'uppercase',
          }}
        >
          {label}
        </div>
        {children}
      </div>
    ) : (
      <>{children}</>
    );

  if (!canDrillDown) return wrapper(card);
  const params = teamKey
    ? `?${game.league === 'NHL' ? 'abbr' : 'teamId'}=${encodeURIComponent(teamKey)}`
    : '';
  return wrapper(
    <Link
      to={`/sports/${game.league.toLowerCase()}/${encodeURIComponent(game.id)}${params}`}
      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      {card}
    </Link>,
  );
}
