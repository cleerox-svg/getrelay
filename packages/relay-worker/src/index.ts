import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { authRoutes, readAuthedUser } from './auth';
import { avatarsRoutes } from './avatars';
import { meRoutes } from './me';
import { contactsRoutes } from './contacts';
import { chatsRoutes } from './chats';
import { messagesRoutes } from './messages';

export { ChatRoom } from './do/chat-room';
export { UserHub } from './do/user-hub';

const app = new Hono<{ Bindings: Env }>();

app.use('*', async (c, next) => {
  const cb = cors({
    origin: (origin) => {
      if (!origin) return null;
      const allowed = new Set([c.env.APP_URL, 'http://localhost:5173', 'http://localhost:8787']);
      if (allowed.has(origin)) return origin;
      // dev-only: allow LAN IPs (Pixel testing) when not in production
      if (
        !c.env.AUTH_COOKIE_DOMAIN &&
        /^https?:\/\/(?:192\.168|10|172\.(?:1[6-9]|2\d|3[01]))\./.test(origin)
      ) {
        return origin;
      }
      return null;
    },
    credentials: true,
    allowMethods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
  });
  return cb(c, next);
});

app.get('/', (c) => c.text('Relay API. See https://github.com/cleerox-svg/getrelay'));
app.get('/health', (c) => c.json({ ok: true, service: 'relay-worker' }));

app.route('/', authRoutes());
app.route('/', meRoutes());
app.route('/', avatarsRoutes());
app.route('/', contactsRoutes());
app.route('/', chatsRoutes());
app.route('/', messagesRoutes());

// WebSocket upgrade — authenticates via cookie, forwards to the user's
// UserHub DO with the user id/jti in headers.
app.get('/ws', async (c) => {
  if (c.req.header('Upgrade') !== 'websocket') {
    return c.text('expected upgrade', 426);
  }
  const me = await readAuthedUser(c.env, c.req.raw);
  if (!me) return c.text('unauthorized', 401);

  const headers = new Headers(c.req.raw.headers);
  headers.set('X-Relay-User-Id', me.id);
  headers.set('X-Relay-Jti', me.jti);

  const stub = c.env.USER_HUB.get(c.env.USER_HUB.idFromName(me.id));
  return stub.fetch('https://do/ws', { method: 'GET', headers });
});

export default app;
