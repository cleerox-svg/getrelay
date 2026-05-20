// Shared types between UI code. Matches RELAY_BUILD_SPEC.md §9.

export interface Me {
  id: string;
  email: string;
  pin: string;
  displayName: string;
  statusMessage: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
}

export interface Contact {
  id: string;
  pin: string;
  displayName: string;
  statusMessage: string | null;
  avatarUrl: string | null;
  alias: string | null;
  category: string | null;
  addedAt: number;
  lastSeenAt: number | null;
  online: boolean;
}

export interface ChatLastMessage {
  id: string;
  senderId: string | null;
  messageType: string | null;
  body: string | null;
  createdAt: number | null;
  editedAt: number | null;
  deletedAt: number | null;
}

export interface ChatPeer {
  id: string;
  displayName: string;
  avatarUrl: string | null;
  pin: string;
}

export interface Chat {
  id: string;
  type: '1to1' | 'group';
  subject: string | null;
  memberCount?: number;
  peer: ChatPeer | null;
  lastMessage: ChatLastMessage | null;
  unreadCount: number;
  lastActivityAt: number;
}

export interface GroupMember {
  id: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  online: boolean;
  joinedAt: number;
}

export interface UiMessage {
  id: string;
  chatId: string;
  from: string;
  sequence: number | null;
  type: string;
  body: string | null;
  mediaKey?: string | null;
  mediaUrl?: string | null;
  ts: number;
  editedAt: number | null;
  deletedAt: number | null;
  delivered: boolean;
  read: boolean;
  pending?: boolean;
  tempId?: string;
}

// Client -> Server
export type ClientMsg =
  | {
      t: 'send';
      tempId: string;
      chatId: string;
      type: 'text' | 'ping' | 'image';
      body?: string;
      mediaKey?: string;
    }
  | { t: 'typing'; chatId: string; on: boolean }
  | { t: 'read'; chatId: string; messageIds: string[] }
  | { t: 'ping'; chatId: string }
  | { t: 'recall'; messageId: string }
  | { t: 'edit'; messageId: string; body: string }
  | { t: 'subscribe'; chatId: string }
  | { t: 'unsubscribe'; chatId: string };

// Server -> Client
export type ServerMsg =
  | { t: 'ack'; tempId: string; messageId: string; sequence: number; chatId: string; ts: number }
  | {
      t: 'message';
      id: string;
      chatId: string;
      from: string;
      sequence: number;
      type: string;
      body: string | null;
      mediaKey?: string | null;
      mediaUrl?: string | null;
      ts: number;
    }
  | { t: 'delivered'; messageId: string; chatId: string; userId: string; ts: number }
  | { t: 'read'; messageId: string; chatId: string; userId: string; ts: number }
  | { t: 'typing'; chatId: string; userId: string; on: boolean }
  | { t: 'presence'; userId: string; online: boolean; lastSeen: number | null }
  | { t: 'ping'; chatId: string; from: string; ts: number }
  | { t: 'recalled'; messageId: string; chatId: string; ts: number }
  | { t: 'edited'; messageId: string; chatId: string; body: string; editedAt: number }
  | { t: 'error'; code: string; message?: string };
