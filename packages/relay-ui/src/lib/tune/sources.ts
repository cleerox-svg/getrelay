// Round source for the "Guess the Tune" mini game. Each round is a
// { previewUrl, title, artist, answer, 3 distractors, artwork } tuple
// built from one iTunes Search batch: a seed term returns a group of
// preview-bearing tracks, one becomes the answer (its title in title
// mode, its artist in artist mode) and its batch-mates — or the genre's
// seed pool in artist mode — supply plausible same-genre distractors.
// Audio plays through a plain
// <audio> element (no Web Audio, no canvas), so CORS is irrelevant here.
//
// Unlike Fog there is NO bundled offline pack: every round needs the
// network. If the music service can't be reached the game simply has
// nothing to show — buildTuneRound returns null and the caller surfaces
// that as "unavailable" rather than hanging.

import { api } from '../api';

export type TuneGenreId =
  | 'any'
  | 'pop'
  | 'hiphop'
  | 'rock'
  | 'rnb'
  | 'electronic'
  | 'country'
  | 'latin';

// What the player is guessing this game: the track TITLE (default) or the
// ARTIST name. Chosen on the menu, fixed for the run.
export type TuneMode = 'title' | 'artist';

export interface TuneRound {
  // Song-preview clip URL for the <audio> element.
  previewUrl: string;
  // Track title + artist are BOTH carried so the reveal screen can show
  // the full "Title — Artist" regardless of which one was the answer.
  title: string;
  artist: string;
  // The correct choice the player picks: the title in 'title' mode, the
  // artist in 'artist' mode. Always one of `choices`.
  answer: string;
  artworkUrl: string;
  genre: string;
  // Apple Music / iTunes track page URL, or '' when the worker didn't
  // supply one. Drives the reveal-screen "Apple Music" deep-link.
  trackViewUrl: string;
  // 4 shuffled choices including the answer.
  choices: string[];
}

// ---- helpers (mirrors lib/fog/sources.ts) ----

function pick<T>(arr: readonly T[]): T | null {
  if (arr.length === 0) return null;
  return arr[Math.floor(Math.random() * arr.length)] ?? null;
}

function shuffle<T>(arr: T[]): T[] {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    const a = arr[i] as T;
    arr[i] = arr[j] as T;
    arr[j] = a;
  }
  return arr;
}

// n distinct random elements (fewer if the pool is smaller).
function sample<T>(arr: readonly T[], n: number): T[] {
  return shuffle(arr.slice()).slice(0, n);
}

