// Round sources for the Fog guessing game. Each source produces
// { image, answer, 3 distractors } rounds from a different corpus:
// bundled pack SVGs, sports team logos, Giphy stills, or contact
// avatars. All remote images are shown via <img> only — they are
// never drawn into the fog canvas (cross-origin pixels would taint it
// and break the fogPct() readback), so no CORS headers are required.

import { api } from '../api';
import { useStore } from '../store';
import { FOG_PACK } from './pack';

export type FogCategory = 'logos' | 'pack' | 'gifs' | 'contacts' | 'mix';

export interface FogRound {
  imageUrl: string;
  answer: string;
  choices: string[];
  category: Exclude<FogCategory, 'mix'>;
}

export interface RoundSource {
  id: Exclude<FogCategory, 'mix'>;
  label: string;
  available(): Promise<boolean>;
  // `used` carries source-namespaced keys across a game so the same
  // subject can't come up twice. Returns null when the corpus is
  // exhausted or a fetch produced nothing usable.
  next(used: Set<string>): Promise<FogRound | null>;
}

// ---- helpers ----

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

// ---- logos: NHL + MLB team logos ----

interface LogoTeam {
  league: 'NHL' | 'MLB';
  key: string;
  name: string;
  logo: string;
}

let teamsPromise: Promise<LogoTeam[]> | null = null;

function loadTeams(): Promise<LogoTeam[]> {
  if (!teamsPromise) {
    teamsPromise = api
      .getSportsTeams()
      .then((r) => {
        const all: LogoTeam[] = [];
        for (const t of r.nhl) {
          if (t.logo) all.push({ league: 'NHL', key: t.key, name: t.name, logo: t.logo });
        }
        for (const t of r.mlb) {
          if (t.logo) all.push({ league: 'MLB', key: t.key, name: t.name, logo: t.logo });
        }
        return all;
      })
      .catch((e: unknown) => {
        // Allow a retry on the next call instead of caching the failure
        // for the whole session.
        teamsPromise = null;
        throw e;
      });
  }
  return teamsPromise;
}

const logosSource: RoundSource = {
  id: 'logos',
  label: 'Team logos',
  available: async () => {
    try {
      return (await loadTeams()).length >= 4;
    } catch {
      return false;
    }
  },
  next: async (used) => {
    const teams = await loadTeams();
    const fresh = teams.filter((t) => !used.has(`logos:${t.league}:${t.key}`));
    const team = pick(fresh);
    if (!team) return null;
    used.add(`logos:${team.league}:${team.key}`);
    // Distractors stay within the same league — an NHL name among MLB
    // choices would be a giveaway.
    const others = teams.filter((t) => t.league === team.league && t.key !== team.key);
    const distractors = sample(others, 3).map((t) => t.name);
    return {
      imageUrl: team.logo,
      answer: team.name,
      choices: shuffle([team.name, ...distractors]),
      category: 'logos',
    };
  },
};

// ---- pack: bundled SVG objects ----

const packSource: RoundSource = {
  id: 'pack',
  label: 'Objects',
  // Bundled assets: always available, and the fallback for every
  // other source's failure path.
  available: async () => true,
  next: async (used) => {
    const fresh = FOG_PACK.filter((p) => !used.has(`pack:${p.id}`));
    const item = pick(fresh);
    if (!item) return null;
    used.add(`pack:${item.id}`);
    const others = FOG_PACK.filter((p) => p.id !== item.id).map((p) => p.label);
    return {
      imageUrl: item.path,
      answer: item.label,
      choices: shuffle([item.label, ...sample(others, 3)]),
      category: 'pack',
    };
  },
};

// ---- gifs: Giphy stills for concrete-noun keywords ----

// Concrete, drawable nouns only — the player has to recognize the
// subject from a fragment, so abstract or ambiguous terms don't work.
const GIF_KEYWORDS: readonly string[] = [
  'pizza', 'penguin', 'rocket', 'guitar', 'dinosaur', 'cupcake', 'waterfall',
  'kitten', 'puppy', 'robot', 'rainbow', 'tornado', 'volcano', 'skateboard',
  'helicopter', 'unicorn', 'octopus', 'panda', 'sloth', 'flamingo', 'popcorn',
  'donut', 'sushi', 'hamburger', 'fireworks', 'snowboard', 'motorcycle',
  'sunflower', 'jellyfish', 'koala', 'hedgehog', 'parrot', 'avocado',
  'pancake', 'telescope', 'submarine', 'cheetah', 'dolphin', 'pretzel',
  'accordion',
];

let gifsAvailable: boolean | null = null;

