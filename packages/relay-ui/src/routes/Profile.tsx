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
import { PillToggle } from '../components/PillToggle';
import { PinDisplay } from '../components/PinDisplay';
import { QrCodeDisplay } from '../components/QrCodeDisplay';
import { ApiError, api } from '../lib/api';
import { setUiMode, useUiMode, type UiMode } from '../lib/legacy';
import {
  currentPushState,
  diagnosePush,
  disablePush,
  enablePush,
  sendTestPush,
  type PushState,
  type PushTestResult,
} from '../lib/push';
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
  const [pushState, setPushState] = useState<PushState>('unsubscribed');
  const [pushBusy, setPushBusy] = useState(false);
  const [pushError, setPushError] = useState<string | null>(null);
  const [testResults, setTestResults] = useState<PushTestResult[] | null>(null);
  const [testing, setTesting] = useState(false);
  const [blocked, setBlocked] = useState<
    {
      id: string;
      pin: string;
      displayName: string;
      statusMessage: string | null;
      avatarUrl: string | null;
      blockedAt: number;
    }[]
  >([]);
  const uiMode = useUiMode();
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const nav = useNavigate();

  useEffect(() => {
    setThemeMode(getTheme());
    currentPushState().then(setPushState).catch(() => undefined);
    api.listBlocks().then((r) => setBlocked(r.blocked)).catch(() => undefined);
  }, []);

  async function unblock(userId: string) {
    try {
      await api.unblockUser(userId);
      setBlocked((bs) => bs.filter((b) => b.id !== userId));
    } catch {
      /* ignore */
    }
  }

  async function runPushTest() {
    setTesting(true);
    setTestResults(null);
    setPushError(null);
    try {
      const results = await sendTestPush();
      setTestResults(results);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'failed');
    } finally {
      setTesting(false);
    }
  }

  async function togglePush() {
    setPushBusy(true);
    setPushError(null);
    try {
      const next =
        pushState === 'subscribed' ? await disablePush() : await enablePush();
      setPushState(next);
    } catch (err) {
      setPushError(err instanceof Error ? err.message : 'failed');
    } finally {
      setPushBusy(false);
    }
  }

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
      <List strong inset>
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

      <BlockTitle>Add me on Relay</BlockTitle>
      <Block strong inset>
        <QrCodeDisplay pin={me.pin} />
        <div
          className="text-center text-sm"
          style={{ color: 'var(--text-dim)', marginTop: 12 }}
        >
          Anyone with the Relay app can scan this to add you.
        </div>
      </Block>

      <BlockTitle>Display</BlockTitle>
      <List strong inset>
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

      <BlockTitle>Notifications</BlockTitle>
      <Block strong inset className="!py-4">
        {(() => {
          const blocker = diagnosePush(pushState);
          if (blocker === 'ios_in_app_browser') {
            return (
              <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                Push notifications can't run inside this in-app browser.
                Tap the share / menu icon and choose <strong>Open in Safari</strong>,
                then come back here.
              </div>
            );
          }
          if (blocker === 'ios_third_party_browser') {
            return (
              <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                On iOS, push notifications only work in <strong>Safari</strong> —
                Apple blocks them in Chrome, Firefox, and other browsers (even
                though they look like separate apps, they all run on Safari's
                engine but without push access). Open
                <code> relay.averrow.com </code>
                in Safari, then tap <strong>Share → Add to Home Screen</strong> and
                launch Relay from your Home Screen icon.
              </div>
            );
          }
          if (blocker === 'in_app_browser') {
            return (
              <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                Push notifications aren't available in this in-app browser.
                Open <code>relay.averrow.com</code> in Chrome, Edge, or
                Firefox to enable them.
              </div>
            );
          }
          if (blocker === 'ios_not_installed') {
            return (
              <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                On iOS, push notifications require installing Relay to your
                Home Screen first. In Safari: tap the <strong>Share</strong>{' '}
                button → <strong>Add to Home Screen</strong>. Then open Relay
                from your Home Screen and try again.
              </div>
            );
          }
          if (blocker === 'denied') {
            return (
              <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                Notifications are blocked for this site. Enable them in your
                browser's site settings, then refresh.
              </div>
            );
          }
          if (blocker === 'unsupported') {
            return (
              <div className="text-sm" style={{ color: 'var(--text-dim)' }}>
                This browser doesn't support web push notifications.
              </div>
            );
          }
          return (
          <>
            <div
              className="flex items-center justify-between gap-3"
              style={{ minHeight: 32 }}
            >
              <div>
                <div className="font-medium">Push notifications</div>
                <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
                  {pushState === 'subscribed'
                    ? 'Enabled on this device.'
                    : 'Get notified when someone messages you and the app is closed.'}
                </div>
              </div>
              <PillToggle
                on={pushState === 'subscribed'}
                disabled={pushBusy}
                onChange={togglePush}
                onLabel={pushBusy ? '…' : 'Enabled'}
                offLabel={pushBusy ? '…' : 'Enable'}
                destructive={pushState === 'subscribed'}
              />
            </div>
              {pushError ? (
                <div className="text-xs mt-2" style={{ color: 'var(--ping)' }}>
                  {pushError}
                </div>
              ) : null}
              {pushState === 'subscribed' ? (
                <div className="mt-3">
                  <button
                    onClick={runPushTest}
                    disabled={testing}
                    className="text-sm font-medium disabled:opacity-50"
                    style={{ color: 'var(--accent)' }}
                  >
                    {testing ? 'Sending…' : 'Send test notification'}
                  </button>
                  {testResults ? (
                    <div className="mt-2 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                      {testResults.length === 0 ? (
                        <div>No subscriptions for this account.</div>
                      ) : (
                        testResults.map((r, i) => (
                          <div key={i} style={{ marginTop: 4 }}>
                            <span style={{ color: r.ok ? 'var(--online)' : 'var(--ping)' }}>
                              {r.ok ? '✓' : '✗'}
                            </span>{' '}
                            <code>{r.endpointHost}</code> · HTTP {r.status}
                            {r.body ? (
                              <div
                                style={{
                                  marginLeft: 16,
                                  marginTop: 2,
                                  whiteSpace: 'pre-wrap',
                                  wordBreak: 'break-word',
                                }}
                              >
                                {r.body}
                              </div>
                            ) : null}
                          </div>
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              ) : null}
            </>
          );
        })()}
      </Block>

      <Block strong inset className="!py-3 !mt-2">
        <div className="flex items-center justify-between gap-3">
          <div>
            <div className="font-medium">Sports</div>
            <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
              Follow teams and tune which pushes you receive.
            </div>
          </div>
          <button
            type="button"
            onClick={() => nav('/settings/sports')}
            className="pill-link"
          >
            Settings
          </button>
        </div>
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
        <div
          className="mt-4 pt-3"
          style={{ borderTop: '1px solid var(--separator, rgba(0,0,0,0.08))' }}
        >
          <div className="font-medium mb-1">UI style</div>
          <Segmented strong>
            {(
              [
                { id: 'classic', label: 'Classic' },
                { id: 'modern', label: 'Modern' },
                { id: 'beta', label: 'Beta' },
              ] satisfies { id: UiMode; label: string }[]
            ).map((m) => (
              <SegmentedButton
                key={m.id}
                active={uiMode === m.id}
                onClick={() => setUiMode(m.id)}
              >
                {m.label}
              </SegmentedButton>
            ))}
          </Segmented>
          <div className="text-xs mt-2" style={{ color: 'var(--text-dim)' }}>
            {uiMode === 'classic'
              ? 'Classic — BBM-era chat list and bubbles. Tab strip on top, tight rows.'
              : uiMode === 'modern'
                ? 'Modern — iOS-native styling via Konsta. The default.'
                : 'Beta — preview of the upcoming look: every chat row and message bubble gets the lifted-card treatment from /sports. Try it before we replace Modern.'}
          </div>
        </div>
      </Block>

      <Block
        strong
        inset
        className="!mt-6 !py-3"
      >
        <div className="flex items-baseline gap-2 mb-1">
          <span
            className="text-[10px] font-bold tracking-wider px-1.5 py-[1px] rounded-sm"
            style={{ background: 'var(--accent)', color: '#FFFFFF', letterSpacing: 1 }}
          >
            BETA
          </span>
          <span className="font-medium">You're testing Relay early</span>
        </div>
        <div className="text-xs" style={{ color: 'var(--text-dim)' }}>
          Things may break. When Relay reaches its 1.0 release we'll
          introduce optional ads and a subscription to remove them. Beta
          testers will get a heads-up first.
        </div>
        <div className="text-xs mt-2">
          <a
            href="/privacy"
            target="_blank"
            rel="noreferrer"
            style={{ color: 'var(--accent)' }}
          >
            Privacy policy
          </a>
        </div>
      </Block>

      {blocked.length > 0 ? (
        <>
          <BlockTitle>Blocked users</BlockTitle>
          <List strong inset>
            {blocked.map((b) => (
              <ListItem
                key={b.id}
                media={<Avatar src={b.avatarUrl} name={b.displayName} size={36} />}
                title={b.displayName}
                after={
                  <button
                    onClick={() => unblock(b.id)}
                    className="text-sm font-medium"
                    style={{ color: 'var(--accent)' }}
                  >
                    Unblock
                  </button>
                }
              />
            ))}
          </List>
        </>
      ) : null}

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
