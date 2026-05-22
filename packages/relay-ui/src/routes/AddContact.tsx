import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Block, Button, List, ListInput, Navbar, NavbarBackLink, Page } from 'konsta/react';
import { QrScanner } from '../components/QrScanner';
import { ApiError } from '../lib/api';
import { isValidPin, parsePinFromQr, stripPin } from '../lib/pin';
import { useStore } from '../lib/store';

export function AddContact() {
  const [params, setParams] = useSearchParams();
  const [raw, setRaw] = useState(() => params.get('pin') ?? '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [scanning, setScanning] = useState(false);
  const addContact = useStore((s) => s.addContact);
  const openOneToOne = useStore((s) => s.openOneToOne);
  const nav = useNavigate();

  const clean = stripPin(raw);
  const valid = isValidPin(clean);

  async function submit(pin: string = clean) {
    if (!isValidPin(pin) || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { contactId } = await addContact(pin);
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

  // Auto-submit when arriving via deep link (?pin=…) with a valid PIN.
  // Without this the user has to tap Find again, which defeats the
  // point of the QR-share flow. Only runs once on mount.
  useEffect(() => {
    const fromQuery = params.get('pin');
    if (!fromQuery) return;
    const pin = stripPin(fromQuery);
    if (isValidPin(pin)) submit(pin);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleScan(decoded: string) {
    setScanning(false);
    const pin = parsePinFromQr(decoded);
    if (!pin) {
      setError("That QR code isn't a Relay contact code.");
      return;
    }
    setRaw(pin);
    // Drop ?pin= so a failure can be retried without the deep-link
    // auto-submit re-firing if the user navigates away and back.
    setParams({}, { replace: true });
    submit(pin);
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
        <Button large disabled={!valid || busy} onClick={() => submit()}>
          {busy ? 'Finding…' : 'Find'}
        </Button>
        <div style={{ height: 12 }} />
        <Button large outline onClick={() => setScanning(true)} disabled={busy}>
          Scan QR code
        </Button>
      </Block>
      {scanning ? (
        <QrScanner onDecode={handleScan} onClose={() => setScanning(false)} />
      ) : null}
    </Page>
  );
}
