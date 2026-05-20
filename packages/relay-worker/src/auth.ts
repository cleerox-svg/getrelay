import { Hono } from 'hono';
import { googleAuth } from '@hono/oauth-providers/google';
import type { Env } from './env';
import { generatePin } from './pin';
import { signJwt, verifyJwt, type JwtClaims } from './lib/jwt';
import { makeSessionCookie, clearSessionCookie, readSessionCookie } from './lib/cookies';

const SESSION_TTL_DAYS = 30;
const SESSION_TTL_SECONDS = SESSION_TTL_DAYS * 24 * 60 * 60;

export interface AuthedUser {
  id: string;
  jti: string;
}

export function authRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // ---- Google OAuth ----
  app.use('/auth/google', async (c, next) => {
    const middleware = googleAuth({
      client_id: c.env.GOOGLE_ID,
      client_secret: c.env.GOOGLE_SECRET,
      scope: ['openid', 'email', 'profile'],
    });
    return middleware(c, next);
  });

  app.use('/auth/google/callback', async (c, next) => {
    const middleware = googleAuth({
      client_id: c.env.GOOGLE_ID,
      client_secret: c.env.GOOGLE_SECRET,
      scope: ['openid', 'email', 'profile'],
    });
    return middleware(c, next);
  });

  app.get('/auth/google/callback', async (c) => {
    const googleUser = c.get('user-google') as
      | { id: string; email: string; name: string; picture: string; verified_email: boolean }
      | undefined;
    if (!googleUser || !googleUser.email) {
      return c.text('Google auth failed', 401);
    }

    const userId = await findOrCreateUser(c.env, googleUser);
    const jti = crypto.randomUUID();
    const now = Math.floor(Date.now() / 1000);
    const exp = now + SESSION_TTL_SECONDS;

    await c.env.DB.prepare(
      `INSERT INTO sessions (jwt_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
    ).bind(jti, userId, now * 1000, exp * 1000).run();

    const token = await signJwt({ sub: userId, jti, iat: now, exp }, c.env.JWT_SECRET);
    c.header(
      'Set-Cookie',
      makeSessionCookie(token, {
        domain: c.env.AUTH_COOKIE_DOMAIN,
        maxAgeSeconds: SESSION_TTL_SECONDS,
      }),
    );

    // Redirect: new users to /onboarding, returning to /chats
    const isNew = await isFirstLogin(c.env, userId);
    return c.redirect(`${c.env.APP_URL}${isNew ? '/onboarding' : '/chats'}`);
  });

  app.post('/auth/signout', async (c) => {
    const user = await readAuthedUser(c.env, c.req.raw);
    if (user) {
      await c.env.DB.prepare(`UPDATE sessions SET revoked = 1 WHERE jwt_id = ?`)
        .bind(user.jti).run();
    }
    c.header('Set-Cookie', clearSessionCookie(c.env.AUTH_COOKIE_DOMAIN));
    return c.body(null, 204);
  });

  return app;
}

export async function readAuthedUser(env: Env, request: Request): Promise<AuthedUser | null> {
  const cookie = readSessionCookie(request.headers.get('cookie'));
  if (!cookie) return null;
  const claims: JwtClaims | null = await verifyJwt(cookie, env.JWT_SECRET);
  if (!claims) return null;

  const row = await env.DB.prepare(
    `SELECT user_id, revoked, expires_at FROM sessions WHERE jwt_id = ?`,
  ).bind(claims.jti).first<{ user_id: string; revoked: number; expires_at: number }>();
  if (!row) return null;
  if (row.revoked) return null;
  if (row.expires_at < Date.now()) return null;

  return { id: row.user_id, jti: claims.jti };
}

async function findOrCreateUser(
  env: Env,
  g: { id: string; email: string; name: string; picture: string },
): Promise<string> {
  const existing = await env.DB.prepare(
    `SELECT id FROM users WHERE google_sub = ?`,
  ).bind(g.id).first<{ id: string }>();
  if (existing) return existing.id;

  // New user: create with a unique PIN.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userId = crypto.randomUUID();
    const pin = generatePin(8);
    try {
      await env.DB.prepare(
        `INSERT INTO users
         (id, google_sub, email, pin, display_name, avatar_url, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(userId, g.id, g.email, pin, g.name || g.email, g.picture, Date.now()).run();
      return userId;
    } catch (err) {
      // unique constraint on PIN → retry; on email or google_sub → race, lookup again
      const msg = String(err);
      if (msg.includes('UNIQUE') && msg.includes('pin')) continue;
      const racer = await env.DB.prepare(
        `SELECT id FROM users WHERE google_sub = ?`,
      ).bind(g.id).first<{ id: string }>();
      if (racer) return racer.id;
      throw err;
    }
  }
  throw new Error('pin_collision_exhausted');
}

async function isFirstLogin(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?`,
  ).bind(userId).first<{ c: number }>();
  return (row?.c ?? 0) <= 1;
}
