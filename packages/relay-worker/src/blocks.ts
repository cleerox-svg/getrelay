import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';

// Block / unblock another user, plus the read endpoint the UI uses to
// render a "Blocked users" list. Read-side filtering (chats list,
// contacts list, status feed) happens inside each of those endpoints
// via the helpers exported below — keeping the SQL local to each route.

export function blocksRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/me/blocks', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.pin, u.display_name, u.status_message,
              u.avatar_url, u.avatar_r2_key, b.created_at
         FROM user_blocks b
         JOIN users u ON u.id = b.blocked_id
        WHERE b.blocker_id = ?
        ORDER BY b.created_at DESC`,
    )
      .bind(me.id)
      .all<{
        id: string;
        pin: string;
        display_name: string;
        status_message: string | null;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        created_at: number;
      }>();

    const origin = new URL(c.req.url).origin;
    const blocked = (rows.results ?? []).map((r) => ({
      id: r.id,
      pin: r.pin,
      displayName: r.display_name,
      statusMessage: r.status_message,
      avatarUrl: avatarUrlFor(origin, r),
      blockedAt: r.created_at,
    }));
    return c.json({ blocked });
  });

  app.post('/me/blocks', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = (await c.req.json().catch(() => null)) as { userId?: string } | null;
    const userId = body?.userId;
    if (!userId || typeof userId !== 'string') {
      return c.json({ error: 'invalid_user_id' }, 400);
    }
    if (userId === me.id) return c.json({ error: 'cannot_block_self' }, 400);

    const other = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`)
      .bind(userId)
      .first<{ id: string }>();
    if (!other) return c.json({ error: 'not_found' }, 404);

    await c.env.DB.prepare(
      `INSERT OR IGNORE INTO user_blocks (blocker_id, blocked_id, created_at)
       VALUES (?, ?, ?)`,
    )
      .bind(me.id, userId, Date.now())
      .run();
    return c.json({ ok: true });
  });

  app.delete('/me/blocks/:userId', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    const userId = c.req.param('userId');
    await c.env.DB.prepare(
      `DELETE FROM user_blocks WHERE blocker_id = ? AND blocked_id = ?`,
    )
      .bind(me.id, userId)
      .run();
    return c.json({ ok: true });
  });

  return app;
}

// True iff `viewerId` has blocked `otherId`. Used by routes that need
// to refuse opening a chat with a blocked contact, etc.
export async function isBlocked(
  env: Env,
  viewerId: string,
  otherId: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM user_blocks WHERE blocker_id = ? AND blocked_id = ? LIMIT 1`,
  )
    .bind(viewerId, otherId)
    .first<{ x: number }>();
  return !!row;
}

// True iff EITHER party has blocked the other. The message gateway
// uses this to drop direct messages so neither side can route around
// a block via reconnect.
export async function isBlockedEitherWay(
  env: Env,
  a: string,
  b: string,
): Promise<boolean> {
  const row = await env.DB.prepare(
    `SELECT 1 AS x FROM user_blocks
      WHERE (blocker_id = ? AND blocked_id = ?)
         OR (blocker_id = ? AND blocked_id = ?)
      LIMIT 1`,
  )
    .bind(a, b, b, a)
    .first<{ x: number }>();
  return !!row;
}
