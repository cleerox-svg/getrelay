import { useSyncExternalStore } from 'react';

// UI mode picker. Three modes:
//   modern   — Konsta iOS-native styling. The default.
//   classic  — BBM-era chat list + bubbles (legacy.css). Drives the
//              `<html class="legacy">` class.
//   beta     — Sports-card aesthetic applied across Chats + Chat:
//              lifted-tile chat rows, gradient message bubbles.
//              Drives the `<html class="beta">` class.
//
// File is still named legacy.ts for blame continuity; the boolean-
// only API stuck around for a long time and there are external bits
// (the .legacy CSS class, the localStorage key) we don't want to
// renumber without reason.

export type UiMode = 'modern' | 'classic' | 'beta';

const KEY = 'relay.uiMode';
const LEGACY_KEY = 'relay.legacyUi'; // pre-v2 boolean storage
const listeners = new Set<() => void>();

function read(): UiMode {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'classic' || v === 'beta' || v === 'modern') return v;
    // Back-compat: users who toggled "Classic theme" before the
    // 3-way picker landed have relay.legacyUi=1 in storage. Treat
    // that as the new 'classic' mode and migrate on first read so
    // both keys stay in sync if some old code path still writes the
    // legacy one.
    if (localStorage.getItem(LEGACY_KEY) === '1') {
      localStorage.setItem(KEY, 'classic');
      return 'classic';
    }
    return 'modern';
  } catch {
    return 'modern';
  }
}

function apply(mode: UiMode): void {
  const html = document.documentElement;
  html.classList.toggle('legacy', mode === 'classic');
  html.classList.toggle('beta', mode === 'beta');
}

export function getUiMode(): UiMode {
  return read();
}

export function setUiMode(mode: UiMode): void {
  try {
    if (mode === 'modern') localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
    // Keep the legacy boolean storage in sync so an older bundle
    // loaded mid-flight doesn't see stale state.
    if (mode === 'classic') localStorage.setItem(LEGACY_KEY, '1');
    else localStorage.removeItem(LEGACY_KEY);
  } catch {
    /* ignore */
  }
  apply(mode);
  listeners.forEach((l) => l());
}

export function initUiMode(): void {
  apply(read());
}

export function useUiMode(): UiMode {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(),
    () => 'modern',
  );
}

// Back-compat: existing callers check a boolean for "is classic
// mode active". Beta is NOT classic — it still uses the modern
// route components (Chats / Chat / MainLayout's Konsta tabbar), it
// just opts those components into the card aesthetic. So this
// returns true only for explicit classic.
export function useLegacyUi(): boolean {
  return useUiMode() === 'classic';
}

export function useBetaUi(): boolean {
  return useUiMode() === 'beta';
}

// Deprecated shims so any stragglers keep working through one
// release. New callers should use setUiMode / useUiMode.
export function getLegacyUi(): boolean {
  return getUiMode() === 'classic';
}
export function setLegacyUi(on: boolean): void {
  setUiMode(on ? 'classic' : 'modern');
}
export function initLegacyUi(): void {
  initUiMode();
}
