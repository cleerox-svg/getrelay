// Firebase Cloud Messaging (HTTP v1) sender for Cloudflare Workers.
//
// Native Android and iOS can't use Web Push — the Capacitor WebView doesn't
// expose the PushManager API. Those installs register an FCM device token
// instead (via @capacitor/push-notifications), and this module delivers the
// same notification payloads to them.
//
// iOS rides the same path on purpose: Firebase relays to APNs on our behalf
// once the APNs auth key (.p8) is uploaded to the Firebase project, so both
// platforms share one sender, one service-account credential, and one
// native_push_tokens table. Talking to APNs directly would mean a second
// sender AND is HTTP/2-only, which the local workerd dev runtime can't do.
// See packages/relay-ui/IOS-PUSH.md.
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
  // Message lifetime in seconds. When the device is offline/asleep longer
  // than this, FCM DROPS the message instead of holding it. Omitting it
  // means FCM's default of 4 weeks — which is how a time-sensitive alert
  // ("game starting") ends up delivered a day late. Time-sensitive callers
  // should pass a short value so a stale alert expires rather than arrives.
  ttlSeconds?: number;
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
  const android: Record<string, unknown> = {
    priority: opts.highPriority === false ? 'NORMAL' : 'HIGH',
    // `tag` collapses same-thread notifications (a second message
    // overwrites the first) exactly like the Web Push SW does.
    notification: tag ? { tag } : {},
  };
  // FCM v1 wants the TTL as a Duration string ("3600s"). Clamp to a
  // non-negative integer of seconds; 0 means "deliver now or drop".
  if (typeof opts.ttlSeconds === 'number' && Number.isFinite(opts.ttlSeconds)) {
    android.ttl = `${Math.max(0, Math.floor(opts.ttlSeconds))}s`;
  }

  // iOS installs register FCM tokens too (Firebase relays to APNs), so every
  // message carries an `apns` block alongside `android`. FCM applies only the
  // block matching the token's platform and ignores the other, so one message
  // shape serves both — no per-platform branching, and no second sender.
  //
  // The three knobs mirror the Android ones one-for-one:
  //   apns-priority 10/5   ↔ android.priority HIGH/NORMAL
  //   apns-expiration      ↔ android.ttl
  //   apns-collapse-id     ↔ android.notification.tag
  const apnsHeaders: Record<string, string> = {
    // 10 = deliver immediately (alert pushes); 5 = power-considerate, which
    // is what a non-urgent payload should use.
    'apns-priority': opts.highPriority === false ? '5' : '10',
  };
  if (tag) {
    // APNs caps collapse-id at 64 BYTES and 400s the whole request if you
    // exceed it. Our tags are short ascii ("chat-<id>", "nhl-<key>"), but
    // truncate defensively rather than lose the push.
    apnsHeaders['apns-collapse-id'] = tag.slice(0, 64);
  }
  if (typeof opts.ttlSeconds === 'number' && Number.isFinite(opts.ttlSeconds)) {
    // Unlike android.ttl (a *duration*), apns-expiration is an ABSOLUTE unix
    // timestamp. 0 is special-cased by APNs as "try once, then drop", which
    // is exactly what a 0-second TTL means, so pass it straight through.
    const ttl = Math.max(0, Math.floor(opts.ttlSeconds));
    apnsHeaders['apns-expiration'] = ttl === 0 ? '0' : String(Math.floor(Date.now() / 1000) + ttl);
  }
  const apns = {
    headers: apnsHeaders,
    payload: {
      aps: {
        sound: 'default',
        // Groups this app's notifications in Notification Center the way
        // Android's channel grouping does. Collapsing is apns-collapse-id
        // above; thread-id only affects stacking.
        ...(tag ? { 'thread-id': tag } : {}),
      },
    },
  };

  const message = {
    token,
    notification: { title, body: bodyText },
    data,
    android,
    apns,
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
