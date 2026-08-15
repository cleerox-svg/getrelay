import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { sendPush, type PushSubscription, type VapidKeys, type SendResult } from './lib/web-push';
import {
  fcmConfigured,
  pruneDeadTokens,
  pushFcmToUser,
  sendFcm,
  type FcmSendResult,
  type NativePushPayload,
} from './lib/fcm';

export function pushRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // GET /push/public-key — UI calls before subscribing.
  app.get('/push/public-key', (c) => {
    const key = c.env.VAPID_PUBLIC_KEY;
    if (!key) return c.json({ error: 'vapid_not_configured' }, 503);
    return c.json({ publicKey: key });
  });

  // POST /me/push/subscribe — body: { endpoint, keys: { p256dh, auth } }
  app.post('/me/push/subscribe', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = (await c.req.json().catch(() => null)) as PushSubscription | null;
    if (
      !body ||
      typeof body.endpoint !== 'string' ||
      !body.keys ||
      typeof body.keys.p256dh !== 'string' ||
      typeof body.keys.auth !== 'string'
    ) {
      return c.json({ error: 'bad_subscription' }, 400);
    }

    await c.env.DB.prepare(
      `INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh  = excluded.p256dh,
         auth    = excluded.auth`,
    )
      .bind(body.endpoint, me.id, body.keys.p256dh, body.keys.auth, Date.now())
      .run();

    return c.json({ ok: true });
  });

  // POST /me/push/test — fires a synchronous test push to every
  // subscription this user has and returns the raw push-service results
  // (status + first 400 chars of body). Surfaces what the push service
  // is actually saying so we can diagnose Android-vs-iOS issues from
  // the UI without server logs.
  app.post('/me/push/test', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const keys = vapidKeys(c.env);
    if (!keys) return c.json({ error: 'vapid_not_configured' }, 503);

    const rows = await c.env.DB.prepare(
      `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`,
    )
      .bind(me.id)
      .all<{ endpoint: string; p256dh: string; auth: string }>();
    const subs = rows.results ?? [];
    if (subs.length === 0) {
      return c.json({ error: 'no_subscriptions' }, 404);
    }

    const payload = {
      title: 'Relay test',
      body: 'If you can see this, push is working on this device.',
      chatId: '',
      tag: 'relay-test',
    };

    const results = await Promise.all(
      subs.map(async (s) => {
        try {
          const r = await sendPush(
            { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
            payload,
            keys,
          );
          return {
            endpointHost: new URL(s.endpoint).host,
            status: r.status,
            ok: r.ok,
            body: r.body,
          };
        } catch (err) {
          return {
            endpointHost: safeHost(s.endpoint),
            status: 0,
            ok: false,
            body: String(err).slice(0, 400),
          };
        }
      }),
    );

    // Mirror pushToUser's cleanup: 404 / 410 means the push service has
    // dropped the subscription. Delete from D1 so the next test only
    // shows live endpoints.
    const dead = subs
      .map((s, i) => ({ endpoint: s.endpoint, r: results[i] }))
      .filter((x) => x.r && (x.r.status === 404 || x.r.status === 410))
      .map((x) => x.endpoint);
    if (dead.length > 0) {
      const placeholders = dead.map(() => '?').join(',');
      await c.env.DB.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`,
      )
        .bind(...dead)
        .run();
    }

    return c.json({ results });
  });

  // ---- Native push (FCM device tokens) ----
  // Capacitor Android/iOS installs can't use Web Push; they register a
  // Firebase Cloud Messaging device token here instead. Delivery of the
  // same payloads happens in pushToUser / the sports fan-out.

  // POST /me/push/native/register — body: { token, platform? }
  app.post('/me/push/native/register', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = (await c.req.json().catch(() => null)) as
      | { token?: string; platform?: string }
      | null;
    const token = body?.token;
    if (!token || typeof token !== 'string') {
      return c.json({ error: 'bad_token' }, 400);
    }
    const platform = body?.platform === 'ios' ? 'ios' : 'android';

    // Guard against the one iOS failure mode that is otherwise SILENT.
    //
    // @capacitor/push-notifications hands back the raw *APNs* device token on
    // iOS (64 hex chars), not an FCM token — the iOS build only yields an FCM
    // token because build-ios.yml patches AppDelegate.swift to swap it (see
    // IOS-PUSH.md). If that patch ever stops applying, registration still
    // "succeeds", the token still stores, and every later send just fails
    // deep inside FCM where nobody is looking. Reject it at the door instead,
    // so the Profile toggle surfaces it on the very first tap.
    if (platform === 'ios' && /^[0-9a-f]{64}$/i.test(token)) {
      return c.json({ error: 'apns_token_not_fcm' }, 400);
    }

    // A token is unique to a device+app install, so re-registering (or a
    // token that moved to a new account) just re-points the row.
    await c.env.DB.prepare(
      `INSERT INTO native_push_tokens (token, user_id, platform, created_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(token) DO UPDATE SET
         user_id  = excluded.user_id,
         platform = excluded.platform`,
    )
      .bind(token, me.id, platform, Date.now())
      .run();

    return c.json({ ok: true, configured: fcmConfigured(c.env) });
  });

  // POST /me/push/native/unregister — body: { token }
  app.post('/me/push/native/unregister', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = (await c.req.json().catch(() => null)) as { token?: string } | null;
    const token = body?.token;
    if (token) {
      await c.env.DB.prepare(
        `DELETE FROM native_push_tokens WHERE token = ? AND user_id = ?`,
      )
        .bind(token, me.id)
        .run();
    } else {
      await c.env.DB.prepare(`DELETE FROM native_push_tokens WHERE user_id = ?`)
        .bind(me.id)
        .run();
    }
    return c.json({ ok: true });
  });

  // POST /me/push/native/test — the native twin of /me/push/test. Fires a
  // test push to every FCM device token this user has and returns the raw
  // per-token result (status + first 400 chars of the FCM error body).
  //
  // This is the only way to tell the three native failure modes apart from
  // the phone, without server logs: worker has no FCM credentials
  // (`fcm_not_configured`), the build never registered a token
  // (`no_tokens`), or FCM itself is rejecting the send (a real status +
  // body — e.g. an iOS token with no APNs auth key uploaded to Firebase
  // comes back as a 401/404 naming the missing key).
  app.post('/me/push/native/test', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    if (!fcmConfigured(c.env)) return c.json({ error: 'fcm_not_configured' }, 503);

    const rows = await c.env.DB.prepare(
      `SELECT token, platform FROM native_push_tokens WHERE user_id = ?`,
    )
      .bind(me.id)
      .all<{ token: string; platform: string }>();
    const toks = rows.results ?? [];
    if (toks.length === 0) return c.json({ error: 'no_tokens' }, 404);

    const payload: NativePushPayload = {
      title: 'Relay test',
      body: 'If you can see this, native push is working on this device.',
      chatId: '',
      tag: 'relay-test',
    };

    const sent = await Promise.all(
      toks.map(async (t) => {
        const r = await sendFcm(c.env, t.token, payload, { highPriority: true }).catch(
          (err) =>
            ({
              token: t.token,
              ok: false,
              status: 0,
              unregistered: false,
              body: String(err).slice(0, 400),
            }) as FcmSendResult,
        );
        return { platform: t.platform, result: r };
      }),
    );

    // Mirror the send paths: drop anything FCM reports as permanently gone so
    // a repeat test only shows live devices.
    await pruneDeadTokens(
      c.env,
      sent.map((s) => s.result),
    );

    return c.json({
      results: sent.map(({ platform: p, result: r }) => ({
        platform: p,
        // Never echo the whole device token back to the client — the tail is
        // enough to tell two devices apart.
        tokenTail: r.token.slice(-8),
        ok: r.ok,
        status: r.status,
        unregistered: r.unregistered,
        body: r.body,
      })),
    });
  });

  // DELETE /me/push/subscribe?endpoint=... — UI calls when user disables
  // notifications or the browser revokes the subscription.
  app.delete('/me/push/subscribe', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const endpoint = c.req.query('endpoint');
    if (endpoint) {
      await c.env.DB.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?`,
      )
        .bind(endpoint, me.id)
        .run();
    } else {
      await c.env.DB.prepare(`DELETE FROM push_subscriptions WHERE user_id = ?`)
        .bind(me.id)
        .run();
    }
    return c.json({ ok: true });
  });

  return app;
}

