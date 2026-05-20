import { Suspense, lazy, useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Actions,
  ActionsButton,
  ActionsGroup,
  Messagebar,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { GroupAvatar } from '../components/GroupAvatar';
import { PingChip } from '../components/PingChip';
import { Receipt } from '../components/Receipt';
import { TypingDots } from '../components/TypingDots';
import { ApiError, api } from '../lib/api';
import { useStore } from '../lib/store';
import type { UiMessage } from '../lib/types';

// Lazy: emoji-mart's data + UI is ~110 KB gzip. Only fetch when the user
// actually opens the picker.
const EmojiPicker = lazy(() => import('../components/EmojiPicker'));

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

const MAX_TEXTAREA_HEIGHT = 140; // ~6 lines

export function Chat() {
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
  const recall = useStore((s) => s.recall);
  const edit = useStore((s) => s.edit);

  const loadChatHistory = useStore((s) => s.loadChatHistory);
  const loadChats = useStore((s) => s.loadChats);
  const chats = useStore((s) => s.chats);

  const [input, setInput] = useState('');
  const [editing, setEditing] = useState<UiMessage | null>(null);
  const [actionsFor, setActionsFor] = useState<UiMessage | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTypingRef = useRef(false);
  const messagebarRef = useRef<{ areaElRef: HTMLTextAreaElement | null } | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [emojiOpen, setEmojiOpen] = useState(false);

  function insertEmoji(emoji: string) {
    const ta = messagebarRef.current?.areaElRef;
    // No textarea yet, or picker is open and we want to keep the keyboard
    // dismissed: just append at the end.
    if (!ta || emojiOpen) {
      setInput((prev) => prev + emoji);
      return;
    }
    const start = ta.selectionStart ?? input.length;
    const end = ta.selectionEnd ?? input.length;
    const next = input.slice(0, start) + emoji + input.slice(end);
    setInput(next);
    requestAnimationFrame(() => {
      const pos = start + emoji.length;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  useEffect(() => {
    ensureChatState(chatId);
    loadChatHistory(chatId).catch(() => undefined);
    subscribeChat(chatId);
    return () => unsubscribeChat(chatId);
  }, [chatId, ensureChatState, loadChatHistory, subscribeChat, unsubscribeChat]);

  useEffect(() => {
    if (chats.length === 0) loadChats().catch(() => undefined);
  }, [chats.length, loadChats]);

  const submitRef = useRef(() => undefined as void);

  // Enter (no shift) submits; Shift+Enter inserts a newline.
  useEffect(() => {
    const textarea = messagebarRef.current?.areaElRef;
    if (!textarea) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitRef.current();
      }
    };
    textarea.addEventListener('keydown', onKey);
    return () => textarea.removeEventListener('keydown', onKey);
  });

  // Auto-grow the textarea up to MAX_TEXTAREA_HEIGHT. Konsta defaults to a
  // fixed h-8, which truncates multi-line input.
  useEffect(() => {
    const textarea = messagebarRef.current?.areaElRef;
    if (!textarea) return;
    textarea.style.height = 'auto';
    const next = Math.min(textarea.scrollHeight, MAX_TEXTAREA_HEIGHT);
    textarea.style.height = `${next}px`;
    textarea.style.overflowY = textarea.scrollHeight > MAX_TEXTAREA_HEIGHT ? 'auto' : 'hidden';
  }, [input]);

  const messages = chatState?.messages ?? [];

  useEffect(() => {
    if (!me) return;
    const unread = messages
      .filter((m) => m.from !== me.id && !m.read && !m.deletedAt && m.id && !m.tempId)
      .map((m) => m.id);
    if (unread.length > 0) markRead(chatId, unread);
  }, [messages, chatId, me, markRead]);

  // Auto-scroll to the most recent message when:
  //   - the chat first mounts / route changes
  //   - a new message arrives or one is sent
  //   - someone starts/stops typing (so the dots stay visible)
  // The bottom sentinel + scrollIntoView lets the browser pick the right
  // ancestor (Konsta Page is the actual scroll container, so writing to
  // scrollTop on an arbitrary inner div didn't work). Two RAFs so layout
  // and image loads have a chance to settle before we measure.
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

  const isGroup = chat?.type === 'group';
  const peerOnline = chat?.peer ? presence[chat.peer.id]?.online ?? false : false;

  const typingNames = useMemo(() => {
    if (!chatState || !me) return [];
    return Object.entries(chatState.typing)
      .filter(([uid, on]) => on && uid !== me.id)
      .map(([uid]) => (uid === chat?.peer?.id ? chat.peer.displayName : 'Someone'));
  }, [chatState, me, chat]);

  function submit() {
    const text = input.trim();
    if (!text) return;
    if (editing) {
      edit(editing.id, text);
      setEditing(null);
    } else {
      sendText(chatId, text);
    }
    setInput('');
    if (sentTypingRef.current) {
      sendTyping(chatId, false);
      sentTypingRef.current = false;
    }
  }
  submitRef.current = submit;

  async function onPickFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setUploadError(null);
    setUploading(true);
    try {
      const result = await api.uploadMedia(file);
      const caption = input.trim();
      sendMedia(chatId, result.key, result.url, caption || undefined);
      setInput('');
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'too_large') setUploadError('Files up to 10 MB.');
        else if (err.code === 'bad_type') setUploadError('Use JPEG, PNG, WebP, GIF, MP4, WebM, or MOV.');
        else setUploadError(err.code);
      } else setUploadError('Upload failed');
    } finally {
      setUploading(false);
    }
  }

  function isVideoKey(key: string | null | undefined): boolean {
    if (!key) return false;
    return /\.(mp4|webm|mov)$/i.test(key);
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

  // Single-column stacked bubbles: every message in chronological order,
  // each bubble colored by sender. No left/right alignment.
  const stacked: React.ReactNode[] = [];
  let lastDay = '';
  for (const m of messages) {
    const k = dayKey(m.ts);
    if (k !== lastDay) {
      stacked.push(
        <div
          key={`day-${k}`}
          className="text-center text-xs font-medium py-2"
          style={{ color: 'var(--text-dim)' }}
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

    const bg = recalled
      ? 'transparent'
      : isPing
        ? 'transparent'
        : mine
          ? 'var(--accent)'
          : 'var(--bubble-them)';
    const fg = mine && !recalled && !isPing ? '#FFFFFF' : 'var(--text)';
    const metaColor =
      mine && !recalled && !isPing ? 'rgba(255,255,255,0.85)' : 'var(--text-dim)';

    stacked.push(
      <div
        key={m.id}
        className="fade-in"
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 8,
          alignSelf: 'stretch',
        }}
      >
        <Avatar src={senderAvatarSrc} name={senderName} size={28} />
        <div
          onClick={() => {
            if (mine && !recalled) setActionsFor(m);
          }}
          style={{
            maxWidth: 'calc(100% - 44px)',
            background: bg,
            color: fg,
            borderRadius: 16,
            padding: isPing ? 6 : hasMedia ? 4 : '10px 14px',
            border: recalled ? '1px dashed var(--text-dim)' : 'none',
            opacity: m.pending ? 0.7 : 1,
            cursor: mine && !recalled ? 'pointer' : 'default',
            overflow: 'hidden',
          }}
        >
          {isGroup && !mine && !recalled ? (
            <div
              className="text-[12px] font-semibold mb-1 px-2 pt-1"
              style={{ color: 'var(--accent)' }}
            >
              {senderName}
            </div>
          ) : null}

          {recalled ? (
            <em style={{ color: 'var(--text-dim)' }}>Message recalled</em>
          ) : isPing ? (
            <div className="flex justify-center py-1">
              <PingChip />
            </div>
          ) : hasMedia ? (
            <div>
              {isVideoKey(m.mediaKey) ? (
                <video
                  src={m.mediaUrl ?? undefined}
                  controls
                  playsInline
                  style={{
                    display: 'block',
                    width: '100%',
                    maxHeight: 360,
                    borderRadius: 12,
                    background: '#000',
                  }}
                />
              ) : (
                <a href={m.mediaUrl ?? undefined} target="_blank" rel="noreferrer">
                  <img
                    src={m.mediaUrl ?? undefined}
                    alt=""
                    style={{
                      display: 'block',
                      maxWidth: '100%',
                      maxHeight: 360,
                      borderRadius: 12,
                      objectFit: 'cover',
                    }}
                  />
                </a>
              )}
              {m.body ? (
                <div
                  style={{
                    padding: '6px 10px 2px',
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                    lineHeight: 1.35,
                  }}
                >
                  {m.body}
                </div>
              ) : null}
            </div>
          ) : (
            <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.35 }}>
              {m.body}
            </div>
          )}

          <div
            className="text-[11px] mt-1 flex items-center gap-1.5"
            style={{
              color: metaColor,
              justifyContent: 'flex-end',
              paddingRight: hasMedia ? 10 : 0,
              paddingBottom: hasMedia ? 4 : 0,
              paddingLeft: hasMedia ? 10 : 0,
            }}
          >
            <span>{formatTime(m.ts)}</span>
            {m.editedAt && !recalled ? <span>· edited</span> : null}
            {mine && !recalled ? (
              <Receipt delivered={m.delivered} read={m.read} onAccent={!isPing} />
            ) : null}
          </div>
        </div>
      </div>,
    );
  }

  return (
    <Page>
      <Navbar
        // Force fixed positioning so the navbar stays pinned during scroll
        // even when iOS Safari's URL bar collapses (which changes the Page
        // scroll-container height and breaks sticky-top in some cases).
        // bgClassName is used for the inner toolbar background so the
        // translucent style still works.
        className="!fixed !top-0 !left-0 !right-0 !z-30"
        title={
          <Link
            to={
              isGroup
                ? `/chats/${encodeURIComponent(chatId)}`
                : chat?.peer
                  ? `/contacts/${encodeURIComponent(chat.peer.id)}`
                  : '#'
            }
            className="flex items-center gap-2"
            style={{ textDecoration: 'none' }}
          >
            {isGroup ? (
              <GroupAvatar subject={chat?.subject ?? 'Group'} size={28} />
            ) : (
              <Avatar
                src={chat?.peer?.avatarUrl ?? null}
                name={chat?.peer?.displayName ?? chat?.subject ?? 'Chat'}
                size={28}
                online={peerOnline}
              />
            )}
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold" style={{ color: 'var(--text, #000)' }}>
                {isGroup ? chat?.subject : chat?.peer?.displayName ?? 'Chat'}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {isGroup
                  ? `${chat?.memberCount ?? '–'} members`
                  : peerOnline
                    ? 'online'
                    : chat?.peer?.pin ?? ''}
              </span>
            </span>
          </Link>
        }
        left={<NavbarBackLink text="Chats" onClick={() => nav('/chats')} />}
      />

      <div
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          // Top pad clears the fixed Navbar (44 px iOS toolbar + notch /
          // status-bar safe area). Bottom pad clears the fixed Messagebar
          // (~64 px) and the home-bar safe area.
          padding:
            'calc(56px + env(safe-area-inset-top, 0px)) 16px ' +
            'calc(96px + env(safe-area-inset-bottom, 0px))',
        }}
      >
        {stacked}
        {typingNames.length > 0 ? <TypingDots name={typingNames[0]} /> : null}
        {uploadError ? (
          <div className="text-xs text-center" style={{ color: 'var(--ping)' }}>
            {uploadError}
          </div>
        ) : null}
        {/* Sentinel scroll target — kept directly below the last message
            so scrollIntoView always lands on the most recent thing. The
            scroll-margin-bottom reserves room for the fixed Messagebar
            so scrollIntoView({ block: 'end' }) doesn't park the bottom
            under the bar. */}
        <div
          ref={bottomRef}
          aria-hidden="true"
          style={{
            scrollMarginBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))',
          }}
        />
      </div>

      {emojiOpen ? (
        <Suspense fallback={null}>
          <EmojiPicker open={emojiOpen} onSelect={insertEmoji} />
        </Suspense>
      ) : null}

      <Messagebar
        // @ts-expect-error Konsta forwardRef returns { el, areaElRef }; types lag
        ref={messagebarRef}
        placeholder={editing ? 'Edit message' : 'Message'}
        value={input}
        onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) =>
          onInputChange(e.target.value)
        }
        right={
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              aria-label="Attach photo or video"
              disabled={uploading}
              className="px-2 disabled:opacity-50"
              style={{ color: 'var(--accent)' }}
            >
              {uploading ? (
                <span style={{ fontSize: 14 }}>…</span>
              ) : (
                <svg viewBox="0 0 24 24" width="24" height="24" aria-hidden="true">
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
            <button
              type="button"
              onClick={() => {
                const ta = messagebarRef.current?.areaElRef;
                // Dismiss the on-screen keyboard before opening so iOS /
                // Android don't render the picker behind the keyboard.
                if (!emojiOpen && ta) ta.blur();
                setEmojiOpen((v) => !v);
              }}
              aria-label="Insert emoji"
              className="px-1 text-xl"
              style={{ color: emojiOpen ? 'var(--accent)' : 'var(--text-dim)' }}
            >
              😀
            </button>
            <button
              type="button"
              onClick={() => sendPing(chatId)}
              aria-label="Send PING"
              className="px-1 text-xl"
              style={{ color: 'var(--ping)' }}
            >
              ⚡
            </button>
            <button
              type="button"
              onClick={submit}
              aria-label="Send"
              disabled={!input.trim()}
              className="px-3 font-semibold disabled:opacity-40"
              style={{ color: 'var(--accent)' }}
            >
              Send
            </button>
          </div>
        }
      />
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
        onChange={onPickFile}
        hidden
      />

      {editing ? (
        <div
          className="px-4 py-2 text-center text-xs"
          style={{ color: 'var(--text-dim)' }}
        >
          Editing — Send saves.{' '}
          <button
            onClick={() => {
              setEditing(null);
              setInput('');
            }}
            style={{ color: 'var(--accent)' }}
          >
            cancel
          </button>
        </div>
      ) : null}

      <Actions opened={!!actionsFor} onBackdropClick={() => setActionsFor(null)}>
        <ActionsGroup>
          <ActionsButton
            className={!actionsFor?.body ? 'opacity-40 pointer-events-none' : undefined}
            onClick={() => {
              if (actionsFor?.body)
                navigator.clipboard.writeText(actionsFor.body).catch(() => undefined);
              setActionsFor(null);
            }}
          >
            Copy text
          </ActionsButton>
          <ActionsButton
            className={
              actionsFor?.type !== 'text' || !!actionsFor?.deletedAt
                ? 'opacity-40 pointer-events-none'
                : undefined
            }
            onClick={() => {
              if (actionsFor?.type === 'text' && !actionsFor.deletedAt) {
                setEditing(actionsFor);
                setInput(actionsFor.body ?? '');
              }
              setActionsFor(null);
            }}
          >
            Edit
          </ActionsButton>
          <ActionsButton
            className={`!text-red-500${actionsFor?.deletedAt ? ' opacity-40 pointer-events-none' : ''}`}
            onClick={() => {
              if (actionsFor && !actionsFor.deletedAt) recall(actionsFor.id);
              setActionsFor(null);
            }}
          >
            Recall
          </ActionsButton>
        </ActionsGroup>
        <ActionsGroup>
          <ActionsButton onClick={() => setActionsFor(null)} bold>
            Cancel
          </ActionsButton>
        </ActionsGroup>
      </Actions>
    </Page>
  );
}
