import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Block,
  BlockTitle,
  Button,
  List,
  ListItem,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { PinDisplay } from '../components/PinDisplay';
import { api } from '../lib/api';
import { useStore } from '../lib/store';

const SUPPORT_EMAIL = 'support@averrow.com';

function formatLastSeen(ms: number | null): string {
  if (ms === null) return 'never';
  const diff = Date.now() - ms;
  if (diff < 60 * 1000) return 'just now';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return new Date(ms).toLocaleDateString();
}

export function ContactProfile() {
  const { id } = useParams();
  const nav = useNavigate();
  const contacts = useStore((s) => s.contacts);
  const loadContacts = useStore((s) => s.loadContacts);
  const openOneToOne = useStore((s) => s.openOneToOne);
  const presence = useStore((s) => s.presence);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (contacts.length === 0) loadContacts().catch(() => undefined);
  }, [contacts.length, loadContacts]);

  const contact = contacts.find((c) => c.id === id);

  if (!id) {
    return (
      <Page>
        <Navbar
          title="Contact"
          left={<NavbarBackLink text="Contacts" onClick={() => nav('/contacts')} />}
        />
        <Block className="text-center" style={{ color: 'var(--text-dim)' }}>
          Missing id.
        </Block>
      </Page>
    );
  }

  if (!contact) {
    return (
      <Page>
        <Navbar
          title="Contact"
          left={<NavbarBackLink text="Contacts" onClick={() => nav('/contacts')} />}
        />
        <Block className="text-center" style={{ color: 'var(--text-dim)' }}>
          {contacts.length === 0 ? 'Loading…' : 'Contact not found.'}
        </Block>
      </Page>
    );
  }

  const live = presence[contact.id];
  const online = live?.online ?? contact.online;
  const lastSeen = live?.lastSeen ?? contact.lastSeenAt;

  async function openChat() {
    if (!contact) return;
    const chatId = await openOneToOne(contact.id);
    nav(`/chats/${encodeURIComponent(chatId)}`);
  }

  async function block() {
    if (!contact) return;
    const ok = window.confirm(
      `Block ${contact.displayName}? They won't be able to message you and they'll disappear from your contacts and chats.`,
    );
    if (!ok) return;
    setBusy(true);
    try {
      await api.blockUser(contact.id);
      await loadContacts();
      nav('/contacts');
    } catch {
      setBusy(false);
    }
  }

  function report() {
    if (!contact) return;
    const subject = `Report user ${contact.pin}`;
    const body = `User: ${contact.displayName} (${contact.pin}, id: ${contact.id})\n\nDescribe the issue:\n\n`;
    const href = `mailto:${SUPPORT_EMAIL}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
  }

  return (
    <Page>
      <Navbar
        title="Contact"
        left={<NavbarBackLink text="Contacts" onClick={() => nav('/contacts')} />}
      />

      <Block className="flex flex-col items-center gap-2 !mt-4">
        <Avatar
          src={contact.avatarUrl}
          name={contact.alias ?? contact.displayName}
          size={96}
          online={online}
        />
        <div className="text-2xl font-semibold mt-2">
          {contact.alias ?? contact.displayName}
        </div>
        {contact.alias && contact.alias !== contact.displayName ? (
          <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
            {contact.displayName}
          </div>
        ) : null}
        {contact.statusMessage ? (
          <div
            className="text-sm text-center mt-1"
            style={{ color: 'var(--text-dim)', maxWidth: 280 }}
          >
            {contact.statusMessage}
          </div>
        ) : null}
        <div className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
          {online ? (
            <span style={{ color: 'var(--online)' }}>● Online</span>
          ) : (
            <>Last seen {formatLastSeen(lastSeen)}</>
          )}
        </div>
      </Block>

      <BlockTitle>PIN (Username)</BlockTitle>
      <List strong inset>
        <ListItem
          title={<PinDisplay pin={contact.pin} />}
          after={
            <button
              onClick={() => navigator.clipboard.writeText(contact.pin).catch(() => undefined)}
              className="text-sm font-medium"
              style={{ color: 'var(--accent)' }}
            >
              Copy
            </button>
          }
        />
      </List>

      <Block>
        <Button onClick={openChat}>Message</Button>
      </Block>

      <BlockTitle>Safety</BlockTitle>
      <List strong inset>
        <ListItem
          link
          title="Report this user"
          onClick={report}
          after={
            <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
              opens email
            </span>
          }
        />
        <ListItem
          link
          title={<span style={{ color: 'var(--ping, #FF3B30)' }}>Block</span>}
          onClick={busy ? undefined : block}
        />
      </List>
    </Page>
  );
}
