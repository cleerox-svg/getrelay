import { beforeAll, describe, expect, it } from 'vitest';

// Regression guard for the useSyncExternalStore contract: getAudioPrefs() MUST
// return a referentially STABLE object between changes (a fresh object literal
// each call makes React 19's useSyncExternalStore re-render forever — the
// "Maximum update depth exceeded" crash that took down the Course HUD/Profile).
// The reference may only change when a pref actually flips.

// The sim harness runs in a plain node env (no localStorage). Stub a minimal
// in-memory one BEFORE the module under test is imported (dynamic import in the
// tests, after this beforeAll) so prefs can persist and we can assert values.
const store = new Map<string, string>();
beforeAll(() => {
  (globalThis as unknown as { localStorage: Storage }).localStorage = {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => {
      store.set(k, v);
    },
    removeItem: (k: string) => {
      store.delete(k);
    },
    clear: () => store.clear(),
    key: () => null,
    get length() {
      return store.size;
    },
  } as Storage;
});

describe('audio prefs snapshot stability', () => {
  it('returns a stable reference between changes and a new one on change', async () => {
    const { getAudioPrefs, setAudioPrefs } = await import('./prefs');

    const a = getAudioPrefs();
    // Repeated reads with nothing changed → SAME reference (the crash guard).
    expect(getAudioPrefs()).toBe(a);
    expect(getAudioPrefs()).toBe(a);
    // Defaults: effects + music on, not muted.
    expect(a).toEqual({ sfx: true, music: true, muted: false });

    setAudioPrefs({ muted: true });
    const b = getAudioPrefs();
    expect(b).not.toBe(a); // a change yields a NEW reference…
    expect(b.muted).toBe(true); // …reflecting the new value…
    expect(getAudioPrefs()).toBe(b); // …then stable again.

    setAudioPrefs({ muted: false });
    expect(getAudioPrefs()).not.toBe(b);
    expect(getAudioPrefs().muted).toBe(false);
  });

  it('notifies subscribers with the fresh snapshot exactly on change', async () => {
    const { getAudioPrefs, setAudioPrefs, subscribeAudioPrefs } = await import('./prefs');

    let seen: unknown = null;
    let calls = 0;
    const unsub = subscribeAudioPrefs((p) => {
      calls += 1;
      seen = p;
    });

    setAudioPrefs({ sfx: false });
    expect(calls).toBe(1);
    expect(seen).toBe(getAudioPrefs()); // listener got the cached (stable) object
    expect(getAudioPrefs().sfx).toBe(false);

    unsub();
    setAudioPrefs({ sfx: true });
    expect(calls).toBe(1); // no longer notified after unsubscribe
  });
});
