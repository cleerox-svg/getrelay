// iTunes Search proxy tests — GET /itunes/search. Mirrors the auth
// seed in games.test.ts (users + sessions + a minted session JWT) and
// stubs the Apple upstream with the pool's fetchMock so no real network
// is hit. Each test uses a distinct term so caches.default entries from
// one case can't satisfy another.
import { beforeAll, describe, expect, it } from 'vitest';
import {
  createExecutionContext,
  env,
  fetchMock,
  waitOnExecutionContext,
} from 'cloudflare:test';
import worker from '../src/index';
import type { Env } from '../src/env';
import { signJwt } from '../src/lib/jwt';

const testEnv = env as unknown as Env;
const DAY = 24 * 3600 * 1000;

const DDL = [
  `CREATE TABLE IF NOT EXISTS users (
     id TEXT PRIMARY KEY,
     google_sub TEXT UNIQUE NOT NULL,
     email TEXT UNIQUE NOT NULL,
     pin TEXT UNIQUE NOT NULL,
     display_name TEXT NOT NULL,
     status_message TEXT,
     avatar_url TEXT,
     avatar_r2_key TEXT,
     created_at INTEGER NOT NULL,
     last_seen_at INTEGER,
     is_admin INTEGER NOT NULL DEFAULT 0
   )`,
  `CREATE TABLE IF NOT EXISTS sessions (
     jwt_id TEXT PRIMARY KEY,
     user_id TEXT NOT NULL REFERENCES users(id),
     created_at INTEGER NOT NULL,
     expires_at INTEGER NOT NULL,
     revoked INTEGER DEFAULT 0
   )`,
];

let cookie = '';

async function seed() {
  for (const sql of DDL) await testEnv.DB.prepare(sql).run();
  const now = Date.now();
  await testEnv.DB.prepare(
    `INSERT INTO users (id, google_sub, email, pin, display_name, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind('user-a', 'sub-a', 'a@example.com', 'PINAAA01', 'Alice', now)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO sessions (jwt_id, user_id, created_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, 0)`,
  )
    .bind('jti-a', 'user-a', now, now + 30 * DAY)
    .run();
  const nowSec = Math.floor(now / 1000);
  const token = await signJwt(
    { sub: 'user-a', jti: 'jti-a', iat: nowSec, exp: nowSec + 3600 },
    'test-secret',
  );
  cookie = `relay_session=${token}`;
}

function mockItunes(body: object) {
  fetchMock
    .get('https://itunes.apple.com')
    .intercept({ path: (p) => p.startsWith('/search') })
    .reply(200, body, { headers: { 'content-type': 'application/json' } });
}

// Single-use Deezer reply. Called multiple times in registration order to
// script a burst: the first Deezer call consumes the first interceptor, the
// retry consumes the next.
function mockDeezer(body: object, status = 200) {
  fetchMock
    .get('https://api.deezer.com')
    .intercept({ path: (p) => p.startsWith('/search') })
    .reply(status, body, { headers: { 'content-type': 'application/json' } });
}

// Persistent Deezer reply — every attempt (initial + retries) gets it.
function mockDeezerPersist(body: object, status = 200) {
  fetchMock
    .get('https://api.deezer.com')
    .intercept({ path: (p) => p.startsWith('/search') })
    .reply(status, body, { headers: { 'content-type': 'application/json' } })
    .persist();
}

async function request(path: string, init?: RequestInit): Promise<Response> {
  const ctx = createExecutionContext();
  const res = await worker.fetch(new Request(`https://example.com${path}`, init), testEnv, ctx);
  await waitOnExecutionContext(ctx);
  return res;
}

beforeAll(async () => {
  await seed();
  fetchMock.activate();
  fetchMock.disableNetConnect();
});

