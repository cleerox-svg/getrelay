// Guess-the-Tune proxy tests — GET /tunes/search. Mirrors itunes.test.ts:
// the same auth seed (users + sessions + a minted session JWT) and stubs
// the Apple upstream with the pool's fetchMock so no real network is hit.
// Each test uses a distinct term so caches.default entries from one case
// can't satisfy another.
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

describe('GET /tunes/search', () => {
  it('rejects requests without a session cookie', async () => {
    const res = await request('/tunes/search?term=beatles');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a missing term', async () => {
    const res = await request('/tunes/search', { headers: { Cookie: cookie } });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });

  type TuneBody = {
    items: {
      trackId: string;
      previewUrl: string;
      title: string;
      artist: string;
      genre: string;
      artworkUrl: string;
      trackViewUrl: string;
    }[];
  };

  it('sources from Deezer, projecting to the minimal shape and filtering unusable rows', async () => {
    mockDeezer({
      data: [
        {
          id: 101,
          title: 'Here Comes the Sun',
          preview: 'https://audio.deezer/101.mp3',
          artist: { name: 'The Beatles' },
          album: {
            title: 'Abbey Road',
            cover_big: 'https://cdn.deezer/101-big.jpg',
            cover_xl: 'https://cdn.deezer/101-xl.jpg',
          },
          link: 'https://www.deezer.com/track/101',
        },
        // No preview — must be skipped.
        {
          id: 102,
          title: 'Something',
          preview: '',
          artist: { name: 'The Beatles' },
          album: { cover_xl: 'https://cdn.deezer/102-xl.jpg' },
          link: 'https://www.deezer.com/track/102',
        },
        // Missing title — must be skipped.
        {
          id: 103,
          preview: 'https://audio.deezer/103.mp3',
          artist: { name: 'The Beatles' },
          album: { cover_xl: 'https://cdn.deezer/103-xl.jpg' },
          link: 'https://www.deezer.com/track/103',
        },
        // No cover_xl — falls back to cover_big.
        {
          id: 104,
          title: 'Come Together',
          preview: 'https://audio.deezer/104.mp3',
          artist: { name: 'The Beatles' },
          album: { cover_big: 'https://cdn.deezer/104-big.jpg' },
          link: 'https://www.deezer.com/track/104',
        },
        // Duplicate id — must be dropped.
        {
          id: 101,
          title: 'Here Comes the Sun',
          preview: 'https://audio.deezer/101.mp3',
          artist: { name: 'The Beatles' },
          album: { cover_xl: 'https://cdn.deezer/101-xl.jpg' },
          link: 'https://www.deezer.com/track/101',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-unique-1', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuneBody;
    expect(body.items).toEqual([
      {
        trackId: '101',
        previewUrl: 'https://audio.deezer/101.mp3',
        title: 'Here Comes the Sun',
        artist: 'The Beatles',
        genre: '',
        artworkUrl: 'https://cdn.deezer/101-xl.jpg',
        trackViewUrl: 'https://www.deezer.com/track/101',
      },
      {
        trackId: '104',
        previewUrl: 'https://audio.deezer/104.mp3',
        title: 'Come Together',
        artist: 'The Beatles',
        genre: '',
        artworkUrl: 'https://cdn.deezer/104-big.jpg',
        trackViewUrl: 'https://www.deezer.com/track/104',
      },
    ]);
  });

  it('falls back to iTunes when Deezer returns an error payload', async () => {
    mockDeezer({ error: { type: 'Exception', message: 'nope', code: 500 } });
    mockItunes({
      resultCount: 1,
      results: [
        {
          wrapperType: 'track',
          trackId: 201,
          trackName: 'Blackbird',
          artistName: 'The Beatles',
          previewUrl: 'https://audio.example/201.m4a',
          artworkUrl100: 'https://is1.example/e/100x100bb.jpg',
          primaryGenreName: 'Rock',
          trackViewUrl: 'https://music.apple.com/us/album/blackbird/201',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-unique-err', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuneBody;
    expect(body.items).toEqual([
      {
        trackId: '201',
        previewUrl: 'https://audio.example/201.m4a',
        title: 'Blackbird',
        artist: 'The Beatles',
        genre: 'Rock',
        artworkUrl: 'https://is1.example/e/600x600bb.jpg',
        trackViewUrl: 'https://music.apple.com/us/album/blackbird/201',
      },
    ]);
  });

  it('falls back to iTunes when Deezer yields zero usable rows', async () => {
    mockDeezer({ data: [] });
    mockItunes({
      resultCount: 1,
      results: [
        {
          wrapperType: 'track',
          trackId: 202,
          trackName: 'Let It Be',
          artistName: 'The Beatles',
          previewUrl: 'https://audio.example/202.m4a',
          artworkUrl100: 'https://is1.example/f/100x100bb.jpg',
          primaryGenreName: 'Rock',
          trackViewUrl: 'https://music.apple.com/us/album/let-it-be/202',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-unique-empty', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuneBody;
    expect(body.items).toEqual([
      {
        trackId: '202',
        previewUrl: 'https://audio.example/202.m4a',
        title: 'Let It Be',
        artist: 'The Beatles',
        genre: 'Rock',
        artworkUrl: 'https://is1.example/f/600x600bb.jpg',
        trackViewUrl: 'https://music.apple.com/us/album/let-it-be/202',
      },
    ]);
  });

  it('caches a successful result for 10 minutes (previews expire, so no 24h TTL)', async () => {
    mockDeezer({
      data: [
        {
          id: 401,
          title: 'Hey Jude',
          preview: 'https://audio.deezer/401.mp3?hdnea=exp=9999999999~hmac=x',
          artist: { name: 'The Beatles' },
          album: { cover_xl: 'https://cdn.deezer/401-xl.jpg' },
          link: 'https://www.deezer.com/track/401',
        },
      ],
    });
    const res = await request('/tunes/search?term=beatles-cache-ttl', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('public, max-age=600');
  });

  it('retries an HTTP 429 throttle and recovers with the next attempt', async () => {
    // First Deezer call is rate-limited (HTTP 429); the retry succeeds.
    mockDeezer({ error: { code: 4, message: 'Quota limit exceeded' } }, 429);
    mockDeezer({
      data: [
        {
          id: 301,
          title: 'Yesterday',
          preview: 'https://audio.deezer/301.mp3',
          artist: { name: 'The Beatles' },
          album: { cover_xl: 'https://cdn.deezer/301-xl.jpg' },
          link: 'https://www.deezer.com/track/301',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-retry-429', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuneBody;
    expect(body.items).toEqual([
      {
        trackId: '301',
        previewUrl: 'https://audio.deezer/301.mp3',
        title: 'Yesterday',
        artist: 'The Beatles',
        genre: '',
        artworkUrl: 'https://cdn.deezer/301-xl.jpg',
        trackViewUrl: 'https://www.deezer.com/track/301',
      },
    ]);
  });

  it('retries a 200 quota-error envelope (code 4) and recovers with the next attempt', async () => {
    // Deezer signals its quota throttle with HTTP 200 + { error: { code: 4 } }.
    mockDeezer({ error: { code: 4, message: 'Quota limit exceeded' } });
    mockDeezer({
      data: [
        {
          id: 302,
          title: 'Help!',
          preview: 'https://audio.deezer/302.mp3',
          artist: { name: 'The Beatles' },
          album: { cover_xl: 'https://cdn.deezer/302-xl.jpg' },
          link: 'https://www.deezer.com/track/302',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-retry-code4', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuneBody;
    expect(body.items).toEqual([
      {
        trackId: '302',
        previewUrl: 'https://audio.deezer/302.mp3',
        title: 'Help!',
        artist: 'The Beatles',
        genre: '',
        artworkUrl: 'https://cdn.deezer/302-xl.jpg',
        trackViewUrl: 'https://www.deezer.com/track/302',
      },
    ]);
  });

  it('returns 502 when both Deezer and iTunes fail', async () => {
    mockDeezer({ error: { message: 'down' } });
    fetchMock
      .get('https://itunes.apple.com')
      .intercept({ path: (p) => p.startsWith('/search') })
      .reply(500, 'boom');
    const res = await request('/tunes/search?term=beatles-unique-2', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: 'upstream_failed' });
  });

  // Registers a PERSISTENT Deezer interceptor, so keep it last in the file
  // to avoid its generic /search matcher bleeding into other cases.
  it('falls back to iTunes when Deezer throttles through every retry', async () => {
    // Persistent quota throttle: initial attempt + both retries all 429.
    mockDeezerPersist({ error: { code: 4, message: 'Quota limit exceeded' } }, 429);
    mockItunes({
      resultCount: 1,
      results: [
        {
          wrapperType: 'track',
          trackId: 303,
          trackName: 'Michelle',
          artistName: 'The Beatles',
          previewUrl: 'https://audio.example/303.m4a',
          artworkUrl100: 'https://is1.example/m/100x100bb.jpg',
          primaryGenreName: 'Rock',
          trackViewUrl: 'https://music.apple.com/us/album/michelle/303',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-retry-exhausted', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as TuneBody;
    expect(body.items).toEqual([
      {
        trackId: '303',
        previewUrl: 'https://audio.example/303.m4a',
        title: 'Michelle',
        artist: 'The Beatles',
        genre: 'Rock',
        artworkUrl: 'https://is1.example/m/600x600bb.jpg',
        trackViewUrl: 'https://music.apple.com/us/album/michelle/303',
      },
    ]);
  });
});
