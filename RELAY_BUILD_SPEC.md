# Relay — Build Specification (v2)

> **Project:** Relay — a BBM-inspired secure messenger
> **Owner:** Claude Leroux, LRX Enterprises Inc.
> **Stack:** Cloudflare Workers (Hono) + D1 + Durable Objects (Hibernation API) + R2 + React PWA
> **Heritage:** PIN-based identity, D/R receipts, PING!!, recall/edit — the BBM Consumer experience, rebuilt for 2026
> **Deployment:**
> &nbsp;&nbsp;&nbsp;&nbsp;UI:  `https://relay.averrow.com` (Cloudflare Pages)
> &nbsp;&nbsp;&nbsp;&nbsp;API: `https://relay-api.averrow.com` (Cloudflare Worker)

---

## 1. BLUF

Relay v0 = **Google OAuth → 8-char PIN → 1:1 chat with offline-aware D/R receipts + typing + PING + recall + edit**. One Cloudflare Worker, two Durable Object classes (`ChatRoom` per chat, `UserHub` per user — both hibernatable), D1 + R2 + WebSockets. Five Claude Code sessions to ship.

---

## 2. Coding Standard — DIAGNOSE FIRST

Every Claude Code task in this build follows three steps without exception:

1. **DIAGNOSE** — read and print the current state (files, schema, env, route table)
2. **IDENTIFY ROOT CAUSE** — name the exact gap or requirement
3. **FIX** — implement correctly the first time

No blind fixes. No bandaids. No partial implementations that "we'll come back to." Solve correctly the first time.

---

## 3. Brand Identity

**Name:** Relay
**Tagline candidate:** *"Your PIN. Your line. No phone number required."*

### Palette

The brand mark (launcher icon, favicon, splash, og:image) is **Averrow red `#C83C3C`** — the same red the parent brand uses. That gives Relay a visible family link without forcing red chrome onto a chat app, which would fight platform conventions.

In-app chrome (nav, tab bar, messagebar, bubbles) is themed by **Konsta UI** with iOS-native system colors. The PWA manifest pins `theme_color` and `background_color` to `#0A0A0E` so the OS chrome around the install matches the dark theme.

Custom tokens defined in `src/styles/global.css` for the bits Konsta doesn't paint (Avatar, PinDisplay, Receipt, PingChip, animations, caret):

| Token | Light | Dark | Usage |
|---|---|---|---|
| `--accent` | `#007AFF` | `#0A84FF` | iOS system blue — caret, primary action affordances, R-receipt |
| `--receipt-d` | `#6E6E73` | (inherits) | iOS systemGray — Delivered receipt glyph |
| `--receipt-r` | `#007AFF` | `#0A84FF` | iOS system blue — Read receipt glyph |
| `--online` | `#34C759` | `#30D158` | iOS system green — presence dot |
| `--ping` | `#FF3B30` | `#FF453A` | iOS system red — PING!! attention color |
| `--red` | `#C83C3C` | (same) | Averrow brand red — shared with launcher icon, exposed for any custom UI |
| `--text` | `#000000` | `#FFFFFF` | Pinned explicitly so Konsta can't be overridden by OS dark-mode defaults |
| `--text-dim` | `#6E6E73` | `#98989F` | iOS systemGray scale — timestamps, secondary text |
| `--bubble-them` | `#E5E5EA` | `#2C2C2E` | Konsta's incoming-bubble color, pinned for animations that need it |

### Typography

- **Display / body:** Outfit (variable weight)
- **Monospace:** JetBrains Mono — used for PINs, sequence numbers, technical UI
- **PIN rendering:** Always mono, uppercase, letter-spaced, formatted as `XXXX·XXXX`

### Voice and tone

Minimal. Confident. No emoji bloat. Short labels. "Send" not "Send Message." "PIN" not "User ID."

---

## 4. v0 Scope (Session 1–5 ship target)

1. **Google OAuth** sign-in (no phone, no password, no email magic link)
2. PIN generation (8-char Crockford base32, excludes I/L/O/U) on first sign-in
3. Add contact by PIN
4. Create 1:1 chat (deterministic ID — find-or-create is idempotent)
5. WebSocket send/receive text messages
6. **D** (Delivered) and **R** (Read) receipts — **with offline backfill** (D fires when the recipient comes back online, not only when both are online)
7. Typing indicator
8. **PING!!** nudge
9. Message **recall** (sender removes a sent message)
10. Message **edit** (sender corrects a sent message; shows "edited" tag)
11. Display name + status message + avatar (Google profile photo URL on v0)
12. Mobile-first React PWA

### Out of v0 scope (saved for v1+)

- libsodium end-to-end encryption
- Multi-device support
- Group chats (schema is ready; UI deferred)
- Broadcast lists
- Media (images, voice notes, files) via R2
- Self-uploaded avatars to R2
- Stickers
- BBM Voice / Video (WebRTC signaling)
- Push notifications (Web Push, then APNs / FCM)
- QR-code add-contact

---

## 5. Information Architecture

```
SignIn ──[Google OAuth]──▶ Onboarding (first-time only: PIN reveal, edit display name)
                                  │
                                  ▼
                          Chats list ─── ⊕ ──► AddContact
                            │                    │
                            │                    ▼
                            │              (back to Chats list)
                            ▼
                          Chat view
                            │
                            ├── ⋮ menu → Contact info / Block / Mute
                            ├── long-press on own msg → Recall / Edit / Copy
                            └── ← back to Chats list

Settings (top-right gear from Chats list)
  ├── My profile (display name, status, avatar)
  ├── My PIN (copy, show QR — v1)
  └── Sign out
```

---

## 6. Wireframes (mobile-first, 390px target)

### 6.1 Sign in

```
┌────────────────────────────┐
│                            │
│         RELAY              │
│                            │
│  ┌──────────────────────┐ │
│  │ ▸ Continue with Google│ │   ← single big button
│  └──────────────────────┘ │
│                            │
│  ─────────────────         │
│                            │
│  No phone number.          │
│  No tracking.              │
│  Just a PIN.               │
│                            │
└────────────────────────────┘
```

### 6.2 Onboarding — PIN reveal (first sign-in only)

```
┌────────────────────────────┐
│                            │
│         RELAY              │
│                            │
│   Your PIN is ready.       │
│                            │
│   ┌──────────────────┐    │
│   │  7K2A · 9XQM     │    │   ← mono, large, letter-spaced
│   └──────────────────┘    │
│                            │
│   Share it. Memorize it.   │
│   This is who you are      │
│   on Relay.                │
│                            │
│   ┌──────────────────┐    │
│   │   Copy PIN       │    │
│   └──────────────────┘    │
│                            │
│   [Continue →]             │
└────────────────────────────┘
```

### 6.3 Chats list (home)

```
┌────────────────────────────┐
│ RELAY            ⊕   ⚙     │
│ ─────────────────────────  │
│ Your PIN: 7K2A·9XQM    📋  │
│                            │
│ ● Banx          2:14 PM    │
│   hey, you up?        D R  │
│ ─────────────────────────  │
│ ○ Matthew       11:02 AM   │
│   sent a PING!!       D    │
│ ─────────────────────────  │
│ ○ Daniel        Yesterday  │
│   barn 4 check at 6...  R  │
│                            │
└────────────────────────────┘
```

Filled green dot = online. Hollow dot = offline. The list is driven by the user's **UserHub** WebSocket emitting `preview` events.

### 6.4 Chat view (the money screen)

