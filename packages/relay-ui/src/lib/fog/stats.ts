// Local Fog game stats. Kept in localStorage so the menu can show a
// personal best even when the score POST fails (offline, worker not
// yet deployed). Server leaderboard is the source of truth for
// rankings; this is just the player's own history.

export interface FogStats {
  bestScore: number;
  bestStreak: number;
  gamesPlayed: number;
  totalPoints: number;
}

const KEY = 'relay.fogStats';

const EMPTY: FogStats = { bestScore: 0, bestStreak: 0, gamesPlayed: 0, totalPoints: 0 };

export function getFogStats(): FogStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<FogStats>;
    return {
      bestScore: typeof parsed.bestScore === 'number' ? parsed.bestScore : 0,
      bestStreak: typeof parsed.bestStreak === 'number' ? parsed.bestStreak : 0,
      gamesPlayed: typeof parsed.gamesPlayed === 'number' ? parsed.gamesPlayed : 0,
      totalPoints: typeof parsed.totalPoints === 'number' ? parsed.totalPoints : 0,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function recordFogGame(score: number, bestStreak: number): FogStats {
  const cur = getFogStats();
  const next: FogStats = {
    bestScore: Math.max(cur.bestScore, score),
    bestStreak: Math.max(cur.bestStreak, bestStreak),
    gamesPlayed: cur.gamesPlayed + 1,
    totalPoints: cur.totalPoints + score,
  };
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* private mode — stats become per-session, which is fine */
  }
  return next;
}
