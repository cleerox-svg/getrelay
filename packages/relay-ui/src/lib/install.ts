// PWA install detection + prompt orchestration.
//
// Android Chrome/Edge fire `beforeinstallprompt` once the PWA criteria are
// met (manifest, SW, HTTPS). We capture and stash the event so the user
// can trigger it from our UI on a button tap (the spec requires a user
// gesture, and the captured event preserves the gesture from earlier).
//
// iOS has no programmatic install — we surface visual instructions
// instead.

import {
  isIOS,
  isIOSThirdPartyBrowser,
  isInAppBrowser,
  isStandalonePwa,
} from './push';

export type InstallState =
  | 'installed'           // running as a PWA already
  | 'android_installable' // beforeinstallprompt captured, can call prompt()
  | 'ios_safari'          // iOS Safari, not installed — guide to Add to Home Screen
  | 'ios_third_party'     // iOS Chrome / Firefox / Edge — must use Safari
  | 'ios_in_app'          // iOS Snapchat / Instagram / etc.
  | 'unsupported';        // desktop, or Android without the install hook

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};

let deferredEvt: BeforeInstallPromptEvent | null = null;
const subscribers = new Set<() => void>();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeinstallprompt', (e: Event) => {
    e.preventDefault();
    deferredEvt = e as BeforeInstallPromptEvent;
    subscribers.forEach((fn) => fn());
  });
  window.addEventListener('appinstalled', () => {
    deferredEvt = null;
    subscribers.forEach((fn) => fn());
  });
}

export function onInstallStateChange(fn: () => void): () => void {
  subscribers.add(fn);
  return () => {
    subscribers.delete(fn);
  };
}

export function getInstallState(): InstallState {
  if (typeof window === 'undefined') return 'unsupported';
  if (isStandalonePwa()) return 'installed';
  if (deferredEvt) return 'android_installable';
  if (isIOS()) {
    if (isInAppBrowser()) return 'ios_in_app';
    if (isIOSThirdPartyBrowser()) return 'ios_third_party';
    return 'ios_safari';
  }
  return 'unsupported';
}

export async function triggerInstall(): Promise<'accepted' | 'dismissed' | 'unavailable'> {
  if (!deferredEvt) return 'unavailable';
  await deferredEvt.prompt();
  const { outcome } = await deferredEvt.userChoice;
  deferredEvt = null;
  subscribers.forEach((fn) => fn());
  return outcome;
}
