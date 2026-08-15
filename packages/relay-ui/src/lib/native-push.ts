// Native (Capacitor) push notifications via @capacitor/push-notifications.
//
// The Android and iOS apps are WebViews that can't use Web Push (no
// PushManager), so on native platforms we register a Firebase Cloud Messaging
// device token and hand it to the worker (POST /me/push/native/register). The
// worker delivers the same message / sports payloads to it via FCM. The
// browser build keeps using Web Push (lib/push.ts) — this module is a no-op
// there.
//
// This file is deliberately platform-agnostic: iOS reaches it with an FCM
// token too, because build-ios.yml patches the native AppDelegate to swap the
// plugin's default APNs token for the Firebase one. So there is exactly one
// native push path, not two. See IOS-PUSH.md.

import { Capacitor } from '@capacitor/core';
import { API_BASE } from './api';

const TOKEN_KEY = 'relay.native_push_token';

export type NativePushState = 'unsupported' | 'denied' | 'unsubscribed' | 'subscribed';

export function isNativePush(): boolean {
  return Capacitor.isNativePlatform();
}

function nativePlatform(): 'android' | 'ios' {
  return Capacitor.getPlatform() === 'ios' ? 'ios' : 'android';
}

async function registerToken(token: string): Promise<void> {
  const res = await fetch(`${API_BASE}/me/push/native/register`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, platform: nativePlatform() }),
  });
  // Surface a rejected registration instead of reporting 'subscribed' for a
  // token the worker never stored. The one that matters in practice is
  // `apns_token_not_fcm` on iOS: the device registered fine, but with a raw
  // APNs token FCM can't address (see IOS-PUSH.md). Caching that token
  // locally would then make the toggle read "on" forever while no
  // notification ever arrives.
  if (!res.ok) {
    const err = (await res.json().catch(() => null)) as { error?: string } | null;
    throw new Error(err?.error ?? `register_failed_${res.status}`);
  }
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* private mode / storage disabled — token still registered server-side */
  }
}

// Request permission, register with FCM/APNs, and send the device token to
// the worker. Resolves the resulting state; rejects if registration fails
// (most commonly because the build has no Firebase config — see
// ANDROID-PUSH.md).
export async function enableNativePush(): Promise<NativePushState> {
  if (!isNativePush()) return 'unsupported';
  const { PushNotifications } = await import('@capacitor/push-notifications');

  let perm = await PushNotifications.checkPermissions();
  if (perm.receive !== 'granted' && perm.receive !== 'denied') {
    perm = await PushNotifications.requestPermissions();
  }
  if (perm.receive !== 'granted') {
    return perm.receive === 'denied' ? 'denied' : 'unsubscribed';
  }

  // Attach the one-shot result listeners BEFORE register() so we don't miss
  // the event, then wait for either the token or an error.
  //
  // These are removed by HANDLE, never via removeAllListeners(): that call
  // detaches EVERY listener on the plugin, including the app-wide
  // `pushNotificationActionPerformed` router in App.tsx that routes a
  // notification tap to its chat. Enabling notifications would otherwise
  // silently break tap-routing until the next cold start.
  const handles: { remove: () => Promise<void> }[] = [];
  try {
    const token = await new Promise<string>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          reject(new Error('registration_timeout'));
        }
      }, 15000);
      const finish = (fn: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        fn();
      };
      Promise.all([
        PushNotifications.addListener('registration', (t) => finish(() => resolve(t.value))),
        PushNotifications.addListener('registrationError', (e) =>
          finish(() =>
            reject(new Error(String((e as { error?: string })?.error ?? 'registration_error'))),
          ),
        ),
      ])
        .then((hs) => {
          handles.push(...hs);
          return PushNotifications.register();
        })
        .catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
    });

    await registerToken(token);
    return 'subscribed';
  } finally {
    await Promise.all(handles.map((h) => h.remove().catch(() => undefined)));
  }
}

// Keep the worker's copy of this device's token current for as long as the app
// is running. Firebase rotates FCM tokens (restore from backup, reinstall,
// long idle) and fires `registration` again — on iOS via the AppDelegate's
// MessagingDelegate, on Android from the plugin itself. Without this the
// stored token goes stale and pushes stop arriving with nothing on screen to
// explain it. Call once at app start; returns a detach function.
export async function watchNativePushToken(): Promise<() => void> {
  if (!isNativePush()) return () => undefined;
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const handle = await PushNotifications.addListener('registration', (t) => {
    // Only re-register a token that replaces one we already had. A first-ever
    // token belongs to the enableNativePush() flow, which stores it itself.
    let known: string | null = null;
    try {
      known = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    if (!known || known === t.value) return;
    registerToken(t.value).catch(() => undefined);
  });
  return () => {
    handle.remove().catch(() => undefined);
  };
}

export async function disableNativePush(): Promise<NativePushState> {
  if (!isNativePush()) return 'unsupported';
  let token: string | null = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  try {
    const { PushNotifications } = await import('@capacitor/push-notifications');
    await PushNotifications.unregister().catch(() => undefined);
  } catch {
    /* ignore */
  }
  await fetch(`${API_BASE}/me/push/native/unregister`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token }),
  }).catch(() => undefined);
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
  return 'unsubscribed';
}

// Fire a test push at every device token this account has registered and
// return the per-token result, shaped like lib/push.ts's PushTestResult so
// the Profile screen renders both with one component. The native twin of
// sendTestPush() — on a native build the web-push test hits `no_subscriptions`
// and tells you nothing, since these installs never subscribe that way.
export async function sendNativeTestPush(): Promise<
  { endpointHost: string; status: number; ok: boolean; body?: string }[]
> {
  const res = await fetch(`${API_BASE}/me/push/native/test`, {
    method: 'POST',
    credentials: 'include',
  });
  const json = (await res.json().catch(() => ({}))) as {
    results?: { platform: string; tokenTail: string; status: number; ok: boolean; body?: string }[];
    error?: string;
  };
  if (!res.ok) throw new Error(json.error ?? `http_${res.status}`);
  return (json.results ?? []).map((r) => ({
    // Reuse the endpoint column to identify the device: which platform, and
    // enough of the token to tell two phones on one account apart.
    endpointHost: `${r.platform} …${r.tokenTail}`,
    status: r.status,
    ok: r.ok,
    body: r.body,
  }));
}

export async function currentNativePushState(): Promise<NativePushState> {
  if (!isNativePush()) return 'unsupported';
  const { PushNotifications } = await import('@capacitor/push-notifications');
  const perm = await PushNotifications.checkPermissions();
  if (perm.receive === 'denied') return 'denied';
  if (perm.receive === 'granted') {
    let token: string | null = null;
    try {
      token = localStorage.getItem(TOKEN_KEY);
    } catch {
      /* ignore */
    }
    return token ? 'subscribed' : 'unsubscribed';
  }
  return 'unsubscribed';
}
