// BASEBALL'S LOCAL PREFERENCES — and the first `localStorage` this game has.
//
// ⚠ IT IS THE FIRST, SO IT IS THE PATTERN. Baseball had no local persistence at
// all until this file; the next one — a preferred camera mode, a muted-audio
// flag, an offline score queue for the submission path that currently has no
// fallback — will be copied from here, so the shape is written down rather than
// assumed:
//
//   • ONE namespaced key per concern (`relay.bb.daylight`), never a blob. A blob
//     makes every write a read-modify-write and every schema change a migration.
//   • EVERY read is validated against the type's own guard and falls back to the
//     default. A `localStorage` value is UNTRUSTED INPUT: it survives upgrades,
//     it is editable in devtools, and it is shared with whatever the previous
//     version of this app wrote there.
//   • EVERY access is wrapped. Safari in private mode throws on `setItem`, and
//     an embedded WebView can have storage disabled outright. A preference that
//     takes the game down is worse than a preference that does not persist.
//   • NO React state lives here. The hook below is a thin `useState` over these
//     two functions, so a test can drive the preference with no renderer.
//
// ⚠⚠ AND WHAT THIS FILE MUST NEVER BECOME: a channel into the sim.
//
// `daylight` is COSMETIC — see `stadium/daylight.ts` for the argument, which is
// that air density falls out of temperature and a player-selectable option that
// changes carry is a "pick the easy mode" button on a leaderboard game. Nothing
// under `lib/baseball/` may ever import this module, and `prefs.test.ts` asserts
// both halves: the source scan, and the carry ladder run byte-identical with the
// preference set each way.

// ⚠ THIS REACHES INTO `stadium/` FOR A VALUE, NOT JUST A TYPE, AND THAT IS SAFE
// FOR ONE CHECKABLE REASON: `stadium/daylight.ts` is pure data and imports no
// `three`. It is the only module under `stadium/` of which that is true, so it
// is the only one a HUD file may import at all — everything else there would
// drag the 560 kB renderer into whatever chunk the Games hub lands in, which is
// the exact failure `budget.test.ts`'s three-import scan exists to catch. That
// test scans `shared/*`, so this line is checked rather than promised.
import { useCallback, useState } from 'react';
import { isDaylightId } from '../stadium/daylight';
import type { DaylightId } from '../stadium/daylight';

const KEY_DAYLIGHT = 'relay.bb.daylight';
const KEY_MOUND_GESTURE = 'relay.bb.moundgesture';

/**
 * The default. DAY, and it is a deliberate default rather than a coin flip: the
 * whole art pass — the sky dome's gradient, the bowl's authored colours, every
 * "authored a stop brighter because it faces the plate" note in the scene — was
 * measured against a day game, so day is the mode with the evidence behind it.
 */
export const DEFAULT_DAYLIGHT: DaylightId = 'day';

/** Read a namespaced string, or `null` if storage is unavailable or empty. */
function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Write a namespaced string. Silently a no-op when storage refuses. */
function write(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* private mode, disabled storage, quota — none of them are worth a crash */
  }
}

export function loadDaylight(): DaylightId {
  const v = read(KEY_DAYLIGHT);
  return isDaylightId(v) ? v : DEFAULT_DAYLIGHT;
}

export function saveDaylight(v: DaylightId): void {
  write(KEY_DAYLIGHT, v);
}

/**
 * The preference as React state, persisted on every set.
 *
 * ⚠ THE INITIALISER IS LAZY. `useState(loadDaylight())` would hit storage on
 * every render of every component that uses it; `useState(loadDaylight)` reads
 * once. The same distinction `DerbyGame` makes for its own seed.
 */
export function useDaylight(): [DaylightId, (v: DaylightId) => void] {
  const [value, setValue] = useState<DaylightId>(loadDaylight);
  const set = useCallback((v: DaylightId) => {
    saveDaylight(v);
    setValue(v);
  }, []);
  return [value, set];
}

// ===========================================================================
// ⚠⚠ TEMPORARY — THE MOUND GESTURE A/B. DELETE ONE ARM AND THEN DELETE THIS.
// ===========================================================================
//
// WHY IT EXISTS. The mound's first control was a slingshot — a pull delta from
// wherever the finger went down — and the owner tapped, because that is what
// every shipping mobile baseball game trains you to do. A tap is a zero-length
// pull, the slingshot honoured it as a deliberate one, and every pitch went
// middle-middle: reported as "you tap in the strikezone although it doesn't seem
// to do high low or anything other than right down the middle". Two grammars are
// in the field and the owner asked to play both and choose:
//
//   `tap`   — Baseball Clash's, and this game's stated north star: choose the
//             location, choose the pitch, throw. One tap places the spot.
//   `drag`  — MLB 9 Innings': press, the marker follows the finger, release to
//             lock. More precise, more expensive, one extra beat per pitch.
//
// ⚠ IT IS NOT A SETTING AND MUST NOT BECOME ONE. The charter's rule is
// delete-on-supersede, and a permanent A/B toggle is exactly the dead mode that
// rule forbids: two control grammars means two things to keep working, two
// tutorials, and a split in every future measurement of how well players aim.
//
// ⚠ HOW TO REMOVE IT, once the owner has decided (it should be one small edit):
//   1. this block, `MoundGesture`, `isMoundGesture`, `DEFAULT_MOUND_GESTURE`,
//      `loadMoundGesture`, `saveMoundGesture`, `useMoundGesture`, `KEY_MOUND_GESTURE`;
//   2. in `MoundControl.tsx`: the `useMoundGesture()` call, the `gesture ===`
//      test inside `move`, the toggle's JSX block and the two-armed copy line
//      (each is marked `⚠ A/B`);
//   3. `prefs.test.ts`'s "the mound gesture switch" describe, and
//      `MoundControl.test.tsx`'s "the switch selects a different gesture" test.
// Nothing else branches on it: `aimAtPoint` is one mapping and both arms sample
// the same one, which is deliberate — see `moundAim.ts`.

/** Which gesture places the pitcher's aim. TEMPORARY — see above. */
export type MoundGesture = 'tap' | 'drag';

export const isMoundGesture = (v: unknown): v is MoundGesture => v === 'tap' || v === 'drag';

/**
 * The default. TAP — the arm with the evidence behind it: it is Baseball Clash's
 * grammar, this game's named north star, and it is what the owner actually did
 * on the shipped slingshot. Losing the A/B should be a deletion, not a flip, so
 * the default is the arm most likely to survive.
 */
export const DEFAULT_MOUND_GESTURE: MoundGesture = 'tap';

export function loadMoundGesture(): MoundGesture {
  const v = read(KEY_MOUND_GESTURE);
  return isMoundGesture(v) ? v : DEFAULT_MOUND_GESTURE;
}

export function saveMoundGesture(v: MoundGesture): void {
  write(KEY_MOUND_GESTURE, v);
}

/** As React state, persisted on every set. Lazy initialiser, as above. */
export function useMoundGesture(): [MoundGesture, (v: MoundGesture) => void] {
  const [value, setValue] = useState<MoundGesture>(loadMoundGesture);
  const set = useCallback((v: MoundGesture) => {
    saveMoundGesture(v);
    setValue(v);
  }, []);
  return [value, set];
}
