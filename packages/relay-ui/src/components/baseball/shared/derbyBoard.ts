// THE DERBY'S READOUT, AS A BOARD ARRAY — the one place the sim's vocabulary
// meets the videoboard's.
//
// ⚠ IT IS HUD CODE AND THE MAP ITSELF IS PURE. `boardState.ts` says in its own
// header that the board "deliberately does NOT import `DerbyState`,
// `SwingResult` or `DuelState`: the HUD maps the sim's readout onto these shapes
// exactly as `swingCopy.ts` maps it onto a string". This is that map.
// `derbyBoardArray` takes state and returns data — no clock, no `three`, no
// React — so it is testable with no renderer and no DOM. The ONE impure thing
// here is `useDerbyBoard` at the bottom, which is a latch over a clock and is
// documented as such.
//
// ⚠ THE RESULT LINE IS `describeSwing(r)` VERBATIM. Not "based on", not
// "reworded for the board" — the identical string the HUD prints under the
// batter, which `boardScreens.boardResultRows` then re-WRAPS on that line's own
// punctuation. One vocabulary for eight outcomes; a second one is the charter's
// "one implementation per concept" broken in the softest possible place, where
// nothing fails and the board slowly starts telling the player something
// slightly different from the HUD.
//
// ⚠ AND EVERY NUMBER IS ROUNDED HERE, ON ITS WAY IN.
//
// The board's repaint key is taken over its INPUTS, and a 1024 × 512 RGBA atlas
// is 2.0 MB per upload. `bestFt`, `distFt`, `evMph` and the chain multiplier are
// floats off the sim, and the HUD polls on a 120 ms interval, so two consecutive
// polls can hand in 428.4001 and 428.4002 — a different key, a full 2.0 MB
// re-upload, and a byte-identical picture. `boardState.normaliseArray` rounds
// too (that is its own defence, and the two roundings agree by construction
// because both are `Math.round`), but the STRINGS in a `BoardSide` are formatted
// HERE and nothing downstream can normalise a string. `108.4 MPH` and
// `108.4 MPH` differing in the third decimal is a repaint nothing can see.

import { useMemo, useRef } from 'react';
import { chainMultiplier } from '../../../lib/baseball/derbyChain';
import type { DerbyState, SwingResult } from '../../../lib/baseball/derbyState';
import type { Park } from '../../../lib/baseball/parks';
import { sceneNow } from '../../../lib/scene3d/clock';
import type { BoardFeed } from '../StadiumGL';
import { boardScreenKey } from '../stadium/boardState';
import type { BoardArray, BoardSide, BoardTone } from '../stadium/scoreboard';
import { describeSwing } from './swingCopy';

/**
 * The multiplier a chain position earns, rounded to what the board PRINTS.
 *
 * ⚠ `chainMultiplier` IS THE SIM'S FUNCTION AND IS CALLED, NOT REIMPLEMENTED —
 * the same line `swingCopy.describeSwing` takes, and for the same stated reason:
 * dividing it out of `points` rounds, and prints `×1.99`. `null` when it is not
 * earning, because a `×1.00` on the biggest surface in the park is noise.
 *
 * The `r2` is not cosmetic. `boardState.normaliseScreen` rounds `chainX` to two
 * decimals and the painter prints `toFixed(2)`, so an unrounded value here is a
 * different repaint key for a byte-identical 2.0 MB picture.
 */
const chainX = (chainIndex: number): number | null => {
  const m = Math.round(chainMultiplier(chainIndex) * 100) / 100;
  return m > 1 ? m : null;
};

/**
 * The park's own name on the ribbon, plus the count.
 *
 * ⚠ THE RIBBON'S ITEMS ARE SHORT BECAUSE THE RING IS. `boardRibbon.ribbonTrain`
 * lays them out as EXACTLY `RIBBON_CELLS` characters and pads to a fixed tile so
 * the join around the bowl is seamless — an item longer than the tile is simply
 * dropped rather than cut mid-word, which is a rendered finding recorded in that
 * file. Keep them to a few words each.
 */
function ribbonItems(park: Park, st: DerbyState): string[] {
  const items = [park.name.toUpperCase(), `ROUND ${st.round} OF ${st.rounds}`];
  if (st.homeRuns > 0) items.push(`${st.homeRuns} HR`);
  if (st.bestFt > 0) items.push(`LONG ${Math.round(st.bestFt)} FT`);
  return items;
}

