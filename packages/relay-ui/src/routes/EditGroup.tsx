import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import {
  Block,
  BlockTitle,
  Button,
  List,
  ListInput,
  Navbar,
  NavbarBackLink,
  Page,
} from 'konsta/react';
import { GroupAvatar } from '../components/GroupAvatar';
import { ApiError, api } from '../lib/api';
import { useStore } from '../lib/store';

// /groups/:id/edit — rename the group + upload or remove its avatar.
// Both write paths fan out `group_updated` on the server, so other
// devices and other members see the change in real time without a
// manual /chats refetch.
export function EditGroup() {
  const { id: rawId } = useParams<{ id: string }>();
  const chatId = decodeURIComponent(rawId ?? '');
  const nav = useNavigate();
  const chat = useStore((s) => s.chats.find((c) => c.id === chatId));
  const loadChats = useStore((s) => s.loadChats);

  const [subject, setSubject] = useState(chat?.subject ?? '');
  const [savingSubject, setSavingSubject] = useState(false);
  const [uploadingAvatar, setUploadingAvatar] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // Keep the input synced if the chat data refreshes underneath us
  // (group_updated arrives, or a manual /chats refetch lands while
  // the screen is open).
  useEffect(() => {
    setSubject(chat?.subject ?? '');
  }, [chat?.subject]);

  if (chat && chat.type !== 'group') {
    nav(`/chats/${encodeURIComponent(chatId)}`, { replace: true });
    return null;
  }

  const trimmed = subject.trim();
  const dirty = trimmed.length > 0 && trimmed !== (chat?.subject ?? '');
  const canSaveSubject = dirty && trimmed.length <= 80 && !savingSubject;

  async function saveSubject() {
    if (!canSaveSubject) return;
    setSavingSubject(true);
    setError(null);
    try {
      await api.renameGroup(chatId, trimmed);
      // group_updated WS event will land and re-sync chat.subject;
      // refresh the list as a belt-and-suspenders fallback in case
      // the socket is wedged.
      await loadChats();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'invalid_subject')
          setError('Subject is required (≤ 80 characters).');
        else if (err.code === 'not_in_chat')
          setError("You're no longer in this group.");
        else if (err.code === 'not_a_group')
          setError("This isn't a group chat.");
        else setError(err.code);
      } else setError('Network error');
    } finally {
      setSavingSubject(false);
    }
  }

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setError(null);
    setUploadingAvatar(true);
    try {
      await api.uploadGroupAvatar(chatId, file);
      await loadChats();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'too_large') setError('Image must be 2 MB or less.');
        else if (err.code === 'bad_type') setError('Use JPEG, PNG, or WebP.');
        else if (err.code === 'not_in_chat')
          setError("You're no longer in this group.");
        else setError(err.code);
      } else setError('Upload failed');
    } finally {
      setUploadingAvatar(false);
    }
  }

  async function clearAvatar() {
    setError(null);
    setUploadingAvatar(true);
    try {
      await api.removeGroupAvatar(chatId);
      await loadChats();
    } catch {
      setError('Remove failed');
    } finally {
      setUploadingAvatar(false);
    }
  }

  return (
    <Page>
      <Navbar
        title="Edit Group"
        left={
          <NavbarBackLink
            text="Group"
            onClick={() => nav(`/groups/${encodeURIComponent(chatId)}`)}
          />
        }
      />

      <Block className="flex flex-col items-center gap-2 !mt-4">
        <button
          type="button"
          onClick={() => fileInputRef.current?.click()}
          disabled={uploadingAvatar}
          aria-label="Change group photo"
          className="disabled:opacity-50"
          style={{ background: 'transparent', border: 0, padding: 0, cursor: 'pointer' }}
        >
          <GroupAvatar
            subject={chat?.subject ?? 'Group'}
            src={chat?.avatarUrl}
            size={96}
          />
        </button>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          onChange={onPickAvatar}
          hidden
        />
        <div className="flex gap-4 mt-1">
          <button
            type="button"
            onClick={() => fileInputRef.current?.click()}
            disabled={uploadingAvatar}
            className="text-sm font-medium"
            style={{ color: 'var(--accent)' }}
          >
            {uploadingAvatar
              ? 'Uploading…'
              : chat?.avatarUrl
                ? 'Change photo'
                : 'Add photo'}
          </button>
          {chat?.avatarUrl ? (
            <button
              type="button"
              onClick={clearAvatar}
              disabled={uploadingAvatar}
              className="text-sm font-medium"
              style={{ color: 'var(--ping)' }}
            >
              Remove
            </button>
          ) : null}
        </div>
      </Block>

      <BlockTitle>Subject</BlockTitle>
      <List strong inset>
        <ListInput
          type="text"
          placeholder="What's this group about?"
          value={subject}
          maxLength={80}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
            setSubject(e.target.value)
          }
        />
      </List>

      {error ? (
        <Block className="text-center text-sm" style={{ color: 'var(--ping)' }}>
          {error}
        </Block>
      ) : null}

      <Block inset>
        <Button large disabled={!canSaveSubject} onClick={saveSubject}>
          {savingSubject ? 'Saving…' : 'Save subject'}
        </Button>
      </Block>
    </Page>
  );
}
