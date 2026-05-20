import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { PinDisplay } from '../components/PinDisplay';
import { api } from '../lib/api';
import { formatPin } from '../lib/pin';
import { useStore } from '../lib/store';

export function Onboarding() {
  const me = useStore((s) => s.me);
  const loadMe = useStore((s) => s.loadMe);
  const nav = useNavigate();
  const [copied, setCopied] = useState(false);
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [saving, setSaving] = useState(false);

  if (!me) return null;

  async function copy() {
    if (!me) return;
    try {
      await navigator.clipboard.writeText(formatPin(me.pin));
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  async function continueOn() {
    setSaving(true);
    try {
      if (displayName.trim() && displayName.trim() !== me?.displayName) {
        await api.updateMe({ displayName: displayName.trim() });
        await loadMe();
      }
      nav('/chats', { replace: true });
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="app-shell" style={{ padding: 24, gap: 24 }}>
      <h1
        style={{
          fontSize: 32,
          fontWeight: 800,
          letterSpacing: '-0.02em',
          color: 'var(--accent)',
          textAlign: 'center',
          margin: '24px 0 8px',
        }}
      >
        Welcome to Relay
      </h1>
      <p style={{ textAlign: 'center', color: 'var(--text-dim)', margin: 0 }}>
        Your PIN is ready.
      </p>
      <div
        style={{
          background: 'var(--surface)',
          padding: '24px',
          borderRadius: 'var(--radius-md)',
          textAlign: 'center',
        }}
      >
        <PinDisplay pin={me.pin} size="lg" />
      </div>
      <p style={{ textAlign: 'center', color: 'var(--text-dim)', lineHeight: 1.7, margin: 0 }}>
        Share it. Memorize it.
        <br />
        This is who you are on Relay.
      </p>
      <button onClick={copy} className="btn-secondary">
        {copied ? 'Copied' : 'Copy PIN'}
      </button>

      <div>
        <label
          style={{
            display: 'block',
            color: 'var(--text-dim)',
            marginBottom: 6,
            fontSize: 13,
          }}
        >
          Display name
        </label>
        <input
          className="input"
          value={displayName}
          onChange={(e) => setDisplayName(e.target.value)}
          maxLength={64}
        />
      </div>

      <button onClick={continueOn} disabled={saving} className="btn-primary">
        Continue
      </button>
    </div>
  );
}
