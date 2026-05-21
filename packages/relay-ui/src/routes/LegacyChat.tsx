import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { GroupAvatar } from '../components/GroupAvatar';
import { ApiError, api } from '../lib/api';
import { useStore } from '../lib/store';
import type { UiMessage } from '../lib/types';

const LEGACY_REACTION_PALETTE = ['👍', '❤️', '😂', '😯', '😢', '🎉'];

function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
}
function dayLabel(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const yesterday = new Date();
  yesterday.setDate(today.getDate() - 1);
  if (dayKey(ts) === dayKey(today.getTime())) return 'Today';
  if (dayKey(ts) === dayKey(yesterday.getTime())) return 'Yesterday';
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
}
function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
function isVideoKey(key: string | null | undefined): boolean {
  if (!key) return false;
  return /\.(mp4|webm|mov)$/i.test(key);
}

export function LegacyChat() {
  const params = useParams();
  const chatId = decodeURIComponent(params.id ?? '');
  const nav = useNavigate();
  const me = useStore((s) => s.me);
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const chatState = useStore((s) => s.byChat[chatId]);
  const presence = useStore((s) => s.presence);
  const ensureChatState = useStore((s) => s.ensureChatState);
  const subscribeChat = useStore((s) => s.subscribeChat);
  const unsubscribeChat = useStore((s) => s.unsubscribeChat);
  const sendText = useStore((s) => s.sendText);
  const sendPing = useStore((s) => s.sendPing);
  const sendMedia = useStore((s) => s.sendMedia);
  const sendTyping = useStore((s) => s.sendTyping);
  const markRead = useStore((s) => s.markRead);
  const react = useStore((s) => s.react);
  const loadChatHistory = useStore((s) => s.loadChatHistory);
  const loadChats = useStore((s) => s.loadChats);
  const chats = useStore((s) => s.chats);

  const [input, setInput] = useState('');
  const [replyingTo, setReplyingTo] = useState<UiMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<UiMessage | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTypingRef = useRef(false);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    ensureChatState(chatId);
    loadChatHistory(chatId).catch(() => undefined);
    subscribeChat(chatId);
    return () => unsubscribeChat(chatId);
  }, [chatId, ensureChatState, loadChatHistory, subscribeChat, unsubscribeChat]);

  useEffect(() => {
    if (chats.length === 0) loadChats().catch(() => undefined);
  }, [chats.length, loadChats]);

  const messages = chatState?.messages ?? [];

  useEffect(() => {
    if (!me) return;
    const unread = messages
      .filter((m) => m.from !== me.id && !m.read && !m.deletedAt && m.id && !m.tempId)
      .map((m) => m.id);
    if (unread.length > 0) markRead(chatId, unread);
  }, [messages, chatId, me, markRead]);

  useEffect(() => {
    let cancelled = false;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        if (cancelled) return;
        bottomRef.current?.scrollIntoView({ block: 'end' });
      });
    });
    return () => {
      cancelled = true;
    };
  }, [chatId, messages.length, JSON.stringify(chatState?.typing ?? {})]);

  // Keep the most recent message on screen when the soft keyboard opens
  // or closes — see Chat.tsx for the matching effect / rationale.
  useEffect(() => {
    const vv = typeof window !== 'undefined' ? window.visualViewport : null;
    let raf = 0;
    const scrollSoon = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        bottomRef.current?.scrollIntoView({ block: 'end' });
      });
    };
    const onFocusIn = (e: FocusEvent) => {
      const tgt = e.target as HTMLElement | null;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA')) {
        setTimeout(scrollSoon, 250);
      }
    };
    vv?.addEventListener('resize', scrollSoon);
    vv?.addEventListener('scroll', scrollSoon);
    document.addEventListener('focusin', onFocusIn);
    return () => {
      cancelAnimationFrame(raf);
      vv?.removeEventListener('resize', scrollSoon);
      vv?.removeEventListener('scroll', scrollSoon);
      document.removeEventListener('focusin', onFocusIn);
    };
  }, []);

  const isGroup = chat?.type === 'group';
  const peerOnline = chat?.peer ? presence[chat.peer.id]?.online ?? false : false;
  const peerName = isGroup ? chat?.subject ?? 'Group' : chat?.peer?.displayName ?? 'Chat';
  const subLine = isGroup
    ? `${chat?.memberCount ?? '–'} members`
    : (chat?.peer?.statusMessage?.trim() ||
        (peerOnline ? 'available' : chat?.peer?.pin || ''));

  const typingNames = useMemo(() => {
    if (!chatState || !me) return [];
    return Object.entries(chatState.typing)
      .filter(([uid, on]) => on && uid !== me.id)
      .map(([uid]) => (uid === chat?.peer?.id ? chat.peer.displayName : 'Someone'));
  }, [chatState, me, chat]);

  function submit() {
    const text = input.trim();
    if (!text) return;
    sendText(chatId, text, replyingTo?.id);
    setInput('');
    setReplyingTo(null);
    if (sentTypingRef.current) {
      sendTyping(chatId, false);
      sentTypingRef.current = false;
    }
  }

  function onInputChange(v: string) {
    setInput(v);
    if (!sentTypingRef.current && v.length > 0) {
      sendTyping(chatId, true);
      sentTypingRef.current = true;
    }
    if (typingTimer.current) clearTimeout(typingTimer.current);
    typingTimer.current = setTimeout(() => {
      if (sentTypingRef.current) {
        sendTyping(chatId, false);
        sentTypingRef.current = false;
      }
    }, 2500);
  }

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const result = await api.uploadMedia(file);
      const caption = input.trim();
      sendMedia(chatId, result.key, result.url, caption || undefined, replyingTo?.id);
      setInput('');
      setReplyingTo(null);
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'too_large') setUploadError('Files up to 10 MB.');
        else if (err.code === 'bad_type') setUploadError('Unsupported file type.');
        else setUploadError(err.code);
      } else setUploadError('Upload failed');
    } finally {
      setUploading(false);
    }
  }

  // Classic rendering: each message is a white card with sender name + body +
  // timestamp. Sent messages tint pale blue, received stay white. Grouped
  // by day separator, lined up vertically (no opposing alignment).
  const stacked: React.ReactNode[] = [];
  let lastDay = '';
  for (const m of messages) {
    const k = dayKey(m.ts);
    if (k !== lastDay) {
      stacked.push(
        <div
          key={`day-${k}`}
          style={{
            alignSelf: 'center',
            background: 'var(--legacy-separator)',
            color: 'var(--legacy-text-dim)',
            fontSize: 11,
            fontWeight: 600,
            padding: '2px 10px',
            borderRadius: 999,
            margin: '6px 0',
          }}
        >
          {dayLabel(m.ts)}
        </div>,
      );
      lastDay = k;
    }
    const mine = m.from === me?.id;
    const recalled = !!m.deletedAt;
    const isPing = m.type === 'ping';
    const hasMedia = !!m.mediaKey && !!m.mediaUrl;
    const senderName = mine
      ? me?.displayName ?? 'Me'
      : chat?.peer?.id === m.from
        ? chat?.peer?.displayName ?? '?'
        : `User ${m.from.slice(0, 4)}`;
    const senderAvatarSrc = mine
      ? me?.avatarUrl ?? null
      : chat?.peer?.id === m.from
        ? chat?.peer?.avatarUrl ?? null
        : null;

    if (isPing) {
      stacked.push(
        <div
          key={m.id}
          style={{
            alignSelf: 'center',
            background: 'var(--legacy-ping, #E5443B)',
            color: '#FFFFFF',
            fontWeight: 700,
            fontSize: 12,
            padding: '4px 12px',
            borderRadius: 999,
            margin: '2px 0',
            letterSpacing: 0.5,
          }}
        >
          PING!!
        </div>,
      );
      continue;
    }

    stacked.push(
      <article
        key={m.id}
        className={`legacy-message-card${mine ? ' mine' : ''}`}
        style={{ opacity: m.pending ? 0.7 : 1, cursor: recalled ? 'default' : 'pointer' }}
        onClick={() => {
          if (!recalled) setActionsFor(m);
        }}
      >
        <Avatar src={senderAvatarSrc} name={senderName} size={32} />
        <div className="l-body-col">
          <div className="l-head">
            <span className="l-from">{senderName}</span>
          </div>
          {m.replyTo && !recalled ? (
            <div
              style={{
                marginBottom: 6,
                paddingLeft: 8,
                borderLeft: '3px solid var(--legacy-blue)',
                opacity: 0.85,
              }}
            >
              <div
                style={{
                  fontSize: 11,
                  fontWeight: 700,
                  color: 'var(--legacy-blue)',
                }}
              >
                {m.replyTo.from === me?.id ? 'You' : m.replyTo.fromName}
              </div>
              <div
                style={{
                  fontSize: 12,
                  whiteSpace: 'nowrap',
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  color: 'var(--legacy-text-dim)',
                }}
              >
                {m.replyTo.preview}
              </div>
            </div>
          ) : null}
          {recalled ? (
            <em style={{ color: 'var(--legacy-text-dim)' }}>Message recalled</em>
          ) : hasMedia ? (
            <>
              {isVideoKey(m.mediaKey) ? (
                <video
                  src={m.mediaUrl ?? undefined}
                  controls
                  playsInline
                  className="l-image"
                  style={{ background: '#000' }}
                />
              ) : (
                <a href={m.mediaUrl ?? undefined} target="_blank" rel="noreferrer">
                  <img
                    className="l-image"
                    src={m.mediaUrl ?? undefined}
                    alt=""
                    onError={(e) => {
                      const img = e.currentTarget;
                      img.style.display = 'none';
                      const sib = img.nextElementSibling as HTMLElement | null;
                      if (sib) sib.style.display = 'block';
                    }}
                  />
                  <span
                    style={{
                      display: 'none',
                      padding: '20px 12px',
                      textAlign: 'center',
                      color: 'var(--legacy-text-dim)',
                      fontStyle: 'italic',
                    }}
                  >
                    Image unavailable
                  </span>
                </a>
              )}
              {m.body ? <div className="l-text" style={{ marginTop: 6 }}>{m.body}</div> : null}
            </>
          ) : m.type === 'image' ? (
            <div
              style={{
                padding: '16px 10px',
                textAlign: 'center',
                color: 'var(--legacy-text-dim)',
                fontStyle: 'italic',
                fontSize: 13,
              }}
            >
              Image unavailable
            </div>
          ) : (
            <div className="l-text">{m.body}</div>
          )}
          <div className="l-foot">
            <span>{formatTime(m.ts)}</span>
            {m.editedAt && !recalled ? <span>· edited</span> : null}
            {mine && !recalled ? (
              <span aria-label={m.read ? 'Read' : m.delivered ? 'Delivered' : 'Sent'}>
                {m.read ? 'R' : m.delivered ? 'D' : '✓'}
              </span>
            ) : null}
          </div>
          {m.reactions && m.reactions.length > 0 ? (
            <div
              style={{
                display: 'flex',
                flexWrap: 'wrap',
                gap: 4,
                marginTop: 4,
              }}
            >
              {m.reactions.map((r) => (
                <button
                  key={r.emoji}
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    react(m.id, r.emoji);
                  }}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 4,
                    background: r.mine
                      ? 'var(--legacy-blue)'
                      : 'var(--legacy-bg)',
                    color: r.mine ? '#FFFFFF' : 'var(--legacy-text)',
                    border: r.mine
                      ? 'none'
                      : '1px solid var(--legacy-separator)',
                    borderRadius: 999,
                    padding: '2px 8px',
                    fontSize: 12,
                    fontWeight: 600,
                  }}
                >
                  <span>{r.emoji}</span>
                  {r.count > 1 ? <span>{r.count}</span> : null}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      </article>,
    );
  }

  return (
    <div className="legacy-page">
      <header className="legacy-navbar">
        <button
          type="button"
          onClick={() => nav('/chats')}
          className="l-back"
          aria-label="Back"
        >
          <svg viewBox="0 0 28 28" width="22" height="22" aria-hidden="true">
            <path
              d="M17 6l-8 8 8 8"
              stroke="currentColor"
              strokeWidth="2.4"
              fill="none"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
        <Link
          to={
            isGroup
              ? `/chats/${encodeURIComponent(chatId)}`
              : chat?.peer
                ? `/contacts/${encodeURIComponent(chat.peer.id)}`
                : '#'
          }
          className="l-title"
          style={{ textDecoration: 'none', color: 'inherit', flexDirection: 'row', gap: 8, alignItems: 'center' }}
        >
          {isGroup ? (
            <GroupAvatar subject={chat?.subject ?? 'Group'} size={32} />
          ) : (
            <Avatar
              src={chat?.peer?.avatarUrl ?? null}
              name={peerName}
              size={32}
            />
          )}
          <span style={{ display: 'flex', flexDirection: 'column', minWidth: 0 }}>
            <span style={{ fontWeight: 600, fontSize: 16, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
              {peerName}
            </span>
            <span className="l-title-sub">{typingNames.length > 0 ? 'typing…' : subLine}</span>
          </span>
        </Link>
        <div className="l-right">
          <button
            type="button"
            onClick={() => sendPing(chatId)}
            aria-label="Send PING"
            style={{ color: '#FFFFFF', fontWeight: 700 }}
          >
            ⚡
          </button>
        </div>
      </header>

      <div className="legacy-chat-body">
        {stacked}
        {typingNames.length > 0 ? (
          <article className="legacy-message-card" style={{ alignSelf: 'flex-start' }}>
            <div className="l-body-col">
              <div className="l-text" style={{ color: 'var(--legacy-text-dim)' }}>
                {typingNames[0]} is typing…
              </div>
            </div>
          </article>
        ) : null}
        {uploadError ? (
          <div
            style={{
              alignSelf: 'center',
              color: 'var(--legacy-ping, #E5443B)',
              fontSize: 12,
            }}
          >
            {uploadError}
          </div>
        ) : null}
        <div
          ref={bottomRef}
          aria-hidden="true"
          style={{
            scrollMarginBottom: 'calc(80px + env(safe-area-inset-bottom, 0px))',
          }}
        />
      </div>

      {replyingTo ? (
        <div
          style={{
            position: 'fixed',
            left: 0,
            right: 0,
            bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))',
            zIndex: 20,
            background: 'var(--legacy-bg)',
            borderTop: '1px solid var(--legacy-separator)',
            padding: '8px 14px',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
          }}
        >
          <div
            style={{
              width: 3,
              alignSelf: 'stretch',
              background: 'var(--legacy-blue)',
              borderRadius: 2,
            }}
          />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              style={{
                fontSize: 12,
                fontWeight: 700,
                color: 'var(--legacy-blue)',
              }}
            >
              Replying to{' '}
              {replyingTo.from === me?.id ? 'yourself' : chat?.peer?.displayName ?? 'them'}
            </div>
            <div
              style={{
                fontSize: 13,
                color: 'var(--legacy-text-dim)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {replyingTo.type === 'ping'
                ? 'PING!!'
                : replyingTo.body
                  ? replyingTo.body
                  : replyingTo.mediaKey
                    ? '📷 Photo'
                    : ''}
            </div>
          </div>
          <button
            type="button"
            onClick={() => setReplyingTo(null)}
            aria-label="Cancel reply"
            style={{
              padding: 6,
              color: 'var(--legacy-text-dim)',
              fontSize: 18,
              lineHeight: 1,
            }}
          >
            ×
          </button>
        </div>
      ) : null}

      <div className="legacy-messagebar">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Attach photo or video"
          style={{
            color: 'var(--legacy-blue)',
            width: 36,
            height: 36,
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            flex: '0 0 auto',
          }}
        >
          {uploading ? (
            <span style={{ fontSize: 14 }}>…</span>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
              <path
                d="M21 12.5l-9 9a5 5 0 0 1-7-7l9-9a3 3 0 0 1 4 4l-9 9a1 1 0 0 1-2-2l8-8"
                stroke="currentColor"
                strokeWidth="1.8"
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          )}
        </button>
        <input
          type="text"
          placeholder="Type a message"
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button
          type="button"
          className="l-send"
          onClick={submit}
          disabled={!input.trim()}
        >
          Send
        </button>
      </div>
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
        onChange={onPickFile}
        hidden
      />

      {actionsFor ? (
        <div
          role="dialog"
          aria-modal="true"
          onClick={() => setActionsFor(null)}
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.4)',
            display: 'flex',
            alignItems: 'flex-end',
            justifyContent: 'center',
            zIndex: 40,
            paddingBottom: 'env(safe-area-inset-bottom, 0px)',
          }}
        >
          <div
            onClick={(e) => e.stopPropagation()}
            style={{
              background: 'var(--legacy-card-bg)',
              color: 'var(--legacy-text)',
              borderTopLeftRadius: 16,
              borderTopRightRadius: 16,
              width: '100%',
              maxWidth: 480,
              padding: 8,
            }}
          >
            <div
              style={{
                display: 'flex',
                justifyContent: 'space-around',
                padding: '12px 4px',
                borderBottom: '1px solid var(--legacy-separator)',
              }}
            >
              {LEGACY_REACTION_PALETTE.map((emoji) => (
                <button
                  key={emoji}
                  type="button"
                  onClick={() => {
                    if (actionsFor) react(actionsFor.id, emoji);
                    setActionsFor(null);
                  }}
                  style={{ fontSize: 26, padding: 6, lineHeight: 1 }}
                  aria-label={`React with ${emoji}`}
                >
                  {emoji}
                </button>
              ))}
            </div>
            <button
              type="button"
              onClick={() => {
                if (actionsFor) setReplyingTo(actionsFor);
                setActionsFor(null);
              }}
              style={{
                width: '100%',
                padding: '14px 18px',
                textAlign: 'left',
                fontSize: 16,
                fontWeight: 600,
                color: 'var(--legacy-blue)',
              }}
            >
              Reply
            </button>
            {actionsFor.body ? (
              <button
                type="button"
                onClick={() => {
                  if (actionsFor?.body)
                    navigator.clipboard.writeText(actionsFor.body).catch(() => undefined);
                  setActionsFor(null);
                }}
                style={{
                  width: '100%',
                  padding: '14px 18px',
                  textAlign: 'left',
                  fontSize: 16,
                  fontWeight: 600,
                  color: 'var(--legacy-text)',
                }}
              >
                Copy text
              </button>
            ) : null}
            <button
              type="button"
              onClick={() => setActionsFor(null)}
              style={{
                width: '100%',
                padding: '14px 18px',
                textAlign: 'center',
                fontSize: 16,
                fontWeight: 700,
                color: 'var(--legacy-text-dim)',
                borderTop: '1px solid var(--legacy-separator)',
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
