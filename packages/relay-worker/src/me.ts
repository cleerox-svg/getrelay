import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

export function meRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  app.get('/me', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const row = await c.env.DB.prepare(
      `SELECT id, email, pin, display_name, status_message, avatar_url
       FROM users WHERE id = ?`,
    ).bind(me.id).first<{
      id: string;
      email: string;
      pin: string;
      display_name: string;
      status_message: string | null;
      avatar_url: string | null;
    }>();
    if (!row) return c.json({ error: 'user_not_found' }, 404);

    return c.json({
      id: row.id,
      email: row.email,
      pin: row.pin,
      displayName: row.display_name,
      statusMessage: row.status_message,
      avatarUrl: row.avatar_url,
    });
  });

  app.patch('/me', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const body = await c.req.json<{ displayName?: string; statusMessage?: string }>();

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
    if (updates.length === 0) return c.json({ ok: true });

    values.push(me.id);
    await c.env.DB.prepare(
      `UPDATE users SET ${updates.join(', ')} WHERE id = ?`,
    ).bind(...values).run();

    return c.json({ ok: true });
  });

  return app;
}
