import type { Env } from '../env';

export type OutboundKind =
  | 'delivered'
  | 'read'
  | 'message_preview'
  | 'presence'
  | 'ping'
  | 'invite';

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
