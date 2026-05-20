import { useEffect } from 'react';
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
import { useStore } from '../lib/store';

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
      <List strongIos insetIos>
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
    </Page>
  );
}
