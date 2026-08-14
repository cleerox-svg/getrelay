// Public surface of the golf audio layer. HUDs / scenes import from here.
//
// The framework-light way to fire audio is the plain functions `play()` and
// `unlockAudio()` — no hook needed at a call site. `useAudioPrefs()` is a thin
// React binding for a settings UI (mute / sfx / music toggles) that stays in
// sync across components; it is NOT required to play sounds.

import { useSyncExternalStore } from 'react';
import {
  getAudioPrefs,
  setAudioPrefs,
  subscribeAudioPrefs,
  type AudioPrefs,
} from './prefs';

export {
  play,
  unlockAudio,
  isAudioUnlocked,
  startMusic,
  stopMusic,
  duckMusic,
  type SoundId,
  type PlayOpts,
} from './engine';
export {
  getAudioPrefs,
  setAudioPrefs,
  initAudio,
  subscribeAudioPrefs,
  type AudioPrefs,
} from './prefs';

// React binding for a settings surface. Returns the current prefs and the
// setter; re-renders subscribers when any pref flips.
export function useAudioPrefs(): [AudioPrefs, (p: Partial<AudioPrefs>) => void] {
  const prefs = useSyncExternalStore(subscribeAudioPrefs, getAudioPrefs, getAudioPrefs);
  return [prefs, setAudioPrefs];
}
