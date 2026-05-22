import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, Button, List, ListInput, Page } from 'konsta/react';
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
    <Page>
      <Block className="text-center mt-6">
        <div className="text-3xl font-extrabold tracking-tight" style={{ color: 'var(--accent)' }}>
          Welcome to Relay
        </div>
        <div className="mt-2" style={{ color: 'var(--text-dim)' }}>
          Your PIN is ready.
        </div>
      </Block>
      <Block strong inset className="text-center !py-6">
        <PinDisplay pin={me.pin} size="lg" />
      </Block>
      <Block className="text-center leading-7" style={{ color: 'var(--text-dim)' }}>
        Share it. Memorize it.
        <br />
        This is who you are on Relay.
      </Block>
      <Block>
        <Button outline onClick={copy}>
          {copied ? 'Copied' : 'Copy PIN'}
        </Button>
      </Block>
      <List strong inset>
        <ListInput
          label="Display name"
          type="text"
          value={displayName}
          maxLength={64}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)}
        />
      </List>
      <Block>
        <Button large disabled={saving} onClick={continueOn}>
          Continue
        </Button>
      </Block>
    </Page>
  );
}
