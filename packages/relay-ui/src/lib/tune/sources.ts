// Round source for the "Guess the Tune" mini game. Each round is a
// { previewUrl, title (answer), 3 distractor titles, artist, artwork }
// tuple built from one iTunes Search batch: a seed term returns a group
// of preview-bearing tracks, one becomes the answer and its batch-mates
// supply plausible same-genre distractors. Audio plays through a plain
// <audio> element (no Web Audio, no canvas), so CORS is irrelevant here.
//
// Unlike Fog there is NO bundled offline pack: every round needs the
// network. If the music service can't be reached the game simply has
// nothing to show — buildTuneRound returns null and the caller surfaces
// that as "unavailable" rather than hanging.

import { api } from '../api';

export interface TuneRound {
  // Song-preview clip URL for the <audio> element.
  previewUrl: string;
  // The answer the player picks: the track TITLE.
  answer: string;
  artist: string;
  artworkUrl: string;
  genre: string;
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

// Seed pool: well-known artists + broad genre terms. Each iTunes search
// returns a batch of preview-bearing tracks that share the seed, so one
// becomes the answer and its batch-mates supply same-"genre" distractor
// titles. A wide rotating pool (like fog's MUSIC_SEEDS) plus a random
// pick within each batch keeps the same track from recurring across
// games — iTunes Search has no offset param, so this pool, not
// pagination, is what drives variety.
export const TUNE_SEEDS: readonly string[] = [
  'Taylor Swift', 'The Beatles', 'Beyonce', 'Drake', 'Ed Sheeran', 'Adele',
  'Coldplay', 'Rihanna', 'Bruno Mars', 'Michael Jackson', 'Queen', 'Eminem',
  'Kanye West', 'Ariana Grande', 'Lady Gaga', 'Justin Bieber', 'Elton John',
  'Bob Marley', 'Nirvana', 'Metallica', 'Pink Floyd', 'Fleetwood Mac',
  'The Rolling Stones', 'U2', 'Radiohead', 'Katy Perry', 'Maroon 5',
  'Post Malone', 'Billie Eilish', 'The Weeknd', 'Dua Lipa', 'Kendrick Lamar',
  'Frank Sinatra', 'Stevie Wonder', 'Prince', 'David Bowie',
  'Red Hot Chili Peppers', 'Green Day', 'Linkin Park', 'Imagine Dragons',
];

type TuneItem = {
  trackId: string;
  previewUrl: string;
  title: string;
  artist: string;
  genre: string;
  artworkUrl: string;
};

// Turn one iTunes batch into a round, or null if it can't yield an answer
// + 3 distinct distractors that aren't already used in this game.
function roundFromBatch(items: TuneItem[], used: Set<string>): TuneRound | null {
  const usable = items.filter(
    (i) =>
      i.previewUrl &&
      i.title &&
      !used.has(`tune:track:${i.trackId}`) &&
      !used.has(`tune:title:${i.title.toLowerCase()}`),
  );
  const target = pick(usable);
  if (!target) return null;

  const answer = target.title;
  // Distractor titles, deduped case-insensitively against the answer and
  // each other. Same-genre titles are preferred so the choices aren't a
  // giveaway; any other title backfills if the batch is genre-thin.
  const seen = new Set([answer.toLowerCase()]);
  const sameGenre: string[] = [];
  const anyGenre: string[] = [];
  for (const i of items) {
    if (!i.title) continue;
    const key = i.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    (i.genre && i.genre === target.genre ? sameGenre : anyGenre).push(i.title);
  }
  const distractors = sample(sameGenre, 3);
  if (distractors.length < 3) {
    distractors.push(...sample(anyGenre, 3 - distractors.length));
  }
  if (distractors.length < 3) return null;

  used.add(`tune:track:${target.trackId}`);
  used.add(`tune:title:${answer.toLowerCase()}`);
  return {
    previewUrl: target.previewUrl,
    answer,
    artist: target.artist,
    artworkUrl: target.artworkUrl,
    genre: target.genre,
    choices: shuffle([answer, ...distractors]),
  };
}

// Build one playable round: pick an unused seed, fetch its batch, turn it
// into a round. Retries with a different seed up to a few times, bounding
// each network call. Returns null when every attempt fails — there is no
// offline pack, so the caller treats null as "music service unavailable".
export async function buildTuneRound(used: Set<string>): Promise<TuneRound | null> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const fresh = TUNE_SEEDS.filter((s) => !used.has(`tune:seed:${s}`));
    const seed = pick(fresh.length ? fresh : TUNE_SEEDS);
    if (!seed) return null;
    used.add(`tune:seed:${seed}`);
    try {
      const r = await withTimeout(api.searchTunes(seed), 8000);
      const round = roundFromBatch(r.items, used);
      if (round) return round;
    } catch {
      /* stalled or failed seed — try another */
    }
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
