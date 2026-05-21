import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { avatarUrlFor } from './me';

export function chatsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.post('/chats/1to1', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ contactId?: string }>().catch(
      () => ({}) as { contactId?: string },
    );
    const contactId = body.contactId;
    if (!contactId || typeof contactId !== 'string') {
      return c.json({ error: 'invalid_contact_id' }, 400);
    }
    if (contactId === me.id) return c.json({ error: 'cannot_chat_self' }, 400);

    const other = await c.env.DB.prepare(`SELECT id FROM users WHERE id = ?`)
      .bind(contactId)
      .first<{ id: string }>();
    if (!other) return c.json({ error: 'not_found' }, 404);

    const chatId = oneToOneChatId(me.id, contactId);
    const now = Date.now();

    const existing = await c.env.DB.prepare(`SELECT id, created_at FROM chats WHERE id = ?`)
      .bind(chatId)
      .first<{ id: string; created_at: number }>();

    if (existing) {
      // Re-insert participant rows in case either side previously left the
      // chat (DELETE /chats/:id removes only the caller's row). Safe to
      // re-run because of INSERT OR IGNORE on the (chat_id, user_id) PK.
      await c.env.DB.batch([
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
        ).bind(chatId, me.id, now),
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
        ).bind(chatId, contactId, now),
      ]);
      return c.json({ id: existing.id, type: '1to1', createdAt: existing.created_at, created: false });
    }

    await c.env.DB.batch([
      c.env.DB.prepare(
        `INSERT INTO chats (id, type, created_by, created_at) VALUES (?, '1to1', ?, ?)`,
      ).bind(chatId, me.id, now),
      c.env.DB.prepare(
        `INSERT INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
      ).bind(chatId, me.id, now),
      c.env.DB.prepare(
        `INSERT INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
      ).bind(chatId, contactId, now),
    ]);

    return c.json({ id: chatId, type: '1to1', createdAt: now, created: true });
  });

  // ----- Group chats -----

  app.post('/chats/group', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ subject?: string; contactIds?: string[] }>().catch(
      () => ({}) as { subject?: string; contactIds?: string[] },
    );
    const subject = (body.subject ?? '').trim();
    if (subject.length === 0 || subject.length > 80) {
      return c.json({ error: 'invalid_subject' }, 400);
    }
    const ids = Array.isArray(body.contactIds)
      ? Array.from(new Set(body.contactIds.filter((s) => typeof s === 'string' && s !== me.id)))
      : [];
    if (ids.length < 1) return c.json({ error: 'need_member' }, 400);
    if (ids.length > 49) return c.json({ error: 'too_many_members' }, 400);

    // Every invited member must be a mutual contact of the caller.
    const placeholders = ids.map(() => '?').join(',');
    const rows = await c.env.DB.prepare(
      `SELECT contact_id FROM contacts WHERE owner_id = ? AND contact_id IN (${placeholders})`,
    )
      .bind(me.id, ...ids)
      .all<{ contact_id: string }>();
    const validIds = new Set((rows.results ?? []).map((r) => r.contact_id));
    if (validIds.size !== ids.length) return c.json({ error: 'not_in_contacts' }, 400);

    const chatId = `g:${crypto.randomUUID()}`;
    const now = Date.now();

    const ops = [
      c.env.DB.prepare(
        `INSERT INTO chats (id, type, subject, created_by, created_at) VALUES (?, 'group', ?, ?, ?)`,
      ).bind(chatId, subject, me.id, now),
      c.env.DB.prepare(
        `INSERT INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
      ).bind(chatId, me.id, now),
      ...ids.map((rid) =>
        c.env.DB.prepare(
          `INSERT INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
        ).bind(chatId, rid, now),
      ),
    ];
    await c.env.DB.batch(ops);

    return c.json({
      id: chatId,
      type: 'group',
      subject,
      createdAt: now,
      memberCount: ids.length + 1,
    });
  });

  app.post('/chats/:id/participants', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const chatId = decodeURIComponent(c.req.param('id') ?? '');
    const chat = await c.env.DB.prepare(`SELECT type FROM chats WHERE id = ?`)
      .bind(chatId)
      .first<{ type: '1to1' | 'group' }>();
    if (!chat) return c.json({ error: 'not_found' }, 404);
    if (chat.type !== 'group') return c.json({ error: 'not_a_group' }, 400);

    const inGroup = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM chat_participants WHERE chat_id = ? AND user_id = ?`,
    )
      .bind(chatId, me.id)
      .first<{ ok: number }>();
    if (!inGroup) return c.json({ error: 'not_in_chat' }, 403);

    const body = await c.req.json<{ contactIds?: string[] }>().catch(
      () => ({}) as { contactIds?: string[] },
    );
    const ids = Array.isArray(body.contactIds)
      ? Array.from(new Set(body.contactIds.filter((s) => typeof s === 'string' && s !== me.id)))
      : [];
    if (ids.length === 0) return c.json({ error: 'no_members' }, 400);

    // Mutual-contact gate on the caller, same as group creation.
    const placeholders = ids.map(() => '?').join(',');
    const rows = await c.env.DB.prepare(
      `SELECT contact_id FROM contacts WHERE owner_id = ? AND contact_id IN (${placeholders})`,
    )
      .bind(me.id, ...ids)
      .all<{ contact_id: string }>();
    const validIds = (rows.results ?? []).map((r) => r.contact_id);
    if (validIds.length === 0) return c.json({ error: 'not_in_contacts' }, 400);

    const now = Date.now();
    const ops = validIds.map((rid) =>
      c.env.DB.prepare(
        `INSERT OR IGNORE INTO chat_participants (chat_id, user_id, joined_at) VALUES (?, ?, ?)`,
      ).bind(chatId, rid, now),
    );
    await c.env.DB.batch(ops);

    return c.json({ ok: true, added: validIds.length });
  });

  app.get('/chats/:id/members', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const chatId = decodeURIComponent(c.req.param('id') ?? '');
    const inChat = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM chat_participants WHERE chat_id = ? AND user_id = ?`,
    )
      .bind(chatId, me.id)
      .first<{ ok: number }>();
    if (!inChat) return c.json({ error: 'not_in_chat' }, 403);

    const rows = await c.env.DB.prepare(
      `SELECT u.id, u.display_name, u.pin, u.avatar_url, u.avatar_r2_key, u.last_seen_at,
              cp.joined_at
       FROM chat_participants cp
       JOIN users u ON u.id = cp.user_id
       WHERE cp.chat_id = ?
       ORDER BY cp.joined_at ASC`,
    )
      .bind(chatId)
      .all<{
        id: string;
        display_name: string;
        pin: string;
        avatar_url: string | null;
        avatar_r2_key: string | null;
        last_seen_at: number | null;
        joined_at: number;
      }>();

    const origin = new URL(c.req.url).origin;
    const cutoff = Date.now() - 60_000;
    const members = (rows.results ?? []).map((r) => ({
      id: r.id,
      displayName: r.display_name,
      pin: r.pin,
      avatarUrl: avatarUrlFor(origin, r),
      online: r.last_seen_at !== null && r.last_seen_at > cutoff,
      joinedAt: r.joined_at,
    }));
    return c.json({ members });
  });

  app.get('/chats', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const rows = await c.env.DB.prepare(
      `WITH my_chats AS (
         SELECT chat_id, COALESCE(muted, 0) AS muted, pinned_at
         FROM chat_participants WHERE user_id = ?
       ),
       last_msg AS (
         SELECT m.chat_id, m.id, m.sender_id, m.message_type, m.body,
                m.created_at, m.edited_at, m.deleted_at
         FROM messages m
         JOIN my_chats mc ON mc.chat_id = m.chat_id
         WHERE m.id = (
           SELECT id FROM messages
           WHERE chat_id = m.chat_id
           ORDER BY sequence DESC
           LIMIT 1
         )
       )
       SELECT
         ch.id AS chat_id,
         ch.type AS chat_type,
         ch.subject,
         ch.created_at AS chat_created_at,
         mc.muted AS muted,
         mc.pinned_at AS pinned_at,
         lm.id AS msg_id,
         lm.sender_id AS msg_sender_id,
         lm.message_type AS msg_type,
         lm.body AS msg_body,
         lm.created_at AS msg_created_at,
         lm.edited_at AS msg_edited_at,
         lm.deleted_at AS msg_deleted_at,
         (SELECT COUNT(*) FROM receipts r
            JOIN messages m2 ON m2.id = r.message_id
            WHERE m2.chat_id = ch.id
              AND r.recipient_id = ?
              AND r.read_at IS NULL) AS unread_count,
         (SELECT COUNT(*) FROM chat_participants cp2
            WHERE cp2.chat_id = ch.id) AS member_count,
         (SELECT u.id || char(31) || u.display_name || char(31) ||
                 COALESCE(u.avatar_url, '') || char(31) || u.pin || char(31) ||
                 COALESCE(u.avatar_r2_key, '') || char(31) ||
                 COALESCE(u.status_message, '')
            FROM chat_participants cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.chat_id = ch.id AND cp.user_id != ?
            LIMIT 1) AS peer_blob
       FROM chats ch
       JOIN my_chats mc ON mc.chat_id = ch.id
       LEFT JOIN last_msg lm ON lm.chat_id = ch.id
       ORDER BY
         CASE WHEN mc.pinned_at IS NOT NULL THEN 0 ELSE 1 END,
         mc.pinned_at DESC,
         COALESCE(lm.created_at, ch.created_at) DESC`,
    )
      .bind(me.id, me.id, me.id)
      .all<{
        chat_id: string;
        chat_type: '1to1' | 'group';
        subject: string | null;
        chat_created_at: number;
        muted: number;
        pinned_at: number | null;
        msg_id: string | null;
        msg_sender_id: string | null;
        msg_type: string | null;
        msg_body: string | null;
        msg_created_at: number | null;
        msg_edited_at: number | null;
        msg_deleted_at: number | null;
        unread_count: number;
        member_count: number;
        peer_blob: string | null;
      }>();

    const origin = new URL(c.req.url).origin;
    const chats = (rows.results ?? []).map((r) => {
      const peer = parsePeerBlob(origin, r.peer_blob);
      const lastMessage = r.msg_id
        ? {
            id: r.msg_id,
            senderId: r.msg_sender_id,
            messageType: r.msg_type,
            body: r.msg_deleted_at ? null : r.msg_body,
            createdAt: r.msg_created_at,
            editedAt: r.msg_edited_at,
            deletedAt: r.msg_deleted_at,
          }
        : null;
      return {
        id: r.chat_id,
        type: r.chat_type,
        subject: r.subject,
        memberCount: r.member_count,
        peer,
        lastMessage,
        unreadCount: r.unread_count ?? 0,
        lastActivityAt: r.msg_created_at ?? r.chat_created_at,
        muted: r.muted === 1,
        pinnedAt: r.pinned_at,
      };
    });

    return c.json({ chats });
  });

  // PATCH /chats/:id — flip per-participant flags (mute, pin to top).
  // Both fields are optional; missing means "no change". The chat itself
  // and other participants are untouched — these are per-user UI prefs.
  app.patch('/chats/:id', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const chatId = decodeURIComponent(c.req.param('id') ?? '');
    if (!chatId) return c.json({ error: 'invalid_chat_id' }, 400);

    const body = await c.req.json<{ muted?: boolean; pinned?: boolean }>().catch(
      () => ({}) as { muted?: boolean; pinned?: boolean },
    );

    const member = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM chat_participants WHERE chat_id = ? AND user_id = ?`,
    )
      .bind(chatId, me.id)
      .first<{ ok: number }>();
    if (!member) return c.json({ error: 'not_in_chat' }, 403);

    const updates: string[] = [];
    const values: (string | number | null)[] = [];
    if (typeof body.muted === 'boolean') {
      updates.push('muted = ?');
      values.push(body.muted ? 1 : 0);
    }
    if (typeof body.pinned === 'boolean') {
      updates.push('pinned_at = ?');
      values.push(body.pinned ? Date.now() : null);
    }
    if (updates.length === 0) return c.json({ ok: true });

    values.push(chatId, me.id);
    await c.env.DB.prepare(
      `UPDATE chat_participants SET ${updates.join(', ')}
       WHERE chat_id = ? AND user_id = ?`,
    )
      .bind(...values)
      .run();

    return c.json({ ok: true });
  });

  // DELETE /chats/:id — soft-leave. Drops the caller's chat_participants
  // row + their own receipts; the chat itself and other participants stay
  // intact. For 1:1, the chat reappears when the caller next opens it
  // (openOneToOne re-inserts the participant row).
  app.delete('/chats/:id', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const chatId = decodeURIComponent(c.req.param('id') ?? '');
    if (!chatId) return c.json({ error: 'invalid_chat_id' }, 400);

    const member = await c.env.DB.prepare(
      `SELECT 1 AS ok FROM chat_participants WHERE chat_id = ? AND user_id = ?`,
    )
      .bind(chatId, me.id)
      .first<{ ok: number }>();
    if (!member) return c.json({ error: 'not_in_chat' }, 403);

    await c.env.DB.batch([
      c.env.DB.prepare(
        `DELETE FROM receipts
         WHERE recipient_id = ?
           AND message_id IN (SELECT id FROM messages WHERE chat_id = ?)`,
      ).bind(me.id, chatId),
      c.env.DB.prepare(
        `DELETE FROM chat_participants WHERE chat_id = ? AND user_id = ?`,
      ).bind(chatId, me.id),
    ]);

    return c.json({ ok: true });
  });

  return app;
}

export function oneToOneChatId(a: string, b: string): string {
  const [first, second] = a < b ? [a, b] : [b, a];
  return `1to1:${first}:${second}`;
}

function parsePeerBlob(
  origin: string,
  blob: string | null,
): {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  pin: string;
  statusMessage: string | null;
} | null {
  if (!blob) return null;
  // ASCII Unit Separator (\x1f) — safe against user content that contains '|'.
  const parts = blob.split('\x1f');
  const r2Key = parts[4] ?? '';
  const externalUrl = parts[2] ?? '';
  const avatarUrl = r2Key ? `${origin}/r/${r2Key}` : externalUrl || null;
  const statusMessage = parts[5]?.trim() ? parts[5] : null;
  return {
    id: parts[0] ?? '',
    displayName: parts[1] ?? '',
    avatarUrl,
    pin: parts[3] ?? '',
    statusMessage,
  };
}