describe('GET /itunes/search', () => {
  it('rejects requests without a session cookie', async () => {
    const res = await request('/itunes/search?term=jazz');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a missing term', async () => {
    const res = await request('/itunes/search', { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });

  type ItunesBody = {
    items: { id: string; artistName: string; collectionName: string; artworkUrl: string; genre: string }[];
  };

  it('sources album art from Deezer, projecting to the minimal shape and deduping', async () => {
    mockDeezer({
      data: [
        {
          id: 1,
          title: 'Kind of Blue',
          artist: { name: 'Miles Davis' },
          cover_big: 'https://cdn.deezer/1-big.jpg',
          cover_xl: 'https://cdn.deezer/1-xl.jpg',
          link: 'https://www.deezer.com/album/1',
        },
        // Duplicate id — must be dropped.
        {
          id: 1,
          title: 'Kind of Blue',
          artist: { name: 'Miles Davis' },
          cover_xl: 'https://cdn.deezer/1-xl.jpg',
        },
        // No artwork — must be skipped.
        {
          id: 2,
          title: 'Blue Train',
          artist: { name: 'John Coltrane' },
        },
        // No cover_xl — falls back to cover_big.
        {
          id: 3,
          title: 'A Love Supreme',
          artist: { name: 'John Coltrane' },
          cover_big: 'https://cdn.deezer/3-big.jpg',
        },
      ],
    });

    const res = await request('/itunes/search?term=jazz-unique-1', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItunesBody;
    expect(body.items).toEqual([
      {
        id: '1',
        artistName: 'Miles Davis',
        collectionName: 'Kind of Blue',
        artworkUrl: 'https://cdn.deezer/1-xl.jpg',
        genre: '',
      },
      {
        id: '3',
        artistName: 'John Coltrane',
        collectionName: 'A Love Supreme',
        artworkUrl: 'https://cdn.deezer/3-big.jpg',
        genre: '',
      },
    ]);
  });

  it('falls back to iTunes when Deezer returns an error payload', async () => {
    mockDeezer({ error: { type: 'Exception', message: 'nope', code: 500 } });
    mockItunes({
      resultCount: 1,
      results: [
        {
          wrapperType: 'collection',
          collectionId: 10,
          artistName: 'Bill Evans',
          collectionName: 'Sunday at the Village Vanguard',
          artworkUrl100: 'https://is1.example/g/100x100bb.jpg',
          primaryGenreName: 'Jazz',
        },
      ],
    });

    const res = await request('/itunes/search?term=jazz-unique-err', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItunesBody;
    expect(body.items).toEqual([
      {
        id: '10',
        artistName: 'Bill Evans',
        collectionName: 'Sunday at the Village Vanguard',
        artworkUrl: 'https://is1.example/g/600x600bb.jpg',
        genre: 'Jazz',
      },
    ]);
  });

  it('falls back to iTunes when Deezer yields zero usable rows', async () => {
    mockDeezer({ data: [] });
    mockItunes({
      resultCount: 1,
      results: [
        {
          wrapperType: 'collection',
          collectionId: 11,
          artistName: 'Thelonious Monk',
          collectionName: 'Monk’s Dream',
          artworkUrl100: 'https://is1.example/h/100x100bb.jpg',
          primaryGenreName: 'Jazz',
        },
      ],
    });

    const res = await request('/itunes/search?term=jazz-unique-empty', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItunesBody;
    expect(body.items).toEqual([
      {
        id: '11',
        artistName: 'Thelonious Monk',
        collectionName: 'Monk’s Dream',
        artworkUrl: 'https://is1.example/h/600x600bb.jpg',
        genre: 'Jazz',
      },
    ]);
  });

  it('retries a Deezer throttle (code 700) and recovers with the next attempt', async () => {
    // First album search is throttled (200 + { error: { code: 700 } }); retry wins.
    mockDeezer({ error: { code: 700, message: 'Service busy' } });
    mockDeezer({
      data: [
        {
          id: 20,
          title: 'Giant Steps',
          artist: { name: 'John Coltrane' },
          cover_xl: 'https://cdn.deezer/20-xl.jpg',
          link: 'https://www.deezer.com/album/20',
        },
      ],
    });

    const res = await request('/itunes/search?term=jazz-retry-700', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItunesBody;
    expect(body.items).toEqual([
      {
        id: '20',
        artistName: 'John Coltrane',
        collectionName: 'Giant Steps',
        artworkUrl: 'https://cdn.deezer/20-xl.jpg',
        genre: '',
      },
    ]);
  });

  it('returns 502 when both Deezer and iTunes fail', async () => {
    mockDeezer({ error: { message: 'down' } });
    fetchMock
      .get('https://itunes.apple.com')
      .intercept({ path: (p) => p.startsWith('/search') })
      .reply(500, 'boom');
    const res = await request('/itunes/search?term=jazz-unique-2', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_failed' });
  });

  // Registers a PERSISTENT Deezer interceptor, so keep it last in the file
  // to avoid its generic /search matcher bleeding into other cases.
  it('falls back to iTunes when Deezer throttles through every retry', async () => {
    mockDeezerPersist({ error: { code: 4, message: 'Quota limit exceeded' } }, 429);
    mockItunes({
      resultCount: 1,
      results: [
        {
          wrapperType: 'collection',
          collectionId: 21,
          artistName: 'Charles Mingus',
          collectionName: 'Mingus Ah Um',
          artworkUrl100: 'https://is1.example/i/100x100bb.jpg',
          primaryGenreName: 'Jazz',
        },
      ],
    });

    const res = await request('/itunes/search?term=jazz-retry-exhausted', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as ItunesBody;
    expect(body.items).toEqual([
      {
        id: '21',
        artistName: 'Charles Mingus',
        collectionName: 'Mingus Ah Um',
        artworkUrl: 'https://is1.example/i/600x600bb.jpg',
        genre: 'Jazz',
      },
    ]);
  });
});
