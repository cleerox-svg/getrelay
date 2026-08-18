// THE BOARD'S STATES, AS DATA — one table, read by the pixel harness and by the
// suite.
//
// ⚠ ONE TABLE, TWO CONSUMERS, WHICH IS THE WHOLE REASON IT IS A FILE. The pixel
// harness photographs these and a human looks; `scoreboard.test.ts` can walk the
// same rows and assert. If the two had their own fixtures, the picture a human
// approved and the picture the suite checked would be different pictures — which
// is the softest possible way for a visual gate to stop meaning anything.
//
// ⚠ AND EVERY ROW IS A STATE THE GAME CAN ACTUALLY REACH. They are built through
// the shipping `BoardScreen` union, not hand-drawn ops, so a screen that the sim
// cannot produce cannot be photographed here and mistaken for coverage. The
// result lines are `swingCopy.describeSwing`'s own eight outcomes, verbatim,
// because that is what the HUD feeds the board.
//
// ⚠ AND THE PARK NAME IS IMPORTED, NOT TYPED. These fixtures said
// `HARBOURFRONT DOME` on 8 of the 13 contact-sheet cards, and a `HARBOUR` team
// in the linescore, for the whole of the round that renamed the park — while
// every GL shot beside them correctly read `park.name` and said SKYDOME. Dead
// fixture text is normally harmless; here it is not, because the contact sheet
// IS the visual-review artefact, so the branch's own evidence advertised a park
// that no longer exists and partly exists to document an IP decision. Reading
// `SKYDOME_NAME` makes the next rename propagate instead of rotting.
//
// No canvas, no `three`, no clock. Data.

import { SKYDOME_NAME } from '../../../lib/baseball/parks';
import type { BoardArray, BoardScreen, BoardSide, BoardStrip } from './boardState';

/** The home park, as the board sets it. `board.ts`'s `idleBoardArray` does the same. */
const PARK = SKYDOME_NAME.toUpperCase();

const STATS: BoardSide = {
  heading: 'DERBY',
  rows: [
    { label: 'SCORE', value: '1284' },
    { label: 'HR', value: '7' },
    { label: 'LONG', value: '441' },
    { label: 'RUN', value: '3' },
  ],
};

const PITCH: BoardSide = {
  heading: 'PITCH',
  rows: [
    { label: 'TYPE', value: 'ST' },
    { label: 'MPH', value: '84' },
    { label: 'OF', value: '4/8' },
    { label: 'OUTS', value: '1' },
  ],
};

const STRIP: BoardStrip = {
  columns: ['1', '2', '3'],
  totals: ['HR', 'TOT'],
  rows: [{ name: 'YOU', cells: [612, 672, null], totals: [7, 1284] }],
};

const wrap = (main: BoardScreen, items: string[] = [PARK, 'ROUND 3 OF 3']): BoardArray => ({
  main,
  left: STATS,
  right: PITCH,
  strip: STRIP,
  ribbon: { items },
});

export interface BoardFixture {
  id: string;
  note: string;
  /** The animation frame to paint at. 0 for every static screen. */
  frame: number;
  array: BoardArray;
}

/**
 * ⚠ THE LIST IS ORDERED BY HOW OFTEN A PLAYER SEES IT, not by the union's
 * declaration order — the contact sheet is read top-down and the resting card is
 * what is on the board 90 % of a session.
 *
 * The four celebration frames are the ones worth looking at rather than a
 * uniform sample: 0 is the instant it takes over, 2 and 3 straddle the first
 * strobe boundary (`STROBE_S` = 0.2 s at 12 fps is every 2.4 frames), and 18 is
 * inside the count-up's tail. The defect the board slice found by rendering —
 * "an exclamation dot on a zero" — lives in exactly that count-up.
 */
