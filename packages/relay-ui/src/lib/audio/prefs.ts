// Audio preferences — localStorage-backed, mirroring lib/theme.ts's
// get/set/init pattern. Three independent booleans:
//   relay.audio.sfx    — sound effects on/off        (default ON)
//   relay.audio.music  — background music on/off      (default OFF)
//   relay.audio.muted  — master mute (overrides both) (default OFF)
//
// The engine (lib/audio/engine.ts) reads these to size its gain buses and
// subscribes to changes so toggling mute is instant. This module has NO
// dependency on the engine or Web Audio, so it is safe to import from
// main.tsx (initAudio) before React mounts and before any AudioContext
// exists. Every access is wrapped so a blocked/absent localStorage never
// throws.
//
// A key stores a boolean by ABSENCE = default: like theme's 'auto', we only
// write the key when the value DEVIATES from the default, and remove it to
// return to the default. So a fresh install (no keys) reads the defaults.

export interface AudioPrefs {
  sfx: boolean;
  music: boolean;
  muted: boolean;
}

const KEY_SFX = 'relay.audio.sfx';
const KEY_MUSIC = 'relay.audio.music';
const KEY_MUTED = 'relay.audio.muted';

// Defaults: effects enabled, MUSIC OFF (the synth bed is a fallback until a real
// looping track is dropped in — see engine.ts SAMPLE_FILES), not muted.
const DEFAULTS: AudioPrefs = { sfx: true, music: false, muted: false };

// A boolean pref stored by deviation-from-default (mirrors theme's 'auto'
// removeItem). `def` is the value assumed when the key is absent.
function readBool(key: string, def: boolean): boolean {
  try {
    const v = localStorage.getItem(key);
    if (v === '1') return true;
    if (v === '0') return false;
    return def;
  } catch {
    return def;
  }
}

function writeBool(key: string, value: boolean, def: boolean): void {
  try {
    if (value === def) localStorage.removeItem(key);
    else localStorage.setItem(key, value ? '1' : '0');
  } catch {
    /* ignore */
  }
}

function compute(): AudioPrefs {
  return {
    sfx: readBool(KEY_SFX, DEFAULTS.sfx),
    music: readBool(KEY_MUSIC, DEFAULTS.music),
    muted: readBool(KEY_MUTED, DEFAULTS.muted),
  };
}

// Cached snapshot. `getAudioPrefs()` returns THIS reference so it stays
// referentially STABLE between changes — required by React's
// useSyncExternalStore (a fresh object each call re-renders forever, crashing
// the HUD/Profile). The reference is only replaced inside `notify()`, i.e. when
// a pref actually flips, so subscribers get a new object exactly when something
// changed.
let cached: AudioPrefs = compute();

export function getAudioPrefs(): AudioPrefs {
  return cached;
}

// Change listeners — the engine registers one to re-apply its gain buses the
// instant a pref flips (so mute is immediate). Kept here (not in the engine)
// so prefs stays the single source of truth and has no engine import.
const listeners = new Set<(p: AudioPrefs) => void>();

export function subscribeAudioPrefs(cb: (p: AudioPrefs) => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

function notify(): void {
  // Rebuild the cached snapshot (a new reference) from storage BEFORE notifying,
  // so both plain readers and useSyncExternalStore see the fresh, stable value.
  cached = compute();
  for (const cb of listeners) {
    try {
      cb(cached);
    } catch {
      /* a bad listener must not break setAudioPrefs */
    }
  }
}

export function setAudioPrefs(partial: Partial<AudioPrefs>): void {
  if (partial.sfx !== undefined) writeBool(KEY_SFX, partial.sfx, DEFAULTS.sfx);
  if (partial.music !== undefined) writeBool(KEY_MUSIC, partial.music, DEFAULTS.music);
  if (partial.muted !== undefined) writeBool(KEY_MUTED, partial.muted, DEFAULTS.muted);
  notify();
}

// Called once at module load from main.tsx (alongside initTheme). Nothing to
// apply to the DOM — prefs live purely in localStorage — but this notifies any
// already-registered listener so the engine picks up the persisted state, and
// it gives audio a single, explicit init seam parallel to initTheme().
export function initAudio(): void {
  notify();
}