```
┌────────────────────────────┐
│ ← Banx                  ⋮  │
│   7K2A·9XQM       ● online │
│ ─────────────────────────  │
│                            │
│  ┌─────────────────────┐   │
│  │ hey, you up?        │   │   ← incoming (left, --surface)
│  │ 2:14 PM             │   │
│  └─────────────────────┘   │
│                            │
│         ┌────────────────┐ │
│         │ yeah just in   │ │   ← outgoing (right, accent tint)
│         │ 2:15 PM  edited│ │   ← shows when edited
│         │           D R  │ │
│         └────────────────┘ │
│                            │
│         ┌────────────────┐ │
│         │ ⚡ PING!!      │ │   ← PING shows as orange chip
│         │ 2:15 PM    D   │ │
│         └────────────────┘ │
│                            │
│  Banx is composing···      │
│                            │
│ ─────────────────────────  │
│ ┌──────────────────┬─┬──┐ │
│ │ Type a message   │⚡│➤│ │   ← PING button + send
│ └──────────────────┴─┴──┘ │
└────────────────────────────┘
```

### 6.5 Long-press menu (own message)

```
         ┌────────────────────┐
         │  Copy text         │
         │  Edit              │
         │  Recall            │
         │  ─────────────     │
         │  Cancel            │
         └────────────────────┘
```

Recalled messages render in place as a dim italic line: *"Message recalled"* — same in sender and recipient UI.

### 6.6 Add contact by PIN

```
┌────────────────────────────┐
│ ← Add contact              │
│ ─────────────────────────  │
│                            │
│  Enter their PIN           │
│  ┌──────────────────┐     │
│  │ ____ · ____      │     │
│  └──────────────────┘     │
│                            │
│  ──── or ────              │
│                            │
│  ┌──────────────────┐     │
│  │  📷  Scan QR     │     │   ← v1
│  └──────────────────┘     │
│                            │
│  [Find →]                  │
└────────────────────────────┘
```

PIN input strips the middle dot before sending; API accepts unformatted PIN only.

---

## 7. D1 Schema

```sql
-- packages/relay-worker/src/schema.sql

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  google_sub TEXT UNIQUE NOT NULL,
  email TEXT UNIQUE NOT NULL,
  pin TEXT UNIQUE NOT NULL,
  display_name TEXT NOT NULL,
  status_message TEXT,
  avatar_url TEXT,              -- external URL (Google photo) in v0
  avatar_r2_key TEXT,           -- self-uploaded; v1
  created_at INTEGER NOT NULL,
  last_seen_at INTEGER
);
CREATE INDEX idx_users_pin ON users(pin);
CREATE INDEX idx_users_google_sub ON users(google_sub);

CREATE TABLE sessions (
  jwt_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL,
  expires_at INTEGER NOT NULL,
  revoked INTEGER DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);

CREATE TABLE contacts (
  owner_id TEXT NOT NULL REFERENCES users(id),
  contact_id TEXT NOT NULL REFERENCES users(id),
  alias TEXT,
  category TEXT,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (owner_id, contact_id)
);
CREATE INDEX idx_contacts_owner ON contacts(owner_id);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,                       -- same string used as DO name
  type TEXT NOT NULL CHECK(type IN ('1to1','group')),
  subject TEXT,
  created_by TEXT NOT NULL REFERENCES users(id),
  created_at INTEGER NOT NULL
);

CREATE TABLE chat_participants (
  chat_id TEXT NOT NULL REFERENCES chats(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (chat_id, user_id)
);
CREATE INDEX idx_participants_user ON chat_participants(user_id);

CREATE TABLE messages (
  id TEXT PRIMARY KEY,
  chat_id TEXT NOT NULL REFERENCES chats(id),
  sender_id TEXT NOT NULL REFERENCES users(id),
  sequence INTEGER NOT NULL,
  message_type TEXT NOT NULL CHECK(message_type IN ('text','image','voice','ping','system')),
  body TEXT,                                 -- nullable: ping/system have no body
  media_r2_key TEXT,
  created_at INTEGER NOT NULL,
  edited_at INTEGER,
  deleted_at INTEGER                         -- soft delete for recall
);
CREATE UNIQUE INDEX idx_messages_chat_seq ON messages(chat_id, sequence);

CREATE TABLE receipts (
  message_id TEXT NOT NULL REFERENCES messages(id),
  recipient_id TEXT NOT NULL REFERENCES users(id),
  delivered_at INTEGER,                       -- NULL until recipient comes online
  read_at INTEGER,                            -- NULL until recipient opens chat
  PRIMARY KEY (message_id, recipient_id)
);
CREATE INDEX idx_receipts_recipient ON receipts(recipient_id, read_at);
CREATE INDEX idx_receipts_undelivered ON receipts(recipient_id, delivered_at) WHERE delivered_at IS NULL;

CREATE TABLE outbound_events (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  kind TEXT NOT NULL CHECK(kind IN ('delivered','read','message_preview','presence','ping','invite')),
  payload TEXT NOT NULL,                      -- JSON
  created_at INTEGER NOT NULL,
  consumed INTEGER DEFAULT 0
);
CREATE INDEX idx_outbound_user_pending ON outbound_events(user_id, consumed, created_at);
```

**Schema verification rule:** Before writing any SQL that references columns, always run `PRAGMA table_info(<table>)` first. Never select non-existent columns. This rule carries to every session.

**Why `outbound_events`?** When `ChatRoom` needs to tell the **sender's** `UserHub` "your message was just delivered to recipient X" (so the sender's UI lights up its "D"), the sender may not be connected right now either. We persist the event in D1; the sender's `UserHub` drains the table on next WebSocket connect. This is the single mechanism that makes D/R offline-correct.

---

## 8. Durable Objects

Relay uses **two** Durable Object classes, both built on the **Hibernation API** (`state.acceptWebSocket()` + `webSocketMessage` / `webSocketClose` / `webSocketError`). Hibernation cuts idle billed duration to near zero — see Cloudflare's *Rules of Durable Objects* (Dec 2025).

### 8.1 `UserHub(userId)` — the user's primary socket

One per user. The client opens one WebSocket here on app load and keeps it open across screens (chats list, chat view, profile, anywhere). Everything the user needs to see — incoming messages, D/R deltas for messages they sent, presence changes for their contacts, PINGs, typing, invites — arrives on this socket.

```typescript
// packages/relay-worker/src/do/user-hub.ts

interface Attachment {
  userId: string;
  jti: string;
  subscribedChats: string[]; // chats they've asked to receive typing/presence for
}

export class UserHub implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // RPC entrypoint — other DOs call us here
    if (url.pathname === '/notify') {
      const event = await request.json<OutboundEvent>();
      await this.deliverOrQueue(event);
      return new Response(null, { status: 204 });
    }

    if (url.pathname === '/ws') {
      const userId = await this.authenticate(request);
      if (!userId) return new Response('unauthorized', { status: 401 });

      const pair = new WebSocketPair();
      const server = pair[1];
      this.state.acceptWebSocket(server);
      server.serializeAttachment({ userId, jti: '...', subscribedChats: [] });

      // drain any queued events for this user
      await this.drainOutbound(userId, server);

      // mark presence + broadcast to contacts
      await this.markOnline(userId);

      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    return new Response('not found', { status: 404 });
  }

  async webSocketMessage(ws: WebSocket, msg: string | ArrayBuffer) {
    const { userId } = ws.deserializeAttachment() as Attachment;
    let cmd: ClientMsg;
    try { cmd = JSON.parse(msg as string); }
    catch { return this.sendError(ws, 'bad_json'); }

    if (!this.checkRate(userId, cmd.t)) return this.sendError(ws, 'rate_limited');

    switch (cmd.t) {
      case 'send':        return this.routeSend(userId, cmd);
      case 'typing':      return this.routeToChatRoom(cmd.chatId, { ...cmd, from: userId });
      case 'read':        return this.routeToChatRoom(cmd.chatId, { ...cmd, from: userId });
      case 'ping':        return this.routeToChatRoom(cmd.chatId, { ...cmd, from: userId });
      case 'recall':      return this.routeRecall(userId, cmd);
      case 'edit':        return this.routeEdit(userId, cmd);
      case 'subscribe':   return this.subscribe(ws, cmd.chatId);
      case 'unsubscribe': return this.unsubscribe(ws, cmd.chatId);
      default:            return this.sendError(ws, 'unknown_type');
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, wasClean: boolean) {
    const { userId } = ws.deserializeAttachment() as Attachment;
    if (this.state.getWebSockets().length === 0) await this.markOffline(userId);
  }

  // ... routeSend → env.CHAT_ROOM.idFromName(chatId) → stub.fetch('/persist', ...)
  // ... drainOutbound → SELECT outbound_events WHERE user_id=? AND consumed=0
  //                     emit each to ws, UPDATE consumed=1
  // ... deliverOrQueue → if any open ws → send + mark delivered_at + ack to sender's UserHub
  //                      else → INSERT into outbound_events
}
```

