import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { useStore } from '../lib/store';

export function Contacts() {
  const me = useStore((s) => s.me);
  const contacts = useStore((s) => s.contacts);
  const loadContacts = useStore((s) => s.loadContacts);
  const openOneToOne = useStore((s) => s.openOneToOne);
  const nav = useNavigate();
  const [query, setQuery] = useState('');

  useEffect(() => {
    loadContacts();
  }, [loadContacts]);

  const grouped = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = q
      ? contacts.filter(
          (c) =>
            c.displayName.toLowerCase().includes(q) ||
            (c.alias ?? '').toLowerCase().includes(q) ||
            c.pin.toLowerCase().includes(q),
        )
      : contacts;
    const byLetter: Record<string, typeof contacts> = {};
    for (const c of filtered) {
      const name = c.alias ?? c.displayName ?? '#';
      const letter = (name[0] ?? '#').toUpperCase();
      const key = /[A-Z]/.test(letter) ? letter : '#';
      (byLetter[key] ||= []).push(c);
    }
    return Object.entries(byLetter).sort(([a], [b]) => a.localeCompare(b));
  }, [contacts, query]);

  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px 4px',
        }}
      >
        <Link to="/profile" aria-label="Profile">
          <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={32} />
        </Link>
        <div style={{ flex: 1 }} />
        <Link to="/add-contact" className="btn-ghost" aria-label="Add contact">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
            <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
              <path d="M12 6v12M6 12h12" />
            </g>
          </svg>
        </Link>
      </div>

      <h1 className="large-title">Contacts</h1>

      <div style={{ padding: '0 16px 12px' }}>
        <input
          className="input"
          placeholder="Search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ borderRadius: 999, background: 'var(--surface)' }}
        />
      </div>

      <div style={{ flex: 1, overflowY: 'auto', WebkitOverflowScrolling: 'touch' }}>
        {contacts.length === 0 ? (
          <div
            style={{
              textAlign: 'center',
              color: 'var(--text-dim)',
              padding: '60px 24px',
            }}
          >
            <div style={{ fontSize: 16, marginBottom: 8 }}>No contacts yet</div>
            <div style={{ fontSize: 14 }}>Tap + above to add one by PIN.</div>
          </div>
        ) : null}

        {grouped.map(([letter, items]) => (
          <div key={letter}>
            <div
              style={{
                padding: '4px 16px',
                fontSize: 13,
                color: 'var(--text-dim)',
                fontWeight: 600,
                background: 'var(--surface)',
                textTransform: 'uppercase',
              }}
            >
              {letter}
            </div>
            {items.map((c) => (
              <button
                key={c.id}
                onClick={async () => {
                  const chatId = await openOneToOne(c.id);
                  nav(`/chats/${encodeURIComponent(chatId)}`);
                }}
                style={{
                  width: '100%',
                  textAlign: 'left',
                  padding: '10px 16px',
                  background: 'var(--bg)',
                  borderBottom: '1px solid var(--separator)',
                  display: 'flex',
                  gap: 12,
                  alignItems: 'center',
                  minHeight: 'auto',
                  minWidth: 'auto',
                }}
              >
                <Avatar
                  src={c.avatarUrl}
                  name={c.alias ?? c.displayName}
                  size={40}
                  online={c.online}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 500, fontSize: 16 }}>
                    {c.alias ?? c.displayName}
                  </div>
                  <div style={{ color: 'var(--text-dim)', fontSize: 13, marginTop: 2 }}>
                    {c.pin}
                  </div>
                </div>
              </button>
            ))}
          </div>
        ))}
      </div>
    </>
  );
}
