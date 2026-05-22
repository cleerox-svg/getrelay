import type {
  Chat,
  Contact,
  ContactStatus,
  GroupMember,
  Me,
  SportsGame,
  SportsGameDetail,
  SportsSub,
  SportsTeamLists,
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
  }) => request<{ ok: true }>('/me', { method: 'PATCH', body: JSON.stringify(body) }),
  getSportsSubs: () =>
    request<{ subs: { league: 'NHL' | 'MLB'; teamKey: string }[] }>('/me/sports/subs'),
  setSportsSubs: (subs: { league: 'NHL' | 'MLB'; teamKey: string }[]) =>
    request<{ ok: boolean; count: number }>('/me/sports/subs', {
      method: 'PUT',
      body: JSON.stringify({ subs }),
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
  listFeed: () => request<{ statuses: ContactStatus[] }>('/feed'),
  getSports: () =>
    request<{ games: SportsGame[]; subs: SportsSub[] }>('/sports'),
  getSportsTeams: () => request<SportsTeamLists>('/sports/teams'),
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
      }[];
      next: string | null;
    }>(`/gifs/search?${usp.toString()}`);
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
}

export const GOOGLE_SIGNIN_URL = `${API_BASE}/auth/google`;
