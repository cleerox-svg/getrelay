import { useSyncExternalStore } from 'react';

const KEY = 'relay.legacyUi';
const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return false;
  }
}

function apply(on: boolean): void {
  const html = document.documentElement;
  if (on) html.classList.add('legacy');
  else html.classList.remove('legacy');
}

export function getLegacyUi(): boolean {
  return read();
}

export function setLegacyUi(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
  apply(on);
  listeners.forEach((l) => l());
}

export function initLegacyUi(): void {
  apply(read());
}

export function useLegacyUi(): boolean {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => read(),
    () => false,
  );
}
