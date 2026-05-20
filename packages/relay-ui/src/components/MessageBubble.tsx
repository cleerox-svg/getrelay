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
  const bg = isPing
    ? 'transparent'
    : recalled
      ? 'transparent'
      : mine
        ? 'var(--accent)'
        : 'var(--surface)';
  const fg = mine && !recalled && !isPing ? '#FFFFFF' : 'var(--text)';
  const metaColor = mine && !recalled && !isPing ? 'rgba(255, 255, 255, 0.85)' : 'var(--text-dim)';

  const shouldShake = isPing && !mine && !recalled;
  const bubbleClass = `fade-in${shouldShake ? ' ping-shake' : ''}`;

  // iMessage tail-style asymmetric radius — flatter on the sender's side.
  const radius = mine
    ? '18px 18px 6px 18px'
    : '18px 18px 18px 6px';

  return (
    <div
      style={{
        display: 'flex',
        justifyContent: mine ? 'flex-end' : 'flex-start',
        padding: '3px 12px',
      }}
    >
      <div
        className={bubbleClass}
        onMouseDown={startPress}
        onMouseUp={cancelPress}
        onMouseLeave={cancelPress}
        onTouchStart={startPress}
        onTouchEnd={cancelPress}
        onTouchCancel={cancelPress}
        style={{
          maxWidth: '78%',
          background: bg,
          color: fg,
          borderRadius: isPing ? 0 : radius,
          padding: isPing ? 0 : '8px 12px',
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
          <div style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', lineHeight: 1.3 }}>
            {msg.body}
          </div>
        )}
        <div
          style={{
            display: 'flex',
            justifyContent: 'flex-end',
            alignItems: 'center',
            gap: 6,
            marginTop: 4,
            fontSize: 11,
            color: metaColor,
            paddingLeft: isPing ? 8 : 0,
            paddingRight: isPing ? 8 : 0,
          }}
        >
          <span>{formatTime(msg.ts)}</span>
          {msg.editedAt && !recalled ? <span>· edited</span> : null}
          {mine && !recalled ? (
            <Receipt delivered={msg.delivered} read={msg.read} onAccent={!isPing} />
          ) : null}
        </div>
      </div>
    </div>
  );
}
