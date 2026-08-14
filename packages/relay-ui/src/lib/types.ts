// Shared types between UI code. Matches RELAY_BUILD_SPEC.md §9.

export interface Me {
  id: string;
  email: string;
  pin: string;
  displayName: string;
  statusMessage: string | null;
  avatarUrl: string | null;
  isAdmin: boolean;
  // Master sports kill switch; the three notify_* flags only matter
  // when this is true.
  sportsNotifications: boolean;
  sportsNotifyStart: boolean;
  sportsNotifyScore: boolean;
  sportsNotifyFinal: boolean;
  // When false, my Fog results are kept out of the Updates feed — my
  // contacts' and my own. Scores still count on the leaderboard.
  // Optional because the worker deploys independently of the UI: an
  // older worker omits it, and readers treat absent as "sharing".
  gameFeedShared?: boolean;
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
  // Resolved group avatar URL (R2 key resolves to /r/<key> via the
  // worker, external avatar_url passes through). Null for 1to1 chats
  // and for groups that haven't uploaded an avatar — clients render
  // the hashed-letter GroupAvatar fallback in that case.
  avatarUrl?: string | null;
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

// Every game whose activity can appear in the feed. Widened past Fog so
// the Updates tab can surface golf runs, challenges and records too.
export type GameId = 'fog' | 'tune' | 'golf' | 'golfrange' | 'golfcourse';

// Why a game run made it into the feed. The worker only surfaces notable
// runs, and reports the single most interesting reason that applies.
// `underpar` is golf-only (a scored round under par).
export type GameFeedBadge = 'first' | 'best' | 'underpar' | 'perfect' | 'streak';

// Which longest-shot record a golf `record` event celebrates.
export type RecordMetric = 'drive' | 'closest' | 'putt';

// The person an event belongs to. Carried on status / game / record events.
// Challenge events omit it — they carry `challenger`/`opponent` instead.
export interface FeedActor {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  mine: boolean;
}

// One side of a head-to-head challenge feed event. `toPar` is null when that
// player hasn't submitted (lower to-par wins).
export interface FeedChallenger {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  toPar: number | null;
}

interface FeedEventBase {
  // Stable across refetches: `status:<userId>`, `game:<scoreId>`, etc.
  id: string;
  // ms epoch; the feed is sorted on this, newest first.
  at: number;
}

export interface StatusFeedEvent extends FeedActor, FeedEventBase {
  kind: 'status';
  statusMessage: string;
}

export interface GameFeedEvent extends FeedActor, FeedEventBase {
  kind: 'game';
  game: GameId;
  score: number;
  rounds: number;
  bestStreak: number;
  // Golf-family rounds carry a to-par (relative to par); null for fog/tune.
  // Optional so an older worker's game events (which omit it) still render.
  toPar?: number | null;
  badge: GameFeedBadge;
}

// A settled async golf challenge between two contacts. No actor identity of
// its own — the two participants ride in `challenger`/`opponent`, and `mine`
// says whether the viewer is one of them. `winnerId` null means a tie.
export interface ChallengeFeedEvent extends FeedEventBase {
  kind: 'challenge';
  mine: boolean;
  challengeId: string;
  game: GameId;
  course: string | null;
  hole: number | null;
  challenger: FeedChallenger;
  opponent: FeedChallenger;
  winnerId: string | null;
}

// A new longest-shot record (driving range / course).
export interface RecordFeedEvent extends FeedActor, FeedEventBase {
  kind: 'record';
  metric: RecordMetric;
  valueYards: number;
  hole: number | null;
}

export type FeedEvent =
  | StatusFeedEvent
  | GameFeedEvent
  | ChallengeFeedEvent
  | RecordFeedEvent;

export interface SportsTeam {
  abbr: string;
  name: string;
  logo: string | null;
  score: number | null;
  // Season-to-date record. NHL: "48-24-10" (W-L-OTL). MLB: "29-22"
  // (W-L). Null when the upstream didn't populate it.
  record?: string | null;
}

export interface SportsSeries {
  round: string | null;
  gameLabel: string; // "Game 4 of 7"
  seriesLabel: string; // "MTL leads series 2-1"
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
  series?: SportsSeries;
  // Comma-separated TV network label, e.g. "SN", "TBS, MLBN". Null
  // when upstream didn't expose a broadcast.
  broadcast?: string | null;
}

// One per-team entry in the per-user sports feed: today's game (if
// any) plus the most recent final game so the user can always see the
// last score.
export interface SportsSub {
  league: 'NHL' | 'MLB';
  teamKey: string;
  current: SportsGame | null;
  previous: SportsGame | null;
}

export interface SportsTeamMeta {
  key: string;
  abbr: string;
  name: string;
  logo: string | null;
}

// ---- Sports News + Stats sub-pages ----

export interface SportsNewsArticle {
  id: string;
  league: 'NHL' | 'MLB';
  headline: string;
  description: string;
  published: number; // epoch ms; 0 when unknown
  imageUrl: string | null;
  url: string;
}

export interface SportsStandingRow {
  teamId: string;
  name: string;
  abbr: string;
  logo: string | null;
  wins: number;
  losses: number;
  ot: number | null; // NHL OT losses
  points: number | null; // NHL points
  pct: string | null; // MLB win %
  gb: string | null; // MLB games back
  gp: number | null;
}

export interface SportsStandingGroup {
  league: 'NHL' | 'MLB';
  division: string;
  rows: SportsStandingRow[];
}

export interface SportsLeaderRow {
  rank: number;
  name: string;
  team: string;
  value: string;
}

export interface SportsLeaderList {
  league: 'NHL' | 'MLB';
  category: string;
  rows: SportsLeaderRow[];
}

export interface SportsStatsResponse {
  standings: SportsStandingGroup[];
  leaders: SportsLeaderList[];
}

export interface SportsTeamLists {
  nhl: SportsTeamMeta[];
  mlb: SportsTeamMeta[];
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

// Pregame "Starting Goalies" — NHL only. Both numeric stat fields
// stay nullable because the upstream returns partial rows for
// goalies with limited appearances.
export interface SportsStartingGoalie {
  side: 'home' | 'away';
  name: string;
  teamAbbr: string;
  starter: boolean; // true → "Likely starter" pill
  wins: number | null;
  losses: number | null;
  otLosses: number | null;
  shutouts: number | null;
  gaa: number | null;
  savePct: number | null; // 0-1; formatted ".932" on the client
}

// Per-team season stats for the detail-page comparison bars (NHL).
// All numeric fields stay nullable so the renderer can show "—" for
// teams the upstream returned no qualifying row for (e.g. asking for
// postseason stats on a team that didn't make the playoffs).
export interface SportsTeamSeasonStats {
  gfPerGame: number | null;
  gaPerGame: number | null;
  ppPct: number | null;
  pkPct: number | null;
}

export interface SportsTeamSeasonStatsPair {
  period: 'postseason' | 'regular';
  home?: SportsTeamSeasonStats;
  away?: SportsTeamSeasonStats;
}

// One stat leader (top points / goals / assists scorer on a team).
// `name` is "F. Lastname" preformatted by the worker.
export interface SportsStatLeader {
  name: string;
  teamAbbr: string;
  value: number;
}

export interface SportsTeamLeaders {
  points?: SportsStatLeader;
  goals?: SportsStatLeader;
  assists?: SportsStatLeader;
}

export interface SportsTeamLeadersPair {
  period: 'postseason' | 'regular';
  home?: SportsTeamLeaders;
  away?: SportsTeamLeaders;
}

// Recent head-to-head matchup. Both abbrs are the abbreviations the
// game was actually played by; `homeScore` / `awayScore` always
// numeric (worker filters incomplete rows).
export interface SportsRecentMatchup {
  date: string; // YYYY-MM-DD
  homeAbbr: string;
  awayAbbr: string;
  homeScore: number;
  awayScore: number;
}

export interface SportsGameDetail extends SportsGame {
  linescore: SportsLinescorePeriod[];
  totals: SportsLinescoreTotal[];
  scoringPlays: SportsScoringPlay[];
  threeStars?: SportsThreeStar[];
  startingGoalies?: SportsStartingGoalie[];
  recentMatchups?: SportsRecentMatchup[];
  teamSeasonStats?: SportsTeamSeasonStatsPair;
  teamLeaders?: SportsTeamLeadersPair;
  homeBox: SportsTeamBox;
  awayBox: SportsTeamBox;
}

// One ranked row from GET /game/leaderboard (Fog mini game). Rows
// arrive already sorted by the worker; `mine` marks the caller's own
// row for highlighting.
export interface GameLeaderboardEntry {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  best: number;
  games: number;
  mine: boolean;
}

// One per-course row from GET /game/golf-stats. `course` is null for the
// uncategorized / mini-golf bucket. The to-par aggregates are null when no
// round in the bucket recorded a to-par (lower bestToPar is better).
export interface GolfCourseStat {
  course: string | null;
  games: number;
  bestScore: number;
  avgScore: number;
  bestToPar: number | null;
  avgToPar: number | null;
}

// One recent round from GET /game/golf-stats, newest first. `toPar` is null
// when the round didn't record one; `createdAt` is epoch ms.
export interface GolfRecentRound {
  course: string | null;
  score: number;
  rounds: number;
  toPar: number | null;
  createdAt: number;
}

// The caller's personal golf profile from GET /game/golf-stats. All summary
// figures are null until there is data. `handicap` is an APPROXIMATION —
// the average to-par of recent scored rounds, not an official handicap.
export interface GolfStats {
  game: 'fog' | 'tune' | 'golf' | 'golfrange' | 'golfcourse';
  gamesPlayed: number;
  best: number | null;
  average: number | null;
  bestStreak: number | null;
  lastPlayed: number | null;
  handicap: number | null;
  perCourse: GolfCourseStat[];
  recent: GolfRecentRound[];
}

// ---- Golf economy (coins, cosmetics, season) ----------------------------
// Shapes match the worker's /economy/* endpoints. `visual` is rendered
// GENERICALLY (no per-id logic): ball → {color,metalness?,roughness?},
// trail → {color}, frame → {color,style:'ring'|'glow'}. The default items
// (ball_classic / trail_none / frame_none) are always owned.
export type CosmeticSlot = 'ball' | 'trail' | 'frame';
export type CosmeticRarity = 'common' | 'rare' | 'epic';

// A single generic visual descriptor; only the keys relevant to the slot are
// present, but they're all optional so one type covers every slot.
export interface CosmeticVisual {
  color?: string;
  metalness?: number;
  roughness?: number;
  style?: 'ring' | 'glow';
}

export interface Cosmetic {
  id: string;
  slot: CosmeticSlot;
  name: string;
  rarity: CosmeticRarity;
  price: number;
  visual: CosmeticVisual;
}

// The equipped item id per slot. Always one of the owned ids (defaults are
// always owned), so these are never empty.
export interface EquippedCosmetics {
  ball: string;
  trail: string;
  frame: string;
}

export interface CosmeticsResponse {
  catalog: Cosmetic[];
  owned: string[];
  equipped: EquippedCosmetics;
}

export interface WalletLedgerEntry {
  delta: number;
  reason: string;
  ref: string | null;
  balanceAfter: number;
  createdAt: number;
}

export interface WalletResponse {
  balance: number;
  // Newest 20, server-ordered newest-first.
  ledger: WalletLedgerEntry[];
}

// A tier reward is EITHER coins or a cosmetic id — never both.
export type SeasonReward = { coins: number } | { cosmetic: string };

export interface SeasonTier {
  tier: number;
  xpRequired: number;
  reward: SeasonReward;
}

export interface SeasonResponse {
  seasonId: string;
  endsAt: number;
  xp: number;
  currentTier: number;
  tiers: SeasonTier[];
  claimed: number[];
  claimable: number[];
}

// The caller's best attempt on today's Daily Challenge (null until they play).
// Matches the `today` payload of GET /game/daily and POST /game/daily/result.
export interface DailyResult {
  strokes: number;
  toPar: number;
  score: number;
}

// The caller's Daily Challenge streak: consecutive days played (`current`) and
// their all-time longest (`best`). Zeros before their first daily.
export interface DailyStreak {
  current: number;
  best: number;
}

// Today's Daily Challenge from GET /game/daily. The challenge is derived from
// the UTC date server-side (deterministic course/hole/seed); `today` is the
// caller's best attempt so far (null if unplayed) and `streak` their run.
export interface DailyChallenge {
  date: string;
  game: 'golfcourse';
  course: string;
  hole: number;
  seed: number;
  today: DailyResult | null;
  streak: DailyStreak;
}

// POST /game/daily/result response: the persisted best for today, the updated
// streak, and whether this attempt beat the caller's prior best for the day.
export interface DailyResultResponse {
  today: DailyResult;
  streak: DailyStreak;
  improved: boolean;
}

// One row of today's Daily Challenge leaderboard (GET /game/daily/leaderboard),
// contact-scoped and pre-ranked (higher score, then lower to-par). `mine` flags
// the caller's own row.
export interface DailyLeaderboardEntry {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  score: number;
  toPar: number;
  strokes: number;
  mine: boolean;
}

// ---- Rapid Tournaments ----

// One of the three holes of a tournament round. `course` is a real Course-mode
// id (augusta | listowel-*), `hole` is 1-based within that course.
export interface TournamentHoleRef {
  course: string;
  hole: number;
}

// The caller's current standing in a tournament: their round score (points,
// higher is better), to-par (negative = under par), total strokes and rank.
export interface TournamentEntry {
  score: number;
  toPar: number | null;
  strokes: number;
  rank: number;
}

// The live Rapid Tournament from GET /game/tournament. A fixed, seeded 3-hole
// round shared by everyone; `msLeft` counts down to `closesAt` (ms epoch). The
// UI ticks the countdown client-side from `msLeft` rather than trusting the
// device clock against `closesAt`. `entry` is the caller's standing (null until
// they play), `entrants` the field size.
export interface Tournament {
  // Numeric period index from the worker, not an opaque string.
  id: number;
  seed: number;
  holes: TournamentHoleRef[];
  openedAt: number;
  closesAt: number;
  msLeft: number;
  entrants: number;
  entry: TournamentEntry | null;
}

// POST /game/tournament/result response: the persisted standing (server keeps
// the caller's best), the updated field size, and whether this round beat their
// prior best for the event.
export interface TournamentResultResponse {
  entry: TournamentEntry;
  entrants: number;
  improved: boolean;
}

// One row of a tournament leaderboard (GET /game/tournament/leaderboard),
// pre-ranked (higher score, then lower to-par), top 25. `mine` flags the
// caller's own row. Same shape idiom as DailyLeaderboardEntry.
export interface TournamentLeaderboardEntry {
  userId: string;
  displayName: string;
  pin: string;
  avatarUrl: string | null;
  score: number;
  toPar: number;
  strokes: number;
  mine: boolean;
}

// The caller's lifetime tournament trophy case (GET /game/tournament/me).
// `bestRank` is null until they finish an event.
export interface TournamentTrophies {
  trophies: number;
  golds: number;
  podiums: number;
  bestRank: number | null;
  eventsPlayed: number;
}

// One past tournament placement, newest first. `rank` is the caller's finish,
// `trophies` the trophies that placement earned; `closesAt`/`createdAt` are
// epoch ms.
export interface TournamentPlacement {
  // Numeric period index from the worker, not an opaque string.
  tournamentId: number;
  rank: number;
  trophies: number;
  closesAt: number;
  createdAt: number;
}

// The caller's tournament profile from GET /game/tournament/me: the aggregate
// trophy case plus a list of recent placements.
export interface TournamentMe {
  trophies: TournamentTrophies;
  placements: TournamentPlacement[];
}

// One side of an async golf challenge. `toPar` is null until that player has
// submitted their result (lower to-par wins). Matches the worker's
// readChallengeShaped() output in games.ts.
export interface ChallengeParticipant {
  userId: string;
  displayName: string;
  avatarUrl: string | null;
  toPar: number | null;
}

// An async friend golf challenge over a shared seed. `status` is 'pending'
// until both sides submit, then 'complete'; `winnerId` is the lower-to-par
// player, or null for a tie (or while pending). `mine` says which side the
// current caller is.
export interface Challenge {
  id: string;
  game: string;
  course: string | null;
  hole: number | null;
  seed: number;
  status: 'pending' | 'complete';
  challenger: ChallengeParticipant;
  opponent: ChallengeParticipant;
  winnerId: string | null;
  mine: 'challenger' | 'opponent';
  createdAt: number;
  // Nominal stake: coins on the line for the winner (worker-set). Shown on the
  // LIVE card as the stake. Optional/additive: older worker builds omit it, so
  // the card hides the stake line rather than showing "0 coins".
  rewardCoins?: number;
  // Coins the viewer ACTUALLY received when the match settled (0 if they lost or
  // hit the daily cap). Present on completed challenges only; the outcome
  // headline reads THIS, not the nominal stake, so a capped win isn't a lie.
  rewardCoinsAwarded?: number;
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
  // Denormalized sender identity from the server for history fetches.
  // Undefined for messages that arrived live over the WebSocket — the
  // Chat renderer falls back to the contacts list for those.
  senderName?: string | null;
  senderAvatarUrl?: string | null;
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
  // delivered/read carry the "any recipient" booleans for groups, and
  // the plain per-recipient state for 1to1 — matches the existing
  // semantics so callers that only care about a yes/no don't need to
  // change. The new triple (deliveredCount, readCount, totalRecipients)
  // is sender-view-only (undefined for messages I didn't send) and
  // drives the BBM-style gray-D-when-partial / colored-D-when-all
  // rendering in the Receipt component.
  delivered: boolean;
  read: boolean;
  deliveredCount?: number;
  readCount?: number;
  totalRecipients?: number;
  // Message body is encrypted at rest (not end-to-end). Optional so legacy
  // messages without the flag simply render no lock.
  encrypted?: boolean;
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
      // External media URL. Carries Giphy CDN URLs for GIFs and the
      // bundled-asset URL for stickers. Stickers ride the type='image'
      // rail; the client discriminates via the /stickers/*.svg URL
      // pattern (see lib/stickers.ts isStickerUrl).
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
      // Body is encrypted at rest on the server.
      encrypted?: boolean;
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
  | {
      // Fan-out for a PING. The sender's own UserHub echoes this back to
      // their sockets too, so a ping lands live on both sides.
      // `id`/`sequence` identify the row ChatRoom persisted; they're
      // optional because a client may be talking to a worker that
      // predates them — receivers fall back to a synthetic id.
      t: 'ping';
      chatId: string;
      from: string;
      ts: number;
      id?: string;
      sequence?: number;
    }
  | { t: 'recalled'; messageId: string; chatId: string; ts: number }
  | { t: 'edited'; messageId: string; chatId: string; body: string; editedAt: number }
  | {
      // Group membership change. Sent to every current member of the
      // chat after a successful add. Receiving member_joined with
      // userId === me is the "I was added to a new chat" signal —
      // the client refreshes /chats so the new chat appears.
      t: 'member_joined';
      chatId: string;
      userId: string;
      displayName: string;
      avatarUrl: string | null;
      joinedAt: number;
    }
  | {
      // Sent to remaining group members after someone leaves. The
      // leaver doesn't receive this — they update locally on success
      // of their own DELETE /chats/:id.
      t: 'member_left';
      chatId: string;
      userId: string;
    }
  | {
      // Sent to every current member of a group after the subject or
      // avatar changes. The editor receives it too — supports the
      // "edit on device A, see on device B" multi-device case.
      t: 'group_updated';
      chatId: string;
      subject: string | null;
      avatarUrl: string | null;
    }
  | { t: 'error'; code: string; message?: string };