// Helper used by UserHub when the recipient has no live socket. Fans the
// payload out to both the user's Web Push subscriptions and their native
// (FCM) device tokens — each path is independent and no-ops when its
// backend isn't configured.
export async function pushToUser(env: Env, userId: string, payload: unknown): Promise<void> {
  await Promise.all([
    webPushToUser(env, userId, payload),
    pushFcmToUser(env, userId, payload as NativePushPayload, { highPriority: true }),
  ]);
}

async function webPushToUser(env: Env, userId: string, payload: unknown): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys) {
    console.warn('push: VAPID not configured; skipping');
    return;
  }
  const rows = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  const subs = rows.results ?? [];
  if (subs.length === 0) {
    console.log('push: no subscriptions for', userId);
    return;
  }

  const results = await Promise.all(
    subs.map((s) =>
      sendPush(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        keys,
      ).catch((err) => ({ ok: false, status: 0, endpoint: s.endpoint, body: String(err) }) as SendResult),
    ),
  );

  for (const r of results) {
    const host = safeHost(r.endpoint);
    if (r.ok) {
      console.log(`push: OK ${host} status=${r.status} user=${userId}`);
    } else {
      console.warn(`push: FAIL ${host} status=${r.status} user=${userId} body=${r.body ?? ''}`);
    }
  }

  // Drop subscriptions the push service says are gone (404/410). The
  // browser revoked them or the user uninstalled the PWA.
  const dead = results.filter((r) => r.status === 404 || r.status === 410).map((r) => r.endpoint);
  if (dead.length > 0) {
    const placeholders = dead.map(() => '?').join(',');
    await env.DB.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`,
    )
      .bind(...dead)
      .run();
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'unknown';
  }
}

function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}
