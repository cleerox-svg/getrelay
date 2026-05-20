import { Hono } from 'hono';
import type { Env } from './env';
import { readAuthedUser } from './auth';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/gif',
  'video/mp4',
  'video/webm',
  'video/quicktime',
]);

function extFor(type: string): string {
  switch (type) {
    case 'image/jpeg':      return 'jpg';
    case 'image/png':       return 'png';
    case 'image/webp':      return 'webp';
    case 'image/gif':       return 'gif';
    case 'video/mp4':       return 'mp4';
    case 'video/webm':      return 'webm';
    case 'video/quicktime': return 'mov';
    default:                return 'bin';
  }
}

export function mediaRoutes() {
  const app = new Hono<{ Bindings: Env }>();

  // POST /me/media — multipart with a single `file` field. Returns the
  // R2 key; the client then includes it in a `send` WS message.
  app.post('/me/media', async (c) => {
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
    const file = fileEntry as Blob;
    if (!ALLOWED_TYPES.has(file.type)) return c.json({ error: 'bad_type' }, 415);
    if (file.size > MAX_BYTES) return c.json({ error: 'too_large' }, 413);

    const key = `m-${crypto.randomUUID()}.${extFor(file.type)}`;
    await c.env.MEDIA.put(key, file.stream(), {
      httpMetadata: { contentType: file.type },
      // Tag with the uploader so we can prune orphans + audit later.
      customMetadata: { uploader: me.id },
    });

    return c.json({
      ok: true,
      key,
      url: `${new URL(c.req.url).origin}/m/${key}`,
      contentType: file.type,
      bytes: file.size,
    });
  });

  // GET /m/:key — public proxy. Media attachments aren't secret in v1;
  // anyone in a chat with you sees them. Long, immutable cache because
  // the key (UUID-based) changes per upload.
  app.get('/m/:key', async (c) => {
    const key = c.req.param('key');
    if (!key || key.includes('/') || key.includes('..')) {
      return c.text('not found', 404);
    }
    const obj = await c.env.MEDIA.get(key);
    if (!obj) return c.text('not found', 404);

    const headers = new Headers();
    obj.writeHttpMetadata(headers);
    headers.set('etag', obj.httpEtag);
    headers.set('cache-control', 'public, max-age=31536000, immutable');
    return new Response(obj.body, { headers });
  });

  return app;
}

// Helper for the chat list / messages endpoints to derive a usable URL
// for a stored media key.
export function mediaUrlFor(origin: string, key: string | null): string | null {
  if (!key) return null;
  return `${origin}/m/${key}`;
}

// Guess image vs video from the file extension. Stored message_type is
// always 'image' to fit the existing schema's CHECK constraint; the UI
// branches on this for rendering.
export function isVideoKey(key: string | null): boolean {
  if (!key) return false;
  return /\.(mp4|webm|mov)$/i.test(key);
}
