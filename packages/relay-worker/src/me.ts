import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

export function avatarUrlFor(
  origin: string,
  row: { avatar_r2_key: string | null; avatar_url: string | null },
): string | null {
  if (row.avatar_r2_key) return `${origin}/r/${row.avatar_r2_key}`;
  return row.avatar_url ?? null;
}

export function meRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/me', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const row = await c.env.DB.prepare(
      `SELECT id, email, pin, display_name, status_message, avatar_url, avatar_r2_key,
              is_admin,
              COALESCE(sports_notifications, 1) AS sports_notifications,
              COALESCE(sports_notify_start,  1) AS sports_notify_start,
              COALESCE(sports_notify_score,  1) AS sports_notify_score,
              COALESCE(sports_notify_final,  1) AS sports_notify_final
       FROM users WHERE id = ?`,
    ).bind(me.id).first<{
      id: string;
      email: string;
      pin: string;
      display_name: string;
      status_message: string | null;
      avatar_url: string | null;
      avatar_r2_key: string | null;
      is_admin: number;
      sports_notifications: number;
      sports_notify_start: number;
      sports_notify_score: number;
      sports_notify_final: number;
    }>();
    if (!row) return c.json({ error: 'user_not_found' }, 404);

    const origin = new URL(c.req.url).origin;
    return c.json({
      id: row.id,
      email: row.email,
      pin: row.pin,
      displayName: row.display_name,
      statusMessage: row.status_message,
      avatarUrl: avatarUrlFor(origin, row),
      isAdmin: row.is_admin === 1,
      sportsNotifications: row.sports_notifications === 1,
      sportsNotifyStart: row.sports_notify_start === 1,
      sportsNotifyScore: row.sports_notify_score === 1,
      sportsNotifyFinal: row.sports_notify_final === 1,
    });
  });

  app.patch('/me', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{
      displayName?: string;
      statusMessage?: string;
      sportsNotifications?: boolean;
      sportsNotifyStart?: boolean;
      sportsNotifyScore?: boolean;
      sportsNotifyFinal?: boolean;
    }>();

    const updates: string[] = [];
    const values: (string | number)[] = [];
    if (typeof body.displayName === 'string') {
      const dn = body.displayName.trim();
      if (dn.length === 0 || dn.length > 64) {
        return c.json({ error: 'invalid_display_name' }, 400);
      }
      updates.push('display_name = ?');
      values.push(dn);
    }
    if (typeof body.statusMessage === 'string') {
      const sm = body.statusMessage.trim();
      if (sm.length > 140) return c.json({ error: 'invalid_status' }, 400);
      updates.push('status_message = ?');
      values.push(sm);
    }
    if (typeof body.sportsNotifications === 'boolean') {
      updates.push('sports_notifications = ?');
      values.push(body.sportsNotifications ? 1 : 0);
    }
    if (typeof body.sportsNotifyStart === 'boolean') {
      updates.push('sports_notify_start = ?');
      values.push(body.sportsNotifyStart ? 1 : 0);
    }
    if (typeof body.sportsNotifyScore === 'boolean') {
      updates.push('sports_notify_score = ?');
      values.push(body.sportsNotifyScore ? 1 : 0);
    }
    if (typeof body.sportsNotifyFinal === 'boolean') {
      updates.push('sports_notify_final = ?');
      values.push(body.sportsNotifyFinal ? 1 : 0);
    }
    if (updates.length === 0) return c.json({ ok: true });

    values.push(me.id);
    await c.env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    ).bind(...values).run();

    return c.json({ ok: true });
  });

  // ---- Sports team subscriptions -----------------------------------------
  //
  // GET returns the user's followed (league, team_key) rows. PUT replaces
  // them in a single transaction so the UI can ship a whole set at once
  // and not deal with per-row diffing.

  app.get('/me/sports/subs', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    const rows = await c.env.DB.prepare(
      `SELECT league, team_key FROM user_sports_subs
        WHERE user_id = ? ORDER BY league, team_key`,
    )
      .bind(me.id)
      .all<{ league: 'NHL' | 'MLB'; team_key: string }>();
    return c.json({
      subs: (rows.results ?? []).map((r) => ({ league: r.league, teamKey: r.team_key })),
    });
  });

  app.put('/me/sports/subs', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);
    const body = await c.req.json<{
      subs?: { league?: string; teamKey?: string }[];
    }>();
    const input = Array.isArray(body.subs) ? body.subs : [];
    // Validate + dedupe. Bound at 50 follows just so a runaway client
    // can't drop a giant payload.
    const seen = new Set<string>();
    const valid: { league: 'NHL' | 'MLB'; teamKey: string }[] = [];
    for (const row of input) {
      const league = String(row.league ?? '').toUpperCase();
      const teamKey = String(row.teamKey ?? '').trim();
      if ((league !== 'NHL' && league !== 'MLB') || !teamKey) continue;
      if (teamKey.length > 32) continue;
      const k = `${league}:${teamKey}`;
      if (seen.has(k)) continue;
      seen.add(k);
      valid.push({ league: league as 'NHL' | 'MLB', teamKey });
      if (valid.length >= 50) break;
    }

    const now = Date.now();
    const ops = [
      c.env.DB.prepare(`DELETE FROM user_sports_subs WHERE user_id = ?`).bind(me.id),
      ...valid.map((v) =>
        c.env.DB.prepare(
          `INSERT OR IGNORE INTO user_sports_subs (user_id, league, team_key, created_at)
           VALUES (?, ?, ?, ?)`,
        ).bind(me.id, v.league, v.teamKey, now),
      ),
    ];
    await c.env.DB.batch(ops);
    return c.json({ ok: true, count: valid.length });
  });

  return app;
}