/**
 * The accent of a result line — the OUTCOME, never the copy.
 *
 * A `homeRun` never reaches here (it takes the whole array over; see
 * `boardArrayOps`), so the four tones map the remaining outcomes: something that
 * left the bat well, something that did not, and a take.
 */
function toneOf(r: SwingResult): BoardTone {
  if (r.outcome === 'homeRun') return 'gone';
  if (r.barrel || r.outcome === 'inPlay') return 'good';
  if (r.outcome === 'take') return 'neutral';
  return 'miss';
}

/**
 * ⚠ TWO ROWS PER COLUMN, AND THE NUMBER IS `boardPanels.sideRowBudget`, NOT A
 * PREFERENCE. A side column is `label + value` stacks between `SIDE_TOP` and the
 * bottom edge, which at this geometry is **two**, and `sideOps` takes
 * `.slice(0, sideRowBudget(pt))` — so a third row is not a smaller row, it is a
 * row that silently does not exist.
 *
 * ⚠ AND THIS FILE SHIPPED FOUR OF THEM. The first version sent SCORE / HR /
 * LONG / RUN and TYPE / MPH / OF / OUTS; the board drew SCORE / HR and TYPE /
 * MPH and dropped the other four on the floor. Every test passed — the mapper's
 * output was well-formed and the board's slice is documented behaviour — and the
 * PIXEL HARNESS showed it in the first frame it ever painted. That is the sixth
 * time on this game that looking beat the suite, and it is why the budget is now
 * imported and asserted rather than remembered.
 *
 * Which two: the left column carries what the session is WORTH and its best ball
 * (the derby's two headline numbers); the right carries what is COMING. The
 * count and the outs are on the HUD's own `CountChip`, six inches from the
 * player's thumb, so spending a 430 ft surface on them would be the worse trade.
 *
 * ⚠ NUMBERS, NOT WORDS, AND THE GEOMETRY IS WHY. An 18 ft column at 430 ft
 * carries ten characters at the legibility floor — `boardAtlas.panelCharBudget`
 * prints the measurement — so a longer value truncates with a visible mark
 * rather than shrinking out of the rule. Everything below is well inside it.
 */
export const SIDE_ROWS = 2;

function statsSide(st: DerbyState): BoardSide {
  return {
    heading: 'DERBY',
    rows: [
      { label: 'SCORE', value: `${Math.round(st.score)}` },
      { label: 'LONG', value: st.bestFt > 0 ? `${Math.round(st.bestFt)}` : '—' },
    ],
  };
}

/** The right column: the pitch just thrown, or about to be. */
function pitchSide(st: DerbyState): BoardSide {
  return {
    heading: 'PITCH',
    rows: [
      { label: 'TYPE', value: (st.pitchId ?? '—').toUpperCase() },
      { label: 'MPH', value: st.plate ? `${Math.round(st.plate.speedMph)}` : '—' },
    ],
  };
}

/**
 * The wide strip: the derby's round-by-round line score.
 *
 * ⚠ DATA-DRIVEN COLUMNS, WHICH IS WHY THE DUEL WILL NOT NEED A SECOND STRIP.
 * `BoardStrip` takes `columns` and `totals` as arrays; a duel is three innings
 * plus `R H E` and a derby is `st.rounds` rounds plus a total. Charter rule 4:
 * content is data, not a branch.
 */
function roundStrip(st: DerbyState): BoardArray['strip'] {
  const columns = Array.from({ length: st.rounds }, (_, i) => `${i + 1}`);
  const cells = columns.map((_, i) =>
    // A round not yet played is `null`, which the strip prints as a blank cell.
    // `roundScores` only holds rounds that finished, and the CURRENT round's
    // running total is `st.roundScore`.
    i < st.roundScores.length
      ? Math.round(st.roundScores[i] ?? 0)
      : i === st.roundScores.length
        ? Math.round(st.roundScore)
        : null,
  );
  return {
    columns,
    totals: ['HR', 'TOT'],
    rows: [{ name: 'YOU', cells, totals: [st.homeRuns, Math.round(st.score)] }],
  };
}

/**
 * The whole array, for one instant of a derby.
 *
 * `last` is the swing being shown, or `null` between pitches. `over` is the
 * end of the session — the one state that shows a round summary rather than a
 * batter card.
 */
