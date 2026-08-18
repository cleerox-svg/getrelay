import type {
  Challenge,
  Chat,
  Contact,
  ContactStatus,
  CosmeticSlot,
  CosmeticsResponse,
  DailyChallenge,
  DailyLeaderboardEntry,
  DailyResultResponse,
  FeedEvent,
  GameLeaderboardEntry,
  GolfStats,
  GroupMember,
  Me,
  SportsGame,
  SportsGameDetail,
  SportsNewsArticle,
  SportsStatsResponse,
  SportsSub,
  SportsTeamLists,
  SeasonReward,
  SeasonResponse,
  Tournament,
  TournamentLeaderboardEntry,
  TournamentMe,
  TournamentResultResponse,
  WalletResponse,
} from './types';

export const API_BASE = (import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787').replace(
  /\/+$/,
  '',
);

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message?: string,
  ) {
    super(message ?? code);
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    credentials: 'include',
    headers: {
      'content-type': 'application/json',
      ...(init.headers ?? {}),
    },
    ...init,
  });
  if (!res.ok) {
    let code = 'http_error';
    try {
      const body = (await res.json()) as { error?: string };
      if (body.error) code = body.error;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, code);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const api = {
  health: () => request<{ ok: boolean; service: string }>('/health'),
  me: () => request<Me>('/me'),
  updateMe: (body: {
    displayName?: string;
    statusMessage?: string;
    sportsNotifications?: boolean;
    sportsNotifyStart?: boolean;
    sportsNotifyScore?: boolean;
    sportsNotifyFinal?: boolean;
    gameFeedShared?: boolean;
  }) => request<{ ok: true }>('/me', { method: 'PATCH', body: JSON.stringify(body) }),
  getSportsSubs: () =>
    request<{ subs: { league: 'NHL' | 'MLB'; teamKey: string }[] }>('/me/sports/subs'),
  setSportsSubs: (subs: { league: 'NHL' | 'MLB'; teamKey: string }[]) =>
    request<{ ok: boolean; count: number }>('/me/sports/subs', {
      method: 'PUT',
      body: JSON.stringify({ subs }),
    }),
  sportsNews: () => request<{ articles: SportsNewsArticle[] }>('/sports/news'),
  sportsStats: () => request<SportsStatsResponse>('/sports/stats'),
  // Native (Capacitor) Google sign-in: exchange a Google ID token obtained
  // by the platform plugin for a Relay session cookie. The web build uses
  // the redirect flow (GOOGLE_SIGNIN_URL) instead.
  googleNativeSignIn: (idToken: string) =>
    request<{ ok: true; isNew: boolean }>('/auth/google/native', {
      method: 'POST',
      body: JSON.stringify({ idToken }),
    }),
  signout: () => request<void>('/auth/signout', { method: 'POST' }),
  uploadAvatar: async (file: File): Promise<{ ok: boolean; key: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/me/avatar`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      let code = 'http_error';
      try {
        const b = (await res.json()) as { error?: string };
        if (b.error) code = b.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as { ok: boolean; key: string };
  },
  removeAvatar: () => request<{ ok: true }>('/me/avatar', { method: 'DELETE' }),
  uploadMedia: async (
    file: File,
  ): Promise<{ ok: boolean; key: string; url: string; contentType: string; bytes: number }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(`${API_BASE}/me/media`, {
      method: 'POST',
      credentials: 'include',
      body: form,
    });
    if (!res.ok) {
      let code = 'http_error';
      try {
        const b = (await res.json()) as { error?: string };
        if (b.error) code = b.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as {
      ok: boolean;
      key: string;
      url: string;
      contentType: string;
      bytes: number;
    };
  },
  listContacts: () => request<{ contacts: Contact[] }>('/contacts'),
  addContact: (pin: string) =>
    request<{ ok: boolean; contactId: string }>('/contacts/add', {
      method: 'POST',
      body: JSON.stringify({ pin }),
    }),
  listBlocks: () =>
    request<{
      blocked: {
        id: string;
        pin: string;
        displayName: string;
        statusMessage: string | null;
        avatarUrl: string | null;
        blockedAt: number;
      }[];
    }>('/me/blocks'),
  blockUser: (userId: string) =>
    request<{ ok: true }>('/me/blocks', {
      method: 'POST',
      body: JSON.stringify({ userId }),
    }),
  unblockUser: (userId: string) =>
    request<{ ok: true }>(`/me/blocks/${encodeURIComponent(userId)}`, { method: 'DELETE' }),
  listChats: () => request<{ chats: Chat[] }>('/chats'),
  openOneToOne: (contactId: string) =>
    request<{ id: string; type: '1to1'; createdAt: number; created: boolean }>('/chats/1to1', {
      method: 'POST',
      body: JSON.stringify({ contactId }),
    }),
  patchChat: (chatId: string, body: { muted?: boolean; pinned?: boolean }) =>
    request<{ ok: true }>(`/chats/${encodeURIComponent(chatId)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  deleteChat: (chatId: string) =>
    request<{ ok: true }>(`/chats/${encodeURIComponent(chatId)}`, { method: 'DELETE' }),
  // `events` is the merged status + Fog activity feed. It's optional
  // because the worker deploys independently of the UI — against an
  // older worker the field is simply absent and callers fall back to
  // synthesising the feed from `statuses`.
  listFeed: () => request<{ statuses: ContactStatus[]; events?: FeedEvent[] }>('/feed'),
  getSports: (date?: string) =>
    request<{ games: SportsGame[]; subs: SportsSub[] }>(
      date ? `/sports?date=${encodeURIComponent(date)}` : '/sports',
    ),
  // ?v=2 is a client-side cache-bust to match the worker-side cache
  // key bump in PR #81 — without it, browsers that loaded the defunct-
  // team list before the worker fix can keep serving that response
  // from their HTTP cache for up to 24h. Bumping the query param
  // makes the URL distinct from the browser cache's perspective so it
  // refetches immediately. (The worker doesn't read this param; it
  // serves the response from its internal `?v=2`-keyed cache entry.)
  getSportsTeams: () => request<SportsTeamLists>('/sports/teams?v=2'),
  getSportsGame: (league: 'nhl' | 'mlb', id: string, teamKey?: string) => {
    const params = new URLSearchParams();
    if (teamKey) {
      // NHL passes the abbrev as `abbr`; MLB passes the numeric team id
      // as `teamId`. The worker uses whichever matches the league.
      params.set(league === 'nhl' ? 'abbr' : 'teamId', teamKey);
    }
    const qs = params.toString();
    return request<SportsGameDetail>(
      `/sports/${league}/${encodeURIComponent(id)}${qs ? `?${qs}` : ''}`,
    );
  },
  searchGifs: (q: string, pos?: string) => {
    const usp = new URLSearchParams();
    if (q) usp.set('q', q);
    if (pos) usp.set('pos', pos);
    return request<{
      items: {
        id: string;
        description: string;
        previewUrl: string;
        previewWidth: number;
        previewHeight: number;
        gifUrl: string;
        gifWidth: number;
        gifHeight: number;
        // Static first frame (Giphy 480w_still). Optional until the
        // worker deploy that adds it lands — consumers must fall back
        // to previewUrl.
        stillUrl?: string | null;
        analytics: { onload?: string; onclick?: string; onsent?: string };
      }[];
      next: string | null;
    }>(`/gifs/search?${usp.toString()}`);
  },
  // Album-art search for the Fog game, proxied through the worker's
  // iTunes Search proxy (no key, but the proxy caches + trims the
  // payload). `term` is a genre/style seed; the caller picks one album
  // as the answer (artist) and others as same-genre distractors.
  searchMusic: (term: string) => {
    const usp = new URLSearchParams();
    usp.set('term', term);
    return request<{
      items: {
        id: string;
        artistName: string;
        collectionName: string;
        artworkUrl: string;
        genre: string;
      }[];
    }>(`/itunes/search?${usp.toString()}`);
  },
  // Song-preview search for the "Guess the Tune" game, proxied through
  // the worker's iTunes Search proxy (no key). The worker pre-filters to
  // tracks that actually carry a preview clip and returns hi-res
  // artwork. `term` is an artist/genre seed; the caller picks one track
  // as the answer (title) and others as same-genre distractors. iTunes
  // Search has no offset/pagination, so variety comes from the seed pool.
  searchTunes: (term: string) => {
    const usp = new URLSearchParams();
    usp.set('term', term);
    return request<{
      items: {
        trackId: string;
        previewUrl: string;
        title: string;
        artist: string;
        genre: string;
        artworkUrl: string;
        // Apple Music / iTunes track page URL for the reveal-screen
        // "listen to the full song" deep-link. Optional/possibly '' —
        // older workers omit it, so consumers must tolerate its absence.
        trackViewUrl?: string;
      }[];
    }>(`/tunes/search?${usp.toString()}`);
  },
  // Resolve the EXACT Spotify track link for the "Guess the Tune" reveal
  // screen. The worker looks the track up on Spotify and returns its
  // canonical `open.spotify.com/track/...` URL, or `{ url: null }` when
  // Spotify isn't configured, nothing matched, or the upstream errored.
  // Best-effort only: any thrown error resolves to `{ url: null }` so the
  // reveal always keeps its search-URL fallback — this never rejects.
  resolveSpotify: (title: string, artist: string): Promise<{ url: string | null }> => {
    const usp = new URLSearchParams();
    usp.set('title', title);
    usp.set('artist', artist);
    return request<{ url: string | null }>(`/tunes/spotify?${usp.toString()}`).catch(() => ({
      url: null,
    }));
  },
  // Shared score submit for the mini games. Server clamps rounds to
  // 1..8 and score to rounds*2000 — the client-side tuning
  // (lib/fog/tuning.ts, lib/tune/tuning.ts) must stay within those
  // bounds so local and server bests agree. `game` selects the board;
  // it defaults to 'fog' so existing Fog callers stay unchanged.
  submitGameScore: (body: {
    score: number;
    rounds: number;
    bestStreak: number;
    // Mirrors relay-worker/src/games.ts GAME_IDS. 'bbderby' is the baseball
    // Home Run Derby; the worker has accepted it since the games table landed.
    game?: 'fog' | 'tune' | 'golf' | 'golfrange' | 'golfcourse' | 'bbderby';
    // Golf-only, both optional: the course played and the run's to-par
    // (negative = under par). The server stores them as cosmetic metadata;
    // a bad course is dropped silently, a bad toPar is a 400.
    course?: string;
    toPar?: number;
  }) =>
    request<{ ok: true; best: number }>('/game/score', {
      method: 'POST',
      body: JSON.stringify({ game: 'fog', ...body }),
    }),
  getGameLeaderboard: (
    period: 'weekly' | 'all',
    game: 'fog' | 'tune' | 'golf' | 'golfrange' | 'golfcourse' = 'fog',
  ) =>
    request<{ entries: GameLeaderboardEntry[] }>(
      `/game/leaderboard?period=${period}&game=${game}`,
    ),
  // The caller's personal golf profile — aggregate stats, per-course
  // breakdowns and recent rounds. Not contact-scoped (401 if unauthed).
  // ⚠ A rejection here is UNKNOWN, not "no rounds": GolfProfile renders the
  // failure with a Retry unless another request proved a history.
  getGolfStats: (game: 'golf' | 'golfrange' | 'golfcourse') =>
    request<GolfStats>(`/game/golf-stats?game=${game}`),
  // Golf personal best-shot records (longest drive, closest-to-pin, longest
  // holed putt), persisted per-account. GET returns the caller's current bests.
  // A rejection (401 / offline) must not be rendered as "no records" — see
  // GolfProfile, which reports the failed load and offers a Retry.
  getGolfRecords: () => request<{ records: GolfRecords }>('/game/golf-records'),
  // POST end-of-hole candidates — send ONLY the metrics this hole produced (all
  // optional). The server upserts-on-improve (MAX drive/putt, MIN closest) and
  // reports which improved plus the read-after-write records. Do NOT send
  // timestamps. Values are whole yards.
  postGolfRecords: (body: {
    longestDriveYards?: number;
    longestDriveHole?: number;
    closestToPinYards?: number;
    closestToPinHole?: number;
    longestPuttYards?: number;
    longestPuttHole?: number;
  }) =>
    request<{ improved: GolfRecordsImproved; records: GolfRecords }>('/game/golf-records', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Open an async golf challenge against a contact. The opponent must be one of
  // the caller's contacts and not blocked either way (else 4xx). `hole` is
  // optional (single-hole challenge). Returns the shaped challenge.
  createChallenge: (body: {
    opponentId: string;
    game: 'golf' | 'golfrange' | 'golfcourse';
    course: string | null;
    hole?: number;
  }) =>
    request<{ challenge: Challenge }>('/game/challenge', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Submit the caller's to-par for a challenge (lower wins). The first
  // submission per side sticks — re-submits are ignored server-side. Once both
  // sides are in the challenge completes and `winnerId` is settled.
  submitChallengeResult: (id: string, toPar: number) =>
    request<{ challenge: Challenge }>(
      `/game/challenge/${encodeURIComponent(id)}/result`,
      { method: 'POST', body: JSON.stringify({ toPar }) },
    ),
  // Fetch a challenge the caller participates in (404 otherwise).
  getChallenge: (id: string) =>
    request<{ challenge: Challenge }>(`/game/challenge/${encodeURIComponent(id)}`),
  // Today's Daily Challenge — a single seeded Course hole derived from the UTC
  // date server-side, plus the caller's best attempt today (null if unplayed)
  // and their streak. A rejection (401 / offline / timeout) renders GolfDaily's
  // "needs connection" state with a Retry — never an empty challenge.
  getDaily: () => request<DailyChallenge>('/game/daily'),
  // Submit today's finished hole: strokes + to-par. The server trusts its own
  // UTC day (omit the date) and keeps the caller's BEST for the day, so a replay
  // is safe. Returns the persisted best, the updated streak, and whether this
  // attempt improved it. 400 invalid_result on a bad body.
  postDailyResult: (body: { strokes: number; toPar: number }) =>
    request<DailyResultResponse>('/game/daily/result', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // Today's Daily Challenge leaderboard — contact-scoped, pre-ranked, each row
  // flagged `mine`. Same shape idiom as getGameLeaderboard.
  getDailyLeaderboard: () =>
    request<{ entries: DailyLeaderboardEntry[] }>('/game/daily/leaderboard'),
  // The live Rapid Tournament — a fixed, seeded 3-hole round shared by everyone,
  // open until `closesAt`. Carries the 3 holes (course + 1-based hole no.), the
  // countdown (`msLeft`), the field size and the caller's current standing
  // (`entry`, null until they play). A rejection (401 / offline / timeout)
  // renders GolfTournaments' "needs connection" state with a Retry.
  getTournament: () => request<Tournament>('/game/tournament'),
  // Submit the caller's finished 3-hole ROUND total (to-par + total strokes).
  // The server keeps the caller's BEST for the event, so a replay is safe, and
  // returns the persisted standing, the updated field size and whether this
  // round improved. 409 tournament_closed once the event has ended;
  // 400 invalid_result on a bad body.
  postTournamentResult: (body: { toPar: number; strokes: number }) =>
    request<TournamentResultResponse>('/game/tournament/result', {
      method: 'POST',
      body: JSON.stringify(body),
    }),
  // The tournament leaderboard — top 25, pre-ranked, each row flagged `mine`.
  // `scope` picks the global board (default) or the caller's friends-only board.
  getTournamentLeaderboard: (scope: 'global' | 'friends' = 'global') =>
    request<{ entries: TournamentLeaderboardEntry[] }>(
      `/game/tournament/leaderboard?scope=${scope}`,
    ),
  // The caller's lifetime tournament trophy case + recent placements. A
  // rejection is UNKNOWN, not an empty trophy case — GolfProfile counts it as a
  // failed load rather than rendering zeros as fact.
  getTournamentMe: () => request<TournamentMe>('/game/tournament/me'),
  // ---- Golf economy (coins wallet, cosmetics, season) -------------------
  // The caller's coin wallet: current balance + newest 20 ledger entries.
  // ⚠ A rejection is NOT an empty wallet: the economy store marks the slice
  // 'error' (keeping any balance it already knew) and the UI shows a retryable
  // failure. "Degrade to a hidden/empty wallet" is what rendered a 670-coin
  // wallet as "Need more coins" — see lib/golf/economy.ts.
  getWallet: () => request<WalletResponse>('/economy/wallet'),
  // The full cosmetics catalog plus which the caller owns + has equipped per
  // slot. Defaults (ball_classic / trail_none / frame_none) are always owned.
  getCosmetics: () => request<CosmeticsResponse>('/economy/cosmetics'),
  // Buy a cosmetic with coins. 400 unknown_cosmetic | already_owned |
  // insufficient_funds. Returns the new balance so the wallet can update.
  purchaseCosmetic: (cosmeticId: string) =>
    request<{ ok: true; cosmeticId: string; balance: number }>(
      '/economy/cosmetics/purchase',
      { method: 'POST', body: JSON.stringify({ cosmeticId }) },
    ),
  // Equip an OWNED cosmetic into its slot. 400 unknown_cosmetic | wrong_slot |
  // not_owned. Returns the full equipped map (all three slots).
  equipCosmetic: (slot: CosmeticSlot, cosmeticId: string) =>
    request<{ ok: true; equipped: { ball: string; trail: string; frame: string } }>(
      '/economy/cosmetics/equip',
      { method: 'POST', body: JSON.stringify({ slot, cosmeticId }) },
    ),
  // The current season track: XP, tier ladder, which tiers are claimed /
  // claimable, and the season end (`endsAt`). A rejection is a retryable
  // 'error' on the season slice, never "no active season".
  getSeason: () => request<SeasonResponse>('/economy/season'),
  // Claim a claimable season tier's reward (coins or a cosmetic). 400
  // unknown_tier | tier_locked | already_claimed. Returns the updated
  // claimed/claimable sets and the new balance (for a coin reward).
  claimSeasonTier: (tier: number) =>
    request<{
      ok: true;
      tier: number;
      reward: SeasonReward;
      claimed: number[];
      claimable: number[];
      balance: number;
    }>('/economy/season/claim', {
      method: 'POST',
      body: JSON.stringify({ tier }),
    }),
  // Giphy Action Register pingback. Best-effort: failures are swallowed so
  // analytics never interferes with sending a GIF.
  registerGifAction: (url: string | undefined, randomId: string) => {
    if (!url) return;
    request<void>('/gifs/register', {
      method: 'POST',
      body: JSON.stringify({ url, randomId }),
    }).catch(() => undefined);
  },
  createGroup: (subject: string, contactIds: string[]) =>
    request<{
      id: string;
      type: 'group';
      subject: string;
      createdAt: number;
      memberCount: number;
    }>('/chats/group', {
      method: 'POST',
      body: JSON.stringify({ subject, contactIds }),
    }),
  addGroupMembers: (chatId: string, contactIds: string[]) =>
    request<{ ok: boolean; added: number }>(
      `/chats/${encodeURIComponent(chatId)}/participants`,
      { method: 'POST', body: JSON.stringify({ contactIds }) },
    ),
  listChatMembers: (chatId: string) =>
    request<{ members: GroupMember[] }>(
      `/chats/${encodeURIComponent(chatId)}/members`,
    ),
  renameGroup: (chatId: string, subject: string) =>
    request<{ ok: boolean; subject: string }>(
      `/chats/${encodeURIComponent(chatId)}`,
      { method: 'PATCH', body: JSON.stringify({ subject }) },
    ),
  uploadGroupAvatar: async (
    chatId: string,
    file: File,
  ): Promise<{ ok: boolean; key: string }> => {
    const form = new FormData();
    form.append('file', file);
    const res = await fetch(
      `${API_BASE}/chats/${encodeURIComponent(chatId)}/avatar`,
      { method: 'POST', credentials: 'include', body: form },
    );
    if (!res.ok) {
      let code = 'http_error';
      try {
        const b = (await res.json()) as { error?: string };
        if (b.error) code = b.error;
      } catch {
        /* ignore */
      }
      throw new ApiError(res.status, code);
    }
    return (await res.json()) as { ok: boolean; key: string };
  },
  removeGroupAvatar: (chatId: string) =>
    request<{ ok: true }>(
      `/chats/${encodeURIComponent(chatId)}/avatar`,
      { method: 'DELETE' },
    ),
  listChatMessages: (chatId: string, opts?: { before?: number; limit?: number }) => {
    const qs = new URLSearchParams();
    if (opts?.before != null) qs.set('before', String(opts.before));
    if (opts?.limit != null) qs.set('limit', String(opts.limit));
    const suffix = qs.toString() ? `?${qs.toString()}` : '';
    return request<{ messages: HistoryMessage[]; hasMore: boolean }>(
      `/chats/${encodeURIComponent(chatId)}/messages${suffix}`,
    );
  },
};

// A single golf best-shot record (or null when never set). `hole` is which hole
// produced it; `at` is the server timestamp (ms). Matches the worker's
// shapeGolfRecords() output in games.ts.
export interface GolfRecordMetric {
  yards: number;
  hole: number | null;
  at: number | null;
}
export interface GolfRecords {
  longestDrive: GolfRecordMetric | null;
  closestToPin: GolfRecordMetric | null;
  longestPutt: GolfRecordMetric | null;
}
export interface GolfRecordsImproved {
  longestDrive: boolean;
  closestToPin: boolean;
  longestPutt: boolean;
}

export interface HistoryMessage {
  id: string;
  chatId: string;
  from: string;
  // Denormalized by the server (JOIN users) so each historical
  // message knows its sender's display name + avatar without the
  // client having to maintain a per-chat members cache.
  senderName?: string | null;
  senderAvatarUrl?: string | null;
  sequence: number;
  type: string;
  body: string | null;
  mediaKey: string | null;
  mediaUrl: string | null;
  replyTo: {
    id: string;
    from: string;
    fromName: string;
    preview: string;
  } | null;
  reactions: { emoji: string; count: number; mine: boolean }[];
  ts: number;
  editedAt: number | null;
  deletedAt: number | null;
  delivered: boolean;
  read: boolean;
  // Sender-view-only aggregate (omitted for messages the caller
  // didn't send). Drives the BBM-style gray-D / colored-D rendering
  // for groups; for 1to1 total is always 1 so the counts collapse.
  deliveredCount?: number;
  readCount?: number;
  totalRecipients?: number;
  // Body is stored encrypted at rest on the server.
  encrypted?: boolean;
}

export const GOOGLE_SIGNIN_URL = `${API_BASE}/auth/google`;
