import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { sendPush, type PushSubscription, type VapidKeys, type SendResult } from './lib/web-push';

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

// Helper used by UserHub when the recipient has no live socket.
export async function pushToUser(env: Env, userId: string, payload: unknown): Promise<void> {
  const keys = vapidKeys(env);
  if (!keys) return; // not configured — no-op
  const rows = await env.DB.prepare(
    `SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?`,
  )
    .bind(userId)
    .all<{ endpoint: string; p256dh: string; auth: string }>();
  const subs = rows.results ?? [];
  if (subs.length === 0) return;

  const results = await Promise.all(
    subs.map((s) =>
      sendPush(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload,
        keys,
      ).catch((err) => ({ ok: false, status: 0, endpoint: s.endpoint, body: String(err) }) as SendResult),
    ),
  );

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

function vapidKeys(env: Env): VapidKeys | null {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY || !env.VAPID_SUBJECT) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT,
  };
}
