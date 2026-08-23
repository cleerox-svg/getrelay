// THE DUEL'S READOUT, AS A BOARD ARRAY — the one place `DuelState`'s vocabulary
// meets the videoboard's.
//
// ⚠ IT IS THE CALLER THE `duelScore` SCREEN HAS BEEN WAITING FOR. That variant
// was painted, keyed and table-tested months before `duelSim.ts` existed
// (`boardState.ts` says so in as many words) precisely so the 3-inning mode could
// not arrive and find a board hard-coded to derby fields. Nothing in
// `stadium/*` changes here: this file fills `BoardArray`, and the four panels
// paint it.
//
// ⚠ AND `left` IS FILLED, NOT `null`. `boardAtlas.boardArrayOps` falls back to
// `boardPanels.defaultSides(main)` when a column is null, and `defaultSides` has
// a branch for `derbyBatter` and one for `roundSummary` and NOTHING for
// `duelScore` — so a duel that passed `left: null` painted a dark 18 ft column
// beside a live screen, every pitch, all game. That is a caller bug and it is
// fixed at the caller; `duelBoard.test.ts` asserts the PAINTED ops rather than
// the shape, because "the mapper returned a well-formed object the board then
// dropped on the floor" is exactly how the derby's four-row columns shipped.
//
// ⚠ EVERY NUMBER IS ROUNDED HERE, ON ITS WAY IN, for the reason `derbyBoard.ts`
// states: the repaint key is taken over the board's INPUTS, a 1024 × 512 RGBA
// atlas is 2.0 MB per upload, and a STRING formatted from an unrounded float is
// something no downstream normalisation can rescue.

import { useMemo, useRef } from 'react';
import type { DuelState, PitchRecord } from '../../../lib/baseball/duelState';
import type { Park } from '../../../lib/baseball/parks';
import { sceneNow } from '../../../lib/scene3d/clock';
import type { BoardFeed } from '../StadiumGL';
import { boardScreenKey } from '../stadium/boardState';
import type { BoardArray, BoardSide, BoardStrip } from '../stadium/boardState';
import { pitchSide } from './boardSides';
import { basesLabel, describePitch, toneOfPitch } from './duelCopy';

/**
 * What the two sides are CALLED.
 *
 * ⚠ NOT CLUB MARKS, AND NOT A NICKNAME. `ip.test.ts` is the mechanical guard and
 * this is the surface it exists for — the biggest lettering in the park. The
 * human is `YOU` and the opponent is `CPU`: three characters each, well inside
 * the `BoardSide` five-character floor and the `duelScore` name column's
 * measured width, and neither is anybody's trademark. A future roster of named
 * teams is `teams.ts` DATA, read from the config; it is not a string invented
 * here.
 */
export const HUMAN_NAME = 'YOU';
export const AI_NAME = 'CPU';

const nameFor = (side: 'away' | 'home', humanBats: 'away' | 'home'): string =>
  side === humanBats ? HUMAN_NAME : AI_NAME;

/**
 * The left column: WHO is up and WHO is on.
 *
 * The count, the outs and the inning are already on the `duelScore` screen
 * itself — a 59 ft panel, six feet from this one — so spending the stats column
 * on them again would buy nothing. What that screen does not carry is the
 * baserunners, and in a game whose whole scoring model is forced advancement
 * they are the situation.
 */
function situationSide(st: DuelState): BoardSide {
  return {
    heading: 'AT BAT',
    rows: [
      { label: 'WHO', value: nameFor(st.batting, st.humanBats) },
      { label: 'ON', value: basesLabel(st.bases) },
    ],
  };
}

/**
 * The line score.
 *
 * ⚠ THE BLANK CELL AND THE ZERO ARE DIFFERENT FACTS, and only the sim can tell
 * them apart. `duelInnings.addLineRuns` only writes an inning a team SCORED in,
 * so a scoreless half leaves the array short — indistinguishable, from the array
 * alone, from an inning nobody has batted yet. The half that has been PLAYED is
 * derived from the inning and the half instead: the away side always bats first,
 * so it has batted in every inning up to and including the current one, and the
 * home side in every inning up to the current one only once the bottom starts.
 * A played inning prints `0`; an unplayed one prints blank.
 *
 * ⚠ AND THE COLUMNS ARE DATA. `BoardStrip` takes `columns` as an array, which is
 * why extras need no new strip: the count is the greater of the regulation
 * innings and the innings actually played.
 */