Heartbeat: `state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('p', 'pong'))` — the runtime handles ping/pong without waking the DO.

### 8.2 `ChatRoom(chatId)` — message persistence & fan-out

One per chat. Has **no client WebSockets** — clients never connect directly. Only other DOs (UserHubs) and HTTP routes talk to it via `stub.fetch('/persist' | '/typing' | '/read' | '/ping' | '/recall' | '/edit')`. This keeps the DO eligible for hibernation between writes.

```typescript
// packages/relay-worker/src/do/chat-room.ts

export class ChatRoom implements DurableObject {
  constructor(private state: DurableObjectState, private env: Env) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case '/persist': return this.persist(await request.json());
      case '/typing':  return this.fanoutTyping(await request.json());
      case '/read':    return this.markRead(await request.json());
      case '/ping':    return this.fanoutPing(await request.json());
      case '/recall':  return this.recall(await request.json());
      case '/edit':    return this.edit(await request.json());
    }
    return new Response('not found', { status: 404 });
  }

  private async persist(input: { senderId: string; tempId: string; type: string; body: string | null }) {
    const seq = (await this.state.storage.get<number>('seq') ?? 0) + 1;
    await this.state.storage.put('seq', seq);

    const id = crypto.randomUUID();
    const now = Date.now();
    const chatId = this.state.id.toString();

    // 1. insert message
    await this.env.DB.prepare(
      `INSERT INTO messages (id, chat_id, sender_id, sequence, message_type, body, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, chatId, input.senderId, seq, input.type, input.body, now).run();

    // 2. insert receipts row per recipient (delivered_at = NULL)
    const recipients = await this.recipientIds(chatId, input.senderId);
    if (recipients.length > 0) {
      const stmt = this.env.DB.prepare(
        `INSERT INTO receipts (message_id, recipient_id) VALUES (?, ?)`
      );
      await this.env.DB.batch(recipients.map(rid => stmt.bind(id, rid)));
    }

    // 3. fan-out: notify each recipient's UserHub
    const payload = { t: 'message', id, chatId, from: input.senderId, sequence: seq,
                      type: input.type, body: input.body, ts: now };
    await Promise.all(recipients.map(rid =>
      this.notifyUser(rid, payload)
    ));

    // 4. ack the sender
    return new Response(JSON.stringify({ messageId: id, sequence: seq, ts: now }), {
      headers: { 'content-type': 'application/json' },
    });
  }

  private async notifyUser(userId: string, event: any) {
    const stub = this.env.USER_HUB.get(this.env.USER_HUB.idFromName(userId));
    await stub.fetch('https://do/notify', {
      method: 'POST',
      body: JSON.stringify({ userId, kind: event.t, payload: event, ts: Date.now() }),
    });
  }
}
```

### 8.3 Binding rule (locked)

> **One ChatRoom DO per chat.** Its name is the literal `chats.id` string. Look it up via `env.CHAT_ROOM.idFromName(chats.id)`. **One UserHub DO per user.** Its name is the literal `users.id` string. Look it up via `env.USER_HUB.idFromName(users.id)`.

For 1:1 chats, `chats.id` is generated deterministically from the sorted pair of user IDs so creation is idempotent:

```
chats.id = "1to1:" + [userA.id, userB.id].sort().join(":")
```

For groups (v1), `chats.id = "g:" + crypto.randomUUID()`.

### 8.4 Offline D/R backfill (this is the BBM-correctness mechanism)

**At send:** ChatRoom writes `receipts(delivered_at=NULL, read_at=NULL)` for every recipient.

**Recipient online at send time:** Their UserHub's `/notify` call delivers the message to their socket, updates `receipts.delivered_at = now`, and POSTs a `delivered` event back to the **sender's** UserHub (which forwards to the sender's socket, lighting up the "D").

**Recipient offline at send time:** UserHub's `/notify` finds no open WebSocket → INSERT into `outbound_events(user_id=recipient, kind='message_preview', payload=...)`. When the recipient eventually opens the app and their UserHub `/ws` upgrades, `drainOutbound` SELECTs all `outbound_events WHERE consumed=0`, emits them in `created_at` order, UPDATEs `consumed=1`, and for each `message_preview` it also bumps `receipts.delivered_at = now` and writes a `delivered` event into the **sender's** `outbound_events` (sender may also be offline). Net effect: D arrives correctly on the first moment both have been online, in either order.

Read receipts use the same path on `read` commands; no backfill needed because reading requires explicit user attention.

---

## 9. WebSocket Protocol

A single WebSocket per user, terminating at `UserHub`. URL: `wss://relay-api.averrow.com/ws` (auth via session cookie on upgrade; same origin, so the cookie travels automatically).

### 9.1 Client → Server

| Type | Payload | Purpose |
|---|---|---|
| `send` | `{ tempId, chatId, type, body }` | Send a message (`type`: `text` \| `ping`) |
| `typing` | `{ chatId, on }` | Start/stop typing indicator |
| `read` | `{ chatId, messageIds }` | Mark messages as read (max 200 ids) |
| `ping` | `{ chatId }` | BBM-style PING!! nudge |
| `recall` | `{ messageId }` | Recall own message (soft delete) |
| `edit` | `{ messageId, body }` | Edit own message |
| `subscribe` | `{ chatId }` | Receive `typing`/`presence` for this chat |
| `unsubscribe` | `{ chatId }` | Stop receiving for this chat |

### 9.2 Server → Client

| Type | Payload | Purpose |
|---|---|---|
| `ack` | `{ tempId, messageId, sequence, chatId, ts }` | Send confirmed |
| `message` | `{ id, chatId, from, sequence, type, body, ts }` | Incoming message |
| `delivered` | `{ messageId, chatId, userId, ts }` | A recipient received it |
| `read` | `{ messageId, chatId, userId, ts }` | A recipient read it |
| `typing` | `{ chatId, userId, on }` | Someone typing |
| `presence` | `{ userId, online, lastSeen }` | Contact online/offline change |
| `ping` | `{ chatId, from, ts }` | Incoming PING!! |
| `recalled` | `{ messageId, chatId, ts }` | A message was recalled |
| `edited` | `{ messageId, chatId, body, editedAt }` | A message was edited |
| `preview` | `{ chatId, lastMessage, unreadCount }` | Chats-list row updated |
| `error` | `{ code, message }` | Protocol or auth error |

### 9.3 Error code taxonomy (locked)

`bad_json` · `unknown_type` · `unauthorized` · `rate_limited` · `not_in_chat` · `payload_too_large` · `chat_not_found` · `message_not_found` · `cannot_edit` · `cannot_recall`

### 9.4 Rate limits (per UserHub, in-memory token bucket)

