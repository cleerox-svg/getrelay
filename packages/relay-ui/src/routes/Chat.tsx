import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { LongPressMenu } from '../components/LongPressMenu';
import { MessageBubble } from '../components/MessageBubble';
import { TypingDots } from '../components/TypingDots';
import { useStore } from '../lib/store';
import type { UiMessage } from '../lib/types';

export function Chat() {
  const params = useParams();
  const chatId = decodeURIComponent(params.id ?? '');
  const me = useStore((s) => s.me);
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const chatState = useStore((s) => s.byChat[chatId]);
  const ensureChatState = useStore((s) => s.ensureChatState);
  const subscribeChat = useStore((s) => s.subscribeChat);
  const unsubscribeChat = useStore((s) => s.unsubscribeChat);
  const sendText = useStore((s) => s.sendText);
  const sendPing = useStore((s) => s.sendPing);
  const sendTyping = useStore((s) => s.sendTyping);
  const markRead = useStore((s) => s.markRead);
  const recall = useStore((s) => s.recall);
  const edit = useStore((s) => s.edit);

  const [input, setInput] = useState('');
  const [editing, setEditing] = useState<UiMessage | null>(null);
  const [menuFor, setMenuFor] = useState<UiMessage | null>(null);
  const typingTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sentTypingRef = useRef(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    ensureChatState(chatId);
    subscribeChat(chatId);
    return () => unsubscribeChat(chatId);
  }, [chatId, ensureChatState, subscribeChat, unsubscribeChat]);

  const messages = chatState?.messages ?? [];

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messages.length]);

  // Mark incoming messages as read on mount and whenever new arrive.
  useEffect(() => {
    if (!me) return;
    const unread = messages
      .filter((m) => m.from !== me.id && !m.read && !m.deletedAt && m.id && !m.tempId)
      .map((m) => m.id);
    if (unread.length > 0) markRead(chatId, unread);
  }, [messages, chatId, me, markRead]);

  const typingNames = useMemo(() => {
    if (!chatState || !me) return [];
    return Object.entries(chatState.typing)
      .filter(([uid, on]) => on && uid !== me.id)
      .map(([uid]) => (uid === chat?.peer?.id ? chat.peer.displayName : 'Someone'));
  }, [chatState, me, chat]);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
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

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/chats" className="btn-ghost" style={{ minWidth: 'auto', padding: 8 }}>
          ←
        </Link>
        <div style={{ flex: 1, minWidth: 0 }}>
          <div
            style={{
              fontWeight: 600,
              fontSize: 16,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {chat?.peer?.displayName ?? chat?.subject ?? 'Chat'}
          </div>
          <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>
            {chat?.peer?.pin ? chat.peer.pin : ''}
          </div>
        </div>
      </header>

      <div ref={scrollRef} style={{ flex: 1, overflowY: 'auto', padding: '8px 0' }}>
        {messages.map((m) => (
          <MessageBubble
            key={m.id}
            msg={m}
            mine={m.from === me?.id}
            onLongPress={(target) => setMenuFor(target)}
          />
        ))}
        {typingNames.length > 0 ? <TypingDots name={typingNames[0]} /> : null}
      </div>

      <form
        onSubmit={onSubmit}
        style={{
          display: 'flex',
          gap: 8,
          padding: 12,
          borderTop: '1px solid var(--surface)',
          background: 'var(--bg)',
        }}
      >
        <input
          className="input"
          placeholder={editing ? 'Edit message' : 'Type a message'}
          value={input}
          onChange={(e) => onInputChange(e.target.value)}
          maxLength={2000}
        />
        <button
          type="button"
          onClick={() => sendPing(chatId)}
          aria-label="Send PING"
          style={{
            background: 'var(--surface-2)',
            color: 'var(--accent)',
            borderRadius: 'var(--radius-md)',
            padding: '0 14px',
            fontWeight: 700,
          }}
        >
          ⚡
        </button>
        <button
          type="submit"
          aria-label="Send"
          style={{
            background: 'var(--accent)',
            color: '#0A0A0E',
            borderRadius: 'var(--radius-md)',
            padding: '0 18px',
            fontWeight: 700,
          }}
        >
          ➤
        </button>
      </form>

      {editing ? (
        <div
          style={{
            padding: 8,
            textAlign: 'center',
            color: 'var(--text-dim)',
            fontSize: 12,
            borderTop: '1px solid var(--surface)',
          }}
        >
          Editing — press send to save.{' '}
          <button
            onClick={() => {
              setEditing(null);
              setInput('');
            }}
            style={{ color: 'var(--accent)', minWidth: 'auto', minHeight: 'auto' }}
          >
            cancel
          </button>
        </div>
      ) : null}

      <LongPressMenu
        open={!!menuFor}
        onClose={() => setMenuFor(null)}
        actions={
          menuFor
            ? [
                {
                  label: 'Copy text',
                  onClick: () => {
                    if (menuFor.body) navigator.clipboard.writeText(menuFor.body).catch(() => undefined);
                  },
                  disabled: !menuFor.body,
                },
                {
                  label: 'Edit',
                  onClick: () => {
                    setEditing(menuFor);
                    setInput(menuFor.body ?? '');
                  },
                  disabled: menuFor.type !== 'text' || !!menuFor.deletedAt,
                },
                {
                  label: 'Recall',
                  destructive: true,
                  onClick: () => recall(menuFor.id),
                  disabled: !!menuFor.deletedAt,
                },
              ]
            : []
        }
      />
    </div>
  );
}
