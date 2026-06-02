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
  // Both routes use @hono/oauth-providers/google. The middleware uses
  // `redirect_uri` for both initiating the flow and for the code-exchange
  // step, and Google requires both to match the value registered in the
  // Cloud Console (`/auth/google/callback`). Without an explicit
  // redirect_uri the middleware defaults to the current request URL,
  // which on /auth/google would be /auth/google (no callback path) —
  // hence the redirect_uri_mismatch.
  const googleOptions = (c: { req: { url: string }; env: Env }) => ({
    client_id: c.env.GOOGLE_ID,
    client_secret: c.env.GOOGLE_SECRET,
    scope: ['openid', 'email', 'profile'],
    redirect_uri: `${new URL(c.req.url).origin}/auth/google/callback`,
  });

  app.use('/auth/google', async (c, next) => {
    return googleAuth(googleOptions(c))(c, next);
  });

  app.use('/auth/google/callback', async (c, next) => {
    return googleAuth(googleOptions(c))(c, next);
  });

  app.get('/auth/google/callback', async (c) => {
    const googleUser = c.get('user-google') as
      | { id: string; email: string; name: string; picture: string; verified_email: boolean }
      | undefined;
    if (!googleUser || !googleUser.email) {
      return c.text('Google auth failed', 401);
    }

    const { cookie, isNew } = await createSession(c.env, googleUser);
    c.header('Set-Cookie', cookie);

    // Redirect: new users to /onboarding, returning to /chats
    return c.redirect(`${c.env.APP_URL}${isNew ? '/onboarding' : '/chats'}`);
  });

  // ---- Native Google sign-in (Capacitor Android/iOS) ----
  // The redirect/popup OAuth flow above can't complete inside a Capacitor
  // WebView: Google blocks sign-in from embedded WebViews
  // (disallowed_useragent), and even when it doesn't, the OAuth `state`
  // cookie set on /auth/google doesn't survive the bounce through Google
  // back into the app — so the callback throws and the user sees a bare
  // "Internal Server Error". Instead the native app obtains a Google ID
  // token through the platform's Google Sign-In and POSTs it here; we
  // verify it and mint the exact same session cookie the web flow does.
  app.post('/auth/google/native', async (c) => {
    const body = await c.req.json<{ idToken?: string }>().catch(() => null);
    const idToken = body?.idToken;
    if (!idToken) return c.json({ error: 'missing_id_token' }, 400);

    // Verify with Google's tokeninfo endpoint — Google validates the
    // signature and expiry server-side; we still must check the audience
    // and issuer ourselves so a token minted for some other app can't be
    // replayed against us.
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!resp.ok) return c.json({ error: 'invalid_id_token' }, 401);
    const info = (await resp.json()) as {
      aud?: string;
      iss?: string;
      sub?: string;
      email?: string;
      email_verified?: string | boolean;
      name?: string;
      picture?: string;
    };

    // The native plugin must request the token for our *web* OAuth client
    // (serverClientId === GOOGLE_ID), so that's the audience we expect.
    const issOk =
      info.iss === 'accounts.google.com' || info.iss === 'https://accounts.google.com';
    const emailVerified = info.email_verified === true || info.email_verified === 'true';
    if (info.aud !== c.env.GOOGLE_ID || !issOk || !info.sub || !info.email || !emailVerified) {
      return c.json({ error: 'id_token_rejected' }, 401);
    }

    const { cookie, isNew } = await createSession(c.env, {
      id: info.sub,
      email: info.email,
      name: info.name ?? info.email,
      picture: info.picture ?? '',
    });
    c.header('Set-Cookie', cookie);
    return c.json({ ok: true, isNew });
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

// Shared by both the web redirect callback and the native sign-in
// endpoint: find/create the user, persist a session row, and build the
// session cookie. Returns the Set-Cookie value and whether this is the
// user's first login (drives the onboarding redirect).
async function createSession(
  env: Env,
  g: { id: string; email: string; name: string; picture: string },
): Promise<{ cookie: string; isNew: boolean }> {
  const userId = await findOrCreateUser(env, g);
  const jti = crypto.randomUUID();
  const now = Math.floor(Date.now() / 1000);
  const exp = now + SESSION_TTL_SECONDS;

  await env.DB.prepare(
    `INSERT INTO sessions (jwt_id, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)`,
  ).bind(jti, userId, now * 1000, exp * 1000).run();

  const token = await signJwt({ sub: userId, jti, iat: now, exp }, env.JWT_SECRET);
  const cookie = makeSessionCookie(token, {
    domain: env.AUTH_COOKIE_DOMAIN,
    maxAgeSeconds: SESSION_TTL_SECONDS,
  });
  const isNew = await isFirstLogin(env, userId);
  return { cookie, isNew };
}

async function findOrCreateUser(
  env: Env,
  g: { id: string; email: string; name: string; picture: string },
): Promise<string> {
  const adminFlag = isAdminEmail(env, g.email) ? 1 : 0;

  // 1) Exact match on google_sub — returning user.
  const existing = await env.DB.prepare(
    `SELECT id, is_admin FROM users WHERE google_sub = ?`,
  ).bind(g.id).first<{ id: string; is_admin: number }>();
  if (existing) {
    if (adminFlag && !existing.is_admin) {
      await env.DB.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`)
        .bind(existing.id).run();
    }
    return existing.id;
  }

  // 2) Pending row claim — if a row was pre-seeded with
  //    google_sub = 'pending:<email>' (see migrations/seed-contacts.sql),
  //    adopt it. PIN + contact links from the seed survive intact.
  const pending = await env.DB.prepare(
    `SELECT id, is_admin FROM users
     WHERE email = ? AND google_sub LIKE 'pending:%'`,
  ).bind(g.email).first<{ id: string; is_admin: number }>();
  if (pending) {
    const nextAdmin = adminFlag || pending.is_admin ? 1 : 0;
    await env.DB.prepare(
      `UPDATE users SET google_sub = ?, is_admin = ? WHERE id = ?`,
    ).bind(g.id, nextAdmin, pending.id).run();
    return pending.id;
  }

  // 3) Brand-new sign-up. We deliberately don't persist the Google
  //    profile picture — the avatar starts as initials and the user
  //    can upload their own via POST /me/avatar.
  for (let attempt = 0; attempt < 5; attempt++) {
    const userId = crypto.randomUUID();
    const pin = generatePin(8);
    try {
      await env.DB.prepare(
        `INSERT INTO users
         (id, google_sub, email, pin, display_name, created_at, is_admin)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
        .bind(userId, g.id, g.email, pin, g.name || g.email, Date.now(), adminFlag)
        .run();
      return userId;
    } catch (err) {
      const msg = String(err);
      if (msg.includes('UNIQUE') && msg.includes('pin')) continue;
      const racer = await env.DB.prepare(
        `SELECT id, is_admin FROM users WHERE google_sub = ?`,
      ).bind(g.id).first<{ id: string; is_admin: number }>();
      if (racer) {
        if (adminFlag && !racer.is_admin) {
          await env.DB.prepare(`UPDATE users SET is_admin = 1 WHERE id = ?`)
            .bind(racer.id).run();
        }
        return racer.id;
      }
      throw err;
    }
  }
  throw new Error('pin_collision_exhausted');
}

export function isAdminEmail(env: Env, email: string): boolean {
  const list = (env.ADMIN_EMAILS ?? '')
    .split(',')
    .map((e) => e.trim().toLowerCase())
    .filter((e) => e.length > 0);
  return list.includes(email.toLowerCase());
}

async function isFirstLogin(env: Env, userId: string): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?`,
  ).bind(userId).first<{ c: number }>();
  return (row?.c ?? 0) <= 1;
}
