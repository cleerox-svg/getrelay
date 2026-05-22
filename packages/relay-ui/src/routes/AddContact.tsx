import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, Button, List, ListInput, Navbar, NavbarBackLink, Page } from 'konsta/react';
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

  async function submit() {
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
    <Page>
      <Navbar
        title="Add Contact"
        left={<NavbarBackLink text="Chats" onClick={() => nav('/chats')} />}
      />
      <List strong inset>
        <ListInput
          label="Their PIN"
          type="text"
          placeholder="XXXX·XXXX"
          value={raw}
          maxLength={9}
          autoCapitalize="characters"
          autoCorrect="off"
          spellCheck="false"
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setRaw(e.target.value.toUpperCase())
          }
          inputClassName="font-mono uppercase tracking-widest text-2xl text-center"
          inputStyle={{ fontFamily: 'var(--font-mono)' }}
        />
      </List>
      {error ? (
        <Block className="text-center text-sm" style={{ color: 'var(--ping)' }}>
          {error}
        </Block>
      ) : null}
      <Block>
        <Button large disabled={!valid || busy} onClick={submit}>
          {busy ? 'Finding…' : 'Find'}
        </Button>
      </Block>
    </Page>
  );
}