| Command | Limit |
|---|---|
| `send` | 30/min |
| `typing` | 10/sec |
| `ping` | 6/min |
| `read` | 5/sec, ≤200 ids per call |
| `recall`/`edit` | 10/min |

Buckets reset on DO eviction (acceptable — rates are anti-spam, not security).

### 9.5 Message constraints

- `body` length ≤ 2000 characters (validated server-side; `payload_too_large` if exceeded)
- `edit` only allowed by the original sender, only on messages younger than **15 minutes**, only on `type='text'`
- `recall` only allowed by the original sender, only on messages younger than **24 hours**

---

## 10. Repo Layout

```
relay/
├── packages/
│   ├── relay-worker/
│   │   ├── src/
│   │   │   ├── index.ts           # Hono router, WS upgrade
│   │   │   ├── auth.ts            # Google OAuth handlers, session cookie issue/verify
│   │   │   ├── pin.ts             # Crockford base32 generator
│   │   │   ├── contacts.ts        # add by PIN, list
│   │   │   ├── chats.ts           # create 1:1, list, deterministic IDs
│   │   │   ├── do/
│   │   │   │   ├── chat-room.ts   # ChatRoom DO
│   │   │   │   └── user-hub.ts    # UserHub DO
│   │   │   ├── lib/
│   │   │   │   ├── jwt.ts
│   │   │   │   ├── google-oauth.ts
│   │   │   │   ├── rate-limit.ts
│   │   │   │   └── outbound.ts    # outbound_events helpers
│   │   │   └── schema.sql
│   │   ├── wrangler.toml
│   │   └── package.json
│   └── relay-ui/
│       ├── src/
│       │   ├── App.tsx
│       │   ├── routes/
│       │   │   ├── SignIn.tsx
│       │   │   ├── Onboarding.tsx
│       │   │   ├── Chats.tsx
│       │   │   ├── Chat.tsx
│       │   │   ├── AddContact.tsx
│       │   │   └── Profile.tsx
│       │   ├── components/
│       │   │   ├── MessageBubble.tsx
│       │   │   ├── Receipt.tsx
│       │   │   ├── PinDisplay.tsx
│       │   │   ├── TypingDots.tsx
│       │   │   ├── PingChip.tsx
│       │   │   └── LongPressMenu.tsx
│       │   ├── lib/
│       │   │   ├── ws.ts          # UserHub WebSocket client, reconnect, event router
│       │   │   ├── api.ts         # fetch wrapper (cookie auth, credentials: 'include')
│       │   │   └── format.ts      # PIN formatting, relative timestamps
│       │   └── styles/
│       │       └── tokens.css
│       ├── vite.config.ts
│       └── package.json
├── turbo.json
└── package.json
```

---

## 11. Five-Session Build Plan

| # | Session | Output |
|---|---|---|
| 1 | **Foundation + Google Auth** | Turborepo (Worker + UI stub), Hono router, D1 schema applied, `@hono/oauth-providers/google` wired end-to-end, session cookie issued, `GET /me` + `PATCH /me`, PIN generation, README documents local setup |
| 2 | **Contacts + Chats** | `POST /contacts/add` (by PIN), `GET /contacts` (with `last_seen_at`), `POST /chats/1to1` (deterministic ID, find-or-create), `GET /chats` (preview + unread count), `outbound_events` helpers |
| 3 | **Realtime: UserHub + ChatRoom** | Both DOs on Hibernation API, single `/ws` endpoint on UserHub, all client→server commands wired, **offline D/R backfill via `outbound_events` drain on connect**, rate limiting, full error taxonomy |
| 4 | **React PWA** | Vite + React + React Router v7, all 6 routes, all components, `ws.ts` client with exponential-backoff reconnect, design tokens locked, recall/edit long-press menu |
| 5 | **Polish + deploy** | PING shake CSS animation, typing dots, recalled/edited tags, PWA manifest + SW, Cloudflare Pages deploy to `relay.averrow.com`, Worker route on `relay-api.averrow.com`, two-device smoke test |

**Critical rule:** start a fresh Claude Code session for each phase. Long sessions cause context drift.

---

## 12. Session 1 — Claude Code Prompt (paste-ready)

```
# RELAY — SESSION 1: FOUNDATION + GOOGLE AUTH

You are building Relay, a BBM-inspired messenger.
Stack: Cloudflare Workers (Hono) + D1 + Durable Objects + R2,
React PWA frontend, Turborepo monorepo.

## CODING STANDARD: DIAGNOSE FIRST
For every step:
  1. DIAGNOSE — read current state, print what exists
  2. IDENTIFY ROOT CAUSE / requirement
  3. FIX — implement correctly the first time
No blind fixes. No bandaids. Solve correctly.

## SESSION 1 GOALS (do not exceed scope)

1. Initialize Turborepo with two packages: relay-worker, relay-ui
   (relay-ui may be a stub package.json + empty src this session;
    full UI is Session 4)

2. relay-worker: Hono router, wrangler.toml configured for D1 +
   DO bindings (CHAT_ROOM and USER_HUB classes stubbed only —
   their fetch returns 501)

3. Apply D1 schema (see SCHEMA section below) via
   `wrangler d1 execute relay-db --local --file=src/schema.sql`
   and document the remote-apply command in README.

4. Implement Google OAuth via @hono/oauth-providers/google:
     GET  /auth/google            → 302 to Google consent
     GET  /auth/google/callback   → exchange code, find-or-create user,
                                    issue session cookie, redirect to APP_URL
     POST /auth/signout           → revoke jti, clear cookie
     GET  /me                     → return { id, pin, displayName,
                                              statusMessage, avatarUrl, email }
     PATCH /me                    → update displayName / statusMessage

5. Session cookie:
   - HS256 JWT (env: JWT_SECRET)
   - jti = crypto.randomUUID(), stored in sessions table
   - 30-day expiry
   - Cookie: HttpOnly, Secure, SameSite=Lax, Domain=AUTH_COOKIE_DOMAIN
     (unset in dev), Path=/
   - Verify on every request: signature → jti exists in sessions →
     not revoked → not expired

6. PIN generation (first sign-in only):
   - 8-char Crockford base32
   - Alphabet: 0123456789ABCDEFGHJKMNPQRSTVWXYZ (excludes I, L, O, U)
   - Generated via crypto.getRandomValues, NOT Math.random
   - Stored unformatted in DB (e.g., "7K2A9XQM")
   - Returned to client unformatted; client formats as XXXX·XXXX
   - Collision-retry on insert (max 5 attempts, then 500)

7. Env vars (wrangler.toml + .dev.vars):
   - GOOGLE_ID, GOOGLE_SECRET — Google OAuth client (Web app)
   - JWT_SECRET — HS256 signing key (32+ bytes, random)
   - APP_URL — http://localhost:5173 (dev) / https://relay.averrow.com (prod)
   - AUTH_COOKIE_DOMAIN — unset (dev) / .averrow.com (prod)

8. Google Cloud Console setup (document in README):
   - Create OAuth 2.0 Client ID (Web application)
   - Authorized redirect URIs:
       http://localhost:8787/auth/google/callback
       https://relay-api.averrow.com/auth/google/callback
   - Consent screen: app name "Relay", scopes openid/email/profile

## D1 SCHEMA

[Paste the schema block from section 7 of this spec — both
 tables and indexes. There are 8 tables: users, sessions,
 contacts, chats, chat_participants, messages, receipts,
 outbound_events. Do NOT create auth_emails or auth_tokens —
 those tables do not exist in v2.]

## ACCEPTANCE CRITERIA

- `wrangler dev` runs cleanly with zero TypeScript errors
- Visiting http://localhost:8787/auth/google redirects to Google
- After Google consent, callback issues a session cookie and
  redirects to APP_URL/onboarding (first sign-in) or APP_URL/chats
- `curl localhost:8787/me -b "session=<cookie>"` returns the user
  object with an 8-char PIN
- `wrangler d1 execute relay-db --local --command "SELECT pin, email FROM users"`
  shows generated PINs and Google emails
- All TypeScript strict, NO `any` without an inline justification
  comment (this applies to DO message handlers too — define
  discriminated unions ClientMsg / ServerMsg now)
- README documents: env vars, Google Cloud setup, local D1
  apply command, four auth endpoints, the cookie contract

## OUT OF SCOPE FOR THIS SESSION

- WebSockets / DO implementation beyond stubs (Session 3)
- Contacts / chats endpoints (Session 2)
- React UI (Session 4)
- Encryption (v1)
- Push notifications (v1)

## BEGIN

Step 1: DIAGNOSE — view the current state of the working
directory. Print what exists. Then propose the file structure
you will create.
```

