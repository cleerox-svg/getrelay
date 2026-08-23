// THE DUEL → BOARD MAPPING, asserted against WHAT THE BOARD ACTUALLY PAINTS.
//
// ⚠ WHY THE ASSERTIONS GO THROUGH `boardArrayOps` AND NOT THROUGH THE SHAPE.
// `derbyBoard.test.ts`'s header records the failure this file is built to catch:
// a mapper can return a perfectly well-formed `BoardArray` full of content the
// board silently drops, and every type check and every board test still passes.
// The duel's version of that bug is worse, because it needs no mistake at all —
// `boardAtlas.boardArrayOps` falls back to `boardPanels.defaultSides(main)` when
// a column is null, `defaultSides` has branches for `derbyBatter` and
// `roundSummary` and NOTHING for `duelScore`, and a null therefore paints a dark
// 18 ft column beside a live screen for the whole game. So the test asserts the
// TEXT OPS INSIDE THE STATS PANEL'S OWN RECTANGLE, which is the only statement
// that distinguishes "the caller filled it" from "the caller passed null and
// something else happened to print the same word somewhere on the board".

import { describe, expect, it } from 'vitest';
import { DuelSim } from '../../../lib/baseball/duelSim';
import type { DuelState, PitchRecord } from '../../../lib/baseball/duelState';
import { HARBOURFRONT } from '../../../lib/baseball/parks';
import { boardArrayOps, boardPanel } from '../stadium/boardAtlas';
import type { BoardPanelId } from '../stadium/boardAtlas';
import { defaultSides, sideRowBudget } from '../stadium/boardPanels';
import type { BoardOp } from '../stadium/boardPaint';
import { AI_NAME, HUMAN_NAME, duelBoardArray } from './duelBoard';
import { describePitch } from './duelCopy';

const SEED = 20260823;

/**
 * The text a given PANEL paints, and nothing another panel painted.
 *
 * `boardArrayOps` maps every panel's ops into that panel's rect on one atlas, so
 * a text op belongs to a panel iff its origin lies inside that rect. That is the
 * whole trick, and it is what makes "the left column is filled" a checkable
 * claim rather than a substring search over the whole board.
 */
function panelText(ops: BoardOp[], id: BoardPanelId): string[] {
  const r = boardPanel(id).rect;
  return ops
    .filter((o): o is Extract<BoardOp, { kind: 'text' }> => o.kind === 'text')
    .filter((o) => o.x >= r.x && o.x <= r.x + r.w && o.y >= r.y && o.y <= r.y + r.h)
    .map((o) => o.text);
}

/** A duel driven far enough to have a count, a pitch and somebody on base. */
function playedSim(pitches: number): DuelSim {
  const s = new DuelSim({ seed: SEED, park: HARBOURFRONT, innings: 3 });
  for (let i = 0; i < pitches && s.phase !== 'done'; i++) {
    // ⚠ THE HUMAN'S MOUND NEEDS A COMMAND, and the sim throws rather than
    // auto-playing his half. `humanBats` defaults to `home`, so the very first
    // half of every duel is the player PITCHING — which is exactly the case a
    // fixture that only ever called `servePitch()` would never reach.
    if (s.phase === 'ready') {
      s.servePitch(
        s.isHumanBatting() ? undefined : { id: 'ff', intentX: 0, intentH: 2.5, stopError: 0.2 },
      );
    }
    if (s.isHumanBatting()) s.swing(s.served!.result.plate.t);
    else s.aiBat();
  }
  return s;
}

