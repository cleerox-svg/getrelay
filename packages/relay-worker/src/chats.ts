import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

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

  app.get('/chats', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const rows = await c.env.DB.prepare(
      `WITH my_chats AS (
         SELECT chat_id FROM chat_participants WHERE user_id = ?
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
         (SELECT u.id || '|' || u.display_name || '|' ||
                 COALESCE(u.avatar_url, '') || '|' || u.pin || '|' ||
                 COALESCE(u.avatar_r2_key, '')
            FROM chat_participants cp
            JOIN users u ON u.id = cp.user_id
            WHERE cp.chat_id = ch.id AND cp.user_id != ?
            LIMIT 1) AS peer_blob
       FROM chats ch
       JOIN my_chats mc ON mc.chat_id = ch.id
       LEFT JOIN last_msg lm ON lm.chat_id = ch.id
       ORDER BY COALESCE(lm.created_at, ch.created_at) DESC`,
    )
      .bind(me.id, me.id, me.id)
      .all<{
        chat_id: string;
        chat_type: '1to1' | 'group';
        subject: string | null;
        chat_created_at: number;
        msg_id: string | null;
        msg_sender_id: string | null;
        msg_type: string | null;
        msg_body: string | null;
        msg_created_at: number | null;
        msg_edited_at: number | null;
        msg_deleted_at: number | null;
        unread_count: number;
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
        peer,
        lastMessage,
        unreadCount: r.unread_count ?? 0,
        lastActivityAt: r.msg_created_at ?? r.chat_created_at,
      };
    });

    return c.json({ chats });
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
): { id: string; displayName: string; avatarUrl: string | null; pin: string } | null {
  if (!blob) return null;
  const parts = blob.split('|');
  const r2Key = parts[4] ?? '';
  const externalUrl = parts[2] ?? '';
  const avatarUrl = r2Key ? `${origin}/r/${r2Key}` : externalUrl || null;
  return {
    id: parts[0] ?? '',
    displayName: parts[1] ?? '',
    avatarUrl,
    pin: parts[3] ?? '',
  };
}
