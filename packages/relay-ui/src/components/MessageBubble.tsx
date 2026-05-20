import { useEffect, useRef, useState } from 'react';
import type { UiMessage } from '../lib/types';
import { PingChip } from './PingChip';
import { Receipt } from './Receipt';

interface Props {
  msg: UiMessage;
  mine: boolean;
  onLongPress?: (msg: UiMessage) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function MessageBubble({ msg, mine, onLongPress }: Props) {
  const [pressed, setPressed] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const startPress = () => {
    if (!mine || !onLongPress) return;
    if (msg.deletedAt) return;
    setPressed(true);
    timerRef.current = setTimeout(() => {
      onLongPress(msg);
      setPressed(false);
    }, 450);
  };
  const cancelPress = () => {
    setPressed(false);
    if (timerRef.current) clearTimeout(timerRef.current);
  };

  const recalled = !!msg.deletedAt;
  const isPing = msg.type === 'ping';
  const tint = mine ? 'var(--accent)' : 'var(--surface)';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        padding: '4px 12px',
      }}
    >
      <div
        onMouseDown={startPress}
        onMouseUp={cancelPress}
        onMouseLeave={cancelPress}
        onTouchStart={startPress}
        onTouchEnd={cancelPress}
        onTouchCancel={cancelPress}
        style={{
          maxWidth: '78%',
          background: isPing ? 'transparent' : recalled ? 'transparent' : tint,
          color: mine && !recalled && !isPing ? '#0A0A0E' : 'var(--text)',
          borderRadius: 'var(--radius-lg)',
          padding: isPing ? 0 : '10px 14px',
          opacity: msg.pending ? 0.7 : 1,
          border: recalled ? '1px dashed var(--text-dim)' : 'none',
          transform: pressed ? 'scale(0.98)' : 'none',
          transition: 'transform 80ms ease',
        }}
      >
        {isPing ? (
          <PingChip />
        ) : recalled ? (
          <em style={{ color: 'var(--text-dim)', padding: '6px 10px', display: 'block' }}>
            Message recalled
          </em>
        ) : (
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.body}</div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            gap: 8,
            marginTop: 6,
            fontSize: 11,
            color: mine && !recalled && !isPing ? 'rgba(10,10,14,0.7)' : 'var(--text-dim)',
            paddingLeft: isPing ? 8 : 0,
            paddingRight: isPing ? 8 : 0,
          }}
        >
          <span>{formatTime(msg.ts)}</span>
          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            {msg.editedAt && !recalled ? <span>edited</span> : null}
            {mine && !recalled ? <Receipt delivered={msg.delivered} read={msg.read} /> : null}
          </span>
        </div>
      </div>
    </div>
  );
}
