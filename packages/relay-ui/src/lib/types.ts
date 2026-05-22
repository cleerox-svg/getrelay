// Shared types between UI code. Matches RELAY_BUILD_SPEC.md §9.

export interface Me {
  id: string;
  email: string;
  pin: string;
  displayName: string;
  statusMessage: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  sportsNotifications: boolean;
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
  statusMessage: string | null;
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
  muted?: boolean;
  pinnedAt?: number | null;
}

export interface GroupMember {
  id: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  online: boolean;
  joinedAt: number;
}

export interface ContactStatus {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  statusMessage: string;
  updatedAt: number;
  mine: boolean;
}

export interface SportsTeam {
  abbr: string;
  name: string;
  logo: string | null;
  score: number | null;
}

export interface SportsGame {
  id: string;
  league: 'NHL' | 'MLB';
  status: 'pre' | 'live' | 'final';
  statusDetail: string;
  startTime: number;
  startTimeLocal: string;
  homeTeam: SportsTeam;
  awayTeam: SportsTeam;
  venue: string | null;
  ourSide: 'home' | 'away';
}

export interface SportsLinescorePeriod {
  label: string;
  home: number | null;
  away: number | null;
}

export interface SportsLinescoreTotal {
  label: string; // "G" / "SOG" / "R" / "H" / "E"
  home: number;
  away: number;
}

export interface SportsScoringPlay {
  period: string;
  clock?: string;
  teamAbbr: string;
  description: string;
  homeScore: number;
  awayScore: number;
}

export interface SportsThreeStar {
  star: 1 | 2 | 3;
  name: string;
  teamAbbr: string;
  note?: string;
}

export interface SportsBoxPlayer {
  name: string;
  pos?: string;
  line: string;
  decision?: 'W' | 'L' | 'SV' | 'BS';
}

export interface SportsTeamBox {
  teamAbbr: string;
  batters?: SportsBoxPlayer[];
  pitchers?: SportsBoxPlayer[];
  skaters?: SportsBoxPlayer[];
  goalies?: SportsBoxPlayer[];
  stats?: { label: string; value: string }[];
}

export interface SportsGameDetail extends SportsGame {
  linescore: SportsLinescorePeriod[];
  totals: SportsLinescoreTotal[];
  scoringPlays: SportsScoringPlay[];
  threeStars?: SportsThreeStar[];
  homeBox: SportsTeamBox;
  awayBox: SportsTeamBox;
}

export interface ReplyPreview {
  id: string;
  from: string;
  fromName: string;
  preview: string;
}

export interface ReactionTally {
  emoji: string;
  count: number;
  mine: boolean;
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
  replyTo?: ReplyPreview | null;
  reactions?: ReactionTally[];
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
      // External media URL (Giphy) — used for GIFs that live on a
      // third-party CDN rather than our R2 bucket.
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
      // Either an R2-resolved URL or an external (Giphy) URL.
      mediaUrl?: string | null;
      replyTo?: ReplyPreview | null;
      ts: number;
    }
  | {
      t: 'reaction';
      chatId: string;
      messageId: string;
      userId: string;
      emoji: string;
      action: 'add' | 'remove';
    }
  | { t: 'delivered'; messageId: string; chatId: string; userId: string; ts: number }
  | { t: 'read'; messageId: string; chatId: string; userId: string; ts: number }
  | { t: 'typing'; chatId: string; userId: string; on: boolean }
  | { t: 'presence'; userId: string; online: boolean; lastSeen: number | null }
  | { t: 'ping'; chatId: string; from: string; ts: number }
  | { t: 'recalled'; messageId: string; chatId: string; ts: number }
  | { t: 'edited'; messageId: string; chatId: string; body: string; editedAt: number }
  | { t: 'error'; code: string; message?: string };
