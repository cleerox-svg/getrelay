import { create } from 'zustand';
import { api, API_BASE } from './api';
import { ws } from './ws';
import type {
  Chat,
  Contact,
  Me,
  ServerMsg,
  SportsGameDetail,
  SportsSub,
  UiMessage,
} from './types';

function mediaUrlFor(mediaKey: string | null | undefined): string | null {
  if (!mediaKey) return null;
  return `${API_BASE}/m/${encodeURIComponent(mediaKey)}`;
}

// Today in Toronto (YYYY-MM-DD). Matches the worker's notion of
// "today" so the day-selector tab the user sees as today maps to
// the same cache key the worker uses for today.
export function todayYmdToronto(): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Toronto',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

interface ChatState {
  messages: UiMessage[];
  typing: Record<string, boolean>; // userId -> typing
  loaded: boolean;
}

interface AppState {
  me: Me | null;
  meLoaded: boolean;
  chats: Chat[];
  contacts: Contact[];
  byChat: Record<string, ChatState>;
  presence: Record<string, { online: boolean; lastSeen: number | null }>;
  // Most recent /sports response. One poller writes here (see
  // wireSportsPoller in this file); both the /sports route and the
  // bottom-nav live-game badge read from it, so we never have two
  // pollers fighting for the same data.
  sportsSubs: SportsSub[];
  sportsLoaded: boolean;
  // Per-day cache for the Sports-tab day selector. Today's entry
  // duplicates `sportsSubs`; non-today days only fill on demand
  // when the user taps the selector. Keyed YYYY-MM-DD (Toronto).
  sportsByDate: Record<string, SportsSub[]>;
  selectedSportsDate: string; // YYYY-MM-DD (Toronto)

  loadMe: () => Promise<void>;
  loadSports: () => Promise<void>;
  loadSportsForDate: (ymd: string) => Promise<void>;
  setSelectedSportsDate: (ymd: string) => void;
  signout: () => Promise<void>;

  loadContacts: () => Promise<void>;
  addContact: (pin: string) => Promise<{ contactId: string }>;

  loadChats: () => Promise<void>;
  openOneToOne: (contactId: string) => Promise<string>;
  deleteChat: (chatId: string) => Promise<void>;
  setChatMuted: (chatId: string, muted: boolean) => Promise<void>;
  setChatPinned: (chatId: string, pinned: boolean) => Promise<void>;
  createGroup: (subject: string, contactIds: string[]) => Promise<string>;
  addGroupMembers: (chatId: string, contactIds: string[]) => Promise<number>;

  ensureChatState: (chatId: string) => void;
  loadChatHistory: (chatId: string) => Promise<void>;
  subscribeChat: (chatId: string) => void;
  unsubscribeChat: (chatId: string) => void;

  sendText: (chatId: string, body: string, replyTo?: string) => void;
  sendPing: (chatId: string) => void;
  sendMedia: (
    chatId: string,
    mediaKey: string,
    mediaUrl: string,
    caption?: string,
    replyTo?: string,
  ) => void;
  sendGif: (chatId: string, gifUrl: string, replyTo?: string) => void;
  sendSticker: (chatId: string, stickerUrl: string, replyTo?: string) => void;
  sendTyping: (chatId: string, on: boolean) => void;
  markRead: (chatId: string, messageIds: string[]) => void;
  recall: (messageId: string) => void;
  edit: (messageId: string, body: string) => void;
  react: (messageId: string, emoji: string) => void;

  handleServerMsg: (msg: ServerMsg) => void;
}

function ensureChat(state: AppState, chatId: string): ChatState {
  const cur = state.byChat[chatId];
  if (cur) return cur;
  const fresh: ChatState = { messages: [], typing: {}, loaded: false };
  state.byChat[chatId] = fresh;
  return fresh;
}

function compareMessages(a: UiMessage, b: UiMessage): number {
  // Sort by timestamp first — both optimistic (sequence=null) and persisted
  // messages have valid ts values, so this orders them correctly. Use
  // sequence as a tiebreaker only when timestamps match (multiple persisted
  // messages with the same created_at).
  if (a.ts !== b.ts) return a.ts - b.ts;
  return (a.sequence ?? 0) - (b.sequence ?? 0);
}

