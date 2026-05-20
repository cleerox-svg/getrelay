import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

const PIN_ALPHABET = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;
const ONLINE_WINDOW_MS = 60 * 1000;

export function contactsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/contacts/add', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ pin?: string }>().catch(() => ({}) as { pin?: string });
    const raw = (body.pin ?? '').replace(/[\s·-]/g, '').toUpperCase();
    if (!PIN_ALPHABET.test(raw)) {
      return c.json({ error: 'invalid_pin' }, 400);
    }

    const other = await c.env.DB.prepare(`SELECT id FROM users WHERE pin = ?`)
      .bind(raw)
      .first<{ id: string }>();
    if (!other) return c.json({ error: 'not_found' }, 404);
    if (other.id === me.id) return c.json({ error: 'cannot_add_self' }, 400);

    const now = Date.now();
    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO contacts (owner_id, contact_id, added_at)
         VALUES (?, ?, ?)`,
      ).bind(me.id, other.id, now),
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO contacts (owner_id, contact_id, added_at)
         VALUES (?, ?, ?)`,
      ).bind(other.id, me.id, now),
    ]);

    return c.json({ ok: true, contactId: other.id });
  });

  app.get('/contacts', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.pin, u.display_name, u.status_message, u.avatar_url, u.last_seen_at,
              c.alias, c.category, c.added_at
       FROM contacts c
       JOIN users u ON u.id = c.contact_id
       WHERE c.owner_id = ?
       ORDER BY u.display_name COLLATE NOCASE ASC`,
    )
      .bind(me.id)
      .all<{
        id: string;
        pin: string;
        display_name: string;
        status_message: string | null;
        avatar_url: string | null;
        last_seen_at: number | null;
        alias: string | null;
        category: string | null;
        added_at: number;
      }>();

    const cutoff = Date.now() - ONLINE_WINDOW_MS;
    const contacts = (rows.results ?? []).map((r) => ({
      id: r.id,
      pin: r.pin,
      displayName: r.display_name,
      statusMessage: r.status_message,
      avatarUrl: r.avatar_url,
      alias: r.alias,
      category: r.category,
      addedAt: r.added_at,
      lastSeenAt: r.last_seen_at,
      online: r.last_seen_at !== null && r.last_seen_at > cutoff,
    }));

    return c.json({ contacts });
  });

  return app;
}