// Race a promise against a timeout so a stalled network call reads as a
// failed attempt (retry a different seed) instead of stranding the load.
function withTimeout<T>(p: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = window.setTimeout(() => reject(new Error('tune_timeout')), timeoutMs);
    p.then(
      (v) => {
        window.clearTimeout(timer);
        resolve(v);
      },
      (e: unknown) => {
        window.clearTimeout(timer);
        reject(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

export interface TuneGenre {
  id: TuneGenreId;
  label: string;
  // Rotating pool of well-known artist names for this genre. Each iTunes
  // search on a seed returns a batch of preview-bearing tracks (mostly by
  // that artist), so one becomes the answer and same-genre seeds supply
  // plausible distractors — especially in 'artist' mode, where a single
  // artist-seeded batch rarely holds 4 DISTINCT artists on its own.
  seeds: readonly string[];
}

// Genre buckets: each is a rotating pool of well-known artists. A wide
// pool (like fog's MUSIC_SEEDS) plus a random pick within each batch
// keeps the same track from recurring across games — iTunes Search has no
// offset param, so these pools, not pagination, drive variety.
const GENRE_POOLS: readonly TuneGenre[] = [
  {
    id: 'pop',
    label: 'Pop',
    seeds: [
      'Taylor Swift', 'Ed Sheeran', 'Ariana Grande', 'Dua Lipa', 'Katy Perry',
      'Justin Bieber', 'Lady Gaga', 'Maroon 5', 'Billie Eilish', 'Adele',
      'Bruno Mars', 'Coldplay',
    ],
  },
  {
    id: 'hiphop',
    label: 'Hip-Hop',
    seeds: [
      'Drake', 'Eminem', 'Kanye West', 'Kendrick Lamar', 'Post Malone',
      'Jay-Z', 'Nicki Minaj', 'Travis Scott', 'Cardi B', 'Snoop Dogg',
      'Lil Wayne', '50 Cent',
    ],
  },
  {
    id: 'rock',
    label: 'Rock',
    seeds: [
      'The Beatles', 'Queen', 'Nirvana', 'Metallica', 'Pink Floyd',
      'The Rolling Stones', 'U2', 'Radiohead', 'Red Hot Chili Peppers',
      'Green Day', 'Linkin Park', 'Foo Fighters', 'Led Zeppelin',
      'Imagine Dragons', 'David Bowie', 'Fleetwood Mac',
    ],
  },
  {
    id: 'rnb',
    label: 'R&B',
    seeds: [
      'Beyonce', 'Rihanna', 'The Weeknd', 'Michael Jackson', 'Stevie Wonder',
      'Prince', 'Usher', 'Alicia Keys', 'Frank Ocean', 'SZA', 'Chris Brown',
      'Mariah Carey',
    ],
  },
  {
    id: 'electronic',
    label: 'Electronic',
    seeds: [
      'Daft Punk', 'Calvin Harris', 'David Guetta', 'Avicii', 'Marshmello',
      'The Chainsmokers', 'Skrillex', 'Deadmau5', 'Zedd', 'Kygo',
      'Swedish House Mafia', 'Tiesto',
    ],
  },
  {
    id: 'country',
    label: 'Country',
    seeds: [
      'Luke Bryan', 'Blake Shelton', 'Carrie Underwood', 'Dolly Parton',
      'Johnny Cash', 'Kenny Chesney', 'Keith Urban', 'Shania Twain',
      'Morgan Wallen', 'Chris Stapleton', 'Garth Brooks', 'Miranda Lambert',
    ],
  },
  {
    id: 'latin',
    label: 'Latin',
    seeds: [
      'Shakira', 'Bad Bunny', 'J Balvin', 'Daddy Yankee', 'Enrique Iglesias',
      'Luis Fonsi', 'Maluma', 'Karol G', 'Ricky Martin', 'Ozuna',
      'Marc Anthony', 'Rosalia',
    ],
  },
];

// De-duplicated union of every genre's seeds — the pool for 'Any' and the
// availability probe.
const ALL_SEEDS: readonly string[] = Array.from(
  new Set(GENRE_POOLS.flatMap((g) => g.seeds)),
);

// Genre chip data for the Tune menu: "Any" first (pools all seeds), then
// each bucket. `buildTuneRound`'s `genre` arg selects the pool.
export const TUNE_GENRES: readonly TuneGenre[] = [
  { id: 'any', label: 'Any', seeds: ALL_SEEDS },
  ...GENRE_POOLS,
];

// Back-compat flat pool (used by the availability probe).
export const TUNE_SEEDS: readonly string[] = ALL_SEEDS;

function seedsForGenre(genre: TuneGenreId): readonly string[] {
  const g = TUNE_GENRES.find((x) => x.id === genre);
  return g && g.seeds.length ? g.seeds : ALL_SEEDS;
}

export type TuneItem = {
  trackId: string;
  previewUrl: string;
  title: string;
  artist: string;
  genre: string;
  artworkUrl: string;
  trackViewUrl?: string;
};

// A game-scoped, accumulating pool of already-fetched tracks. The caller
// (TuneGame) owns ONE of these per game (held in a ref that resets on the
// per-game remount) and threads it through every buildTuneRound call so a
// whole game shares the tracks it fetched instead of hitting Deezer once
// per round. `servedSinceFetch` drives an artist-variety cadence: a single
// seed's batch is mostly ONE artist, so we force a fresh seed roughly every
// FETCH_EVERY rounds even when the pool could still yield, keeping a game
// from becoming eight songs by the same artist.
export interface TunePool {
  items: TuneItem[];
  servedSinceFetch: number;
  // Guards against stacking background variety top-ups (see topUpPool): a
  // round and its prefetch can both be due for variety at once.
  topping?: boolean;
}

export function createTunePool(): TunePool {
  return { items: [], servedSinceFetch: 0, topping: false };
}

// Append a fetched batch to the pool, skipping tracks already held (a seed
// can be re-searched once its pool names are exhausted). Keeps the pool a
// clean union so roundFromBatch's `used` dedup is the only gate on reuse.
function appendToPool(pool: TunePool, items: TuneItem[]): void {
  const have = new Set(pool.items.map((i) => i.trackId));
  for (const it of items) {
    if (it.trackId && !have.has(it.trackId)) {
      have.add(it.trackId);
      pool.items.push(it);
    }
  }
}

// Fire-and-forget variety top-up: fold ONE fresh seed's batch into the pool
// for upcoming rounds WITHOUT blocking the current round on the network.
// This is what keeps later rounds instant — they always serve from the pool,
// so a slow fetch can never trip the loading failsafe and end the game. The
// `topping` guard stops a round and its prefetch from stacking top-ups, and
// the variety cadence only resets once a fetch actually lands.
function topUpPool(pool: TunePool, used: Set<string>, seedPool: readonly string[]): void {
  if (pool.topping) return;
  const fresh = seedPool.filter((s) => !used.has(`tune:seed:${s}`));
  const seed = pick(fresh.length ? fresh : seedPool);
  if (!seed) return;
  pool.topping = true;
  used.add(`tune:seed:${seed}`);
  withTimeout(api.searchTunes(seed), 8000)
    .then((r) => {
      appendToPool(pool, r.items);
      pool.servedSinceFetch = 0;
    })
    .catch(() => undefined)
    .finally(() => {
      pool.topping = false;
    });
}

// Force a network top-up with a fresh seed after this many pool-served
// rounds, so a title-mode game spans several artists instead of draining
// eight rounds from one seed's (single-artist) batch. Combined with the
// fetch round itself this caps consecutive same-seed rounds at ~3.
const FETCH_EVERY = 2;

// Case- AND accent-insensitive fold for deduping display names. iTunes
// returns accented forms ("Beyoncé", "ROSALÍA") while the ASCII seed
// pools spell them "Beyonce"/"Rosalia"; comparing on lowercase alone
// lets a pool name slip in as a distractor that's a visual twin of the
// answer — and tapping that twin would score wrong.
function fold(s: string): string {
  return s.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

// Turn one iTunes batch into a round, or null if it can't yield an answer
// + 3 distinct distractors that aren't already used in this game.
// `seedPool` is the active genre's artist list, used to backfill artist
// distractors — an artist-seeded batch is mostly ONE artist, so 'artist'
// mode leans on the pool for other-artist options.
function roundFromBatch(
  items: TuneItem[],
  used: Set<string>,
  mode: TuneMode,
  seedPool: readonly string[],
): TuneRound | null {
  const usable = items.filter(
    (i) =>
      i.previewUrl &&
      i.title &&
      i.artist &&
      !used.has(`tune:track:${i.trackId}`) &&
      (mode === 'artist'
        ? !used.has(`tune:artist:${i.artist.toLowerCase()}`)
        : !used.has(`tune:title:${i.title.toLowerCase()}`)),
  );
  const target = pick(usable);
  if (!target) return null;

  const title = target.title;
  const artist = target.artist;
  let answer: string;
  let distractors: string[];

  if (mode === 'artist') {
    // Other artists, deduped case-insensitively against the answer and
    // each other. A single artist-seeded batch rarely holds 4 distinct
    // artists, so backfill from the genre's seed pool (other well-known
    // names), skipping any already chosen.
    answer = artist;
    const seen = new Set([fold(artist)]);
    const fromBatch: string[] = [];
    for (const i of items) {
      if (!i.artist) continue;
      const key = fold(i.artist);
      if (seen.has(key)) continue;
      seen.add(key);
      fromBatch.push(i.artist);
    }
    distractors = sample(fromBatch, 3);
    distractors.forEach((d) => seen.add(fold(d)));
    if (distractors.length < 3) {
      const poolNames = seedPool.filter((s) => !seen.has(fold(s)));
      for (const name of sample(poolNames, 3 - distractors.length)) {
        seen.add(fold(name));
        distractors.push(name);
      }
    }
    if (distractors.length < 3) return null;
    used.add(`tune:artist:${artist.toLowerCase()}`);
  } else {
    answer = title;
    // Distractor titles, deduped case-insensitively against the answer and
    // each other. Same-genre titles are preferred so the choices aren't a
    // giveaway; any other title backfills if the batch is genre-thin.
    const seen = new Set([fold(title)]);
    const sameGenre: string[] = [];
    const anyGenre: string[] = [];
    for (const i of items) {
      if (!i.title) continue;
      const key = fold(i.title);
      if (seen.has(key)) continue;
      seen.add(key);
      (i.genre && i.genre === target.genre ? sameGenre : anyGenre).push(i.title);
    }
    distractors = sample(sameGenre, 3);
    if (distractors.length < 3) {
      distractors.push(...sample(anyGenre, 3 - distractors.length));
    }
    if (distractors.length < 3) return null;
    used.add(`tune:title:${title.toLowerCase()}`);
  }

  used.add(`tune:track:${target.trackId}`);
  return {
    previewUrl: target.previewUrl,
    title,
    artist,
    answer,
    artworkUrl: target.artworkUrl,
    genre: target.genre,
    trackViewUrl: target.trackViewUrl ?? '',
    choices: shuffle([answer, ...distractors]),
  };
}

export interface BuildTuneOpts {
  // Which seed pool to draw from ('any' = all genres pooled).
  genre?: TuneGenreId;
  // What the player guesses (title | artist).
  mode?: TuneMode;
}

// Build one playable round, drawing from a game-scoped POOL of already
// fetched tracks and only touching the network when the pool can't yield a
// fresh valid round (or when the variety cadence forces a fresh seed). A
// typical 8-round title game makes ~3 Deezer searches this way instead of
// one per round; artist mode fetches more (each round needs a distinct
// artist, and a seed's batch is mostly one). Returns null only when the
// network is exhausted AND the pool still can't yield — there is no offline
// pack, so the caller treats null as "music service unavailable".
export async function buildTuneRound(
  used: Set<string>,
  opts: BuildTuneOpts = {},
  pool: TunePool = createTunePool(),
): Promise<TuneRound | null> {
  const genre = opts.genre ?? 'any';
  const mode = opts.mode ?? 'title';
  const seedPool = seedsForGenre(genre);

  // 1) Serve straight from the current pool with NO network call whenever
  //    possible. Rounds after the first never block on the network this way,
  //    so a slow/throttled fetch can't trip the loading failsafe and end the
  //    game. When the variety cadence is due, fold a fresh artist in via a
  //    BACKGROUND top-up that THIS round never waits on.
  const pooled = roundFromBatch(pool.items, used, mode, seedPool);
  if (pooled) {
    pool.servedSinceFetch += 1;
    if (pool.servedSinceFetch >= FETCH_EVERY) topUpPool(pool, used, seedPool);
    return pooled;
  }

  // 2) Pool can't yield (first round, or every held track already used) —
  //    fetch fresh seeds, append each batch to the shared pool, and retry
  //    against the enlarged pool.
  for (let attempt = 0; attempt < 4; attempt++) {
    const fresh = seedPool.filter((s) => !used.has(`tune:seed:${s}`));
    const seed = pick(fresh.length ? fresh : seedPool);
    if (!seed) break;
    used.add(`tune:seed:${seed}`);
    try {
      const r = await withTimeout(api.searchTunes(seed), 8000);
      appendToPool(pool, r.items);
      const round = roundFromBatch(pool.items, used, mode, seedPool);
      if (round) {
        pool.servedSinceFetch = 0; // reset the cadence: we just fetched
        return round;
      }
    } catch {
      /* stalled or failed seed — try another */
    }
  }

  // 3) Fetches exhausted. Last resort: try the pool once more (covers the
  //    variety-forced path where the network failed but the pool still holds
  //    a valid round), so a transient throttle doesn't needlessly end a game.
  const fallback = roundFromBatch(pool.items, used, mode, seedPool);
  if (fallback) {
    pool.servedSinceFetch += 1;
    return fallback;
  }
  return null;
}

// Availability probe: one search returns >=4 preview items. Mirrors
// gifsSource.available / musicSource.available. Only the positive answer
// is cached for the session; an empty or failed probe (momentary offline
// at tab open) is left uncached so the next call re-probes.
let tuneAvailableCache: boolean | null = null;

export async function tuneAvailable(): Promise<boolean> {
  if (tuneAvailableCache !== null) return tuneAvailableCache;
  try {
    const r = await api.searchTunes(TUNE_SEEDS[0] ?? 'The Beatles');
    const withPreview = r.items.filter((i) => i.previewUrl);
    if (withPreview.length >= 4) {
      tuneAvailableCache = true;
      return true;
    }
    return false;
  } catch {
    return false;
  }
}
