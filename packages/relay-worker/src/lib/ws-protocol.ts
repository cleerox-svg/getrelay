// Shared WebSocket protocol types for UserHub <-> client and DO-to-DO events.
// See RELAY_BUILD_SPEC.md §9.

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
  | { t: 'error'; code: ErrorCode; message?: string };

export type ErrorCode =
  | 'bad_json'
  | 'unknown_type'
  | 'unauthorized'
  | 'rate_limited'
  | 'not_in_chat'
  | 'payload_too_large'
  | 'chat_not_found'
  | 'message_not_found'
  | 'cannot_edit'
  | 'cannot_recall';

export const MAX_BODY_LEN = 2000;
export const MAX_READ_IDS = 200;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;
