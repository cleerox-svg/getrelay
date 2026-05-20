import { API_BASE } from './api';

export type PushState =
  | 'unsupported'   // browser lacks ServiceWorker / PushManager
  | 'denied'        // user blocked notifications
  | 'unsubscribed'  // supported, not yet enabled
  | 'subscribed';   // active subscription on this device

export function isPushSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    'Notification' in window
  );
}

export function isIOS(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  return /iPad|iPhone|iPod/.test(ua) ||
    // iPad Pro on iPadOS 13+ reports MacIntel + touch
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}

export function isStandalonePwa(): boolean {
  if (typeof window === 'undefined') return false;
  if (window.matchMedia?.('(display-mode: standalone)').matches) return true;
  const navAsAny = navigator as unknown as { standalone?: boolean };
  return navAsAny.standalone === true;
}

export function isInAppBrowser(): boolean {
  if (typeof navigator === 'undefined') return false;
  const ua = navigator.userAgent;
  // Common in-app browser markers: Snapchat, Instagram, Facebook, TikTok,
  // LinkedIn, X, WhatsApp, Line, GSA (Google app).
  return /FBAN|FBAV|Instagram|Snapchat|TikTok|Line|MicroMessenger|LinkedInApp|WhatsApp|GSA|Twitter/i.test(
    ua,
  );
}

// Chrome on iOS reports CriOS; Firefox iOS reports FxiOS; Edge iOS EdgiOS.
// All of these are forced to use Apple's WebKit, which still gates Web
// Push behind installation from Safari only (as of iOS 18).
export function isIOSThirdPartyBrowser(): boolean {
  if (typeof navigator === 'undefined' || !isIOS()) return false;
  return /CriOS|FxiOS|EdgiOS|OPiOS|YaBrowser/i.test(navigator.userAgent);
}

export type PushBlocker =
  | 'ok'
  | 'ios_third_party_browser' // Chrome/Firefox/Edge etc. on iOS
  | 'ios_not_installed'       // iOS Safari but not Add-to-Home-Screen yet
  | 'ios_in_app_browser'      // iOS Snapchat / Instagram / etc.
  | 'in_app_browser'          // Android in-app browser
  | 'denied'
  | 'unsupported';

export function diagnosePush(state: PushState): PushBlocker {
  if (state === 'denied') return 'denied';
  if (isPushSupported()) return 'ok';
  if (isIOS()) {
    if (isInAppBrowser()) return 'ios_in_app_browser';
    if (isIOSThirdPartyBrowser()) return 'ios_third_party_browser';
    if (!isStandalonePwa()) return 'ios_not_installed';
  }
  if (isInAppBrowser()) return 'in_app_browser';
  return 'unsupported';
}

export async function currentPushState(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  return sub ? 'subscribed' : 'unsubscribed';
}

function b64urlToBuffer(s: string): ArrayBuffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const norm = (s + pad).replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(norm);
  const out = new ArrayBuffer(bin.length);
  const view = new Uint8Array(out);
  for (let i = 0; i < bin.length; i++) view[i] = bin.charCodeAt(i);
  return out;
}

function uint8ToB64url(u8: Uint8Array): string {
  let s = '';
  for (const b of u8) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function subscriptionToWire(sub: PushSubscription) {
  const p256dh = sub.getKey('p256dh');
  const auth = sub.getKey('auth');
  if (!p256dh || !auth) throw new Error('subscription missing keys');
  return {
    endpoint: sub.endpoint,
    keys: {
      p256dh: uint8ToB64url(new Uint8Array(p256dh)),
      auth: uint8ToB64url(new Uint8Array(auth)),
    },
  };
}

async function fetchPublicKey(): Promise<string> {
  const res = await fetch(`${API_BASE}/push/public-key`, { credentials: 'include' });
  if (!res.ok) throw new Error('public_key_unavailable');
  const j = (await res.json()) as { publicKey: string };
  return j.publicKey;
}

export async function enablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';

  let perm = Notification.permission;
  if (perm === 'default') perm = await Notification.requestPermission();
  if (perm !== 'granted') return perm === 'denied' ? 'denied' : 'unsubscribed';

  const publicKey = await fetchPublicKey();
  const reg = await navigator.serviceWorker.ready;
  let sub = await reg.pushManager.getSubscription();
  if (!sub) {
    sub = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: b64urlToBuffer(publicKey),
    });
  }

  const res = await fetch(`${API_BASE}/me/push/subscribe`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(subscriptionToWire(sub)),
  });
  if (!res.ok) throw new Error('subscribe_failed');
  return 'subscribed';
}

export async function disablePush(): Promise<PushState> {
  if (!isPushSupported()) return 'unsupported';
  const reg = await navigator.serviceWorker.ready;
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    const endpoint = sub.endpoint;
    await sub.unsubscribe().catch(() => undefined);
    await fetch(
      `${API_BASE}/me/push/subscribe?endpoint=${encodeURIComponent(endpoint)}`,
      { method: 'DELETE', credentials: 'include' },
    ).catch(() => undefined);
  }
  return 'unsubscribed';
}