function upsertMessage(list: UiMessage[], msg: UiMessage): UiMessage[] {
  const idx = list.findIndex((m) => m.id === msg.id || (msg.tempId && m.tempId === msg.tempId));
  if (idx >= 0) {
    const merged = { ...list[idx], ...msg };
    const next = list.slice();
    next[idx] = merged as UiMessage;
    return next;
  }
  return [...list, msg].sort(compareMessages);
}

export const useStore = create<AppState>((set, get) => ({
  me: null,
  meLoaded: false,
  chats: [],
  contacts: [],
  byChat: {},
  presence: {},
  sportsSubs: [],
  sportsLoaded: false,
  sportsByDate: {},
  selectedSportsDate: todayYmdToronto(),

  loadMe: async () => {
    try {
      const me = await api.me();
      set({ me, meLoaded: true });
    } catch {
      set({ me: null, meLoaded: true });
    }
  },
  loadSports: async () => {
    try {
      const r = await api.getSports();
      const subs = r.subs ?? [];
      // Mirror today's snapshot into the per-day cache so the day
      // selector can read the same response without an extra fetch.
      const todayKey = todayYmdToronto();
      set({
        sportsSubs: subs,
        sportsLoaded: true,
        sportsByDate: { ...useStore.getState().sportsByDate, [todayKey]: subs },
      });
      // The /sports list pulls scores from MLB's lightweight
      // /linescore endpoint and NHL's /boxscore, both of which we've
      // seen lag the actual game state for many minutes. The per-
      // game detail endpoint hits MLB's /feed/live (gumbo) and the
      // NHL gamecenter landing, which match what the user sees on
      // the drill-down page. For every non-final game, fetch the
      // detail and overlay status / score / inning so the main page
      // matches the truth.
      //
      // We deliberately include `pre` games (not just `live`) here
      // because NHL's boxscore has been observed sitting on
      // gameState='PRE' for many minutes after puck drop — meaning
      // the list would never flip the card to 'live' and we'd never
      // know to overlay. The detail endpoint reads from landing,
      // which transitions reliably.
      const overlayTargets = subs
        .map((s) => ({ sub: s, game: s.current }))
        .filter(
          (x): x is { sub: SportsSub; game: NonNullable<SportsSub['current']> } =>
            !!x.game && x.game.status !== 'final',
        );
      if (overlayTargets.length === 0) return;
      const overlays = await Promise.all(
        overlayTargets.map(async ({ sub, game }) => {
          try {
            const d = await api.getSportsGame(
              sub.league.toLowerCase() as 'nhl' | 'mlb',
              game.id,
              sub.teamKey,
            );
            return { key: `${sub.league}:${sub.teamKey}`, detail: d };
          } catch {
            return null;
          }
        }),
      );
      const byKey = new Map<string, SportsGameDetail>();
      for (const o of overlays) {
        if (o) byKey.set(o.key, o.detail);
      }
      if (byKey.size === 0) return;
      // Re-read the current sportsSubs in case another tick raced
      // in between; merge onto the latest snapshot.
      const latest = useStore.getState().sportsSubs;
      const merged = latest.map((s) => {
        const d = byKey.get(`${s.league}:${s.teamKey}`);
        if (!d || !s.current) return s;
        return {
          ...s,
          current: {
            ...s.current,
            status: d.status,
            // Fall back to the list value when detail returned an
            // empty string (e.g. pre-game with no clock yet) so we
            // don't blank out "8:00 PM ET" with nothing.
            statusDetail: d.statusDetail || s.current.statusDetail,
            homeTeam: {
              ...s.current.homeTeam,
              // Same fallback for scores — landing can briefly
              // return null mid-fetch; the list's last-good number
              // is better than rendering "–".
              score: d.homeTeam.score ?? s.current.homeTeam.score,
            },
            awayTeam: {
              ...s.current.awayTeam,
              score: d.awayTeam.score ?? s.current.awayTeam.score,
            },
            // Prefer the detail's series (landing is the canonical
            // source for seriesStatus and may have it when the
            // list endpoint didn't fetch / parse it).
            series: d.series ?? s.current.series,
          },
        };
      });
      const today = todayYmdToronto();
      set({
        sportsSubs: merged,
        sportsByDate: { ...useStore.getState().sportsByDate, [today]: merged },
      });
    } catch {
      // Don't reset subs on failure — keep the last good snapshot
      // so a transient blip doesn't blank the screen.
      set({ sportsLoaded: true });
    }
  },
  loadSportsForDate: async (ymd: string) => {
    // Today routes through loadSports() so the live-overlay pass
    // still happens and sportsSubs (the polled snapshot the badge
    // reads) stays in sync.
    if (ymd === todayYmdToronto()) {
      await useStore.getState().loadSports();
      return;
    }
    try {
      const r = await api.getSports(ymd);
      const subs = r.subs ?? [];
      set({
        sportsByDate: { ...useStore.getState().sportsByDate, [ymd]: subs },
      });
    } catch {
      // Keep prior snapshot on transient failure.
    }
  },
  setSelectedSportsDate: (ymd: string) => {
    set({ selectedSportsDate: ymd });
  },
  signout: async () => {
    try {
      await api.signout();
    } finally {
      ws.stop();
      set({
        me: null,
        chats: [],
        contacts: [],
        byChat: {},
        presence: {},
      });
    }
  },

  loadContacts: async () => {
    const { contacts } = await api.listContacts();
    set({ contacts });
  },
  addContact: async (pin: string) => {
    const res = await api.addContact(pin);
    await get().loadContacts();
    return { contactId: res.contactId };
  },

  loadChats: async () => {
    const { chats } = await api.listChats();
    set({ chats });
  },
  openOneToOne: async (contactId: string) => {
    const res = await api.openOneToOne(contactId);
    if (res.created) await get().loadChats();
    return res.id;
  },
  deleteChat: async (chatId: string) => {
    await api.deleteChat(chatId);
    set((s) => {
      const { [chatId]: _drop, ...rest } = s.byChat;
      return {
        chats: s.chats.filter((c) => c.id !== chatId),
        byChat: rest,
      };
    });
  },
  setChatMuted: async (chatId, muted) => {
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, muted } : c)),
    }));
    await api.patchChat(chatId, { muted }).catch(() => undefined);
  },
  setChatPinned: async (chatId, pinned) => {
    const now = pinned ? Date.now() : null;
    set((s) => {
      const next = s.chats.map((c) =>
        c.id === chatId ? { ...c, pinnedAt: now } : c,
      );
      // Re-sort so pinned chats float to the top right away.
      next.sort((a, b) => {
        if ((a.pinnedAt ?? 0) !== (b.pinnedAt ?? 0)) {
          return (b.pinnedAt ?? 0) - (a.pinnedAt ?? 0);
        }
        return (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0);
      });
      return { chats: next };
    });
    await api.patchChat(chatId, { pinned }).catch(() => undefined);
  },
  createGroup: async (subject, contactIds) => {
    const res = await api.createGroup(subject, contactIds);
    await get().loadChats();
    return res.id;
  },
  addGroupMembers: async (chatId, contactIds) => {
    const res = await api.addGroupMembers(chatId, contactIds);
    await get().loadChats();
    return res.added;
  },

  ensureChatState: (chatId) => {
    set((s) => {
      ensureChat(s, chatId);
      return { byChat: { ...s.byChat } };
    });
  },

  loadChatHistory: async (chatId) => {
    const { messages } = await api.listChatMessages(chatId, { limit: 100 });
    set((s) => {
      const chat = ensureChat(s, chatId);
      // Merge with any messages already in-memory (e.g. just-sent via WS)
      // so we don't blow away local-only optimistic rows.
      const merged: UiMessage[] = chat.messages.slice();
      for (const m of messages) {
        const ui: UiMessage = {
          id: m.id,
          chatId: m.chatId,
          from: m.from,
          senderName: m.senderName ?? null,
          senderAvatarUrl: m.senderAvatarUrl ?? null,
          sequence: m.sequence,
          type: m.type,
          body: m.body,
          mediaKey: m.mediaKey ?? null,
          mediaUrl: m.mediaUrl ?? mediaUrlFor(m.mediaKey),
          replyTo: m.replyTo ?? null,
          reactions: m.reactions ?? [],
          ts: m.ts,
          editedAt: m.editedAt,
          deletedAt: m.deletedAt,
          delivered: m.delivered,
          read: m.read,
          deliveredCount: m.deliveredCount,
          readCount: m.readCount,
          totalRecipients: m.totalRecipients,
        };
        const idx = merged.findIndex((x) => x.id === m.id);
        if (idx >= 0) merged[idx] = { ...merged[idx], ...ui };
        else merged.push(ui);
      }
      merged.sort(compareMessages);
      chat.messages = merged;
      chat.loaded = true;
      return { byChat: { ...s.byChat, [chatId]: { ...chat } } };
    });
  },

  subscribeChat: (chatId) => {
    ws.send({ t: 'subscribe', chatId });
  },
  unsubscribeChat: (chatId) => {
    ws.send({ t: 'unsubscribe', chatId });
  },

  sendText: (chatId, body, replyTo) => {
    const tempId = crypto.randomUUID();
    const text = body.trim();
    if (!text) return;
    set((s) => {
      const chat = ensureChat(s, chatId);
      const targetPreview =
        replyTo != null ? chat.messages.find((m) => m.id === replyTo) : undefined;
      const optimistic: UiMessage = {
        id: tempId,
        tempId,
        chatId,
        from: s.me?.id ?? '',
        sequence: null,
        type: 'text',
        body: text,
        replyTo:
          targetPreview && s.me
            ? {
                id: targetPreview.id,
                from: targetPreview.from,
                fromName:
                  targetPreview.from === s.me.id
                    ? s.me.displayName
                    : '…',
                preview: (targetPreview.body ?? '').slice(0, 80),
              }
            : null,
        ts: Date.now(),
        editedAt: null,
        deletedAt: null,
        delivered: false,
        read: false,
        pending: true,
      };
      chat.messages = upsertMessage(chat.messages, optimistic);
      return { byChat: { ...s.byChat, [chatId]: { ...chat } } };
    });
    ws.send({
      t: 'send',
      tempId,
      chatId,
      type: 'text',
      body: text,
      replyTo,
    });
  },

  sendPing: (chatId) => {
    ws.send({ t: 'ping', chatId });
  },

  sendMedia: (chatId, mediaKey, mediaUrl, caption, replyTo) => {
    const tempId = crypto.randomUUID();
    set((s) => {
      const chat = ensureChat(s, chatId);
      const optimistic: UiMessage = {
        id: tempId,
        tempId,
        chatId,
        from: s.me?.id ?? '',
        sequence: null,
        type: 'image',
        body: caption?.trim() || null,
        mediaKey,
        mediaUrl,
        ts: Date.now(),
        editedAt: null,
        deletedAt: null,
        delivered: false,
        read: false,
        pending: true,
      };
      chat.messages = upsertMessage(chat.messages, optimistic);
      return { byChat: { ...s.byChat, [chatId]: { ...chat } } };
    });
    ws.send({
      t: 'send',
      tempId,
      chatId,
      type: 'image',
      body: caption?.trim() || undefined,
      mediaKey,
      replyTo,
    });
  },

  // GIF from Giphy. No R2 upload — we just ride the external URL
  // through the existing image type.
  sendGif: (chatId, gifUrl, replyTo) => {
    const tempId = crypto.randomUUID();
    set((s) => {
      const chat = ensureChat(s, chatId);
      const optimistic: UiMessage = {
        id: tempId,
        tempId,
        chatId,
        from: s.me?.id ?? '',
        sequence: null,
        type: 'image',
        body: null,
        mediaKey: null,
        mediaUrl: gifUrl,
        ts: Date.now(),
        editedAt: null,
        deletedAt: null,
        delivered: false,
        read: false,
        pending: true,
      };
      chat.messages = upsertMessage(chat.messages, optimistic);
      return { byChat: { ...s.byChat, [chatId]: { ...chat } } };
    });
    ws.send({
      t: 'send',
      tempId,
      chatId,
      type: 'image',
      mediaUrl: gifUrl,
      replyTo,
    });
  },

  sendSticker: (chatId, stickerUrl, replyTo) => {
    // Stickers ride the type='image' rail; the receiving client picks
    // sticker vs photo rendering via isStickerUrl(mediaUrl). This keeps
    // the wire protocol and DB CHECK constraint unchanged while still
    // giving the UI everything it needs to render stickers without a
    // bubble.
    const tempId = crypto.randomUUID();
    set((s) => {
      const chat = ensureChat(s, chatId);
      const optimistic: UiMessage = {
        id: tempId,
        tempId,
        chatId,
        from: s.me?.id ?? '',
        sequence: null,
        type: 'image',
        body: null,
        mediaKey: null,
        mediaUrl: stickerUrl,
        ts: Date.now(),
        editedAt: null,
        deletedAt: null,
        delivered: false,
        read: false,
        pending: true,
      };
      chat.messages = upsertMessage(chat.messages, optimistic);
      return { byChat: { ...s.byChat, [chatId]: { ...chat } } };
    });
    ws.send({
      t: 'send',
      tempId,
      chatId,
      type: 'image',
      mediaUrl: stickerUrl,
      replyTo,
    });
  },

  sendTyping: (chatId, on) => {
    ws.send({ t: 'typing', chatId, on });
  },

  markRead: (chatId, messageIds) => {
    if (messageIds.length === 0) return;
    ws.send({ t: 'read', chatId, messageIds });
    // Reset unread count locally.
    set((s) => ({
      chats: s.chats.map((c) => (c.id === chatId ? { ...c, unreadCount: 0 } : c)),
    }));
  },

  recall: (messageId) => {
    ws.send({ t: 'recall', messageId });
  },
  edit: (messageId, body) => {
    const text = body.trim();
    if (!text) return;
    ws.send({ t: 'edit', messageId, body: text });
  },

  react: (messageId, emoji) => {
    const e = (emoji ?? '').trim();
    if (!e) return;
    // Optimistic toggle so the chip flips immediately. The server
    // reaction broadcast will eventually arrive and idempotently re-set
    // the count (we treat the server delta as authoritative on next
    // update).
    set((s) => {
      const me = s.me?.id;
      if (!me) return s;
      let chatId: string | null = null;
      for (const [cid, chat] of Object.entries(s.byChat)) {
        if (chat.messages.some((m) => m.id === messageId)) {
          chatId = cid;
          break;
        }
      }
      if (!chatId) return s;
      const chat = s.byChat[chatId];
      if (!chat) return s;
      const next = chat.messages.map((m) => {
        if (m.id !== messageId) return m;
        const reactions = m.reactions ? m.reactions.slice() : [];
        // One reaction per user. Drop any other emoji this user had on
        // the message first; then either toggle the new one or add it.
        for (let i = reactions.length - 1; i >= 0; i--) {
          const r = reactions[i]!;
          if (r.mine && r.emoji !== e) {
            const c = r.count - 1;
            if (c <= 0) reactions.splice(i, 1);
            else reactions[i] = { ...r, count: c, mine: false };
          }
        }
        const idx = reactions.findIndex((r) => r.emoji === e);
        if (idx >= 0) {
          const r = reactions[idx]!;
          if (r.mine) {
            const newCount = r.count - 1;
            if (newCount <= 0) reactions.splice(idx, 1);
            else reactions[idx] = { ...r, count: newCount, mine: false };
          } else {
            reactions[idx] = { ...r, count: r.count + 1, mine: true };
          }
        } else {
          reactions.push({ emoji: e, count: 1, mine: true });
        }
        return { ...m, reactions };
      });
      return {
        byChat: {
          ...s.byChat,
          [chatId]: { ...chat, messages: next },
        },
      };
    });
    ws.send({ t: 'react', messageId, emoji: e });
  },

  handleServerMsg: (msg) => {
    switch (msg.t) {
      case 'ack':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.messages = chat.messages.map((m) =>
            m.tempId === msg.tempId
              ? { ...m, id: msg.messageId, sequence: msg.sequence, ts: msg.ts, pending: false }
              : m,
          );
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'message': {
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          const ui: UiMessage = {
            id: msg.id,
            chatId: msg.chatId,
            from: msg.from,
            sequence: msg.sequence,
            type: msg.type,
            body: msg.body,
            mediaKey: msg.mediaKey ?? null,
            mediaUrl: msg.mediaUrl ?? mediaUrlFor(msg.mediaKey),
            replyTo: msg.replyTo ?? null,
            reactions: [],
            ts: msg.ts,
            editedAt: null,
            deletedAt: null,
            delivered: false,
            read: false,
          };
          chat.messages = upsertMessage(chat.messages, ui);
          const chats = s.chats.map((c) =>
            c.id === msg.chatId
              ? {
                  ...c,
                  unreadCount: c.unreadCount + 1,
                  lastActivityAt: msg.ts,
                  lastMessage: {
                    id: msg.id,
                    senderId: msg.from,
                    messageType: msg.type,
                    body: msg.body,
                    createdAt: msg.ts,
                    editedAt: null,
                    deletedAt: null,
                  },
                }
              : c,
          );
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } }, chats };
        });
        break;
      }

      case 'delivered':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.messages = chat.messages.map((m) => {
            if (m.id !== msg.messageId) return m;
            // Sender-view of a group message: bump deliveredCount,
            // clamped to totalRecipients to keep multi-device
            // duplicate-delivery events idempotent. For 1to1 (no
            // counts on the message) it's just the delivered boolean.
            if (m.totalRecipients === undefined) {
              return { ...m, delivered: true };
            }
            const next = Math.min(
              (m.deliveredCount ?? 0) + 1,
              m.totalRecipients,
            );
            return { ...m, delivered: true, deliveredCount: next };
          });
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'read':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.messages = chat.messages.map((m) => {
            if (m.id !== msg.messageId) return m;
            if (m.totalRecipients === undefined) {
              return { ...m, delivered: true, read: true };
            }
            // Reading implies delivery; bump both counts. Clamp each
            // to totalRecipients so we can't overshoot if events
            // arrive out of order.
            const nextRead = Math.min(
              (m.readCount ?? 0) + 1,
              m.totalRecipients,
            );
            const nextDelivered = Math.min(
              Math.max((m.deliveredCount ?? 0) + 1, nextRead),
              m.totalRecipients,
            );
            return {
              ...m,
              delivered: true,
              read: true,
              deliveredCount: nextDelivered,
              readCount: nextRead,
            };
          });
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'typing':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.typing = { ...chat.typing, [msg.userId]: msg.on };
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'presence':
        set((s) => ({
          presence: {
            ...s.presence,
            [msg.userId]: { online: msg.online, lastSeen: msg.lastSeen },
          },
          contacts: s.contacts.map((c) =>
            c.id === msg.userId ? { ...c, online: msg.online, lastSeenAt: msg.lastSeen } : c,
          ),
        }));
        break;

      case 'ping':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          const id = `ping-${msg.from}-${msg.ts}`;
          const ui: UiMessage = {
            id,
            chatId: msg.chatId,
            from: msg.from,
            sequence: null,
            type: 'ping',
            body: null,
            ts: msg.ts,
            editedAt: null,
            deletedAt: null,
            delivered: false,
            read: false,
          };
          chat.messages = upsertMessage(chat.messages, ui);
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'reaction': {
        set((s) => {
          const me = s.me?.id;
          const chat = ensureChat(s, msg.chatId);
          const next = chat.messages.map((m) => {
            if (m.id !== msg.messageId) return m;
            const reactions = m.reactions ? m.reactions.slice() : [];
            const idx = reactions.findIndex((r) => r.emoji === msg.emoji);
            const isMine = me && msg.userId === me;
            if (msg.action === 'add') {
              if (idx >= 0) {
                const r = reactions[idx]!;
                // Server is authoritative; only flip `mine` if this user
                // added it. Avoid double-counting when our optimistic
                // toggle already incremented.
                if (isMine && r.mine) {
                  // already in sync
                } else if (isMine) {
                  reactions[idx] = { ...r, count: r.count + 1, mine: true };
                } else {
                  reactions[idx] = { ...r, count: r.count + 1 };
                }
              } else {
                reactions.push({ emoji: msg.emoji, count: 1, mine: !!isMine });
              }
            } else {
              if (idx >= 0) {
                const r = reactions[idx]!;
                const newCount = r.count - 1;
                if (newCount <= 0) reactions.splice(idx, 1);
                else
                  reactions[idx] = {
                    ...r,
                    count: newCount,
                    mine: isMine ? false : r.mine,
                  };
              }
            }
            return { ...m, reactions };
          });
          return {
            byChat: {
              ...s.byChat,
              [msg.chatId]: { ...chat, messages: next },
            },
          };
        });
        break;
      }

      case 'recalled':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.messages = chat.messages.map((m) =>
            m.id === msg.messageId ? { ...m, deletedAt: msg.ts, body: null } : m,
          );
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'edited':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.messages = chat.messages.map((m) =>
            m.id === msg.messageId ? { ...m, body: msg.body, editedAt: msg.editedAt } : m,
          );
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'member_joined': {
        const myId = get().me?.id;
        const haveChat = get().chats.some((c) => c.id === msg.chatId);
        if (msg.userId === myId && !haveChat) {
          // I was added to a chat I don't know about yet — fetch the
          // chat list so it appears.
          get().loadChats().catch(() => undefined);
        } else if (haveChat) {
          // Existing chat I'm already in: bump the member count.
          // Detail screen (if mounted) refreshes its own members
          // list on receiving this event.
          set((s) => ({
            chats: s.chats.map((c) =>
              c.id === msg.chatId
                ? { ...c, memberCount: (c.memberCount ?? 0) + 1 }
                : c,
            ),
          }));
        }
        break;
      }

      case 'member_left':
        // The leaver themselves never receives this event (server
        // skips them in fan-out); we always handle it as "someone
        // else left a group I'm still in".
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id === msg.chatId
              ? {
                  ...c,
                  memberCount: Math.max((c.memberCount ?? 1) - 1, 1),
                }
              : c,
          ),
        }));
        break;

      case 'group_updated':
        // Sent to every current member after the subject or avatar
        // changes (PATCH /chats/:id or POST/DELETE /chats/:id/avatar).
        // The editor receives it too — that's how their other
        // devices stay in sync.
        set((s) => ({
          chats: s.chats.map((c) =>
            c.id === msg.chatId
              ? { ...c, subject: msg.subject, avatarUrl: msg.avatarUrl }
              : c,
          ),
        }));
        break;

      case 'error':
        console.warn('[ws] error from server', msg.code, msg.message);
        break;
    }
  },
}));