export const BOARD_STATES: BoardFixture[] = [
  {
    id: 'batter',
    note: 'the resting card — what is on the board most of a session',
    frame: 0,
    array: wrap({
      kind: 'derbyBatter',
      batter: 'YOU',
      round: 3,
      rounds: 3,
      pitch: 4,
      pitches: 8,
      score: 1284,
      chainX: 1.25,
      bestFt: 441,
    }),
  },
  {
    id: 'idle',
    note: 'pre-game — the state that must be LIT AND EMPTY, never frame-dark',
    frame: 0,
    array: {
      main: { kind: 'idle', label: PARK },
      left: null,
      right: null,
      strip: null,
      ribbon: { items: [PARK] },
    },
  },
  // The eight outcomes `describeSwing` can produce, VERBATIM. The whiff line is
  // the sixteen-character one that truncated to `SWING AND A MI…` on a 59 ft
  // main panel and is the reason the panel is 60.
  {
    id: 'result-whiff',
    note: 'Swing and a miss — 16 chars, the line that sized the main panel',
    frame: 0,
    array: wrap({ kind: 'result', line: 'Swing and a miss', tone: 'miss' }),
  },
  {
    id: 'result-wall',
    note: 'two separators — the em dash is a row break, not just the middot',
    frame: 0,
    array: wrap({ kind: 'result', line: 'Off the wall — 395 ft · +42', tone: 'good' }),
  },
  {
    id: 'result-caught',
    note: 'the longest in-play line',
    frame: 0,
    array: wrap({ kind: 'result', line: 'Caught — 412 ft · +18', tone: 'neutral' }),
  },
  {
    id: 'result-take',
    note: 'two words, no numbers — the shortest line the vocabulary has',
    frame: 0,
    array: wrap({ kind: 'result', line: 'Took a strike', tone: 'miss' }),
  },
  {
    id: 'hr-0',
    note: 'the eruption at frame 0',
    frame: 0,
    array: wrap({ kind: 'homeRun', distFt: 441, evMph: 108, laDeg: 27, points: 214, chainX: 1.25 }),
  },
  {
    id: 'hr-2',
    note: 'strobe OFF — the frame straddling the first boundary',
    frame: 2,
    array: wrap({ kind: 'homeRun', distFt: 441, evMph: 108, laDeg: 27, points: 214, chainX: 1.25 }),
  },
  {
    id: 'hr-3',
    note: 'strobe ON — board, ribbon and tower all flash on this frame',
    frame: 3,
    array: wrap({ kind: 'homeRun', distFt: 441, evMph: 108, laDeg: 27, points: 214, chainX: 1.25 }),
  },
  {
    id: 'hr-18',
    note: 'the count-up tail — where "an exclamation dot on a zero" was found',
    frame: 18,
    array: wrap({ kind: 'homeRun', distFt: 441, evMph: 108, laDeg: 27, points: 214, chainX: null }),
  },
  {
    id: 'round',
    note: 'between rounds',
    frame: 0,
    array: wrap({
      kind: 'roundSummary',
      round: 2,
      rounds: 3,
      roundScore: 672,
      homeRuns: 4,
      bestFt: 441,
      total: 1284,
    }),
  },
  {
    id: 'duel',
    note: 'DUEL-READY, months before duelSim — a member, not a rewrite',
    frame: 0,
    array: {
      main: {
        kind: 'duelScore',
        away: { name: PARK, runs: 3 },
        home: { name: 'ALPINE', runs: 4 },
        inning: 3,
        half: 'bot',
        outs: 2,
        balls: 3,
        strikes: 2,
      },
      left: STATS,
      right: PITCH,
      strip: {
        columns: ['1', '2', '3'],
        totals: ['R', 'H', 'E'],
        rows: [
          { name: PARK, cells: [1, 0, 2], totals: [3, 6, 0] },
          { name: 'ALPINE', cells: [0, 4, null], totals: [4, 7, 1] },
        ],
      },
      ribbon: { items: [PARK, 'BOT 3 · 2 OUT'] },
    },
  },
  {
    id: 'overflow',
    note: '⚠ DELIBERATELY TOO LONG EVERYWHERE — every field must truncate visibly',
    frame: 0,
    array: {
      main: { kind: 'result', line: 'A RESULT LINE FAR LONGER THAN ANY PANEL CAN EVER SET', tone: 'gone' },
      left: {
        heading: 'AN OVERLONG HEADING',
        rows: [
          { label: 'AN OVERLONG LABEL', value: '1234567890123' },
          { label: 'X', value: '—' },
        ],
      },
      right: { heading: 'P', rows: [{ label: 'TYPE', value: 'AN OVERLONG VALUE' }] },
      strip: {
        columns: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
        totals: ['R', 'H', 'E'],
        rows: [
          { name: 'A TEAM NAME NOBODY COULD FIT', cells: [1, 2, 3, 4, 5, 6, 7, 8, 9], totals: [45, 60, 3] },
        ],
      },
      ribbon: { items: ['A RIBBON ITEM FAR LONGER THAN ONE TILE OF FIFTY-SEVEN CELLS CAN HOLD'] },
    },
  },
];
