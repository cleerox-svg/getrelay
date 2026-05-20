import { useEffect, useState } from 'react';
import { Dialog, DialogButton } from 'konsta/react';
import { getInstallState } from '../lib/install';
import {
  currentPushState,
  enablePush,
  isPushSupported,
  type PushState,
} from '../lib/push';

const DISMISS_KEY = 'relay.push.dismissed_at';
const NEVER_KEY = 'relay.push.never';
const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

const INSTALL_DISMISS_KEY = 'relay.install.dismissed_at';
const INSTALL_NEVER_KEY = 'relay.install.never';

function installPromptStillPending(): boolean {
  const state = getInstallState();
  if (state === 'installed' || state === 'unsupported') return false;
  try {
    if (localStorage.getItem(INSTALL_NEVER_KEY) === '1') return false;
    const last = Number(localStorage.getItem(INSTALL_DISMISS_KEY) ?? 0);
    // Treat as "actively showing" if dismissed less than 5 minutes ago
    // — gives the user time to act on the install dialog without us
    // stacking another prompt behind it.
    if (Number.isFinite(last) && Date.now() - last < 5 * 60 * 1000) return true;
    if (last === 0) return true; // never dismissed yet → install will show
  } catch {
    /* ignore */
  }
  return false;
}

function shouldShow(state: PushState): boolean {
  if (state !== 'unsubscribed') return false;
  if (typeof Notification === 'undefined' || Notification.permission !== 'default') return false;
  if (installPromptStillPending()) return false;
  try {
    if (localStorage.getItem(NEVER_KEY) === '1') return false;
    const lastRaw = localStorage.getItem(DISMISS_KEY);
    if (lastRaw) {
      const last = Number(lastRaw);
      if (Number.isFinite(last) && Date.now() - last < SNOOZE_MS) return false;
    }
  } catch {
    /* ignore */
  }
  return true;
}

export function PushPrompt() {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!isPushSupported()) return;
    let cancelled = false;
    // Small delay so the prompt doesn't slam into the user the instant
    // /chats paints. Let them see the app first.
    const t = setTimeout(async () => {
      const state = await currentPushState().catch(() => 'unsubscribed' as PushState);
      if (!cancelled && shouldShow(state)) setOpen(true);
    }, 1500);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, []);

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

  async function enable() {
    setBusy(true);
    try {
      await enablePush();
    } catch {
      // permission denied or push not configured — silently move on; the
      // user can retry from Profile → Notifications.
    } finally {
      setBusy(false);
      setOpen(false);
    }
  }

  return (
    <Dialog
      opened={open}
      title="Turn on notifications?"
      content={
        <span style={{ display: 'block', textAlign: 'center', lineHeight: 1.4 }}>
          Get notified the moment someone messages you — even when Relay is
          closed. You can change this anytime in Profile.
        </span>
      }
      buttons={
        <>
          <DialogButton onClick={never}>Don't ask again</DialogButton>
          <DialogButton onClick={snooze}>Not now</DialogButton>
          <DialogButton
            strong
            onClick={enable}
            className={busy ? 'opacity-60 pointer-events-none' : undefined}
          >
            Enable
          </DialogButton>
        </>
      }
    />
  );
}
