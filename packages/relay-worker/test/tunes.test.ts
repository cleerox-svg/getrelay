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

  it('projects to the minimal shape and filters preview-less/nameless rows', async () => {
    mockItunes({
      resultCount: 4,
      results: [
        {
          wrapperType: 'track',
          trackId: 101,
          trackName: 'Here Comes the Sun',
          artistName: 'The Beatles',
          previewUrl: 'https://audio.example/101.m4a',
          artworkUrl100: 'https://is1.example/a/100x100bb.jpg',
          primaryGenreName: 'Rock',
        },
        // No previewUrl — must be skipped.
        {
          wrapperType: 'track',
          trackId: 102,
          trackName: 'Something',
          artistName: 'The Beatles',
          artworkUrl100: 'https://is1.example/b/100x100bb.jpg',
          primaryGenreName: 'Rock',
        },
        // Missing trackName — must be skipped.
        {
          wrapperType: 'track',
          trackId: 103,
          artistName: 'The Beatles',
          previewUrl: 'https://audio.example/103.m4a',
          artworkUrl100: 'https://is1.example/c/100x100bb.jpg',
          primaryGenreName: 'Rock',
        },
        // Duplicate trackId — must be dropped.
        {
          wrapperType: 'track',
          trackId: 101,
          trackName: 'Here Comes the Sun',
          artistName: 'The Beatles',
          previewUrl: 'https://audio.example/101.m4a',
          artworkUrl100: 'https://is1.example/a/100x100bb.jpg',
          primaryGenreName: 'Rock',
        },
      ],
    });

    const res = await request('/tunes/search?term=beatles-unique-1', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      items: {
        trackId: string;
        previewUrl: string;
        title: string;
        artist: string;
        genre: string;
        artworkUrl: string;
      }[];
    };
    expect(body.items).toEqual([
      {
        trackId: '101',
        previewUrl: 'https://audio.example/101.m4a',
        title: 'Here Comes the Sun',
        artist: 'The Beatles',
        genre: 'Rock',
        artworkUrl: 'https://is1.example/a/600x600bb.jpg',
      },
    ]);
  });

  it('returns 502 when the upstream fails', async () => {
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
});
