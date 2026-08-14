import type { ChatLastMessage } from './types';

// Golf challenges ride the text rail as a body of `relay://challenge/<id>`
// (see Chat.tsx / NewChallengeSheet.tsx). The chat list can't resolve the
// challenge record here, so it shows a friendly label instead of the raw URL.
const CHALLENGE_PREFIX = 'relay://challenge/';

// Shared one-line summary for the last message in a chat-list row. Kept in one
// place so the beta card, Konsta list, and legacy list stay in lockstep.
export function lastMessagePreview(last: ChatLastMessage | null | undefined): string {
  if (last?.deletedAt) return 'Message recalled';
  if (last?.body?.startsWith(CHALLENGE_PREFIX)) return '⛳ Golf challenge';
  if (last?.messageType === 'ping') return 'sent a PING!!';
  if (last?.messageType === 'image') return '📷 Photo';
  if (last?.messageType === 'sticker') return '🌟 Sticker';
  return last?.body ?? '';
}
