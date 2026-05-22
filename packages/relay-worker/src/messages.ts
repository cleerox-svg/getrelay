import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { mediaUrlFor } from './media';

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
              m.media_r2_key, m.media_url, m.reply_to,
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
        media_r2_key: string | null;
        media_url: string | null;
        reply_to: string | null;
        created_at: number;
        edited_at: number | null;
        deleted_at: number | null;
        delivered: number | null;
        read_flag: number | null;
      }>();

    const list = (rows.results ?? []).slice().reverse();
    const origin = new URL(c.req.url).origin;
    const msgIds = list.map((r) => r.id);
    const replyTargetIds = Array.from(
      new Set(list.map((r) => r.reply_to).filter((s): s is string => !!s)),
    );

    // Reactions for everything in the slice.
    const reactionsByMsg = new Map<
      string,
      { emoji: string; count: number; mine: boolean }[]
    >();
    if (msgIds.length > 0) {
      const ph = msgIds.map(() => '?').join(',');
      const rr = await c.env.DB.prepare(
        `SELECT message_id, emoji,
                COUNT(*) AS cnt,
                MAX(CASE WHEN user_id = ? THEN 1 ELSE 0 END) AS mine
         FROM message_reactions
         WHERE message_id IN (${ph})
         GROUP BY message_id, emoji`,
      )
        .bind(me.id, ...msgIds)
        .all<{ message_id: string; emoji: string; cnt: number; mine: number }>();
      for (const row of rr.results ?? []) {
        const arr = reactionsByMsg.get(row.message_id) ?? [];
        arr.push({ emoji: row.emoji, count: row.cnt, mine: row.mine === 1 });
        reactionsByMsg.set(row.message_id, arr);
      }
    }

    // Reply-target previews.
    const replyPreviewById = new Map<
      string,
      { id: string; from: string; fromName: string; preview: string }
    >();
    if (replyTargetIds.length > 0) {
      const ph = replyTargetIds.map(() => '?').join(',');
      const rr = await c.env.DB.prepare(
        `SELECT m.id, m.sender_id, m.message_type, m.body, m.deleted_at, u.display_name
         FROM messages m JOIN users u ON u.id = m.sender_id
         WHERE m.id IN (${ph})`,
      )
        .bind(...replyTargetIds)
        .all<{
          id: string;
          sender_id: string;
          message_type: string;
          body: string | null;
          deleted_at: number | null;
          display_name: string;
        }>();
      for (const row of rr.results ?? []) {
        const preview = row.deleted_at
          ? 'Message recalled'
          : row.message_type === 'image'
            ? row.body && row.body.trim() ? truncate(row.body, 80) : '📷 Photo'
            : row.message_type === 'ping'
              ? 'PING!!'
              : truncate(row.body ?? '', 80);
        replyPreviewById.set(row.id, {
          id: row.id,
          from: row.sender_id,
          fromName: row.display_name,
          preview,
        });
      }
    }

    const messages = list.map((r) => ({
      id: r.id,
      chatId,
      from: r.sender_id,
      sequence: r.sequence,
      type: r.message_type,
      body: r.deleted_at ? null : r.body,
      mediaKey: r.deleted_at ? null : r.media_r2_key,
      // Prefer the external URL (Tenor/Giphy) when present, otherwise
      // resolve the R2 key against the worker origin.
      mediaUrl: r.deleted_at
        ? null
        : r.media_url ?? mediaUrlFor(origin, r.media_r2_key),
      replyTo: r.deleted_at
        ? null
        : (r.reply_to ? replyPreviewById.get(r.reply_to) ?? null : null),
      reactions: reactionsByMsg.get(r.id) ?? [],
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

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
