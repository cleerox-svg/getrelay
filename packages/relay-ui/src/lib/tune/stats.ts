// Local "Guess the Tune" game stats. Kept in localStorage so the menu
// can show a personal best even when the score POST fails (offline,
// worker not yet deployed). Server leaderboard is the source of truth
// for rankings; this is just the player's own history. Clone of
// lib/fog/stats.ts under a separate key so Fog and Tune bests don't mix.

export interface TuneStats {
  bestScore: number;
  bestStreak: number;
  gamesPlayed: number;
  totalPoints: number;
}

const KEY = 'relay.tuneStats';

const EMPTY: TuneStats = { bestScore: 0, bestStreak: 0, gamesPlayed: 0, totalPoints: 0 };

export function getTuneStats(): TuneStats {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const parsed = JSON.parse(raw) as Partial<TuneStats>;
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

export function recordTuneGame(score: number, bestStreak: number): TuneStats {
  const cur = getTuneStats();
  const next: TuneStats = {
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
