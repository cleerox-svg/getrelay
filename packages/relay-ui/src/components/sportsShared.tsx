import type { CSSProperties } from 'react';

// League chip colours mirror SportsCard (Canadiens red / Blue Jays blue)
// so the News and Stats sub-pages read as the same surface as Scores.
export function leagueAccent(league: 'NHL' | 'MLB'): { bg: string; chip: string } {
  if (league === 'NHL') return { bg: '#AF1E2D', chip: '#FFFFFF' };
  return { bg: '#134A8E', chip: '#FFFFFF' };
}

// The raised-tile surface used by SportsCard. Reused verbatim so every
// card across the Sports tab shares one look in light + dark themes.
export const sportsCardStyle: CSSProperties = {
  border: '1px solid var(--separator, rgba(0,0,0,0.08))',
  borderRadius: 14,
  padding: '12px 14px',
  background:
    'linear-gradient(180deg, var(--card-bg, #FFFFFF) 0%, color-mix(in srgb, var(--card-bg, #FFFFFF) 96%, black) 100%)',
  marginTop: 10,
};

export function LeagueChip({ league }: { league: 'NHL' | 'MLB' }) {
  const accent = leagueAccent(league);
  return (
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
      {league}
    </span>
  );
}
