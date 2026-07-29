// Firebase Cloud Messaging (HTTP v1) sender for Cloudflare Workers.
//
// Native Android (and iOS, if ever built) can't use Web Push — the
// Capacitor WebView doesn't expose the PushManager API. Those installs
// register an FCM device token instead (via @capacitor/push-notifications),
// and this module delivers the same notification payloads to them.
//
// Auth is the FCM HTTP v1 flow: sign a short-lived JWT with the service
// account's private key, exchange it for an OAuth2 access token, and POST
// the message. The legacy `Authorization: key=...` server-key API was shut
// down by Google, so v1 is the only option. Everything runs on crypto.subtle
// — no Node polyfills.

import type { Env } from '../env';

interface ServiceAccount {
  client_email: string;
  private_key: string;
  token_uri?: string;
}

// A notification payload. `title`/`body` drive the visible notification;
// everything else (chatId, url, tag, …) rides along as string data so the
// app can route a tap. Matches the shape Web Push already sends.
export interface NativePushPayload {
  title?: string;
  body?: string;
  tag?: string;
  chatId?: string;
  url?: string;
  [key: string]: unknown;
}

export interface FcmSendOptions {
  // High priority wakes a dozing Android device immediately (Doze/idle),
  // matching the Web Push `urgency: high` used for messages + score alerts.
  highPriority?: boolean;
}

export interface FcmSendResult {
  token: string;
  ok: boolean;
  status: number;
  // The push service says this token is permanently gone (app uninstalled
  // or token rotated) — the caller should delete it.
  unregistered: boolean;
  body?: string;
}

const TE = new TextEncoder();

export function fcmConfigured(env: Env): boolean {
  return Boolean(env.FCM_PROJECT_ID && env.FCM_SERVICE_ACCOUNT_JSON);
}

function parseServiceAccount(env: Env): ServiceAccount | null {
  if (!env.FCM_SERVICE_ACCOUNT_JSON) return null;
  try {
    const sa = JSON.parse(env.FCM_SERVICE_ACCOUNT_JSON) as ServiceAccount;
    if (!sa.client_email || !sa.private_key) return null;
    return sa;
  } catch {
    return null;
  }
}

function b64url(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

// Import a PKCS#8 PEM RSA private key (as found in a Google service-account
// JSON `private_key`) for RS256 signing.
async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const body = pem
    .replace(/-----BEGIN PRIVATE KEY-----/, '')
    .replace(/-----END PRIVATE KEY-----/, '')
    .replace(/\s+/g, '');
  const der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// Access tokens last ~1h; cache within the isolate so a burst of pushes
// reuses one token exchange instead of one per message.
let cachedToken: { token: string; exp: number } | null = null;

async function getAccessToken(sa: ServiceAccount): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (cachedToken && cachedToken.exp - 60 > now) return cachedToken.token;

  const tokenUri = sa.token_uri || 'https://oauth2.googleapis.com/token';
  const header = b64url(TE.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claim = b64url(
    TE.encode(
      JSON.stringify({
        iss: sa.client_email,
        scope: 'https://www.googleapis.com/auth/firebase.messaging',
        aud: tokenUri,
        iat: now,
        exp: now + 3600,
      }),
    ),
  );
  const signingInput = `${header}.${claim}`;
  const key = await importPrivateKey(sa.private_key);
  const sig = new Uint8Array(
    await crypto.subtle.sign({ name: 'RSASSA-PKCS1-v1_5' }, key, TE.encode(signingInput)),
  );
  const jwt = `${signingInput}.${b64url(sig)}`;

  const res = await fetch(tokenUri, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body:
      `grant_type=${encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer')}` +
      `&assertion=${encodeURIComponent(jwt)}`,
  });
  if (!res.ok) {
    throw new Error(`fcm_token_${res.status}:${(await res.text().catch(() => '')).slice(0, 200)}`);
  }
  const j = (await res.json()) as { access_token: string; expires_in?: number };
  cachedToken = { token: j.access_token, exp: now + (j.expires_in ?? 3600) };
  return cachedToken.token;
}

export async function sendFcm(
  env: Env,
  token: string,
  payload: NativePushPayload,
  opts: FcmSendOptions = {},
): Promise<FcmSendResult> {
  const sa = parseServiceAccount(env);
  if (!sa || !env.FCM_PROJECT_ID) {
    return { token, ok: false, status: 0, unregistered: false, body: 'fcm_not_configured' };
  }

  const access = await getAccessToken(sa);

  const title = typeof payload.title === 'string' && payload.title ? payload.title : 'Relay';
  const bodyText = typeof payload.body === 'string' ? payload.body : '';

  // FCM data values must all be strings. Carry everything except the
  // display fields so the app can route a tap (chatId / url / tag / …).
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (v == null || k === 'title' || k === 'body') continue;
    data[k] = typeof v === 'string' ? v : JSON.stringify(v);
  }

  const tag = typeof payload.tag === 'string' && payload.tag ? payload.tag : undefined;
  const message = {
    token,
    notification: { title, body: bodyText },
    data,
    android: {
      priority: opts.highPriority === false ? 'NORMAL' : 'HIGH',
      // `tag` collapses same-thread notifications (a second message
      // overwrites the first) exactly like the Web Push SW does.
      notification: tag ? { tag } : {},
    },
  };

  const res = await fetch(
    `https://fcm.googleapis.com/v1/projects/${env.FCM_PROJECT_ID}/messages:send`,
    {
      method: 'POST',
      headers: { authorization: `Bearer ${access}`, 'content-type': 'application/json' },
      body: JSON.stringify({ message }),
    },
  );

  let bodyStr: string | undefined;
  let unregistered = false;
  if (!res.ok) {
    bodyStr = (await res.text().catch(() => '')).slice(0, 400);
    // A 404 (NOT_FOUND) or an explicit UNREGISTERED error means the token
    // is permanently dead (app uninstalled / token rotated). Other errors
    // (auth, quota, transient) are NOT grounds to drop the token.
    if (res.status === 404 || /UNREGISTERED/.test(bodyStr)) unregistered = true;
  }

  return { token, ok: res.ok, status: res.status, unregistered, body: bodyStr };
}

// Fan a payload out to every native token a user has registered, pruning
// any the push service reports as permanently gone.
export async function pushFcmToUser(
  env: Env,
  userId: string,
  payload: NativePushPayload,
  opts?: FcmSendOptions,
): Promise<void> {
  if (!fcmConfigured(env)) return;
  const rows = await env.DB.prepare(`SELECT token FROM native_push_tokens WHERE user_id = ?`)
    .bind(userId)
    .all<{ token: string }>();
  const tokens = (rows.results ?? []).map((r) => r.token);
  if (tokens.length === 0) return;

  const results = await Promise.all(
    tokens.map((t) =>
      sendFcm(env, t, payload, opts).catch(
        (err) =>
          ({ token: t, ok: false, status: 0, unregistered: false, body: String(err) }) as FcmSendResult,
      ),
    ),
  );
  await pruneDeadTokens(env, results);
}

// Delete tokens FCM reported as UNREGISTERED. Shared by the message and
// sports fan-outs.
export async function pruneDeadTokens(env: Env, results: FcmSendResult[]): Promise<void> {
  const dead = results.filter((r) => r.unregistered).map((r) => r.token);
  if (dead.length === 0) return;
  const ph = dead.map(() => '?').join(',');
  await env.DB.prepare(`DELETE FROM native_push_tokens WHERE token IN (${ph})`)
    .bind(...dead)
    .run();
}
