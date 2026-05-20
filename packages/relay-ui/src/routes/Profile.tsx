import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { PinDisplay } from '../components/PinDisplay';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

export function Profile() {
  const me = useStore((s) => s.me);
  const loadMe = useStore((s) => s.loadMe);
  const signout = useStore((s) => s.signout);
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [statusMessage, setStatusMessage] = useState(me?.statusMessage ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const nav = useNavigate();

  useEffect(() => {
    setDisplayName(me?.displayName ?? '');
    setStatusMessage(me?.statusMessage ?? '');
  }, [me?.displayName, me?.statusMessage]);

  async function save() {
    if (!me) return;
    setSaving(true);
    try {
      await api.updateMe({
        displayName: displayName.trim(),
        statusMessage: statusMessage.trim(),
      });
      await loadMe();
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } finally {
      setSaving(false);
    }
  }

  async function doSignout() {
    await signout();
    nav('/signin', { replace: true });
  }

  if (!me) return null;

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/chats" className="btn-ghost" style={{ minWidth: 'auto', padding: 8 }}>
          ←
        </Link>
        <h1>Profile</h1>
      </header>
      <div style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
          {me.avatarUrl ? (
            <img
              src={me.avatarUrl}
              alt=""
              referrerPolicy="no-referrer"
              style={{ width: 64, height: 64, borderRadius: 999, objectFit: 'cover' }}
            />
          ) : (
            <div
              style={{
                width: 64,
                height: 64,
                borderRadius: 999,
                background: 'var(--surface-2)',
              }}
            />
          )}
          <div>
            <div style={{ fontWeight: 600 }}>{me.displayName}</div>
            <div style={{ color: 'var(--text-dim)', fontSize: 13 }}>{me.email}</div>
          </div>
        </div>

        <div
          style={{
            background: 'var(--surface)',
            padding: 16,
            borderRadius: 'var(--radius-md)',
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
          }}
        >
          <div>
            <div style={{ color: 'var(--text-dim)', fontSize: 12 }}>Your PIN</div>
            <PinDisplay pin={me.pin} />
          </div>
          <button
            className="btn-ghost"
            onClick={() => navigator.clipboard.writeText(me.pin).catch(() => undefined)}
          >
            Copy
          </button>
        </div>

        <div>
          <label style={{ color: 'var(--text-dim)', fontSize: 13 }}>Display name</label>
          <input
            className="input"
            value={displayName}
            onChange={(e) => setDisplayName(e.target.value)}
            maxLength={64}
          />
        </div>

        <div>
          <label style={{ color: 'var(--text-dim)', fontSize: 13 }}>Status</label>
          <input
            className="input"
            value={statusMessage}
            onChange={(e) => setStatusMessage(e.target.value)}
            maxLength={140}
            placeholder="What's your status?"
          />
        </div>

        <button className="btn-primary" onClick={save} disabled={saving}>
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
        </button>

        {me.isAdmin ? (
          <div
            style={{
              color: 'var(--text-dim)',
              fontSize: 12,
              textAlign: 'center',
              padding: '4px 0',
            }}
          >
            ★ Platform admin
          </div>
        ) : null}

        <button
          onClick={doSignout}
          className="btn-ghost"
          style={{ color: 'var(--accent)', marginTop: 24 }}
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
