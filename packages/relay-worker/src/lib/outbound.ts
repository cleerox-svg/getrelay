import type { Env } from '../env';
import { decryptStoredBody } from './message-crypto';

// Schema-aligned kinds — these are the values stored in outbound_events.kind
// (matches the CHECK constraint in schema.sql).
export type OutboundKind =
  | 'delivered'
  | 'read'
  | 'message_preview'
  | 'presence'
  | 'ping'
  | 'invite';

// Wire kinds for DO-to-DO /notify calls. Ephemeral kinds ('typing',
// 'recalled', 'edited', 'reaction') are best-effort: delivered live if
// the recipient has a socket, dropped otherwise. Persistable kinds are
// mapped to OutboundKind via outboundKindFor() when queuing.
export type NotifyKind =
  | OutboundKind
  | 'typing'
  | 'recalled'
  | 'edited'
  | 'reaction'
  | 'member_joined'
  | 'member_left'
  | 'group_updated';

export function outboundKindFor(kind: NotifyKind): OutboundKind | null {
  switch (kind) {
    case 'typing':
    case 'recalled':
    case 'edited':
    case 'reaction':
    case 'member_joined':
    case 'member_left':
    case 'group_updated':
      return null; // ephemeral
    default:
      return kind;
  }
}

export interface OutboundEvent {
  id: string;
  userId: string;
  kind: OutboundKind;
  payload: unknown;
  createdAt: number;
}

export async function insertOutboundEvent(
  env: Env,
  userId: string,
  kind: OutboundKind,
  payload: unknown,
): Promise<string> {
  const id = crypto.randomUUID();
  await env.DB.prepare(
    `INSERT INTO outbound_events (id, user_id, kind, payload, created_at)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, userId, kind, JSON.stringify(payload), Date.now())
    .run();
  return id;
}

interface OutboundRow {
  id: string;
  user_id: string;
  kind: OutboundKind;
  payload: string;
  created_at: number;
}

export async function drainOutbound(env: Env, userId: string): Promise<OutboundEvent[]> {
  const rows = await env.DB.prepare(
    `SELECT id, user_id, kind, payload, created_at
     FROM outbound_events
     WHERE user_id = ? AND consumed = 0
     ORDER BY created_at ASC`,
  )
    .bind(userId)
    .all<OutboundRow>();

  const events = rows.results ?? [];
  if (events.length === 0) return [];

  // Mark drained, then purge. `message_preview` rows are stored WITHOUT the
  // plaintext body (stripped on queue in UserHub.deliverOrQueue); we rehydrate
  // `body` here from the encrypted messages store so the client still receives
  // plaintext, and no plaintext ever rests in outbound_events. The consumed=1
  // update stays as a safety marker before the DELETE, preserving the existing
  // "mark then return" ordering.
  await env.DB.prepare(
    `UPDATE outbound_events SET consumed = 1 WHERE user_id = ? AND consumed = 0`,
  )
    .bind(userId)
    .run();

  const out: OutboundEvent[] = [];
  for (const r of events) {
    const payload = JSON.parse(r.payload) as unknown;
    if (r.kind === 'message_preview') {
      await rehydrateMessagePreview(env, payload);
    }
    out.push({
      id: r.id,
      userId: r.user_id,
      kind: r.kind,
      payload,
      createdAt: r.created_at,
    });
  }

  // Nothing reads consumed=1 rows (they are drained exactly once on connect),
  // so delete them rather than letting them accumulate forever — this also
  // ensures stripped previews don't linger.
  await env.DB.prepare(
    `DELETE FROM outbound_events WHERE user_id = ? AND consumed = 1`,
  )
    .bind(userId)
    .run();

  return out;
}

interface StoredBodyRow {
  body: string | null;
  body_iv: string | null;
  deleted_at: number | null;
}

// Re-read the message's encrypted body and decrypt it into the drained
// payload's `body`. The payload was persisted with body stripped to null; this
// restores the plaintext the client expects, sourced from the encrypted store.
// If the message no longer exists or is deleted, `body` stays null. The reply
// preview is intentionally left blank — the client refetches history (with
// correctly decrypted reply previews) on reconnect.
async function rehydrateMessagePreview(env: Env, payload: unknown): Promise<void> {
  if (!payload || typeof payload !== 'object') return;
  const ev = payload as { id?: string; chatId?: string; body?: string | null };
  if (!ev.id || !ev.chatId) return;
  const row = await env.DB.prepare(
    `SELECT body, body_iv, deleted_at FROM messages WHERE id = ?`,
  )
    .bind(ev.id)
    .first<StoredBodyRow>();
  if (!row || row.deleted_at != null) {
    ev.body = null;
    return;
  }
  ev.body = await decryptStoredBody(env, env.DB, ev.chatId, row.body, row.body_iv);
}

// Send an event to a recipient's UserHub. The UserHub decides whether the
// recipient is online (forward to socket) or offline (persist via
// insertOutboundEvent for drain on next connect, unless the kind is
// ephemeral).
export async function notifyUserHub(
  env: Env,
  recipientId: string,
  kind: NotifyKind,
  payload: unknown,
): Promise<void> {
  const stub = env.USER_HUB.get(env.USER_HUB.idFromName(recipientId));
  await stub.fetch('https://do/notify', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ userId: recipientId, kind, payload }),
  });
}
