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
      // External media URL. Carries the Giphy CDN URL for GIFs and the
      // bundled sticker URL (e.g. https://relay.averrow.com/stickers/
      // wink.svg) for stickers. Stickers are stored as type='image' on
      // the wire and in the DB — the client discriminates sticker-vs-
      // photo by URL pattern (/stickers/*.svg). This keeps the wire
      // protocol and message_type CHECK constraint simple at the cost
      // of "image" being a slightly broader category.
      mediaUrl?: string;
      replyTo?: string;
    }
  | { t: 'typing'; chatId: string; on: boolean }
  | { t: 'read'; chatId: string; messageIds: string[] }
  | { t: 'ping'; chatId: string }
  | { t: 'recall'; messageId: string }
  | { t: 'edit'; messageId: string; body: string }
  | { t: 'react'; messageId: string; emoji: string }
  | { t: 'subscribe'; chatId: string }
  | { t: 'unsubscribe'; chatId: string };

export interface ReplyPreview {
  id: string;
  from: string;
  fromName: string;
  preview: string;
}

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
      replyTo?: ReplyPreview | null;
      ts: number;
    }
  | { t: 'delivered'; messageId: string; chatId: string; userId: string; ts: number }
  | { t: 'read'; messageId: string; chatId: string; userId: string; ts: number }
  | { t: 'typing'; chatId: string; userId: string; on: boolean }
  | { t: 'presence'; userId: string; online: boolean; lastSeen: number | null }
  | { t: 'ping'; chatId: string; from: string; ts: number }
  | { t: 'recalled'; messageId: string; chatId: string; ts: number }
  | { t: 'edited'; messageId: string; chatId: string; body: string; editedAt: number }
  | {
      // Sent to every member of a group when participants change.
      // Existing members get "someone joined" (update local member
      // count + clear members cache). The newly-added member also
      // receives it for themselves — their client treats userId
      // === me as "I was added to a new chat" and refreshes the
      // chat list.
      t: 'member_joined';
      chatId: string;
      userId: string;
      displayName: string;
      avatarUrl: string | null;
      joinedAt: number;
    }
  | {
      // Sent to remaining group members when someone leaves
      // (DELETE /chats/:id). The leaver doesn't receive it — their
      // client updates locally on API success.
      t: 'member_left';
      chatId: string;
      userId: string;
    }
  | {
      // Sent to every current member of a group after the subject
      // or avatar changes (PATCH /chats/:id, POST/DELETE
      // /chats/:id/avatar). Includes the new state so the receiver
      // can update local chat metadata without a separate /chats
      // refetch. The editor receives it too — supports the
      // "edit on device A, see on device B" multi-device case.
      t: 'group_updated';
      chatId: string;
      subject: string | null;
      avatarUrl: string | null;
    }
  | {
      t: 'reaction';
      chatId: string;
      messageId: string;
      userId: string;
      emoji: string;
      action: 'add' | 'remove';
    }
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
  | 'cannot_recall'
  | 'bad_emoji';

export const MAX_BODY_LEN = 2000;
export const MAX_READ_IDS = 200;
export const EDIT_WINDOW_MS = 15 * 60 * 1000;
export const RECALL_WINDOW_MS = 24 * 60 * 60 * 1000;
// Single grapheme reactions only, capped for sanity.
export const MAX_EMOJI_BYTES = 16;
