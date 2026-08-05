// Local Golf game stats. Kept in localStorage so the menu can show a
// personal best even when the score POST fails (offline, worker not yet
// deployed). Server leaderboard is the source of truth for rankings;
// this is just the player's own history. Clone of lib/fog/stats.ts under
// a separate key so Fog, Tune and Golf bests don't mix.

export interface GolfStats {
  bestScore: number;
  bestStreak: number;
  gamesPlayed: number;
  totalPoints: number;
}

const KEY = 'relay.golfStats';

const EMPTY: GolfStats = { bestScore: 0, bestStreak: 0, gamesPlayed: 0, totalPoints: 0 };

export function getGolfStats(): GolfStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<GolfStats>;
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

export function recordGolfGame(score: number, bestStreak: number): GolfStats {
  const cur = getGolfStats();
  const next: GolfStats = {
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

// --- Driving-range (Target Challenge) stats -------------------------------
// Same GolfStats shape, separate key + board ('golfrange') so putting and
// range personal bests never mix. Practice mode is unscored and records
// nothing.

const RANGE_KEY = 'relay.golfRangeStats';

function readStatsFrom(key: string): GolfStats {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<GolfStats>;
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

export function getRangeStats(): GolfStats {
  return readStatsFrom(RANGE_KEY);
}

export function recordRangeGame(score: number, bestStreak: number): GolfStats {
  const cur = getRangeStats();
  const next: GolfStats = {
    bestScore: Math.max(cur.bestScore, score),
    bestStreak: Math.max(cur.bestStreak, bestStreak),
    gamesPlayed: cur.gamesPlayed + 1,
    totalPoints: cur.totalPoints + score,
  };
  try {
    localStorage.setItem(RANGE_KEY, JSON.stringify(next));
  } catch {
    /* private mode — stats become per-session, which is fine */
  }
  return next;
}