function lineStrip(st: DuelState): BoardStrip {
  const cols = Math.max(st.innings, st.inning, st.lineAway.length, st.lineHome.length);
  const columns = Array.from({ length: cols }, (_, i) => `${i + 1}`);
  const playedAway = st.inning;
  const playedHome = st.half === 'bottom' ? st.inning : st.inning - 1;
  const cells = (line: number[], played: number) =>
    columns.map((_, i) => (i < played ? Math.round(line[i] ?? 0) : null));
  return {
    columns,
    totals: ['R'],
    rows: [
      {
        name: nameFor('away', st.humanBats),
        cells: cells(st.lineAway, playedAway),
        totals: [Math.round(st.awayScore)],
      },
      {
        name: nameFor('home', st.humanBats),
        cells: cells(st.lineHome, playedHome),
        totals: [Math.round(st.homeScore)],
      },
    ],
  };
}

/** The ribbon: short items, because `boardRibbon.ribbonTrain` pads to a tile. */
function ribbonItems(park: Park, st: DuelState): string[] {
  const items = [park.name.toUpperCase(), `${st.half === 'top' ? 'TOP' : 'BOT'} ${st.inning}`];
  items.push(st.outs === 1 ? '1 OUT' : `${st.outs} OUT`);
  return items;
}

/** The final line, when the game is over. */
function finalLabel(st: DuelState): string {
  const away = nameFor('away', st.humanBats);
  const home = nameFor('home', st.humanBats);
  if (st.winner === 'tie') return `FINAL · TIE ${st.awayScore}-${st.homeScore}`;
  const won = st.winner === 'away' ? away : home;
  const hi = Math.max(st.awayScore, st.homeScore);
  const lo = Math.min(st.awayScore, st.homeScore);
  return `FINAL · ${won} ${hi}-${lo}`;
}

/**
 * The whole array, for one instant of a duel.
 *
 * `last` is the pitch being shown, or `null` between pitches. `over` is the end
 * of the game.
 */
export function duelBoardArray(
  st: DuelState,
  park: Park,
  last: PitchRecord | null,
  over: boolean,
): BoardArray {
  const ribbon = { items: ribbonItems(park, st) };
  const left = situationSide(st);
  const right = pitchSide(st.pitchId, st.plate?.speedMph ?? null);
  const strip = lineStrip(st);

  if (over) {
    return { main: { kind: 'idle', label: finalLabel(st) }, left, right, strip, ribbon };
  }

  if (last) {
    // ⚠ WHOSE HALF THE PITCH BELONGED TO, NOT WHOSE HALF IT IS NOW. `toneOfPitch`
    // reads opposite ways in the two halves — a strikeout is the player's
    // triumph on the mound and his failure at the plate — and the pitch that
    // ENDS a half has already flipped `st.batting` by the time this runs. The
    // plate appearance carries its own batting team, so a pitch that ended one
    // is read off `pa`; a pitch mid-appearance cannot have flipped anything.
    const battedFor = last.pa ? last.pa.battingTeam : st.batting;
    return {
      main: {
        kind: 'result',
        line: describePitch(last),
        tone: toneOfPitch(last, battedFor === st.humanBats),
      },
      left,
      right,
      strip,
      ribbon,
    };
  }

  return {
    main: {
      kind: 'duelScore',
      away: { name: nameFor('away', st.humanBats), runs: Math.round(st.awayScore) },
      home: { name: nameFor('home', st.humanBats), runs: Math.round(st.homeScore) },
      inning: st.inning,
      // `DuelState.half` is `'top' | 'bottom'`; the board's is `'top' | 'bot'`,
      // which is what fits the count panel. One mapping, here.
      half: st.half === 'top' ? 'top' : 'bot',
      outs: st.outs,
      balls: st.balls,
      strikes: st.strikes,
    },
    left,
    right,
    strip,
    ribbon,
  };
}

/**
 * The board feed for a live duel: the array, plus WHEN the current screen
 * appeared.
 *
 * Identical in shape to `useDerbyBoard`, and the reasoning is written out there:
 * the HUD latches the INSTANT the screen changed (`sceneNow()`, the clock
 * `StadiumGL` subtracts it from, so a frozen scene holds a celebration on one
 * frame) and the renderer does the subtraction per frame; the latch is keyed on
 * `boardScreenKey` rather than on object identity, because this function returns
 * a fresh object every poll and an identity check would re-latch forever.
 */
export function useDuelBoard(
  st: DuelState,
  park: Park,
  last: PitchRecord | null,
  over: boolean,
): BoardFeed {
  const array = useMemo(() => duelBoardArray(st, park, last, over), [st, park, last, over]);
  const latch = useRef({ key: '', sinceS: 0 });
  const key = boardScreenKey(array.main);
  if (key !== latch.current.key) latch.current = { key, sinceS: sceneNow() / 1000 };
  return { array, sinceS: latch.current.sinceS };
}
