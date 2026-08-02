// Exact Spotify track-link resolution tests — GET /tunes/spotify. Mirrors
// tunes.test.ts: same auth seed (users + sessions + a minted session JWT) and
// stubs the two fixed Spotify hosts with the pool's fetchMock so no real
// network is hit. Each test uses distinct title/artist values so
// caches.default entries from one case can't satisfy another.
//
// The Spotify secrets are OPTIONAL, so we mutate them on testEnv per case:
// the "unset" test asserts we never touch Spotify, the "set" tests inject
// dummy credentials and mock the token + search endpoints.
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
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
    .bind('user-s', 'sub-s', 's@example.com', 'PINSSS01', 'Sam', now)
    .run();
  await testEnv.DB.prepare(
    `INSERT INTO sessions (jwt_id, user_id, created_at, expires_at, revoked)
     VALUES (?, ?, ?, ?, 0)`,
  )
    .bind('jti-s', 'user-s', now, now + 30 * DAY)
    .run();
  const nowSec = Math.floor(now / 1000);
  const token = await signJwt(
    { sub: 'user-s', jti: 'jti-s', iat: nowSec, exp: nowSec + 3600 },
    'test-secret',
  );
  cookie = `relay_session=${token}`;
}

function setSecrets(on: boolean) {
  if (on) {
    testEnv.SPOTIFY_CLIENT_ID = 'test-client-id';
    testEnv.SPOTIFY_CLIENT_SECRET = 'test-client-secret';
  } else {
    delete (testEnv as { SPOTIFY_CLIENT_ID?: string }).SPOTIFY_CLIENT_ID;
    delete (testEnv as { SPOTIFY_CLIENT_SECRET?: string }).SPOTIFY_CLIENT_SECRET;
  }
}

function mockToken(status = 200, body: object = { access_token: 'tok-123', expires_in: 3600 }) {
  fetchMock
    .get('https://accounts.spotify.com')
    .intercept({ path: (p) => p.startsWith('/api/token'), method: 'POST' })
    .reply(status, body, { headers: { 'content-type': 'application/json' } });
}

function mockSearch(status: number, body: object | string) {
  fetchMock
    .get('https://api.spotify.com')
    .intercept({ path: (p) => p.startsWith('/v1/search') })
    .reply(status, body, { headers: { 'content-type': 'application/json' } });
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

afterEach(() => {
  setSecrets(false);
});

describe('GET /tunes/spotify', () => {
  it('rejects requests without a session cookie', async () => {
    const res = await request('/tunes/spotify?title=Yesterday&artist=The%20Beatles');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'unauthorized' });
  });

  it('rejects a missing title', async () => {
    const res = await request('/tunes/spotify?artist=The%20Beatles', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });

  it('rejects a missing artist', async () => {
    const res = await request('/tunes/spotify?title=Yesterday', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: 'bad_request' });
  });

  it('resolves the exact track URL when secrets are configured', async () => {
    setSecrets(true);
    mockToken();
    mockSearch(200, {
      tracks: {
        items: [
          {
            external_urls: { spotify: 'https://open.spotify.com/track/abc123' },
          },
        ],
      },
    });

    const res = await request('/tunes/spotify?title=Resolve%20Hit&artist=Case%20D', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: 'https://open.spotify.com/track/abc123' });
  });

  it('returns { url: null } without calling Spotify when secrets are unset', async () => {
    // No mocks registered + disableNetConnect means any Spotify fetch would
    // throw — proving we short-circuit before touching the network.
    setSecrets(false);
    const res = await request('/tunes/spotify?title=Unconfigured&artist=Case%20E', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  it('returns { url: null } when the search returns no items', async () => {
    setSecrets(true);
    mockToken();
    mockSearch(200, { tracks: { items: [] } });

    const res = await request('/tunes/spotify?title=No%20Hit&artist=Case%20F', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  it('returns { url: null } when the search upstream fails', async () => {
    setSecrets(true);
    mockToken();
    mockSearch(500, 'boom');

    const res = await request('/tunes/spotify?title=Boom&artist=Case%20G', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });

  it('returns { url: null } when the token endpoint fails', async () => {
    setSecrets(true);
    mockToken(401, { error: 'invalid_client' });

    const res = await request('/tunes/spotify?title=NoToken&artist=Case%20H', {
      headers: { Cookie: cookie },
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ url: null });
  });
});
