import type { Env } from '../env';
import {
  drainOutbound,
  insertOutboundEvent,
  outboundKindFor,
  type NotifyKind,
  type OutboundKind,
} from '../lib/outbound';
import { pushToUser } from '../push';
import { RateLimiter } from '../lib/rate-limit';
import {
  type ClientMsg,
  type ErrorCode,
  type ServerMsg,
  MAX_BODY_LEN,
  MAX_READ_IDS,
} from '../lib/ws-protocol';

interface Attachment {
  userId: string;
  jti: string;
  subscribedChats: string[];
}

// One UserHub DO per user (named via env.USER_HUB.idFromName(users.id)).
// Holds the user's primary WebSocket. Receives /notify from ChatRoom DOs to
// forward events to its sockets (or persist via outbound_events).
export class UserHub implements DurableObject {
  private limiter = new RateLimiter();

  constructor(
    private state: DurableObjectState,
    private env: Env,
  ) {
    // Heartbeat handled by the runtime without waking the DO.
    this.state.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair('p', 'pong'),
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/notify') {
      const body = (await request.json()) as {
        userId: string;
        kind: NotifyKind;
        payload: unknown;
      };
      await this.deliverOrQueue(body.userId, body.kind, body.payload);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws') {
      const userId = request.headers.get('X-Relay-User-Id');
      const jti = request.headers.get('X-Relay-Jti');
      if (!userId || !jti) return new Response('unauthorized', { status: 401 });
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected upgrade', { status: 426 });
      }

      const pair = new WebSocketPair();
      const server = pair[1] as WebSocket;
      this.state.acceptWebSocket(server);
      const attachment: Attachment = { userId, jti, subscribedChats: [] };
      server.serializeAttachment(attachment);

      // Run drain + presence after we've returned the upgrade response
      // so the client sees a fast 101.
      this.state.waitUntil(this.onConnect(userId, server));

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return this.sendError(ws, 'unauthorized');

    let cmd: ClientMsg;
    try {
      cmd = JSON.parse(typeof msg === 'string' ? msg : new TextDecoder().decode(msg));
    } catch {
      return this.sendError(ws, 'bad_json');
    }
    if (!cmd || typeof cmd.t !== 'string') return this.sendError(ws, 'bad_json');

    if (!this.limiter.consume(att.userId, cmd.t)) {
      return this.sendError(ws, 'rate_limited');
    }

    try {
      switch (cmd.t) {
        case 'send':        return await this.handleSend(ws, att, cmd);
        case 'typing':      return await this.handleTyping(att, cmd);
        case 'read':        return await this.handleRead(att, cmd);
        case 'ping':        return await this.handlePing(att, cmd);
        case 'recall':      return await this.handleRecall(att, cmd);
        case 'edit':        return await this.handleEdit(att, cmd);
        case 'react':       return await this.handleReact(att, cmd);
        case 'subscribe':   return this.handleSubscribe(ws, att, cmd.chatId);
        case 'unsubscribe': return this.handleUnsubscribe(ws, att, cmd.chatId);
        default:            return this.sendError(ws, 'unknown_type');
      }
    } catch (err) {
      const code: ErrorCode =
        err instanceof Error && isErrorCode(err.message) ? (err.message as ErrorCode) : 'bad_json';
      return this.sendError(ws, code);
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    const att = ws.deserializeAttachment() as Attachment | null;
    if (!att) return;
    const others = this.state.getWebSockets().filter((s) => s !== ws);
    if (others.length === 0) await this.markOffline(att.userId);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    return this.webSocketClose(ws);
  }

  // ---------- connect lifecycle ----------
  private async onConnect(userId: string, ws: WebSocket): Promise<void> {
    await this.markOnline(userId);
    await this.drainQueued(userId, ws);
  }

