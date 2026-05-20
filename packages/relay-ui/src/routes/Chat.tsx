import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import {
  Actions,
  ActionsButton,
  ActionsGroup,
  Icon,
  Message,
  Messagebar,
  Messages,
  MessagesTitle,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
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

  useEffect(() => {
    ensureChatState(chatId);
    loadChatHistory(chatId).catch(() => undefined);
    subscribeChat(chatId);
    return () => unsubscribeChat(chatId);
  }, [chatId, ensureChatState, loadChatHistory, subscribeChat, unsubscribeChat]);

  // Direct deep-links (refresh on /chats/:id) skip the chats list. Pull
  // it so the navbar can resolve the peer's name + avatar.
  useEffect(() => {
    if (chats.length === 0) loadChats().catch(() => undefined);
  }, [chats.length, loadChats]);

  // Hook Enter (without Shift) on the underlying textarea to send.
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

  // Keep a stable ref to the latest submit so the keydown handler always
  // sees current state.
  const submitRef = useRef(() => undefined as void);

  const messages = chatState?.messages ?? [];

  useEffect(() => {
    if (!me) return;
    const unread = messages
      .filter((m) => m.from !== me.id && !m.read && !m.deletedAt && m.id && !m.tempId)
      .map((m) => m.id);
    if (unread.length > 0) markRead(chatId, unread);
  }, [messages, chatId, me, markRead]);

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

  // Build messages array with day separators inserted as <MessagesTitle>.
  const rendered: React.ReactNode[] = [];
  let lastDay = '';
  for (const m of messages) {
    const k = dayKey(m.ts);
    if (k !== lastDay) {
      rendered.push(<MessagesTitle key={`day-${k}`}>{dayLabel(m.ts)}</MessagesTitle>);
      lastDay = k;
    }
    const mine = m.from === me?.id;
    const recalled = !!m.deletedAt;
    const isPing = m.type === 'ping';
    rendered.push(
      <Message
        key={m.id}
        type={mine ? 'sent' : 'received'}
        text={recalled || isPing ? undefined : (m.body ?? '')}
        footer={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 11 }}>
            <span>{formatTime(m.ts)}</span>
            {m.editedAt && !recalled ? <span>· edited</span> : null}
            {mine && !recalled ? (
              <Receipt delivered={m.delivered} read={m.read} onAccent />
            ) : null}
          </span>
        }
        onClick={() => {
          if (mine && !recalled) setActionsFor(m);
        }}
      >
        {recalled ? (
          <em style={{ color: 'var(--text-dim)' }}>Message recalled</em>
        ) : isPing ? (
          <PingChip />
        ) : null}
      </Message>,
    );
  }

  return (
    <Page>
      <Navbar
        title={
          <span className="flex items-center gap-2">
            <Avatar
              src={chat?.peer?.avatarUrl ?? null}
              name={chat?.peer?.displayName ?? chat?.subject ?? 'Chat'}
              size={28}
              online={peerOnline}
            />
            <span className="flex flex-col leading-tight">
              <span className="text-base font-semibold">
                {chat?.peer?.displayName ?? chat?.subject ?? 'Chat'}
              </span>
              <span className="text-[11px]" style={{ color: 'var(--text-dim)' }}>
                {peerOnline ? 'online' : chat?.peer?.pin ?? ''}
              </span>
            </span>
          </span>
        }
        left={<NavbarBackLink text="Chats" onClick={() => nav('/chats')} />}
      />

      <Messages>{rendered}</Messages>
      {typingNames.length > 0 ? <TypingDots name={typingNames[0]} /> : null}

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
