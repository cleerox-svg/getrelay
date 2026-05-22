import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';

export function statusRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // GET /feed — current status_message of me + each of my contacts (one
  // row per user, only users who have a non-empty status). Profile's
  // Status field (PATCH /me) is the only way to update it.
  app.get('/feed', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.pin, u.status_message,
              u.avatar_url, u.avatar_r2_key, u.last_seen_at
       FROM users u
       WHERE (u.id = ?
              OR u.id IN (SELECT contact_id FROM contacts WHERE owner_id = ?))
         AND u.status_message IS NOT NULL
         AND TRIM(u.status_message) != ''
         AND u.id NOT IN (SELECT blocked_id FROM user_blocks WHERE blocker_id = ?)
       ORDER BY (u.id = ?) DESC,
                COALESCE(u.last_seen_at, 0) DESC,
                u.display_name ASC`,
    )
      .bind(me.id, me.id, me.id, me.id)
      .all<{
        id: string;
        display_name: string;
        pin: string;
        status_message: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        last_seen_at: number | null;
      }>();

    const origin = new URL(c.req.url).origin;
    const statuses = (rows.results ?? []).map((r) => ({
      userId: r.id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      statusMessage: r.status_message,
      updatedAt: r.last_seen_at ?? 0,
      mine: r.id === me.id,
    }));
    return c.json({ statuses });
  });

  return app;
}
