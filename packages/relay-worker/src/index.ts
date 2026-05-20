import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { Env } from './env';
import { authRoutes } from './auth';
import { meRoutes } from './me';
import { contactsRoutes } from './contacts';
import { chatsRoutes } from './chats';

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
app.route('/', contactsRoutes());
app.route('/', chatsRoutes());

// Session 3 endpoint — WS upgrade to UserHub.
app.get('/ws', (c) => c.text('not_implemented_yet', 501));

export default app;
