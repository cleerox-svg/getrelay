import type { Env } from '../env';

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
// 'recalled', 'edited') are best-effort: delivered live if the recipient
// has a socket, dropped otherwise. Persistable kinds are mapped to
// OutboundKind via outboundKindFor() when queuing.
export type NotifyKind =
  | OutboundKind
  | 'typing'
  | 'recalled'
  | 'edited';

export function outboundKindFor(kind: NotifyKind): OutboundKind | null {
  switch (kind) {
    case 'typing':
    case 'recalled':
    case 'edited':
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

  await env.DB.prepare(
    `UPDATE outbound_events SET consumed = 1 WHERE user_id = ? AND consumed = 0`,
  )
    .bind(userId)
    .run();

  return events.map((r) => ({
    id: r.id,
    userId: r.user_id,
    kind: r.kind,
    payload: JSON.parse(r.payload) as unknown,
    createdAt: r.created_at,
  }));
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
