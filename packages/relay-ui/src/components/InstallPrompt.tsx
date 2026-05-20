import { useEffect, useState } from 'react';
import { Dialog, DialogButton } from 'konsta/react';
import {
  getInstallState,
  onInstallStateChange,
  triggerInstall,
  type InstallState,
} from '../lib/install';

const DISMISS_KEY = 'relay.install.dismissed_at';
const NEVER_KEY = 'relay.install.never';
const SNOOZE_MS = 14 * 24 * 60 * 60 * 1000;

function shouldShow(state: InstallState): boolean {
  if (state === 'installed' || state === 'unsupported') return false;
  try {
    if (localStorage.getItem(NEVER_KEY) === '1') return false;
    const last = Number(localStorage.getItem(DISMISS_KEY) ?? 0);
    if (Number.isFinite(last) && Date.now() - last < SNOOZE_MS) return false;
  } catch {
    /* ignore */
  }
  return true;
}

function ShareGlyph() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <path
        d="M12 3v12M8 7l4-4 4 4M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}

function PlusInSquare() {
  return (
    <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true">
      <rect
        x="3"
        y="3"
        width="18"
        height="18"
        rx="4"
        stroke="currentColor"
        strokeWidth="1.8"
        fill="none"
      />
      <path
        d="M12 8v8M8 12h8"
        stroke="currentColor"
        strokeWidth="1.8"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function InstallPrompt() {
  const [state, setState] = useState<InstallState>(() => getInstallState());
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const update = () => setState(getInstallState());
    update();
    return onInstallStateChange(update);
  }, []);

  useEffect(() => {
    // Wait a beat so it doesn't slam into a fresh sign-in.
    const t = setTimeout(() => {
      if (shouldShow(state)) setOpen(true);
    }, 1200);
    return () => clearTimeout(t);
  }, [state]);

  function snooze() {
    try {
      localStorage.setItem(DISMISS_KEY, String(Date.now()));
    } catch {
      /* ignore */
    }
    setOpen(false);
  }
  function never() {
    try {
      localStorage.setItem(NEVER_KEY, '1');
    } catch {
      /* ignore */
    }
    setOpen(false);
  }
  async function doInstall() {
    setBusy(true);
    try {
      await triggerInstall();
    } catch {
      /* ignore */
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  const title =
    state === 'android_installable'
      ? 'Install Relay'
      : state === 'ios_safari'
        ? 'Add Relay to your Home Screen'
        : state === 'ios_third_party'
          ? 'Use Safari to install'
          : state === 'ios_in_app'
            ? 'Open in Safari'
            : '';

  const content = (() => {
    if (state === 'android_installable') {
      return (
        <span style={{ display: 'block', lineHeight: 1.45 }}>
          Get one-tap access from your Home Screen, full-screen mode, and push
          notifications. It only takes a second.
        </span>
      );
    }
    if (state === 'ios_safari') {
      return (
        <span style={{ display: 'block', lineHeight: 1.5 }}>
          To install Relay on your iPhone:
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 10,
              justifyContent: 'flex-start',
              color: 'var(--text, #000)',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>
              <ShareGlyph />
            </span>
            <span>1. Tap the Share button at the bottom of Safari.</span>
          </span>
          <span
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              marginTop: 8,
              justifyContent: 'flex-start',
              color: 'var(--text, #000)',
            }}
          >
            <span style={{ color: 'var(--accent)' }}>
              <PlusInSquare />
            </span>
            <span>2. Scroll down and tap "Add to Home Screen".</span>
          </span>
          <span style={{ display: 'block', marginTop: 10, color: 'var(--text-dim)' }}>
            Open Relay from your Home Screen for push notifications and a
            full-screen app feel.
          </span>
        </span>
      );
    }
    if (state === 'ios_third_party') {
      return (
        <span style={{ display: 'block', lineHeight: 1.5 }}>
          On iOS, only Safari can install web apps to your Home Screen
          (Apple blocks Chrome, Firefox, and others from doing this). Open
          <code> relay.averrow.com </code> in Safari, then tap
          <strong> Share → Add to Home Screen</strong>.
        </span>
      );
    }
    if (state === 'ios_in_app') {
      return (
        <span style={{ display: 'block', lineHeight: 1.5 }}>
          This in-app browser can't install web apps. Tap the menu and choose
          <strong> Open in Safari</strong>, then tap
          <strong> Share → Add to Home Screen</strong>.
        </span>
      );
    }
    return null;
  })();

  if (!open || !content) return null;

  return (
    <Dialog
      opened={open}
      title={title}
      content={content}
      buttons={
        <>
          <DialogButton onClick={never}>Don't ask again</DialogButton>
          <DialogButton onClick={snooze}>
            {state === 'android_installable' ? 'Not now' : 'OK'}
          </DialogButton>
          {state === 'android_installable' ? (
            <DialogButton
              strong
              onClick={doInstall}
              className={busy ? 'opacity-60 pointer-events-none' : undefined}
            >
              Install
            </DialogButton>
          ) : null}
        </>
      }
    />
  );
}
