import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';
import { mediaUrlFor } from './media';
import { avatarUrlFor } from './me';

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
    // JOIN users so each message ships its sender's display name + avatar —
    // groups can't rely on the chat-list-level peer record (no peer for
    // multi-party chats) and falling back to "User abcd…" looks broken.
    const rows = await c.env.DB.prepare(
      `SELECT m.id, m.sender_id, m.sequence, m.message_type, m.body,
              m.media_r2_key, m.media_url, m.reply_to,
              m.created_at, m.edited_at, m.deleted_at,
              u.display_name AS sender_display_name,
              u.avatar_url   AS sender_avatar_url,
              u.avatar_r2_key AS sender_avatar_r2_key,
              CASE WHEN m.sender_id = ?
                THEN 1
                ELSE (SELECT CASE WHEN read_at IS NULL THEN 0 ELSE 1 END
                        FROM receipts WHERE message_id = m.id AND recipient_id = ?)
              END AS read_flag
       FROM messages m
       LEFT JOIN users u ON u.id = m.sender_id
       WHERE m.chat_id = ? AND m.sequence < ?
       ORDER BY m.sequence DESC
       LIMIT ?`,
    )
      .bind(me.id, me.id, chatId, before, limit)
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
        sender_display_name: string | null;
        sender_avatar_url: string | null;
        sender_avatar_r2_key: string | null;
        read_flag: number | null;
      }>();

    const list = (rows.results ?? []).slice().reverse();
    const origin = new URL(c.req.url).origin;
    const msgIds = list.map((r) => r.id);
    const myMsgIds = list.filter((r) => r.sender_id === me.id).map((r) => r.id);
    const replyTargetIds = Array.from(
      new Set(list.map((r) => r.reply_to).filter((s): s is string => !!s)),
    );

    // Receipt aggregate for messages I sent — one row per (message,
    // recipient) in the receipts table, with NULL delivered_at / read_at
    // for recipients who haven't acked yet. For groups, this lets the
    // sender's UI render gray-D (some delivered) vs colored-D (all
    // delivered), same for R. For 1to1, total=1 always so the counts
    // collapse to the single recipient's state.
    const receiptAggByMsg = new Map<
      string,
      { total: number; delivered: number; read: number }
    >();
    if (myMsgIds.length > 0) {
      const ph = myMsgIds.map(() => '?').join(',');
      const rr = await c.env.DB.prepare(
        `SELECT message_id,
                COUNT(*) AS total,
                SUM(CASE WHEN delivered_at IS NULL THEN 0 ELSE 1 END) AS delivered,
                SUM(CASE WHEN read_at IS NULL THEN 0 ELSE 1 END) AS read_count
         FROM receipts
         WHERE message_id IN (${ph})
         GROUP BY message_id`,
      )
        .bind(...myMsgIds)
        .all<{ message_id: string; total: number; delivered: number; read_count: number }>();
      for (const row of rr.results ?? []) {
        receiptAggByMsg.set(row.message_id, {
          total: row.total,
          delivered: row.delivered,
          read: row.read_count,
        });
      }
    }

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

    const messages = list.map((r) => {
      const mine = r.sender_id === me.id;
      const agg = mine ? receiptAggByMsg.get(r.id) : undefined;
      // For my own sends: delivered/read are "any recipient" booleans —
      // matches the existing 1to1 semantics so the UI doesn't break,
      // and the group nuance lives in the counts. For others' sends:
      // delivered=true (I have it; that's why I'm reading it) and
      // read=my own read_at.
      const delivered = mine ? (agg?.delivered ?? 0) > 0 : true;
      const read = mine
        ? (agg?.read ?? 0) > 0
        : (r.read_flag ?? 0) === 1;
      return {
        id: r.id,
        chatId,
        from: r.sender_id,
        senderName: r.sender_display_name ?? null,
        senderAvatarUrl: avatarUrlFor(origin, {
          avatar_r2_key: r.sender_avatar_r2_key,
          avatar_url: r.sender_avatar_url,
        }),
        sequence: r.sequence,
        type: r.message_type,
        body: r.deleted_at ? null : r.body,
        mediaKey: r.deleted_at ? null : r.media_r2_key,
        // Prefer the external URL (Giphy) when present, otherwise
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
        delivered,
        read,
        // Sender-view-only aggregate. Undefined for messages I didn't
        // send. Lets the UI render gray-vs-colored receipt for groups
        // without separately fetching member counts.
        ...(mine && agg
          ? {
              deliveredCount: agg.delivered,
              readCount: agg.read,
              totalRecipients: agg.total,
            }
          : {}),
      };
    });

    return c.json({ messages, hasMore: list.length === limit });
  });

  return app;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}