const gifsSource: RoundSource = {
  id: 'gifs',
  label: 'GIFs',
  available: async () => {
    if (gifsAvailable !== null) return gifsAvailable;
    try {
      // One probe search; ApiError 404 gifs_not_configured (or a 502
      // from the upstream) means the category is off for this session.
      const r = await api.searchGifs('pizza');
      gifsAvailable = r.items.length > 0;
    } catch {
      gifsAvailable = false;
    }
    return gifsAvailable;
  },
  next: async (used) => {
    const fresh = GIF_KEYWORDS.filter((k) => !used.has(`gifs:${k}`));
    const kw = pick(fresh);
    if (!kw) return null;
    used.add(`gifs:${kw}`);
    // Random offset into the result set so repeat games don't always
    // show the same top hit for a keyword.
    const pos = String(Math.floor(Math.random() * 21));
    const r = await api.searchGifs(kw, pos);
    const item = pick(r.items);
    if (!item) return null;
    // stillUrl is a static first frame added by the worker; older
    // worker deploys don't send it, in which case the animated preview
    // is the (slightly easier) fallback.
    const imageUrl = item.stillUrl ?? item.previewUrl;
    const distractors = sample(GIF_KEYWORDS.filter((k) => k !== kw), 3);
    return {
      imageUrl,
      answer: kw,
      choices: shuffle([kw, ...distractors]),
      category: 'gifs',
    };
  },
};

// ---- contacts: guess whose avatar is behind the glass ----

async function avatarContacts() {
  const st = useStore.getState();
  if (st.contacts.length === 0) {
    try {
      await st.loadContacts();
    } catch {
      /* offline — play with whatever is cached */
    }
  }
  return useStore.getState().contacts.filter((c) => c.avatarUrl != null);
}

// The name the rest of the app shows for a contact: alias wins.
function contactName(c: { alias: string | null; displayName: string }): string {
  return c.alias?.trim() || c.displayName;
}

const contactsSource: RoundSource = {
  id: 'contacts',
  label: 'Contacts',
  available: async () => (await avatarContacts()).length >= 4,
  next: async (used) => {
    const pool = await avatarContacts();
    if (pool.length < 4) return null;
    const fresh = pool.filter((c) => !used.has(`contacts:${c.id}`));
    const target = pick(fresh);
    if (!target || !target.avatarUrl) return null;
    used.add(`contacts:${target.id}`);
    const distractors = sample(
      pool.filter((c) => c.id !== target.id).map(contactName),
      3,
    );
    return {
      imageUrl: target.avatarUrl,
      answer: contactName(target),
      choices: shuffle([contactName(target), ...distractors]),
      category: 'contacts',
    };
  },
};

export const ROUND_SOURCES: readonly RoundSource[] = [
  logosSource,
  packSource,
  gifsSource,
  contactsSource,
];

export type SourceAvailability = Record<Exclude<FogCategory, 'mix'>, boolean>;

export async function availableSources(): Promise<SourceAvailability> {
  const flags = await Promise.all(
    ROUND_SOURCES.map((s) => s.available().catch(() => false)),
  );
  return {
    logos: flags[0] ?? false,
    pack: flags[1] ?? true,
    gifs: flags[2] ?? false,
    contacts: flags[3] ?? false,
  };
}

// Warm an image into the browser cache and make sure it actually
// decodes before the round starts — the fog must never lift on a
// broken pane. decode() is raced against a timeout because a stalled
// CDN request would otherwise hang the round transition.
function preloadImage(url: string, timeoutMs = 6000): Promise<void> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    let done = false;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      window.clearTimeout(timer);
      if (ok) resolve();
      else reject(new Error('image_load_failed'));
    };
    const timer = window.setTimeout(() => finish(false), timeoutMs);
    img.onload = () => {
      // decode() isn't available on very old WebViews; onload alone is
      // an acceptable signal there.
      if (typeof img.decode === 'function') {
        img.decode().then(() => finish(true), () => finish(true));
      } else {
        finish(true);
      }
    };
    img.onerror = () => finish(false);
    img.src = url;
  });
}

function resolveSource(category: FogCategory, avail: SourceAvailability): RoundSource {
  if (category !== 'mix') {
    return ROUND_SOURCES.find((s) => s.id === category) ?? packSource;
  }
  const candidates = ROUND_SOURCES.filter((s) => avail[s.id]);
  return pick(candidates) ?? packSource;
}

// Build one playable round: pick a source, fetch a round, preload the
// image. Retries with a different pick up to 3 times, then falls back
// to the bundled pack (which can't fail — local assets, and a game is
// only 8 rounds against a 24-item pack).
export async function buildRound(
  category: FogCategory,
  used: Set<string>,
): Promise<FogRound> {
  const avail = category === 'mix' ? await availableSources() : null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const src = avail ? resolveSource(category, avail) : resolveSource(category, {
      logos: true, pack: true, gifs: true, contacts: true,
    });
    try {
      const round = await src.next(used);
      if (!round) continue;
      await preloadImage(round.imageUrl);
      return round;
    } catch {
      continue;
    }
  }
  const fallback = await packSource.next(used);
  if (fallback) return fallback;
  // Only reachable if something cleared FOG_PACK — keep the game alive.
  const first = FOG_PACK[0];
  return {
    imageUrl: first?.path ?? '',
    answer: first?.label ?? 'Umbrella',
    choices: FOG_PACK.slice(0, 4).map((p) => p.label),
    category: 'pack',
  };
}
