import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

export function messagesRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // GET /chats/:id/messages?before=<sequence>&limit=50
  // Returns the most recent N messages (in ascending sequence) for the chat
  // the caller participates in. delivered/read are flattened from the
  // receipts table from the caller's perspective.
  app.get('/chats/:id/messages', async (c) => {
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

    const beforeRaw = c.req.query('before');
    const before = beforeRaw ? Number(beforeRaw) : Number.MAX_SAFE_INTEGER;
    const limitRaw = c.req.query('limit');
    const limit = Math.min(
      MAX_LIMIT,
      Math.max(1, limitRaw ? Number(limitRaw) || DEFAULT_LIMIT : DEFAULT_LIMIT),
    );

    // Pull the slice we want by descending sequence, then reverse for UI.
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.sender_id, m.sequence, m.message_type, m.body,
              m.created_at, m.edited_at, m.deleted_at,
              CASE WHEN m.sender_id = ?
                THEN (SELECT MAX(CASE WHEN delivered_at IS NULL THEN 0 ELSE 1 END)
                        FROM receipts WHERE message_id = m.id)
                ELSE 1
              END AS delivered,
              CASE WHEN m.sender_id = ?
                THEN (SELECT MAX(CASE WHEN read_at IS NULL THEN 0 ELSE 1 END)
                        FROM receipts WHERE message_id = m.id)
                ELSE (SELECT CASE WHEN read_at IS NULL THEN 0 ELSE 1 END
                        FROM receipts WHERE message_id = m.id AND recipient_id = ?)
              END AS read_flag
       FROM messages m
       WHERE m.chat_id = ? AND m.sequence < ?
       ORDER BY m.sequence DESC
       LIMIT ?`,
    )
      .bind(me.id, me.id, me.id, chatId, before, limit)
      .all<{
        id: string;
        sender_id: string;
        sequence: number;
        message_type: string;
        body: string | null;
        created_at: number;
        edited_at: number | null;
        deleted_at: number | null;
        delivered: number | null;
        read_flag: number | null;
      }>();

    const list = (rows.results ?? []).slice().reverse();
    const messages = list.map((r) => ({
      id: r.id,
      chatId,
      from: r.sender_id,
      sequence: r.sequence,
      type: r.message_type,
      body: r.deleted_at ? null : r.body,
      ts: r.created_at,
      editedAt: r.edited_at,
      deletedAt: r.deleted_at,
      delivered: (r.delivered ?? 0) === 1,
      read: (r.read_flag ?? 0) === 1,
    }));

    return c.json({ messages, hasMore: list.length === limit });
  });

  return app;
}
