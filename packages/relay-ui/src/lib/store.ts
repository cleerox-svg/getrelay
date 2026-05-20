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
  createGroup: (subject: string, contactIds: string[]) => Promise<string>;
  addGroupMembers: (chatId: string, contactIds: string[]) => Promise<number>;

  ensureChatState: (chatId: string) => void;
  loadChatHistory: (chatId: string) => Promise<void>;
  subscribeChat: (chatId: string) => void;
  unsubscribeChat: (chatId: string) => void;

  sendText: (chatId: string, body: string) => void;
  sendPing: (chatId: string) => void;
  sendMedia: (chatId: string, mediaKey: string, mediaUrl: string, caption?: string) => void;
  sendTyping: (chatId: string, on: boolean) => void;
  markRead: (chatId: string, messageIds: string[]) => void;
  recall: (messageId: string) => void;
  edit: (messageId: string, body: string) => void;

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

  sendText: (chatId, body) => {
    const tempId = crypto.randomUUID();
    const text = body.trim();
    if (!text) return;
    set((s) => {
      const chat = ensureChat(s, chatId);
      const optimistic: UiMessage = {
        id: tempId,
        tempId,
        chatId,
        from: s.me?.id ?? '',
        sequence: null,
        type: 'text',
        body: text,
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
    ws.send({ t: 'send', tempId, chatId, type: 'text', body: text });
  },

  sendPing: (chatId) => {
    ws.send({ t: 'ping', chatId });
  },

  sendMedia: (chatId, mediaKey, mediaUrl, caption) => {
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
