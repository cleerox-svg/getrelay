import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';

const MAX_BODY = 280;

export function statusRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // POST /me/status — { body }: short text status, ≤ 280 chars.
  app.post('/me/status', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ body?: string }>().catch(() => ({}) as { body?: string });
    const text = (body.body ?? '').trim();
    if (!text) return c.json({ error: 'empty' }, 400);
    if (text.length > MAX_BODY) return c.json({ error: 'too_long' }, 400);

    const id = crypto.randomUUID();
    const now = Date.now();
    await c.env.DB.prepare(
      `INSERT INTO status_posts (id, user_id, body, created_at) VALUES (?, ?, ?, ?)`,
    )
      .bind(id, me.id, text, now)
      .run();
    return c.json({ id, body: text, createdAt: now });
  });

  // DELETE /status/:id — owner only.
  app.delete('/status/:id', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    const id = c.req.param('id') ?? '';
    await c.env.DB.prepare(
      `DELETE FROM status_posts WHERE id = ? AND user_id = ?`,
    )
      .bind(id, me.id)
      .run();
    return c.json({ ok: true });
  });

  // GET /feed — last 50 posts from me + my contacts, newest first.
  app.get('/feed', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const rows = await c.env.DB.prepare(
      `SELECT s.id, s.user_id, s.body, s.created_at,
              u.display_name, u.pin, u.avatar_url, u.avatar_r2_key
       FROM status_posts s
       JOIN users u ON u.id = s.user_id
       WHERE s.user_id = ?
          OR s.user_id IN (SELECT contact_id FROM contacts WHERE owner_id = ?)
       ORDER BY s.created_at DESC
       LIMIT 50`,
    )
      .bind(me.id, me.id)
      .all<{
        id: string;
        user_id: string;
        body: string;
        created_at: number;
        display_name: string;
        pin: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
      }>();

    const origin = new URL(c.req.url).origin;
    const posts = (rows.results ?? []).map((r) => ({
      id: r.id,
      userId: r.user_id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      body: r.body,
      createdAt: r.created_at,
      mine: r.user_id === me.id,
    }));
    return c.json({ posts });
  });

  return app;
}
