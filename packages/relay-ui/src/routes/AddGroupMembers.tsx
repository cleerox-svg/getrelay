import { useEffect, useMemo, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Block,
  List,
  ListInput,
  ListItem,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { ApiError, api } from '../lib/api';
import { useStore } from '../lib/store';

export function AddGroupMembers() {
  const { id: rawId } = useParams<{ id: string }>();
  const chatId = decodeURIComponent(rawId ?? '');
  const nav = useNavigate();
  const contacts = useStore((s) => s.contacts);
  const loadContacts = useStore((s) => s.loadContacts);
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const addGroupMembers = useStore((s) => s.addGroupMembers);

  const [memberIds, setMemberIds] = useState<Set<string> | null>(null);
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (contacts.length === 0) loadContacts().catch(() => undefined);
  }, [contacts.length, loadContacts]);

  // Filter contacts down to "not already in the group" so the picker
  // never duplicates an existing member.
  useEffect(() => {
    let cancelled = false;
    api
      .listChatMembers(chatId)
      .then((r) => {
        if (!cancelled) setMemberIds(new Set(r.members.map((m) => m.id)));
      })
      .catch(() => {
        if (!cancelled) setMemberIds(new Set());
      });
    return () => {
      cancelled = true;
    };
  }, [chatId]);

  const eligible = useMemo(() => {
    if (memberIds === null) return [];
    return contacts.filter((c) => !memberIds.has(c.id));
  }, [contacts, memberIds]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return eligible;
    return eligible.filter(
      (c) =>
        c.displayName.toLowerCase().includes(q) ||
        (c.alias ?? '').toLowerCase().includes(q) ||
        c.pin.toLowerCase().includes(q),
    );
  }, [eligible, query]);

  const selectedIds = Object.keys(selected).filter((k) => selected[k]);
  const canAdd = selectedIds.length >= 1 && !busy;

  function toggle(id: string) {
    setSelected((s) => ({ ...s, [id]: !s[id] }));
  }

  async function submit() {
    if (!canAdd) return;
    setBusy(true);
    setError(null);
    try {
      await addGroupMembers(chatId, selectedIds);
      nav(`/groups/${encodeURIComponent(chatId)}`, { replace: true });
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'not_in_contacts')
          setError('Some picks are not in your contacts.');
        else if (err.code === 'no_members') setError('Pick at least one contact.');
        else if (err.code === 'not_a_group') setError("This isn't a group chat.");
        else if (err.code === 'not_in_chat')
          setError("You're no longer in this group.");
        else setError(err.code);
      } else setError('Network error');
    } finally {
      setBusy(false);
    }
  }

  if (chat && chat.type !== 'group') {
    nav(`/chats/${encodeURIComponent(chatId)}`, { replace: true });
    return null;
  }

  return (
    <Page>
      <Navbar
        title="Add Members"
        left={
          <NavbarBackLink
            text="Group"
            onClick={() => nav(`/groups/${encodeURIComponent(chatId)}`)}
          />
        }
        right={
          <button
            onClick={submit}
            disabled={!canAdd}
            className="px-3 font-semibold disabled:opacity-40"
            style={{ color: 'var(--accent)' }}
          >
            {busy ? '…' : 'Add'}
          </button>
        }
      />

      <List strong inset>
        <ListInput
          type="text"
          placeholder="Search contacts"
          clearButton
          value={query}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setQuery(e.target.value)
          }
        />
      </List>

      {error ? (
        <Block className="text-center text-sm" style={{ color: 'var(--ping)' }}>
          {error}
        </Block>
      ) : null}

      <Block className="!py-1 text-xs" style={{ color: 'var(--text-dim)' }}>
        {selectedIds.length} selected · {eligible.length} eligible
      </Block>

      <List strong inset>
        {memberIds === null ? (
          <ListItem
            title={
              <span style={{ color: 'var(--text-dim)' }}>Loading…</span>
            }
          />
        ) : filtered.length === 0 ? (
          <ListItem
            title={
              <span style={{ color: 'var(--text-dim)' }}>
                {eligible.length === 0
                  ? 'All your contacts are already in this group.'
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
