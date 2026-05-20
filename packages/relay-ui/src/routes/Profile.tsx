import { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
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
    <div className="app-shell" style={{ background: 'var(--surface)' }}>
      <header className="app-header" style={{ background: 'var(--surface)' }}>
        <Link to="/chats" className="btn-ghost" style={{ minWidth: 'auto', padding: 6 }}>
          ‹ Chats
        </Link>
        <h1 style={{ flex: 1, textAlign: 'center', fontSize: 17, fontWeight: 600 }}>Profile</h1>
        <span style={{ width: 60 }} />
      </header>

      <div style={{ flex: 1, overflowY: 'auto', padding: '16px 0 32px' }}>
        <div
          style={{
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
            padding: 24,
          }}
        >
          <Avatar src={me.avatarUrl} name={me.displayName} size={96} />
          <div style={{ fontSize: 22, fontWeight: 600 }}>{me.displayName}</div>
          <div style={{ color: 'var(--text-dim)', fontSize: 14 }}>{me.email}</div>
          {me.isAdmin ? (
            <div
              style={{
                fontSize: 12,
                color: 'var(--accent)',
                fontWeight: 600,
                marginTop: 4,
              }}
            >
              ★ Platform admin
            </div>
          ) : null}
        </div>

        <div className="section-header">PIN (Username)</div>
        <div className="list-section">
          <div
            className="list-row"
            style={{ display: 'flex', justifyContent: 'space-between' }}
          >
            <PinDisplay pin={me.pin} />
            <button
              className="btn-ghost"
              onClick={() => navigator.clipboard.writeText(me.pin).catch(() => undefined)}
              style={{ minHeight: 'auto', minWidth: 'auto', padding: '4px 8px', fontSize: 15 }}
            >
              Copy
            </button>
          </div>
        </div>

        <div className="section-header">Display</div>
        <div className="list-section">
          <div className="list-row" style={{ display: 'block', padding: '10px 16px' }}>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 2 }}>
              Display name
            </div>
            <input
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={64}
              style={{
                width: '100%',
                background: 'transparent',
                border: 0,
                outline: 'none',
                fontSize: 17,
                padding: 0,
              }}
            />
          </div>
          <div className="list-row" style={{ display: 'block', padding: '10px 16px' }}>
            <div style={{ color: 'var(--text-dim)', fontSize: 12, marginBottom: 2 }}>Status</div>
            <input
              value={statusMessage}
              onChange={(e) => setStatusMessage(e.target.value)}
              maxLength={140}
              placeholder="What's your status?"
              style={{
                width: '100%',
                background: 'transparent',
                border: 0,
                outline: 'none',
                fontSize: 17,
                padding: 0,
              }}
            />
          </div>
        </div>

        <div style={{ padding: 16 }}>
          <button className="btn-primary" onClick={save} disabled={saving}>
            {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
          </button>
        </div>

        <div style={{ padding: '24px 16px' }}>
          <button
            onClick={doSignout}
            style={{
              width: '100%',
              background: 'var(--bg)',
              color: 'var(--ping)',
              padding: '14px 20px',
              borderRadius: 'var(--radius-md)',
              fontWeight: 500,
              fontSize: 17,
              border: '1px solid var(--separator)',
            }}
          >
            Sign out
          </button>
        </div>
      </div>
    </div>
  );
}
