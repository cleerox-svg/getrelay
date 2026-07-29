// Native (Capacitor) push notifications via @capacitor/push-notifications.
//
// The Android app is a WebView that can't use Web Push (no PushManager), so
// on native platforms we register a Firebase Cloud Messaging device token
// and hand it to the worker (POST /me/push/native/register). The worker
// delivers the same message / sports payloads to it via FCM. The browser
// build keeps using Web Push (lib/push.ts) — this module is a no-op there.

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
  await fetch(`${API_BASE}/me/push/native/register`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token, platform: nativePlatform() }),
  });
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
  await PushNotifications.removeAllListeners();
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
      .then(() => PushNotifications.register())
      .catch((e) => finish(() => reject(e instanceof Error ? e : new Error(String(e)))));
  });

  await registerToken(token);
  return 'subscribed';
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
