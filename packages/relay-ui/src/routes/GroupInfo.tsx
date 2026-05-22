import { useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Actions,
  ActionsButton,
  ActionsGroup,
  ActionsLabel,
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
import { GroupAvatar } from '../components/GroupAvatar';
import { api } from '../lib/api';
import { useStore } from '../lib/store';
import type { GroupMember } from '../lib/types';

export function GroupInfo() {
  const { id: rawId } = useParams<{ id: string }>();
  const chatId = decodeURIComponent(rawId ?? '');
  const nav = useNavigate();
  const me = useStore((s) => s.me);
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const deleteChat = useStore((s) => s.deleteChat);

  const [members, setMembers] = useState<GroupMember[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [leaveOpen, setLeaveOpen] = useState(false);
  const [leaving, setLeaving] = useState(false);

  // Re-fetch members whenever memberCount changes — covers WS
  // member_joined / member_left bumping the count from underneath.
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .listChatMembers(chatId)
      .then((r) => {
        if (!cancelled) setMembers(r.members);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });
    return () => {
      cancelled = true;
    };
  }, [chatId, chat?.memberCount]);

  // Not a group (or 1to1 mistakenly routed here) — bounce back to chat.
  if (chat && chat.type !== 'group') {
    nav(`/chats/${encodeURIComponent(chatId)}`, { replace: true });
    return null;
  }

  async function leave() {
    if (leaving) return;
    setLeaving(true);
    try {
      await deleteChat(chatId);
      nav('/chats', { replace: true });
    } catch {
      setLeaving(false);
      setError('Could not leave the group. Try again.');
    }
  }

  return (
    <Page>
      <Navbar
        title="Group Info"
        left={
          <NavbarBackLink
            text="Chat"
            onClick={() => nav(`/chats/${encodeURIComponent(chatId)}`)}
          />
        }
      />

      <Block strong inset className="text-center">
        <div className="flex flex-col items-center gap-3 py-2">
          <GroupAvatar subject={chat?.subject ?? 'Group'} size={84} />
          <div className="text-xl font-bold" style={{ color: 'var(--text)' }}>
            {chat?.subject ?? 'Group'}
          </div>
          <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
            {chat?.memberCount ?? members?.length ?? '–'} members
          </div>
        </div>
      </Block>

      <Block inset>
        <Button
          large
          outline
          onClick={() => nav(`/groups/${encodeURIComponent(chatId)}/add`)}
        >
          Add member
        </Button>
      </Block>

      <BlockTitle>Members</BlockTitle>
      <List strong inset>
        {error ? (
          <ListItem
            title={
              <span style={{ color: 'var(--ping)' }}>
                Couldn't load members.
              </span>
            }
          />
        ) : members === null ? (
          <ListItem
            title={
              <span style={{ color: 'var(--text-dim)' }}>Loading…</span>
            }
          />
        ) : (
          members.map((m) => {
            const isMe = m.id === me?.id;
            return (
              <ListItem
                key={m.id}
                media={
                  <Avatar
                    src={m.avatarUrl}
                    name={m.displayName}
                    size={40}
                    online={m.online}
                  />
                }
                title={isMe ? `${m.displayName} (you)` : m.displayName}
                text={m.pin}
                link={!isMe}
                chevronIos={!isMe}
                onClick={
                  isMe ? undefined : () => nav(`/contacts/${encodeURIComponent(m.id)}`)
                }
              />
            );
          })
        )}
      </List>

      <Block inset>
        <Button
          large
          colors={{ activeBgIos: 'bg-red-500' }}
          style={{ background: 'var(--ping)', color: '#FFFFFF' }}
          onClick={() => setLeaveOpen(true)}
        >
          Leave group
        </Button>
      </Block>

      <Actions opened={leaveOpen} onBackdropClick={() => setLeaveOpen(false)}>
        <ActionsGroup>
          <ActionsLabel>
            Leave "{chat?.subject ?? 'this group'}"? You'll stop receiving
            messages and disappear from the member list.
          </ActionsLabel>
          <ActionsButton
            className="!text-red-500"
            onClick={() => {
              setLeaveOpen(false);
              leave();
            }}
          >
            Leave group
          </ActionsButton>
        </ActionsGroup>
        <ActionsGroup>
          <ActionsButton bold onClick={() => setLeaveOpen(false)}>
            Cancel
          </ActionsButton>
        </ActionsGroup>
      </Actions>
    </Page>
  );
}
