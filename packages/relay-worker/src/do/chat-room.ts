import type { Env } from '../env';
import { notifyUserHub } from '../lib/outbound';
import {
  EDIT_WINDOW_MS,
  MAX_BODY_LEN,
  MAX_READ_IDS,
  RECALL_WINDOW_MS,
  type ErrorCode,
} from '../lib/ws-protocol';

// One ChatRoom DO per chat (named via env.CHAT_ROOM.idFromName(chats.id)).
// HTTP-only: clients never connect directly; UserHub forwards commands here.

type PersistInput = {
  senderId: string;
  tempId: string;
  type: 'text' | 'ping';
  body: string | null;
};
type TypingInput = { chatId: string; senderId: string; on: boolean };
type ReadInput = { chatId: string; senderId: string; messageIds: string[] };
type PingInput = { chatId: string; senderId: string };
type RecallInput = { chatId: string; senderId: string; messageId: string };
type EditInput = { chatId: string; senderId: string; messageId: string; body: string };

export class ChatRoom implements DurableObject {
  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    try {
      switch (url.pathname) {
        case '/persist': return await this.persist(await request.json());
        case '/typing':  return await this.fanoutTyping(await request.json());
        case '/read':    return await this.markRead(await request.json());
        case '/ping':    return await this.persistPing(await request.json());
        case '/recall':  return await this.recall(await request.json());
        case '/edit':    return await this.edit(await request.json());
      }
    } catch (err) {
      return err instanceof RoomError
        ? errorResponse(err.code, err.status)
        : errorResponse('bad_json', 400);
    }
    return new Response('not found', { status: 404 });
  }

  private async loadChatMeta(chatId: string): Promise<{ type: '1to1' | 'group' } | null> {
    const cached = await this.state.storage.get<{ type: '1to1' | 'group' }>('chatMeta');
    if (cached) return cached;
    const row = await this.env.DB.prepare(`SELECT type FROM chats WHERE id = ?`)
      .bind(chatId)
      .first<{ type: '1to1' | 'group' }>();
    if (!row) return null;
    await this.state.storage.put('chatMeta', row);
    return row;
  }

  private async recipientIds(chatId: string, senderId: string): Promise<string[]> {
    const rows = await this.env.DB.prepare(
      `SELECT user_id FROM chat_participants WHERE chat_id = ? AND user_id != ?`,
    )
      .bind(chatId, senderId)
      .all<{ user_id: string }>();
    return (rows.results ?? []).map((r) => r.user_id);
  }

  private async assertParticipant(chatId: string, userId: string): Promise<void> {
    const row = await this.env.DB.prepare(
      `SELECT 1 AS ok FROM chat_participants WHERE chat_id = ? AND user_id = ?`,
    )
      .bind(chatId, userId)
      .first<{ ok: number }>();
    if (!row) throw new RoomError('not_in_chat', 403);
  }

  private async nextSequence(): Promise<number> {
    const cur = (await this.state.storage.get<number>('seq')) ?? 0;
    const next = cur + 1;
    await this.state.storage.put('seq', next);
    return next;
  }

  // ---------- /persist ----------
  private async persist(input: PersistInput & { chatId?: string }): Promise<Response> {
    if (input.type !== 'text' && input.type !== 'ping') {
      throw new RoomError('bad_json', 400);
    }
    const body = input.type === 'text' ? (input.body ?? '').trim() : null;
    if (input.type === 'text') {
      if (!body || body.length === 0) throw new RoomError('bad_json', 400);
      if (body.length > MAX_BODY_LEN) throw new RoomError('payload_too_large', 413);
    }

    const chatId = input.chatId ?? (await this.state.storage.get<string>('chatId'));
    if (!chatId) throw new RoomError('chat_not_found', 404);
    await this.state.storage.put('chatId', chatId);

    const meta = await this.loadChatMeta(chatId);
    if (!meta) throw new RoomError('chat_not_found', 404);

    await this.assertParticipant(chatId, input.senderId);

    const recipients = await this.recipientIds(chatId, input.senderId);
    const id = crypto.randomUUID();
    const now = Date.now();
    const seq = await this.nextSequence();

    const ops = [
      this.env.DB.prepare(
        `INSERT INTO messages (id, chat_id, sender_id, sequence, message_type, body, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).bind(id, chatId, input.senderId, seq, input.type, body, now),
      ...recipients.map((rid) =>
        this.env.DB.prepare(
          `INSERT INTO receipts (message_id, recipient_id) VALUES (?, ?)`,
        ).bind(id, rid),
      ),
    ];
    await this.env.DB.batch(ops);

    // Fan-out. We use kind=message_preview so drainOutbound triggers the
    // delivered_at side-effect for offline recipients; for ping-type
    // messages we use kind=ping (same side-effect on drain).
    const fanoutKind = input.type === 'ping' ? 'ping' : 'message_preview';
    const eventPayload =
      input.type === 'ping'
        ? { t: 'ping', chatId, from: input.senderId, ts: now }
        : {
            t: 'message',
            id,
            chatId,
            from: input.senderId,
            sequence: seq,
            type: input.type,
            body,
            ts: now,
          };

    await Promise.all(
      recipients.map((rid) =>
        fireAndForget(notifyUserHub(this.env, rid, fanoutKind, eventPayload)),
      ),
    );

    return json({
      messageId: id,
      sequence: seq,
      ts: now,
      tempId: input.tempId,
      chatId,
    });
  }

  // ---------- /typing ----------
  private async fanoutTyping(input: TypingInput): Promise<Response> {
    const chatId = input.chatId;
    await this.assertParticipant(chatId, input.senderId);
    const recipients = await this.recipientIds(chatId, input.senderId);
    const payload = { t: 'typing', chatId, userId: input.senderId, on: !!input.on };
    await Promise.all(
      recipients.map((rid) => fireAndForget(notifyUserHub(this.env, rid, 'typing', payload))),
    );
    return new Response(null, { status: 204 });
  }

  // ---------- /ping ----------
  private async persistPing(input: PingInput): Promise<Response> {
    return this.persist({
      senderId: input.senderId,
      tempId: crypto.randomUUID(),
      type: 'ping',
      body: null,
      chatId: input.chatId,
    });
  }

  // ---------- /read ----------
  private async markRead(input: ReadInput): Promise<Response> {
    const ids = (input.messageIds ?? []).filter((s) => typeof s === 'string');
    if (ids.length === 0) return new Response(null, { status: 204 });
    if (ids.length > MAX_READ_IDS) throw new RoomError('payload_too_large', 413);
    const chatId = input.chatId;
    await this.assertParticipant(chatId, input.senderId);

    const now = Date.now();
    const placeholders = ids.map(() => '?').join(',');
    await this.env.DB.prepare(
      `UPDATE receipts SET read_at = ?
       WHERE recipient_id = ? AND read_at IS NULL AND message_id IN (${placeholders})`,
    )
      .bind(now, input.senderId, ...ids)
      .run();

    const senderRows = await this.env.DB.prepare(
      `SELECT id, sender_id FROM messages WHERE chat_id = ? AND id IN (${placeholders})`,
    )
      .bind(chatId, ...ids)
      .all<{ id: string; sender_id: string }>();

    await Promise.all(
      (senderRows.results ?? []).map((m) => {
        if (m.sender_id === input.senderId) return Promise.resolve();
        return fireAndForget(
          notifyUserHub(this.env, m.sender_id, 'read', {
            t: 'read',
            messageId: m.id,
            chatId,
            userId: input.senderId,
            ts: now,
          }),
        );
      }),
    );

    return new Response(null, { status: 204 });
  }

  // ---------- /recall ----------
  private async recall(input: RecallInput): Promise<Response> {
    const chatId = input.chatId;
    await this.assertParticipant(chatId, input.senderId);
    const cutoff = Date.now() - RECALL_WINDOW_MS;

    const msg = await this.env.DB.prepare(
      `SELECT id, sender_id, created_at, deleted_at FROM messages
       WHERE id = ? AND chat_id = ?`,
    )
      .bind(input.messageId, chatId)
      .first<{
        id: string;
        sender_id: string;
        created_at: number;
        deleted_at: number | null;
      }>();
    if (!msg) throw new RoomError('message_not_found', 404);
    if (msg.sender_id !== input.senderId) throw new RoomError('cannot_recall', 403);
    if (msg.created_at < cutoff || msg.deleted_at) throw new RoomError('cannot_recall', 403);

    const now = Date.now();
    await this.env.DB.prepare(`UPDATE messages SET deleted_at = ? WHERE id = ?`)
      .bind(now, input.messageId)
      .run();

    const recipients = await this.recipientIds(chatId, input.senderId);
    const payload = { t: 'recalled', messageId: input.messageId, chatId, ts: now };
    await Promise.all(
      [...recipients, input.senderId].map((uid) =>
        fireAndForget(notifyUserHub(this.env, uid, 'recalled', payload)),
      ),
    );

    return new Response(null, { status: 204 });
  }

  // ---------- /edit ----------
  private async edit(input: EditInput): Promise<Response> {
    const chatId = input.chatId;
    await this.assertParticipant(chatId, input.senderId);
    const body = (input.body ?? '').trim();
    if (body.length === 0) throw new RoomError('bad_json', 400);
    if (body.length > MAX_BODY_LEN) throw new RoomError('payload_too_large', 413);

    const cutoff = Date.now() - EDIT_WINDOW_MS;
    const msg = await this.env.DB.prepare(
      `SELECT id, sender_id, message_type, created_at, deleted_at
       FROM messages WHERE id = ? AND chat_id = ?`,
    )
      .bind(input.messageId, chatId)
      .first<{
        id: string;
        sender_id: string;
        message_type: string;
        created_at: number;
        deleted_at: number | null;
      }>();
    if (!msg) throw new RoomError('message_not_found', 404);
    if (msg.sender_id !== input.senderId) throw new RoomError('cannot_edit', 403);
    if (msg.message_type !== 'text') throw new RoomError('cannot_edit', 403);
    if (msg.deleted_at) throw new RoomError('cannot_edit', 403);
    if (msg.created_at < cutoff) throw new RoomError('cannot_edit', 403);

    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE messages SET body = ?, edited_at = ? WHERE id = ?`,
    )
      .bind(body, now, input.messageId)
      .run();

    const recipients = await this.recipientIds(chatId, input.senderId);
    const payload = { t: 'edited', messageId: input.messageId, chatId, body, editedAt: now };
    await Promise.all(
      [...recipients, input.senderId].map((uid) =>
        fireAndForget(notifyUserHub(this.env, uid, 'edited', payload)),
      ),
    );

    return new Response(null, { status: 204 });
  }
}

class RoomError extends Error {
  constructor(
    public code: ErrorCode,
    public status: number,
  ) {
    super(code);
  }
}

function errorResponse(code: ErrorCode, status: number): Response {
  return new Response(JSON.stringify({ error: code }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function fireAndForget<T>(p: Promise<T>): Promise<void> {
  return p.then(() => undefined).catch(() => undefined);
}