  private async markOnline(userId: string): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
      .bind(now, userId)
      .run();
    await this.broadcastPresenceToContacts(userId, true, now);
  }

  private async markOffline(userId: string): Promise<void> {
    const now = Date.now();
    await this.env.DB.prepare(`UPDATE users SET last_seen_at = ? WHERE id = ?`)
      .bind(now, userId)
      .run();
    await this.broadcastPresenceToContacts(userId, false, now);
  }

  private async broadcastPresenceToContacts(
    userId: string,
    online: boolean,
    ts: number,
  ): Promise<void> {
    const rows = await this.env.DB.prepare(
      `SELECT owner_id FROM contacts WHERE contact_id = ?`,
    )
      .bind(userId)
      .all<{ owner_id: string }>();
    const payload: ServerMsg = { t: 'presence', userId, online, lastSeen: ts };
    await Promise.all(
      (rows.results ?? []).map((r) =>
        this.notifyOtherUserHub(r.owner_id, 'presence', payload).catch(() => undefined),
      ),
    );
  }

  private async notifyOtherUserHub(
    recipientId: string,
    kind: NotifyKind,
    payload: unknown,
  ): Promise<void> {
    const stub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(recipientId));
    await stub.fetch('https://do/notify', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ userId: recipientId, kind, payload }),
    });
  }

  // ---------- /notify ingress ----------
  private async deliverOrQueue(
    userId: string,
    kind: NotifyKind,
    payload: unknown,
  ): Promise<void> {
    const sockets = this.openSocketsFor(userId);

    const persistKind: OutboundKind | null = outboundKindFor(kind);

    if (sockets.length === 0) {
      // No live socket on this UserHub. Queue persistable kinds for the
      // recipient to drain on next connect; ephemeral kinds drop.
      if (persistKind !== null) {
        await insertOutboundEvent(this.env, userId, persistKind, payload);
      }
    } else {
      for (const s of sockets) this.safeSend(s, payload as ServerMsg);
      if (kind === 'message_preview' || kind === 'ping') {
        await this.markDeliveredAndAck(userId, payload);
      }
    }

    // Always fire Web Push for message-bearing kinds, regardless of
    // socket state. A user can be "online" on desktop while their mobile
    // PWA sits closed — that mobile still deserves a notification. The
    // SW silences the notification (no sound / vibration) on whichever
    // device is currently focused so it isn't annoying for the user
    // actively reading the chat.
    //
    // Exception: if the recipient muted this chat, skip the push (the
    // live socket still receives the message — they see it in the chat
    // list, just no notification).
    if (kind === 'message_preview' || kind === 'ping') {
      const chatId = (payload as { chatId?: string })?.chatId;
      if (chatId) {
        const muted = await this.isChatMutedFor(userId, chatId);
        if (muted) return;
      }
      const pushPayload = await buildPushPayload(this.env, kind, payload);
      await pushToUser(this.env, userId, pushPayload).catch(() => undefined);
    }
  }

  private async isChatMutedFor(userId: string, chatId: string): Promise<boolean> {
    const row = await this.env.DB.prepare(
      `SELECT COALESCE(muted, 0) AS muted
       FROM chat_participants WHERE user_id = ? AND chat_id = ?`,
    )
      .bind(userId, chatId)
      .first<{ muted: number }>();
    return row?.muted === 1;
  }

  private openSocketsFor(userId: string): WebSocket[] {
    return this.state.getWebSockets().filter((s) => {
      const att = s.deserializeAttachment() as Attachment | null;
      return att?.userId === userId;
    });
  }

  private async markDeliveredAndAck(recipientId: string, payload: unknown): Promise<void> {
    const ev = payload as { id?: string; chatId?: string; from?: string };
    if (!ev.id || !ev.chatId || !ev.from) return;
    const now = Date.now();
    await this.env.DB.prepare(
      `UPDATE receipts SET delivered_at = ?
       WHERE message_id = ? AND recipient_id = ? AND delivered_at IS NULL`,
    )
      .bind(now, ev.id, recipientId)
      .run();
    await this.notifyOtherUserHub(ev.from, 'delivered', {
      t: 'delivered',
      messageId: ev.id,
      chatId: ev.chatId,
      userId: recipientId,
      ts: now,
    });
  }

  // ---------- drain ----------
  private async drainQueued(userId: string, ws: WebSocket): Promise<void> {
    const events = await drainOutbound(this.env, userId);
    for (const ev of events) {
      this.safeSend(ws, ev.payload as ServerMsg);
      if (ev.kind === 'message_preview' || ev.kind === 'ping') {
        await this.markDeliveredAndAck(userId, ev.payload);
      }
    }
  }

  // ---------- command handlers ----------
  private async handleSend(
    ws: WebSocket,
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'send' }>,
  ): Promise<void> {
    if (cmd.type !== 'text' && cmd.type !== 'ping' && cmd.type !== 'image') {
      return this.sendError(ws, 'bad_json');
    }
    const body =
      cmd.type === 'ping' ? null : (cmd.body ?? '').trim() || null;
    if (cmd.type === 'text') {
      if (!body || body.length === 0) return this.sendError(ws, 'bad_json');
      if (body.length > MAX_BODY_LEN) return this.sendError(ws, 'payload_too_large');
    }
    if (cmd.type === 'image') {
      if (!cmd.mediaKey || typeof cmd.mediaKey !== 'string') {
        return this.sendError(ws, 'bad_json');
      }
      if (body && body.length > MAX_BODY_LEN) {
        return this.sendError(ws, 'payload_too_large');
      }
    }

    const res = await this.callChatRoom(cmd.chatId, '/persist', {
      senderId: att.userId,
      tempId: cmd.tempId,
      type: cmd.type,
      body,
      mediaKey: cmd.type === 'image' ? cmd.mediaKey : null,
      replyTo: cmd.replyTo ?? null,
      chatId: cmd.chatId,
    });

    const ack = (await res.json()) as {
      messageId: string;
      sequence: number;
      ts: number;
      tempId: string;
      chatId: string;
    };
    this.safeSend(ws, {
      t: 'ack',
      tempId: ack.tempId,
      messageId: ack.messageId,
      sequence: ack.sequence,
      chatId: ack.chatId,
      ts: ack.ts,
    });
  }

  private async handleTyping(
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'typing' }>,
  ): Promise<void> {
    await this.callChatRoom(cmd.chatId, '/typing', {
      chatId: cmd.chatId,
      senderId: att.userId,
      on: !!cmd.on,
    });
  }

  private async handleRead(
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'read' }>,
  ): Promise<void> {
    const ids = Array.isArray(cmd.messageIds) ? cmd.messageIds : [];
    if (ids.length > MAX_READ_IDS) throw new Error('payload_too_large');
    await this.callChatRoom(cmd.chatId, '/read', {
      chatId: cmd.chatId,
      senderId: att.userId,
      messageIds: ids,
    });
  }

  private async handlePing(
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'ping' }>,
  ): Promise<void> {
    await this.callChatRoom(cmd.chatId, '/ping', {
      chatId: cmd.chatId,
      senderId: att.userId,
    });
  }

  private async handleRecall(
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'recall' }>,
  ): Promise<void> {
    const chatId = await this.lookupChatIdForMessage(cmd.messageId);
    if (!chatId) throw new Error('message_not_found');
    await this.callChatRoom(chatId, '/recall', {
      chatId,
      senderId: att.userId,
      messageId: cmd.messageId,
    });
  }

  private async handleEdit(
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'edit' }>,
  ): Promise<void> {
    const chatId = await this.lookupChatIdForMessage(cmd.messageId);
    if (!chatId) throw new Error('message_not_found');
    await this.callChatRoom(chatId, '/edit', {
      chatId,
      senderId: att.userId,
      messageId: cmd.messageId,
      body: cmd.body,
    });
  }

  private async handleReact(
    att: Attachment,
    cmd: Extract<ClientMsg, { t: 'react' }>,
  ): Promise<void> {
    const chatId = await this.lookupChatIdForMessage(cmd.messageId);
    if (!chatId) throw new Error('message_not_found');
    await this.callChatRoom(chatId, '/react', {
      chatId,
      senderId: att.userId,
      messageId: cmd.messageId,
      emoji: cmd.emoji,
    });
  }

  private async lookupChatIdForMessage(messageId: string): Promise<string | null> {
    const row = await this.env.DB.prepare(`SELECT chat_id FROM messages WHERE id = ?`)
      .bind(messageId)
      .first<{ chat_id: string }>();
    return row?.chat_id ?? null;
  }

  private handleSubscribe(ws: WebSocket, att: Attachment, chatId: string): void {
    if (!chatId || typeof chatId !== 'string') return this.sendError(ws, 'bad_json');
    if (!att.subscribedChats.includes(chatId)) {
      att.subscribedChats.push(chatId);
      ws.serializeAttachment(att);
    }
  }

  private handleUnsubscribe(ws: WebSocket, att: Attachment, chatId: string): void {
    if (!chatId || typeof chatId !== 'string') return this.sendError(ws, 'bad_json');
    const idx = att.subscribedChats.indexOf(chatId);
    if (idx >= 0) {
      att.subscribedChats.splice(idx, 1);
      ws.serializeAttachment(att);
    }
  }

  // ---------- helpers ----------
  private async callChatRoom(
    chatId: string,
    path: '/persist' | '/typing' | '/read' | '/ping' | '/recall' | '/edit' | '/react',
    body: unknown,
  ): Promise<Response> {
    const stub = this.env.CHAT_ROOM.get(this.env.CHAT_ROOM.idFromName(chatId));
    const res = await stub.fetch(`https://do${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const code = await readErrorCode(res);
      throw new Error(code);
    }
    return res;
  }

  private safeSend(ws: WebSocket, payload: ServerMsg): void {
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // socket may have closed mid-write; webSocketClose will fire.
    }
  }

  private sendError(ws: WebSocket, code: ErrorCode): void {
    this.safeSend(ws, { t: 'error', code });
  }
}

// Resolve the sender's display name and the chat type/subject so the
// notification title is meaningful ("Bradey" or the group name) and the
// body conveys who sent what.
async function buildPushPayload(
  env: Env,
  kind: 'message_preview' | 'ping',
  payload: unknown,
) {
  const ev = payload as {
    chatId?: string;
    from?: string;
    body?: string | null;
    mediaKey?: string | null;
  };
  const fromId = ev.from ?? '';
  const chatId = ev.chatId ?? '';

  const [sender, chat] = await Promise.all([
    fromId
      ? env.DB.prepare(`SELECT display_name FROM users WHERE id = ?`)
          .bind(fromId)
          .first<{ display_name: string }>()
      : Promise.resolve(null),
    chatId
      ? env.DB.prepare(`SELECT type, subject FROM chats WHERE id = ?`)
          .bind(chatId)
          .first<{ type: '1to1' | 'group'; subject: string | null }>()
      : Promise.resolve(null),
  ]);

  const senderName = sender?.display_name ?? 'Someone';
  const isGroup = chat?.type === 'group';
  const groupName = chat?.subject ?? 'Group';
  const tag = chatId || (kind === 'ping' ? 'ping' : 'message');

  if (kind === 'ping') {
    return {
      title: isGroup ? groupName : senderName,
      body: isGroup ? `${senderName} sent a PING!!` : 'sent you a PING!!',
      chatId,
      tag,
    };
  }

  // Media-only previews (no caption): icon + label so it reads at a glance.
  const trimmed = (ev.body ?? '').trim();
  let preview: string;
  if (trimmed.length > 0) {
    preview = trimmed.slice(0, 140);
  } else if (ev.mediaKey) {
    preview = /\.(mp4|webm|mov)$/i.test(ev.mediaKey) ? '🎬 Video' : '📷 Photo';
  } else {
    preview = 'New message';
  }

  return {
    title: isGroup ? groupName : senderName,
    body: isGroup ? `${senderName}: ${preview}` : preview,
    chatId,
    tag,
  };
}

async function readErrorCode(res: Response): Promise<ErrorCode> {
  try {
    const j = (await res.json()) as { error?: string };
    if (j.error && isErrorCode(j.error)) return j.error;
  } catch {
    /* swallow */
  }
  return 'bad_json';
}

function isErrorCode(s: string): s is ErrorCode {
  return [
    'bad_json',
    'unknown_type',
    'unauthorized',
    'rate_limited',
    'not_in_chat',
    'payload_too_large',
    'chat_not_found',
    'message_not_found',
    'cannot_edit',
    'cannot_recall',
  ].includes(s);
}