describe('the duel fills the board the duelScore screen has been waiting for', () => {
  it('⚠ THE LEFT COLUMN IS PAINTED, and it could not have been the fallback', () => {
    const st = playedSim(6).getState();
    const array = duelBoardArray(st, HARBOURFRONT, null, false);
    const ops = boardArrayOps(array, 0);
    const stats = panelText(ops, 'stats');

    // eslint-disable-next-line no-console
    console.log(
      `\n[DUEL BOARD — the panels, as painted]\n` +
        `  main   ${panelText(ops, 'main').join(' · ')}\n` +
        `  stats  ${stats.join(' · ')}\n` +
        `  pitcher ${panelText(ops, 'pitcher').join(' · ')}\n` +
        `  strip  ${panelText(ops, 'strip').join(' ')}\n` +
        `  ⚠ stats was DARK until this caller existed — defaultSides has no duelScore branch.\n`,
    );

    // The heading, both labels and both values reach the LEFT panel's rectangle.
    expect(stats).toContain('AT BAT');
    expect(stats).toContain('WHO');
    expect(stats).toContain('ON');
    expect(stats).toContain(st.humanIsBatting ? HUMAN_NAME : AI_NAME);

    // ⚠ GUARD THE GUARD. If `defaultSides` ever grew a `duelScore` branch this
    // test would pass with `left: null` — the thing it exists to forbid. Assert
    // that the fallback is still empty, so the paint above can only have come
    // from the caller.
    expect(array.main.kind).toBe('duelScore');
    expect(defaultSides(array.main)).toEqual({ left: null, right: null });
    expect(array.left).not.toBeNull();
    expect(array.right).not.toBeNull();
  });

  it('both columns spend exactly `sideRowBudget` rows — no computed-and-dropped row', () => {
    const array = duelBoardArray(playedSim(4).getState(), HARBOURFRONT, null, false);
    const budget = sideRowBudget(boardPanel('stats').type);
    expect(budget).toBeGreaterThanOrEqual(1);
    expect(array.left?.rows.length).toBe(budget);
    expect(array.right?.rows.length).toBe(budget);
  });

  it('every duelScore field is the SIM’s, and no two are crossed', () => {
    // ⚠ A STATE WITH NO TWO FIELDS EQUAL, deliberately. `inning`, `outs`,
    // `balls` and `strikes` are all small integers, so a mapper that read
    // `outs` where it meant `strikes` would be invisible on any state where
    // they happened to match — which is most of them.
    const st: DuelState = {
      ...playedSim(2).getState(),
      inning: 3,
      half: 'bottom',
      outs: 2,
      balls: 1,
      strikes: 0,
      awayScore: 7,
      homeScore: 4,
      humanBats: 'home',
    };
    const array = duelBoardArray(st, HARBOURFRONT, null, false);
    expect(array.main).toEqual({
      kind: 'duelScore',
      away: { name: AI_NAME, runs: 7 },
      home: { name: HUMAN_NAME, runs: 4 },
      inning: 3,
      half: 'bot',
      outs: 2,
      balls: 1,
      strikes: 0,
    });
  });

  it('the right column carries the pitch the sim served', () => {
    const s = playedSim(1);
    const st = s.getState();
    const array = duelBoardArray(st, HARBOURFRONT, null, false);
    expect(st.pitchId).not.toBeNull();
    expect(array.right?.rows[0]?.value).toBe(String(st.pitchId).toUpperCase());
    expect(array.right?.rows[1]?.value).toBe(`${Math.round(st.plate!.speedMph)}`);
  });

  it('⚠ A SCORELESS PLAYED INNING PRINTS 0; AN UNPLAYED ONE PRINTS BLANK', () => {
    // `addLineRuns` only writes innings a team SCORED in, so the array alone
    // cannot tell a scoreless half from one nobody has batted yet. Top of the
    // first, nothing scored: the away side is batting (played), the home side
    // has not batted at all.
    const fresh = new DuelSim({ seed: SEED, innings: 3 }).getState();
    const strip = duelBoardArray(fresh, HARBOURFRONT, null, false).strip!;
    expect(strip.columns).toEqual(['1', '2', '3']);
    expect(strip.rows[0]?.cells).toEqual([0, null, null]);
    expect(strip.rows[1]?.cells).toEqual([null, null, null]);

    // …and once the bottom of the first is under way the home cell appears.
    const bottom: DuelState = { ...fresh, half: 'bottom' };
    const s2 = duelBoardArray(bottom, HARBOURFRONT, null, false).strip!;
    expect(s2.rows[1]?.cells).toEqual([0, null, null]);
  });

  it('the strip totals are the score, and the rows are labelled by ROLE', () => {
    const st: DuelState = {
      ...new DuelSim({ seed: SEED, innings: 3 }).getState(),
      humanBats: 'away',
      awayScore: 5,
      homeScore: 2,
    };
    const strip = duelBoardArray(st, HARBOURFRONT, null, false).strip!;
    expect(strip.totals).toEqual(['R']);
    expect(strip.rows.map((r) => r.name)).toEqual([HUMAN_NAME, AI_NAME]);
    expect(strip.rows.map((r) => r.totals)).toEqual([[5], [2]]);
  });

  it('⚠ THE RESULT LINE IS `describePitch` VERBATIM, and it reaches the main panel', () => {
    const s = playedSim(1);
    const rec = s.getState().last!;
    const array = duelBoardArray(s.getState(), HARBOURFRONT, rec, false);
    expect(array.main).toMatchObject({ kind: 'result', line: describePitch(rec) });
    // …and the board actually sets it. `boardResultRows` re-wraps the line on
    // its own punctuation and DROPS the separators themselves (`Out — LF` sets
    // as `OUT LF`), so the claim is that every word carrying information
    // survives, not that the dash does.
    const painted = panelText(boardArrayOps(array, 0), 'main').join(' ').toUpperCase();
    const words = describePitch(rec)
      .split(' ')
      .filter((w) => /[a-z0-9]/i.test(w));
    expect(words.length).toBeGreaterThan(0);
    for (const word of words) expect(painted).toContain(word.toUpperCase());
  });

  it('⚠ THE TONE IS THE PITCH’S HALF, NOT THE HALF IT IS NOW', () => {
    // The pitch that ENDS a half flips `st.batting` before the HUD draws it, so
    // toning off the live state reads every inning-ending pitch backwards: the
    // strikeout the player just threw would be painted as his own failure.
    const st = new DuelSim({ seed: SEED, innings: 3 }).getState();
    const struckOut = {
      outcome: 'swingingStrike',
      play: null,
      swung: true,
      distFt: 0,
      fielder: '',
      pa: { outcome: 'strikeout', runs: 0, battingTeam: 'away' },
    } as unknown as PitchRecord;

    // `humanBats: 'home'` — the AWAY side was batting, so the human was PITCHING
    // for this strikeout and it is a good thing. The live state has already
    // flipped to the bottom half, i.e. to the human batting.
    const flipped: DuelState = { ...st, humanBats: 'home', half: 'bottom', batting: 'home' };
    const array = duelBoardArray(flipped, HARBOURFRONT, struckOut, false);
    expect(array.main).toMatchObject({ kind: 'result', tone: 'good' });

    // The mirror: the same pitch with the human on the AWAY side is his own
    // strikeout at the plate.
    const mine: DuelState = { ...flipped, humanBats: 'away' };
    expect(duelBoardArray(mine, HARBOURFRONT, struckOut, false).main).toMatchObject({
      tone: 'miss',
    });
  });

  it('the final screen names a winner, and the columns stay lit', () => {
    const st: DuelState = {
      ...new DuelSim({ seed: SEED, innings: 3 }).getState(),
      humanBats: 'home',
      awayScore: 2,
      homeScore: 5,
      winner: 'home',
      phase: 'done',
    };
    const array = duelBoardArray(st, HARBOURFRONT, null, true);
    expect(array.main).toEqual({ kind: 'idle', label: `FINAL · ${HUMAN_NAME} 5-2` });
    // ⚠ AND THE COLUMNS ARE STILL FILLED. `defaultSides('idle')` is null/null
    // too, so a final screen that dropped them would go dark at the one moment
    // the player is looking at the board.
    expect(defaultSides(array.main)).toEqual({ left: null, right: null });
    expect(panelText(boardArrayOps(array, 0), 'stats')).toContain('AT BAT');
  });
});
