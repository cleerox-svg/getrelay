import { create } from 'zustand';
import { api, API_BASE } from './api';
import { ws } from './ws';
import type { Chat, Contact, Me, ServerMsg, UiMessage } from './types';

function mediaUrlFor(mediaKey: string | null | undefined): string | null {
  if (!mediaKey) return null;
  return `${API_BASE}/m/${encodeURIComponent(mediaKey)}`;
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

  loadMe: () => Promise<void>;
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

  loadMe: async () => {
    try {
      const me = await api.me();
      set({ me, meLoaded: true });
    } catch {
      set({ me: null, meLoaded: true });
    }
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
          chat.messages = chat.messages.map((m) =>
            m.id === msg.messageId ? { ...m, delivered: true } : m,
          );
          return { byChat: { ...s.byChat, [msg.chatId]: { ...chat } } };
        });
        break;

      case 'read':
        set((s) => {
          const chat = ensureChat(s, msg.chatId);
          chat.messages = chat.messages.map((m) =>
            m.id === msg.messageId ? { ...m, delivered: true, read: true } : m,
          );
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
