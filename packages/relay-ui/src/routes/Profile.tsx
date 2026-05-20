import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Block,
  BlockTitle,
  Button,
  List,
  ListInput,
  ListItem,
  Navbar,
  NavbarBackLink,
  Page,
  Segmented,
  SegmentedButton,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { PinDisplay } from '../components/PinDisplay';
import { ApiError, api } from '../lib/api';
import { useStore } from '../lib/store';
import { getTheme, setTheme, type ThemeMode } from '../lib/theme';

export function Profile() {
  const me = useStore((s) => s.me);
  const loadMe = useStore((s) => s.loadMe);
  const signout = useStore((s) => s.signout);
  const [displayName, setDisplayName] = useState(me?.displayName ?? '');
  const [statusMessage, setStatusMessage] = useState(me?.statusMessage ?? '');
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);
  const [themeMode, setThemeMode] = useState<ThemeMode>('auto');
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    setThemeMode(getTheme());
  }, []);

  useEffect(() => {
    setDisplayName(me?.displayName ?? '');
    setStatusMessage(me?.statusMessage ?? '');
  }, [me?.displayName, me?.statusMessage]);

  async function save() {
    if (!me) return;
    setSaving(true);
    try {
      await api.updateMe({
        displayName: displayName.trim(),
        statusMessage: statusMessage.trim(),
      });
      await loadMe();
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    } finally {
      setSaving(false);
    }
  }

  async function doSignout() {
    await signout();
    nav('/signin', { replace: true });
  }

  async function onPickAvatar(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    setAvatarError(null);
    setUploading(true);
    try {
      await api.uploadAvatar(file);
      await loadMe();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'too_large') setAvatarError('Image must be 2 MB or less.');
        else if (err.code === 'bad_type') setAvatarError('Use JPEG, PNG, or WebP.');
        else setAvatarError(err.code);
      } else setAvatarError('Upload failed');
    } finally {
      setUploading(false);
    }
  }

  async function clearAvatar() {
    setUploading(true);
    setAvatarError(null);
    try {
      await api.removeAvatar();
      await loadMe();
    } catch {
      setAvatarError('Remove failed');
    } finally {
      setUploading(false);
    }
  }

  if (!me) return null;

  return (
    <Page>
      <Navbar
        title="Profile"
        left={<NavbarBackLink text="Chats" onClick={() => nav('/chats')} />}
      />

      <Block className="flex flex-col items-center gap-2 !mt-4">
        <button
          onClick={() => fileInputRef.current?.click()}
          disabled={uploading}
          aria-label="Change profile picture"
          className="rounded-full disabled:opacity-50"
        >
          <Avatar src={me.avatarUrl} name={me.displayName} size={96} />
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
            onClick={() => fileInputRef.current?.click()}
            disabled={uploading}
            className="text-sm font-medium"
            style={{ color: 'var(--accent)' }}
          >
            {uploading ? 'Uploading…' : me.avatarUrl ? 'Change photo' : 'Add photo'}
          </button>
          {me.avatarUrl ? (
            <button
              onClick={clearAvatar}
              disabled={uploading}
              className="text-sm font-medium"
              style={{ color: 'var(--ping)' }}
            >
              Remove
            </button>
          ) : null}
        </div>
        {avatarError ? (
          <div className="text-xs" style={{ color: 'var(--ping)' }}>
            {avatarError}
          </div>
        ) : null}
        <div className="text-2xl font-semibold mt-2">{me.displayName}</div>
        <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
          {me.email}
        </div>
        {me.isAdmin ? (
          <div className="text-xs font-semibold mt-1" style={{ color: 'var(--accent)' }}>
            ★ Platform admin
          </div>
        ) : null}
      </Block>

      <BlockTitle>PIN (Username)</BlockTitle>
      <List strongIos insetIos>
        <ListItem
          title={<PinDisplay pin={me.pin} />}
          after={
            <button
              onClick={() => navigator.clipboard.writeText(me.pin).catch(() => undefined)}
              className="text-sm font-medium"
              style={{ color: 'var(--accent)' }}
            >
              Copy
            </button>
          }
        />
      </List>

      <BlockTitle>Display</BlockTitle>
      <List strongIos insetIos>
        <ListInput
          label="Display name"
          type="text"
          value={displayName}
          maxLength={64}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setDisplayName(e.target.value)}
        />
        <ListInput
          label="Status"
          type="text"
          placeholder="What's your status?"
          value={statusMessage}
          maxLength={140}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setStatusMessage(e.target.value)}
        />
      </List>
      <Block>
        <Button onClick={save} disabled={saving}>
          {saved ? 'Saved' : saving ? 'Saving…' : 'Save'}
        </Button>
      </Block>

      <BlockTitle>Appearance</BlockTitle>
      <Block strong inset className="!py-3">
        <Segmented strong>
          {(['auto', 'light', 'dark'] as ThemeMode[]).map((m) => (
            <SegmentedButton
              key={m}
              active={themeMode === m}
              onClick={() => {
                setThemeMode(m);
                setTheme(m);
              }}
            >
              {m === 'auto' ? 'Auto' : m === 'light' ? 'Light' : 'Dark'}
            </SegmentedButton>
          ))}
        </Segmented>
        <div className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
          Auto follows your device's setting.
        </div>
      </Block>

      <Block className="mt-6">
        <Button
          outline
          onClick={doSignout}
          className="!border-red-500 !text-red-500"
        >
          Sign out
        </Button>
      </Block>
    </Page>
  );
}
