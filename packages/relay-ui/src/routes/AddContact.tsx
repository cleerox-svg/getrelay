import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ApiError } from '../lib/api';
import { stripPin } from '../lib/pin';
import { useStore } from '../lib/store';

const PIN_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

export function AddContact() {
  const [raw, setRaw] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const addContact = useStore((s) => s.addContact);
  const openOneToOne = useStore((s) => s.openOneToOne);
  const nav = useNavigate();

  const clean = stripPin(raw);
  const valid = PIN_RE.test(clean);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!valid || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { contactId } = await addContact(clean);
      const chatId = await openOneToOne(contactId);
      nav(`/chats/${encodeURIComponent(chatId)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'not_found') setError('No user found with that PIN.');
        else if (err.code === 'cannot_add_self') setError("You can't add yourself.");
        else if (err.code === 'invalid_pin') setError('Invalid PIN.');
        else setError(err.code);
      } else setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <Link to="/chats" className="btn-ghost" style={{ minWidth: 'auto', padding: 8 }}>
          ←
        </Link>
        <h1>Add contact</h1>
      </header>
      <form onSubmit={submit} style={{ padding: 24, display: 'flex', flexDirection: 'column', gap: 16 }}>
        <label style={{ color: 'var(--text-dim)', fontSize: 13 }}>Enter their PIN</label>
        <input
          className="input"
          style={{
            fontFamily: 'var(--font-mono)',
            letterSpacing: '0.08em',
            textTransform: 'uppercase',
            fontSize: 22,
            textAlign: 'center',
          }}
          autoFocus
          inputMode="text"
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck={false}
          maxLength={9}
          placeholder="XXXX·XXXX"
          value={raw}
          onChange={(e) => setRaw(e.target.value.toUpperCase())}
        />
        {error ? (
          <div style={{ color: 'var(--accent)', fontSize: 14, textAlign: 'center' }}>{error}</div>
        ) : null}
        <button className="btn-primary" type="submit" disabled={!valid || busy}>
          {busy ? 'Finding…' : 'Find →'}
        </button>
      </form>
    </div>
  );
}
