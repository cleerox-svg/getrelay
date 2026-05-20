import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import {
  Block,
  Icon,
  List,
  ListItem,
  ListInput,
  Navbar,
  Page,
} from 'konsta/react';
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
    <Page>
      <Navbar
        title="Contacts"
        left={
          <Link to="/profile" className="px-3">
            <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={30} />
          </Link>
        }
        right={
          <Link to="/add-contact" className="px-3" aria-label="Add contact">
            <Icon
              ios={
                <svg viewBox="0 0 28 28" width="28" height="28">
                  <path d="M14 7v14M7 14h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
                </svg>
              }
            />
          </Link>
        }
        large
        transparent
      />

      <List strongIos insetIos>
        <ListInput
          type="text"
          placeholder="Search"
          clearButton
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
        />
      </List>

      {contacts.length === 0 ? (
        <Block className="text-center" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">No contacts yet</div>
          <div className="text-sm">Tap + to add one by PIN.</div>
        </Block>
      ) : (
        grouped.map(([letter, items]) => (
          <List key={letter} strongIos insetIos>
            <ListItem title={letter} groupTitle />
            {items.map((c) => (
              <ListItem
                key={c.id}
                link
                chevronIos={false}
                onClick={async () => {
                  const chatId = await openOneToOne(c.id);
                  nav(`/chats/${encodeURIComponent(chatId)}`);
                }}
                media={
                  <Avatar
                    src={c.avatarUrl}
                    name={c.alias ?? c.displayName}
                    size={40}
                    online={c.online}
                  />
                }
                title={c.alias ?? c.displayName}
                text={c.pin}
              />
            ))}
          </List>
        ))
      )}
    </Page>
  );
}