---

## 13. Session 2–5 — Goal Sketches

Use these only as the *next* session begins. Write the full prompt fresh each time, in the same DIAGNOSE → IDENTIFY → FIX style as Session 1.

### Session 2 — Contacts + Chats

- `POST /contacts/add` `{ pin }` — look up user by PIN, create mutual contact entries in one transaction
- `GET /contacts` — list with online/offline derived from `last_seen_at` (online if `last_seen_at > now - 60s`)
- `POST /chats/1to1` `{ contactId }` — compute `chats.id = "1to1:" + sorted-pair`, find-or-create idempotently, also insert two `chat_participants` rows
- `GET /chats` — list user's chats with last message preview, unread count (`COUNT(receipts WHERE recipient=me AND read_at IS NULL`), last activity
- Implement `outbound_events` insert/drain helpers in `lib/outbound.ts`

### Session 3 — UserHub + ChatRoom + WebSockets

- Implement both DOs on the Hibernation API (see §8)
- Single WS endpoint: `GET /ws` → upgrades to UserHub via cookie auth
- ChatRoom is HTTP-only (no client WS); UserHub calls it via `stub.fetch`
- All client commands: `send`/`typing`/`read`/`ping`/`recall`/`edit`/`subscribe`/`unsubscribe`
- Offline D/R backfill: `drainOutbound(userId)` on connect (SELECT/UPDATE in batch)
- Rate limits (§9.4) via in-memory token bucket on UserHub
- Error taxonomy (§9.3) wired everywhere
- Heartbeat via `setWebSocketAutoResponse('p','pong')`
- `recall`: UPDATE messages SET deleted_at = now WHERE id = ? AND sender_id = self AND created_at > now - 24h
- `edit`: UPDATE messages SET body = ?, edited_at = now WHERE id = ? AND sender_id = self AND created_at > now - 15m AND message_type = 'text'

### Session 4 — React UI

- Vite + React + TypeScript + React Router v7
- Routes: `/signin`, `/onboarding`, `/chats`, `/chats/:id`, `/add-contact`, `/profile`
- All API calls use `credentials: 'include'` for cookie auth
- Design tokens in `styles/tokens.css` per §3
- Components: MessageBubble (variants: text, ping, recalled, edited), Receipt (D/R glyphs), PinDisplay, TypingDots, PingChip, LongPressMenu
- WebSocket client in `lib/ws.ts`:
  - Single instance, opens on app mount, closes on signout
  - Exponential-backoff reconnect (1s, 2s, 4s, 8s, max 30s)
  - Event router: `dispatch(event)` → store update via Zustand or React context
  - Outbound queue when not connected (held in memory)
- Mobile-first; fluid widths; minimum 44×44px touch targets
- Test on Pixel 9 Pro XL viewport (412 × 915 CSS px)

### Session 5 — Polish + Deploy

- PING shake animation: CSS `@keyframes` on incoming PING bubble + ~600ms
- Typing dots: 3-dot pulse animation, dimmed
- "edited" and "recalled" affordances in MessageBubble
- PWA manifest: name, short_name, icons (192, 512, maskable), theme_color = `#0A0A0E`, background_color = `#0A0A0E`
- Service worker: cache shell, network-first for API
- Favicon, splash, og:image
- Deploy Worker to `relay-api.averrow.com` via `wrangler deploy`
- Deploy UI to `relay.averrow.com` via Cloudflare Pages
- Smoke test: two devices (or one device + incognito), full BBM conversation including offline D backfill (sign out one side, send messages, sign back in, verify D lights up)

---

## 14. Deployment & DNS

### Domains

| Surface | URL | Cloudflare resource |
|---|---|---|
| Web UI (PWA) | `https://relay.averrow.com` | Cloudflare Pages project `relay-ui` |
| API + WS | `https://relay-api.averrow.com` | Cloudflare Worker `relay-worker` |

### DNS records (averrow.com zone)

- `relay` — CNAME → Pages project hostname (set automatically by Pages on custom-domain bind)
- `relay-api` — proxied to the Worker via the route binding below (no separate DNS record)

### Worker route binding (`wrangler.toml`)

```toml
[[routes]]
pattern = "relay-api.averrow.com/*"
zone_name = "averrow.com"
```

### CORS

`relay-api.averrow.com` allows origin `https://relay.averrow.com` only in production.
Local dev allows `http://localhost:5173` and `http://localhost:8787`.
For LAN testing of the PWA on a real phone, dev mode additionally allows `http://192.168.*` and `http://10.*` (regex-matched, dev-only).
No wildcard CORS, ever.

All cross-origin requests use `credentials: 'include'` so the session cookie travels. WS upgrade is same-origin (no CORS needed).

### Google Cloud Console setup

- Project: `relay-prod` (and `relay-dev`)
- OAuth Consent Screen: External, app name "Relay", logo (192×192 maskable), support email, scopes `openid email profile`
- OAuth 2.0 Client ID — Web application
- Authorized redirect URIs:
  - `https://relay-api.averrow.com/auth/google/callback`
  - `http://localhost:8787/auth/google/callback`
- Drop client_id / client_secret into Wrangler secrets:
  - `wrangler secret put GOOGLE_ID` / `GOOGLE_SECRET` / `JWT_SECRET`

### Brand isolation from Averrow proper

- Relay shares the averrow.com **zone** for DNS convenience and Cloudflare account simplicity, but is a **separate product surface**
- No shared D1 database. Relay gets its own D1 (`relay-db`).
- No shared user table. Averrow auth ≠ Relay auth.
- No shared design system. Averrow's primary accent is Afterburner Amber (#E5A832); Relay's launcher icon uses Averrow's red (#C83C3C) for family resemblance but the in-app chrome uses iOS-native system blue via Konsta — a messenger needs to feel native, not branded.
- Footer on `relay.averrow.com` says "from LRX Enterprises" — keeps the option open to split to `getrelay.app` without rebrand.

---

## 15. Trademark / IP Safety Notes

- Do **not** use "BBM", "BlackBerry Messenger", or BlackBerry's logos anywhere
- "PIN" as a term is generic — safe to use
- "Relay" as a brand — clear of major messenger trademarks; verify with a Canadian trademark search before serious investment
- Pre-2010 delivery-receipt patents have largely expired; modern variants are held by Malikie Innovations (former BlackBerry portfolio)
- Functional UX patterns (D/R receipts, typing indicators, group chat, broadcast) are not protectable; specific visual treatments may be — design fresh

---

## 16. v1+ Roadmap (concrete epics, not just bullets)

