import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Block,
  Button,
  List,
  ListInput,
  ListItem,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { ApiError } from '../lib/api';
import { useStore } from '../lib/store';

export function NewGroup() {
  const nav = useNavigate();
  const contacts = useStore((s) => s.contacts);
  const loadContacts = useStore((s) => s.loadContacts);
  const createGroup = useStore((s) => s.createGroup);

  const [subject, setSubject] = useState('');
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (contacts.length === 0) loadContacts().catch(() => undefined);
  }, [contacts.length, loadContacts]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return contacts;
    return contacts.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        (c.alias ?? '').toLowerCase().includes(q) ||
        c.pin.toLowerCase().includes(q),
    );
  }, [contacts, query]);

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);
  const canCreate = subject.trim().length > 0 && selectedIds.length >= 1 && !busy;

  function toggle(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  async function submit() {
    if (!canCreate) return;
    setBusy(true);
    setError(null);
    try {
      const chatId = await createGroup(subject.trim(), selectedIds);
      nav(`/chats/${encodeURIComponent(chatId)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'invalid_subject') setError('Subject is required (≤ 80 characters).');
        else if (err.code === 'need_member') setError('Pick at least one member.');
        else if (err.code === 'too_many_members') setError('Groups are capped at 50 members.');
        else if (err.code === 'not_in_contacts') setError('Some picks are not in your contacts.');
        else setError(err.code);
      } else setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <Navbar
        title="New Group"
        left={<NavbarBackLink text="Chats" onClick={() => nav('/chats')} />}
        right={
          <button
            onClick={submit}
            disabled={!canCreate}
            className="px-3 font-semibold disabled:opacity-40"
            style={{ color: 'var(--accent)' }}
          >
            {busy ? '…' : 'Create'}
          </button>
        }
      />

      <List strong inset>
        <ListInput
          label="Subject"
          type="text"
          placeholder="What's this group about?"
          value={subject}
          maxLength={80}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSubject(e.target.value)}
        />
      </List>

      <List strong inset>
        <ListInput
          type="text"
          placeholder="Search contacts"
          clearButton
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
        />
      </List>

      {error ? (
        <Block className="text-center text-sm" style={{ color: 'var(--ping)' }}>
          {error}
        </Block>
      ) : null}

      <Block className="!py-1 text-xs" style={{ color: 'var(--text-dim)' }}>
        {selectedIds.length} selected
      </Block>

      <List strong inset>
        {filtered.length === 0 ? (
          <ListItem
            title={
              <span style={{ color: 'var(--text-dim)' }}>
                {contacts.length === 0
                  ? 'You have no contacts yet.'
                  : 'No contacts match that search.'}
              </span>
            }
          />
        ) : (
          filtered.map((c) => (
            <ListItem
              key={c.id}
              link
              chevronIos={false}
              onClick={() => toggle(c.id)}
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
              after={
                <span
                  aria-hidden="true"
                  className="inline-flex items-center justify-center"
                  style={{
                    width: 22,
                    height: 22,
                    borderRadius: 999,
                    border: '2px solid var(--text-dim)',
                    background: selected[c.id] ? 'var(--accent)' : 'transparent',
                    borderColor: selected[c.id] ? 'var(--accent)' : 'var(--text-dim)',
                    color: '#FFFFFF',
                    fontSize: 12,
                    fontWeight: 700,
                  }}
                >
                  {selected[c.id] ? '✓' : ''}
                </span>
              }
            />
          ))
        )}
      </List>
    </Page>
  );
}