export function derbyBoardArray(
  st: DerbyState,
  park: Park,
  last: SwingResult | null,
  over: boolean,
): BoardArray {
  const ribbon = { items: ribbonItems(park, st) };
  const left = statsSide(st);
  const right = pitchSide(st);
  const strip = roundStrip(st);

  if (over) {
    return {
      main: {
        kind: 'roundSummary',
        round: st.roundsPlayed,
        rounds: st.rounds,
        roundScore: Math.round(st.roundScore),
        homeRuns: st.homeRuns,
        bestFt: Math.round(st.bestFt),
        total: Math.round(st.score),
      },
      left,
      right,
      strip,
      ribbon,
    };
  }

  if (last && last.outcome === 'homeRun') {
    return {
      main: {
        kind: 'homeRun',
        distFt: Math.round(last.distFt),
        evMph: Math.round(last.evMph),
        laDeg: Math.round(last.laDeg),
        points: Math.round(last.points),
        // `chainIndex` is REPORTED by the scorer, not re-derived from
        // `curStreak` — see `SwingResult.chainIndex`, which records that
        // recomputing it reads the counter one swing ahead, i.e. would print
        // the multiplier of the swing AFTER the one on screen.
        chainX: chainX(last.chainIndex),
      },
      left,
      right,
      strip,
      ribbon,
    };
  }

  if (last) {
    return { main: { kind: 'result', line: describeSwing(last), tone: toneOf(last) }, left, right, strip, ribbon };
  }

  return {
    main: {
      kind: 'derbyBatter',
      batter: 'YOU',
      round: st.round,
      rounds: st.rounds,
      pitch: st.pitch,
      pitches: st.pitchesPerRound,
      score: Math.round(st.score),
      // ⚠ `curStreak + 1`, NOT `curStreak`, AND THE OFF-BY-ONE IS THE WHOLE
      // POINT OF SHOWING IT HERE. Between pitches the batter card is looking
      // FORWARD: what the NEXT home run would pay. `curStreak` is how many have
      // already gone, so the next one is at position `curStreak + 1`. Showing
      // the current position instead would tell a player on two straight home
      // runs that the chain pays ×1.00, on the exact swing at which it starts
      // paying ×1.25.
      chainX: chainX(st.curStreak + 1),
      bestFt: st.bestFt > 0 ? Math.round(st.bestFt) : null,
    },
    left,
    right,
    strip,
    ribbon,
  };
}

// ---------------------------------------------------------------------------
// The HUD's half of the clock
// ---------------------------------------------------------------------------

/**
 * The board feed for a live derby: the array, plus WHEN the current screen
 * appeared.
 *
 * ⚠ WHY THE HUD SUPPLIES A TIMESTAMP RATHER THAN AN ELAPSED TIME. The board
 * animates — the home-run eruption is 2.6 s at 12 Hz, the ribbon sweeps the ring
 * every 1.3 s — so it needs `tS` every frame. A HUD that computed `tS` would
 * have to render every frame, which the layer rules forbid and which is the one
 * thing this component is built not to do (it polls at 120 ms). So the HUD
 * latches the INSTANT the screen changed and `StadiumGL` does the subtraction
 * per frame. Nobody accumulates a `dt`.
 *
 * ⚠ `sceneNow()`, NOT `performance.now()`. It is the same clock `StadiumGL`
 * subtracts it from, so with the harness's virtual clock engaged the difference
 * is exact virtual time and a FROZEN scene holds the celebration on one frame —
 * which is what makes a night-home-run screenshot reproducible. Mixing the two
 * clocks would make `tS` a function of how fast the machine ran between them.
 *
 * ⚠ THE LATCH IS KEYED ON `boardScreenKey`, NOT ON THE OBJECT. `derbyBoardArray`
 * returns a fresh object every time it runs, so an identity check would re-latch
 * on every poll and the celebration would never advance past frame 0 — a defect
 * that looks exactly like a broken animation and is in fact a broken clock. The
 * key is the board's OWN normalised key, so "the screen changed" means the same
 * thing here as it does to the repaint policy.
 */
export function useDerbyBoard(
  st: DerbyState,
  park: Park,
  last: SwingResult | null,
  over: boolean,
): BoardFeed {
  const array = useMemo(() => derbyBoardArray(st, park, last, over), [st, park, last, over]);
  const latch = useRef({ key: '', sinceS: 0 });
  const key = boardScreenKey(array.main);
  if (key !== latch.current.key) latch.current = { key, sinceS: sceneNow() / 1000 };
  return { array, sinceS: latch.current.sinceS };
}