| Epic | Sketch |
|---|---|
| **E1: Groups** | Reuse `chats.type='group'`; add `/chats/group` create endpoint; participant invite/leave flow; group avatar; group D coloring (gray-D = some / orange-D = all, per receipts aggregate) |
| **E2: Media** | R2 bucket `relay-media`; `POST /media/upload` returns presigned PUT; client uploads; message body carries `media_r2_key`; image/voice/file rendering in MessageBubble |
| **E3: Stickers** | R2-hosted sticker packs; `GET /stickers/packs`; new `message_type='sticker'` (schema change required); sticker picker in input bar |
| **E4: BBM Voice/Video** | WebRTC; ChatRoom DO acts as signaling channel for ICE/SDP exchange; TURN via Cloudflare Calls API |
| **E5: E2E Encryption** | libsodium-wrappers (X25519 ECDH + XSalsa20-Poly1305), per-chat symmetric key, per-message nonce; server stores ciphertext + AAD only |
| **E6: Multi-device** | Per-device keypair; sender-side fan-out encryption to each recipient device; device list in profile |
| **E7: Push notifications** | Web Push (VAPID) for v1; APNs/FCM gateways for v2 native; `outbound_events` already provides the durable queue |
| **E8: QR add-contact** | `qrcode` for generation, `@zxing/library` for camera scan; payload = PIN |
| **E9: Broadcast lists** | Sender-side fan-out; no group chat semantics; recipients see as 1:1 from sender |
| **E10: Federation** | Long-term moonshot — Matrix-style federation; consider after E1–E7 land |

---

## 17. BBM Feature Parity Matrix

| BBM Consumer feature | v0 | v1+ | Notes |
|---|---|---|---|
| PIN identity (8-char Crockford base32) | ✅ | | |
| D / R receipts with **offline backfill** | ✅ | | Via `outbound_events` drain |
| PING!! | ✅ | | Shake animation v0; sound v1 |
| Typing indicator | ✅ | | "X is composing···" |
| Status message | ✅ | | Shown under display name |
| Avatar (Google photo URL) | ✅ | | Self-upload deferred to v1 (E2) |
| Display name (editable) | ✅ | | Seeded from Google |
| Message recall (≤24h) | ✅ | | Soft delete |
| Message edit (≤15m, text only) | ✅ | | `edited_at` column |
| 2000-char body cap | ✅ | | API-enforced |
| Contact categories | schema only | UI in v1 | |
| Last-seen | ✅ | | Derived from `last_seen_at` |
| Groups up to 250 | | E1 | Schema is group-ready |
| Group D coloring (some/all) | | E1 | |
| Broadcast lists | | E9 | |
| BBM Channels | | ❌ | Out of roadmap |
| BBM Voice (audio) | | E4 | |
| BBM Video | | E4 | |
| Stickers | | E3 | |
| Pictures/files/voice notes | | E2 | |
| Real-time location share | | ❌ | Out of scope |
| End-to-end encryption | | E5 | |
| QR add-contact | | E8 | |
| Push notifications | | E7 | |

---

## 18. Operational Concerns

### 18.1 Observability

