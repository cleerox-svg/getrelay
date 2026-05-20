import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

const MAX_AVATAR_BYTES = 2 * 1024 * 1024;
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);

function extFor(type: string): string {
  switch (type) {
    case 'image/jpeg': return 'jpg';
    case 'image/png':  return 'png';
    case 'image/webp': return 'webp';
    default:           return 'bin';
  }
}

export function avatarsRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // POST /me/avatar — multipart upload with a single `file` field.
  app.post('/me/avatar', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const form = await c.req.raw.formData().catch(() => null);
    if (!form) return c.json({ error: 'bad_form' }, 400);

    const fileEntry = form.get('file');
    if (
      !fileEntry ||
      typeof fileEntry === 'string' ||
      !('arrayBuffer' in fileEntry) ||
      !('type' in fileEntry) ||
      !('size' in fileEntry) ||
      !('stream' in fileEntry)
    ) {
      return c.json({ error: 'no_file' }, 400);
    }
    const file = fileEntry as Blob & { name?: string };
    if (!ALLOWED_TYPES.has(file.type)) return c.json({ error: 'bad_type' }, 415);
    if (file.size > MAX_AVATAR_BYTES) return c.json({ error: 'too_large' }, 413);

    const key = `av-${crypto.randomUUID()}.${extFor(file.type)}`;
    await c.env.AVATARS.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
    });

    // Replace any previous avatar; delete the old object so we don't accumulate.
    const prev = await c.env.DB.prepare(`SELECT avatar_r2_key FROM users WHERE id = ?`)
      .bind(me.id)
      .first<{ avatar_r2_key: string | null }>();

    await c.env.DB.prepare(
      `UPDATE users SET avatar_r2_key = ?, avatar_url = NULL WHERE id = ?`,
    )
      .bind(key, me.id)
      .run();

    if (prev?.avatar_r2_key) {
      c.executionCtx.waitUntil(c.env.AVATARS.delete(prev.avatar_r2_key));
    }

    return c.json({ ok: true, key });
  });

  // DELETE /me/avatar — clear back to initials.
  app.delete('/me/avatar', async (c) => {
    const me = await readAuthedUser(c.env, c.req.raw);
    if (!me) return c.json({ error: 'unauthorized' }, 401);

    const prev = await c.env.DB.prepare(`SELECT avatar_r2_key FROM users WHERE id = ?`)
      .bind(me.id)
      .first<{ avatar_r2_key: string | null }>();
    await c.env.DB.prepare(
      `UPDATE users SET avatar_r2_key = NULL, avatar_url = NULL WHERE id = ?`,
    )
      .bind(me.id)
      .run();
    if (prev?.avatar_r2_key) {
      c.executionCtx.waitUntil(c.env.AVATARS.delete(prev.avatar_r2_key));
    }
    return c.json({ ok: true });
  });

  // GET /r/:key — public proxy for an R2 object. Avatars are not secret;
  // anyone in a chat with you sees yours. Cache aggressively — the key
  // changes on every upload, so the URL is self-versioning.
  app.get('/r/:key', async (c) => {
    const key = c.req.param('key');
    if (!key || key.includes('/') || key.includes('..')) {
      return c.text('not found', 404);
    }
    const obj = await c.env.AVATARS.get(key);
    if (!obj) return c.text('not found', 404);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(obj.body, { headers });
  });

  return app;
}