// Wire WS messages into the store once.
let wired = false;
export function wireWsToStore(): void {
  if (wired) return;
  wired = true;
  ws.onMessage((msg) => useStore.getState().handleServerMsg(msg));
}

// Periodic /sports fetch — re-arms itself at 30s while any followed
// team has a live game and 5min otherwise. One instance per signed-
// in app lifetime. Both the /sports route and the bottom-nav live-
// game badge read from useStore.sportsSubs so a single poll feeds
// the whole UI; without this lift, the page-local poller meant the
// tab badge wouldn't tick until the user opened the Sports tab.
let sportsTimer: number | undefined;
let sportsVisibilityHandler: (() => void) | undefined;
let sportsOnlineHandler: (() => void) | undefined;
export function wireSportsPoller(): void {
  // Re-entry on remount: clear any prior timer/listeners so we don't
  // end up with two pollers racing.
  stopSportsPoller();
  const tick = async () => {
    await useStore.getState().loadSports();
    const live = useStore
      .getState()
      .sportsSubs.some((s) => s.current?.status === 'live');
    sportsTimer = window.setTimeout(tick, live ? 30_000 : 300_000);
  };
  // setTimeout is paused/throttled while the PWA is backgrounded or
  // the tab is hidden, so the next tick can be many minutes overdue
  // when the user comes back — leaving the list showing the inning
  // and score from the last successful poll. Force an immediate
  // refresh on resume so the Sports tab matches reality.
  sportsVisibilityHandler = () => {
    if (document.visibilityState !== 'visible') return;
    if (sportsTimer !== undefined) window.clearTimeout(sportsTimer);
    void tick();
  };
  sportsOnlineHandler = () => {
    if (sportsTimer !== undefined) window.clearTimeout(sportsTimer);
    void tick();
  };
  document.addEventListener('visibilitychange', sportsVisibilityHandler);
  window.addEventListener('online', sportsOnlineHandler);
  void tick();
}
export function stopSportsPoller(): void {
  if (sportsTimer !== undefined) {
    window.clearTimeout(sportsTimer);
    sportsTimer = undefined;
  }
  if (sportsVisibilityHandler) {
    document.removeEventListener('visibilitychange', sportsVisibilityHandler);
    sportsVisibilityHandler = undefined;
  }
  if (sportsOnlineHandler) {
    window.removeEventListener('online', sportsOnlineHandler);
    sportsOnlineHandler = undefined;
  }
}