- Workers Logs enabled in production (`[observability] enabled = true` in `wrangler.toml`)
- `wrangler tail relay-worker` for live local debugging
- Per-route latency emitted via `console.log` with structured JSON (Workers Logs auto-parses)
- DO storage size monitored via Cloudflare dashboard alerts (per chat: shouldn't grow beyond `seq` counter + ~few KB)

### 18.2 CI

GitHub Actions on push + PR:
- `pnpm install --frozen-lockfile`
- `pnpm -r typecheck` (`tsc --noEmit` in each package)
- `pnpm -r test` (Vitest in `relay-worker` using `@cloudflare/vitest-pool-workers`)
- `pnpm -r build`
- `wrangler deploy --dry-run` in `relay-worker` (config sanity)

### 18.3 Pinned versions

- Node: **20.x LTS** (pinned via `.nvmrc` and `"engines.node": "^20"`)
- pnpm: **9.x**
- Wrangler: **^4** (latest at v0 time)
- Hono: **^4**

### 18.4 Local development

- `pnpm dev` runs `wrangler dev` + Vite concurrently via Turbo
- Worker on `http://localhost:8787`, UI on `http://localhost:5173`
- D1 local sqlite at `.wrangler/state/v3/d1`
- For Google OAuth locally, use a *separate* Google Cloud OAuth client (`relay-dev`) so prod secrets never appear in `.dev.vars`

### 18.5 Secrets management

- Production secrets via `wrangler secret put`
- Local dev secrets in `.dev.vars` (gitignored)
- Rotation: `JWT_SECRET` rotation invalidates all sessions — acceptable; do at most quarterly. `GOOGLE_SECRET` rotation requires no app change.

---

## 19. Research Dossier — BBM Channels (v2+ planning artifact)

> **Status:** Research-only. Not on the v1 roadmap. Captured here so it doesn't get lost when we scope Channels post-E1–E7. The "v1+ Roadmap" table in §16 explicitly marks `BBM Channels` as out-of-roadmap; this section keeps the door open with a sourced product/architecture brief.

### 19.1 What BBM Channels actually was

BlackBerry announced BBM Channels in beta on **May 14, 2013** at BlackBerry Live in Orlando, alongside the news that BBM would go cross-platform to iOS and Android ([Engadget, 14 May 2013](https://www.engadget.com/2013/05/14/blackberry-announces-bbm-channels/)). Open beta landed on BlackBerry 10 and BBOS 5–7.1 in late 2013; iOS and Android shipped with **BBM 2.0 on Feb 13, 2014**, alongside BBM Voice ([TechCrunch, 13 Feb 2014](https://techcrunch.com/2014/02/13/bbm-update-adds-voice-calls-channels-dropbox-and-location-sharing-for-ios-and-android-users/); [Engadget, 13 Feb 2014](https://www.engadget.com/2014-02-13-bbm-channels-and-voice-come-to-android-and-iphone.html)).

BlackBerry positioned Channels as a "social engagement platform within BBM" connecting people to businesses, brands, celebrities, and groups. Message-board-style: hybrid between a Twitter feed (one-to-many broadcast) and a chat room (subscribers could comment and even open 1:1 chats with the owner during published "chat hours").

Both consumers and brands could create channels. Anyone with a BBM account could spin one up via the **BBM Channels Manager** web portal, or in-app on BlackBerry 10. Launch brand partners included Time, Rolling Stone, CNBC, Virgin Atlantic, Coca-Cola, UPS, and Mercedes-Benz ([CrackBerry – BBM Channels hub](https://crackberry.com/bbm-channels); [Wikipedia – BBM (software)](https://en.wikipedia.org/wiki/BBM_(software))).

Content: text posts up to ~400 chars with an optional title and a photo/GIF attachment. Native video posting was **not** a launch feature — videos were linked via URLs. Polls were not first-class.

Discovery: (a) a hand-curated **Featured** carousel; (b) a **Discover** tab with category browsing; (c) **search** by title, description, or Channel PIN. Owners could embed a Channel PIN HTML widget / QR code on their site to pull subscribers in from the open web.

Subscriber interactions: owner-broadcast with two-way comments — *not* pure one-way like Telegram/WhatsApp Channels. Subscribers could **comment** (threaded after a 2014 update), **react/like**, **repost**, and **open a direct 1:1** with the channel owner during the owner's published **chat hours** ([CrackBerry – Set chatting hours, threaded conversations](https://crackberry.com/bbm-channels-updated-set-chatting-hours-threaded-conversations-and-more)). That "broadcast + structured 1:1" combo was BBM Channels' most distinctive design move.

By March 2014: **85M MAU / 113M registered users / ~500,000 channels** ([TechCrunch, 28 Mar 2014](https://techcrunch.com/2014/03/28/bbm-usage/)).

### 19.2 Identity & moderation

**Identity scheme.** User PINs were 8 hex-style chars (e.g., `1234ABCD`). **Channel PINs were prefixed with `C`** (e.g., `C0030899F`), textually disjoint from user PINs ([CrackBerry – Exploring PIN culture](https://crackberry.com/exploring-pin-culture); [forums.crackberry.com](https://forums.crackberry.com/general-bbm-chat-f404/url-bbm-pins-channels-1076886/)). The PIN was the canonical identifier; the channel also had a separate display title and description for search.

**Verification.** A blue-style **verified badge** appeared in the channel profile, search results, and Featured carousel — explicitly modeled after Twitter's blue check. Consistent, high-quality posting was a path to being verified and featured.

**Owner controls.**
- **Multiple admins** via the BBM Channels Manager web portal (added in 2014 after a delayed rollout) — invite contributors by email, accept via BlackBerry ID.
- **Comment moderation:** delete comments, disable commenting per post, or **require approval before publication**.
- **PIN-spam blocking:** an update added auto-block for comments containing PINs/Channel PINs (response to spammers posting their own channel PINs in popular channels — [CrackBerry](https://crackberry.com/bbm-channels-udpated-brings-ability-block-comments-pins)).
- **Scheduled chat hours:** owners published chat windows for 1:1 subscriber DMs.
- **Hootsuite integration** for filtering pending/flagged comments at scale.

**Reporting/abuse.** Users could report channels, posts, or comments. Rules in the [BBM Channels Content Guidelines](https://www.blackberry.com/content/dam/blackberry-com/Documents/pdf/legal/bbm-channels-content-guidelines/BBM_Channels_Content_Guidelines_Polish.pdf) and [BBM Channel Terms](https://www.blackberry.com/us/en/legal/bbm-channel-terms/bbm-channel-terms).

### 19.3 Differentiation from competitors

| Platform | Launch | Direction | Distinctive trait |
|---|---|---|---|
| **BBM Channels** | May 2013 / Feb 2014 (iOS+Android) | Owner broadcast + comments + 1:1 chat hours | PIN-based identity; chat-hours hybrid; verified badge; Hootsuite |
| **Telegram Channels** | Sept 2015 | One-way broadcast + linked discussion group | Unlimited subs, polls, native video, public directory ([Telegram blog](https://telegram.org/blog/channels)) |
| **Discord servers** | 2015 | Many-to-many, role-based | Voice rooms, granular roles, bots |
| **Instagram Broadcast Channels** | Feb 2023 | One-to-many; reactions + polls only | Voice notes, creator-only sending ([Meta](https://about.fb.com/news/2023/02/instagram-broadcast-channels-creators-deepen-connections-with-followers/)) |
| **WhatsApp Channels** | Jun → Sept 2023 (global) | One-to-many broadcast | Hidden PII, emoji reactions; polls/voice added Jan 2024 ([Meta](https://about.fb.com/news/2023/09/whatsapp-channels-global-launch/); [TechCrunch](https://techcrunch.com/2023/09/13/whatsapp-is-launching-its-channels-feature-globally/)) |
| **X/Twitter Communities** | 2021 | Many-to-many, topical | Community-moderated, in-feed |

**Distinct ideas worth resurrecting:**
1. **PIN-as-identity** — keep BBM's pseudonymous identity; you don't need a phone number for the channel handle; QR/widget for offline marketing.
2. **Scheduled chat hours** — bridging broadcast and 1:1 support is unusual then and still rare now. Nobody else built an explicit office-hours UI.
3. **Threaded text comments** — Telegram routes to a linked group; WhatsApp still allows only reactions.
4. **Hootsuite-class owner dashboard** — was unusually mature creator tooling for 2013–14.

**What apparently failed:**
- Late cross-platform launch (Feb 2014); WhatsApp was already at ~450M MAU.
- No native video, no polls — parity gap widened fast.
- Hand-curated Featured rail, no algorithmic trending.
- Bound to a dying host client.

### 19.4 Engagement mechanics

- **Read receipts on posts:** No public per-post indicator (unlike BBM 1:1's D/R). Reach was surfaced via an owner-only analytics dashboard.
- **Push notifications:** New-post pushes for subscribers; comment-reply pushes for owners and threaded participants.
- **Categories/topics:** Self-tagged; surfaced under Discover.
- **Subscriber counts:** Publicly visible on the channel profile.
- **Multiple admins:** Yes (post-2014 web portal feature).
- **Pinned / scheduled posts:** Not a first-class feature (Telegram added both; BBM did not).
- **Reposts:** First-class "repost to my channel" action, promoted as a discovery driver.
- **Threaded comments:** Added 2014 with per-thread notifications.
- **Reactions:** Like-style reactions on posts.

### 19.5 Post-mortem

**Timeline.**
- May 2013: Beta on BlackBerry devices.
- Feb 2014: Cross-platform launch with BBM 2.0 ([TechCrunch](https://techcrunch.com/2014/02/13/bbm-update-adds-voice-calls-channels-dropbox-and-location-sharing-for-ios-and-android-users/)).
- Jun 2016: Indonesia's **Emtek** acquires BBM consumer licensing in a 6-year, $207M deal.
- Jun 27, 2018: Channels and the paid BBM Shop discontinued on BB10/BBOS; alive on Android/iOS under Emtek.
- Apr 18, 2019: Emtek announces full consumer-BBM shutdown for May 31 ([TechCrunch](https://techcrunch.com/2019/04/18/the-consumer-version-of-bbm-is-shutting-down-on-may-31/); [Android Authority](https://www.androidauthority.com/bbm-blackberry-messenger-shuts-down-may-31-977490/)).
- **May 31, 2019:** Consumer BBM (and Channels) goes dark. BBM Enterprise survives as a paid BlackBerry UEM SKU ([CBS NY](https://www.cbsnews.com/newyork/news/blackberry-messenger-shut-down/); [Trusted Reviews](https://www.trustedreviews.com/news/bbm-blackberry-messenger-shut-down-3699034)).

**Why it died (industry consensus):**
- **Platform decline came first, feature dependency second.** BBM lost the messaging war by 2016; Channels inherited its fate.
- **Emtek bloat anti-pattern.** Post-mortems argue the Emtek-era addition of *channels, games, and ads* made BBM feel bloated — the opposite of WhatsApp's deliberate minimalism ([Android Authority](https://www.androidauthority.com/bbm-blackberry-messenger-shuts-down-may-31-977490/); [KitGuru](https://www.kitguru.net/lifestyle/mobile/damien-cox/emtek-is-closing-down-bbm-for-good-as-blackberry-publicly-releases-its-enterprise-messenger/)).
- **Single-country dependency.** By Jan 2018, BBM had 63M MAU concentrated in Indonesia. Emtek couldn't grow beyond it.
- **Feature lag.** No native video / polls / stories → brand spend migrated to Instagram and WhatsApp.

**Lessons for Relay v2+ Channels:**
1. Don't ship Channels until 1:1 + group has product-market fit; Channels rides on existing engagement.
2. Resist "channels + games + ads" bundling. Keep Channels feature-pure.
3. Polls + native video are table stakes today. Don't ship without them.
4. Discovery is the moat — invest in trending/category surfaces, not just a hand-curated Featured rail.
5. The chat-hours bridge between broadcast and 1:1 is an underused idea worth resurrecting.

### 19.6 Adapting to the Relay stack (Workers + D1 + DOs + R2)

**Channel as a Durable Object.** One named DO per channel (`CHANNEL_DO.idFromName(channelId)`) owns:
- post sequencing (monotonic `post_seq` counter in DO storage),
- the subscriber WebSocket fan-out using **Hibernatable WebSockets** so idle channels burn no CPU (one DO holds thousands of sockets — [DO docs](https://developers.cloudflare.com/durable-objects/)),
- moderation state (banned PINs, pending-approval queue),
- the per-channel SQLite store for hot post cache and counters.

Mirrors the per-room DO pattern in Cloudflare's [DO examples](https://developers.cloudflare.com/durable-objects/examples/) and community work like [jw-12138/durable-objects-channel](https://github.com/jw-12138/durable-objects-channel/).

**D1 as system of record.**

```sql
channels(channel_pin PK, owner_pin, title, description, category, verified, created_at)
channel_admins(channel_pin, admin_pin, role)
channel_subscriptions(channel_pin, subscriber_pin, joined_at, muted) -- subscription edge
channel_posts(channel_pin, post_seq, author_pin, body, media_r2_key, created_at, deleted_at)
  -- composite PK (channel_pin, post_seq) aligns with DO sequencer
channel_comments(channel_pin, post_seq, comment_id, parent_comment_id, author_pin, body, status)
  -- status: 'pending' | 'approved' | 'rejected'
channel_reports(target_type, target_id, reporter_pin, reason, created_at)
channel_chat_hours(channel_pin, day_of_week, start_utc, end_utc)
```

Shard by `channel_pin` hash if you outgrow a single D1.

**Fan-out via the existing `outbound_events` queue.** Reuse, don't reinvent. On `POST /channels/{pin}/posts`:
1. Worker authenticates author, writes post to D1.
2. Worker calls the channel DO to assign `post_seq` and push to live WebSocket subscribers.
3. Channel DO enqueues a single `channel.post.created` event into `outbound_events`.
4. A consumer worker reads the event and **fan-outs via batched queue messages** — one message per N subscribers, or one per shard.

For >100k subscriber channels: **two-tier fan-out**. Channel DO posts a fan-out command `(channel_pin, post_seq)`; sharded fan-out workers each read a hashed subscriber range and emit pushes.

**R2 for channel media.** Direct-to-R2 upload via signed URL → `r2://relay-channel-media/{channel_pin}/{post_seq}/{filename}`. Persist key on `channel_posts.media_r2_key`. Public-read bucket fronted by a Worker enforcing channel-private vs public visibility. For video, layer **Cloudflare Stream** in front for HLS.

**Channel PIN format.** Keep BBM's `C`-prefix. Cheap deeplink (`relay://channel/C0030899F`) and printable QR for offline marketing come for free.

**Verification.** `verified BOOLEAN, verified_at TIMESTAMP` on `channels`, gated behind a server-only admin endpoint; small badge next to title in client.

**Discovery.**
- **Featured / Trending:** materialized view in D1, recomputed every N minutes by a scheduled Worker from post counts + subscriber growth (last 24h).
- **Search:** D1 FTS5 on `channels(title, description)`. Fine for the first 10k channels; graduate later.
- **Category browse:** `WHERE category = ?`.

**Moderation primitives day-one:** soft-delete via `deleted_at`; per-channel PIN-blocklist (BBM had to retrofit this — don't); comment approval queue via `channel_comments.status`; global report sink with reporter throttling.

**Push.** Reuse Relay's existing 1:1 push pipeline (already E7-done). Add `channel_subscriptions.muted` and per-channel notification preferences (all posts / mentions / owner-only).

**Scheduled chat hours (the BBM differentiator worth keeping).** `channel_chat_hours` table; "DM the owner" button gated client- and server-side against current UTC window. Cheap to ship, and nobody else has it.

**Explicitly NOT in v2:** multi-admin (do single-owner first), Hootsuite-style external integrations, ads.

### 19.7 Primary citations

- Engadget – [BBM Channels announced (14 May 2013)](https://www.engadget.com/2013/05/14/blackberry-announces-bbm-channels/)
- Engadget – [Channels + Voice on Android/iPhone (13 Feb 2014)](https://www.engadget.com/2014-02-13-bbm-channels-and-voice-come-to-android-and-iphone.html)
- TechCrunch – [BBM 2.0 update (13 Feb 2014)](https://techcrunch.com/2014/02/13/bbm-update-adds-voice-calls-channels-dropbox-and-location-sharing-for-ios-and-android-users/)
- TechCrunch – [85M MAU / 500k channels (28 Mar 2014)](https://techcrunch.com/2014/03/28/bbm-usage/)
- TechCrunch – [Consumer BBM shutdown (18 Apr 2019)](https://techcrunch.com/2019/04/18/the-consumer-version-of-bbm-is-shutting-down-on-may-31/)
- Android Authority – [BBM shuts down May 31](https://www.androidauthority.com/bbm-blackberry-messenger-shuts-down-may-31-977490/)
- CBS New York – [BlackBerry Messenger officially extinct](https://www.cbsnews.com/newyork/news/blackberry-messenger-shut-down/)
- Trusted Reviews – [RIP BBM](https://www.trustedreviews.com/news/bbm-blackberry-messenger-shut-down-3699034)
- KitGuru – [Emtek closing down BBM](https://www.kitguru.net/lifestyle/mobile/damien-cox/emtek-is-closing-down-bbm-for-good-as-blackberry-publicly-releases-its-enterprise-messenger/)
- CrackBerry – [BBM Channels hub](https://crackberry.com/bbm-channels)
- CrackBerry – [How to use BBM Channels on BB10](https://crackberry.com/how-use-bbm-channels)
- CrackBerry – [Multiple admin feature](https://crackberry.com/multiple-admins-bbm-channels-now-available)
- CrackBerry – [Chat hours + threaded comments](https://crackberry.com/bbm-channels-updated-set-chatting-hours-threaded-conversations-and-more)
- CrackBerry – [Block comments with PINs](https://crackberry.com/bbm-channels-udpated-brings-ability-block-comments-pins)
- CrackBerry – [Channel PIN badge for websites](https://crackberry.com/create-channel-pin-badge-your-website-blog-using-bbm-channels-manager)
- CrackBerry – [Exploring PIN culture](https://crackberry.com/exploring-pin-culture)
- CrackBerry – [Emtek consumer-BBM closure](https://crackberry.com/emtek-consumer-bbm)
- CrackBerry forums – [URL for BBM PINs / Channels?](https://forums.crackberry.com/general-bbm-chat-f404/url-bbm-pins-channels-1076886/)
- BlackBerry – [BBM Channel Terms](https://www.blackberry.com/us/en/legal/bbm-channel-terms/bbm-channel-terms)
- BlackBerry – [Content Guidelines (PDF)](https://www.blackberry.com/content/dam/blackberry-com/Documents/pdf/legal/bbm-channels-content-guidelines/BBM_Channels_Content_Guidelines_Polish.pdf)
- BlackBerry blogs – [Getting Started with BBM Channels (Nov 2013)](https://blogs.blackberry.com/en/2013/11/getting-started-with-bbm-channels)
- Wikipedia – [BBM (software)](https://en.wikipedia.org/wiki/BBM_(software))
- Telegram – [Channels: Broadcasting Done Right (Sept 2015)](https://telegram.org/blog/channels)
- Meta – [Instagram Broadcast Channels (Feb 2023)](https://about.fb.com/news/2023/02/instagram-broadcast-channels-creators-deepen-connections-with-followers/)
- Meta – [WhatsApp Channels global (Sept 2023)](https://about.fb.com/news/2023/09/whatsapp-channels-global-launch/)
- TechCrunch – [WhatsApp Channels global (13 Sept 2023)](https://techcrunch.com/2023/09/13/whatsapp-is-launching-its-channels-feature-globally/)
- Cloudflare – [Durable Objects overview](https://developers.cloudflare.com/durable-objects/)
- Cloudflare – [DO examples](https://developers.cloudflare.com/durable-objects/examples/)
- GitHub – [jw-12138/durable-objects-channel](https://github.com/jw-12138/durable-objects-channel/)

---

*End of spec. v2 — Google OAuth, two-DO hibernating realtime, offline-correct D/R, BBM-grade UX. Print this. Tape it to your monitor. Ship Session 1 this weekend.*
