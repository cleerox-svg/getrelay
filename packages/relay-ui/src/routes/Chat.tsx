import { useEffect, useMemo, useRef, useState } from 'react';
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
import { useStore } from '../lib/store';
import type { UiMessage } from '../lib/types';

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
  const scrollRef = useRef<HTMLDivElement | null>(null);

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

  // Auto-scroll to bottom when messages or typing state changes.
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length, chatState?.typing]);

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
    const bg = recalled
      ? 'transparent'
      : isPing
        ? 'transparent'
        : mine
          ? 'var(--accent)'
          : 'rgba(0,0,0,0.06)';
    const fg = mine && !recalled && !isPing ? '#FFFFFF' : 'var(--text, #000)';
    const metaColor =
      mine && !recalled && !isPing ? 'rgba(255,255,255,0.85)' : 'var(--text-dim)';

    stacked.push(
      <div
        key={m.id}
        onClick={() => {
          if (mine && !recalled) setActionsFor(m);
        }}
        style={{
          alignSelf: 'stretch',
          background: bg,
          color: fg,
          borderRadius: 16,
          padding: isPing ? 6 : '10px 14px',
          border: recalled ? '1px dashed var(--text-dim)' : 'none',
          opacity: m.pending ? 0.7 : 1,
          cursor: mine && !recalled ? 'pointer' : 'default',
        }}
      >
        {isGroup && !mine && !recalled ? (
          <div
            className="text-[12px] font-semibold mb-0.5"
            style={{ color: 'var(--accent)' }}
          >
            {/* Sender name placeholder — we currently only have ids in messages.
                Group sender names land in v2 when we wire member info. */}
            {m.from.slice(0, 6)}
          </div>
        ) : null}

        {recalled ? (
          <em style={{ color: 'var(--text-dim)' }}>Message recalled</em>
        ) : isPing ? (
          <div className="flex justify-center py-1">
            <PingChip />
          </div>
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.35 }}>
            {m.body}
          </div>
        )}

        <div
          className="text-[11px] mt-1 flex items-center gap-1.5"
          style={{ color: metaColor, justifyContent: 'flex-end' }}
        >
          <span>{formatTime(m.ts)}</span>
          {m.editedAt && !recalled ? <span>· edited</span> : null}
          {mine && !recalled ? (
            <Receipt delivered={m.delivered} read={m.read} onAccent={!isPing} />
          ) : null}
        </div>
      </div>,
    );
  }

  return (
    <Page>
      <Navbar
        title={
          <Link
            to={isGroup ? `/chats/${encodeURIComponent(chatId)}` : '#'}
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
        ref={scrollRef}
        className="flex-1 overflow-y-auto"
        style={{
          display: 'flex',
          flexDirection: 'column',
          gap: 8,
          padding: '12px 16px 16px',
        }}
      >
        {stacked}
        {typingNames.length > 0 ? <TypingDots name={typingNames[0]} /> : null}
      </div>

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
              onClick={() => sendPing(chatId)}
              aria-label="Send PING"
              className="px-2 text-xl"
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
