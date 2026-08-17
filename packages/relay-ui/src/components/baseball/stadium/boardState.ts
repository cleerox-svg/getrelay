// What the videoboard ARRAY is showing — the state shapes, and the key that
// decides whether a repaint is needed.
//
// ⚠ THE BOARD IS AN ARRAY, NOT A SCREEN, and that is the owner's art direction
// read off a photograph of the real venue: "It's not just a rectangle." What the
// photo shows is a LARGE CENTRAL VIDEO PANEL, a narrow STATS COLUMN to its left,
// a PITCHER PANEL to its right and a wide LINESCORE STRIP below, all set into a
// dark architectural frame — plus lit RIBBON bands running the full circumference
// between the seating decks. So the state here is not one screen; it is four
// panels and a ribbon, updated together.
//
// ⚠ AND THE ARRAY IS WHAT BUYS THE INFORMATION BUDGET BACK. `boardAtlas.ts`
// derives the legibility floor per panel from that panel's OWN subtended height,
// and a single 100 × 50 ft board carries ten floor-height rows and 26 characters
// — one row for everything. Four panels carry **21 rows** between them, because
// the strip is short but very wide and the side columns are tall but very narrow,
// and each is budgeted on its own terms rather than on the whole board's. The
// budget table `boardAtlas` prints every run is the measurement, not this prose.
//
// Every field is a plain scalar or a string. The board deliberately does NOT
// import `DerbyState`, `SwingResult` or `DuelState`: the HUD maps the sim's
// readout onto these shapes exactly as `swingCopy.ts` maps it onto a string, so
// the display layer has no coupling to how the game is scored.
//
// No canvas, no `three`, no clock, no gameplay.

/** The accent colour of a result line. Mirrors the OUTCOME, not the copy. */
export type BoardTone = 'gone' | 'good' | 'neutral' | 'miss';

/** One side of a duel line score. */
export interface BoardTeam {
  name: string;
  runs: number;
}

/**
 * What the big central panel can show.
 *
 * ⚠ A DISCRIMINATED UNION SO THE DUEL IS A VARIANT, NOT A REWRITE. `duelScore`
 * already exists here and is already painted and tested, months before
 * `duelSim.ts` does — precisely so that the 3-inning mode cannot arrive and find
 * a board hard-coded to derby fields. Adding the next screen is a member plus a
 * painter plus a row in the test table; it is never a change to `scoreboard.ts`.
 */
export type BoardScreen =
  /** Pre-game / between-sessions. `label` is copy the caller owns. */
  | { kind: 'idle'; label: string }
  /** The derby's resting state: who is up, where we are, what it is worth. */
  | {
      kind: 'derbyBatter';
      batter: string;
      round: number;
      rounds: number;
      pitch: number;
      pitches: number;
      score: number;
      /** The chain multiplier, when it is EARNING. `null` = not on a chain. */
      chainX: number | null;
      /** Longest ball of the session, ft. `null` before the first one. */
      bestFt: number | null;
    }
  /**
   * The outcome of one swing.
   *
   * ⚠ `line` IS `swingCopy.describeSwing(r)`, VERBATIM. The board does not own a
   * second vocabulary for the same eight outcomes — the charter's "one
   * implementation per concept" applied to words.
   */
  | { kind: 'result'; line: string; tone: BoardTone }
  /** The money moment. The only screen that animates — and it takes the whole
   * array and the ribbons with it; see `boardAtlas.boardArrayOps`. */
  | {
      kind: 'homeRun';
      distFt: number;
      evMph: number;
      laDeg: number;
      points: number;
      chainX: number | null;
    }
  /** Between rounds. */
  | {
      kind: 'roundSummary';
      round: number;
      rounds: number;
      roundScore: number;
      homeRuns: number;
      bestFt: number;
      total: number;
    }
  /** DUEL-READY, and shipped now on purpose — see the union's note. */
  | {
      kind: 'duelScore';
      away: BoardTeam;
      home: BoardTeam;
      inning: number;
      half: 'top' | 'bot';
      outs: number;
      balls: number;
      strikes: number;
    };

/**
 * A narrow side column — the left stats column AND the right pitcher panel.
 *
 * ⚠ ONE SHAPE FOR BOTH, which is the charter's "one core, many modulators"
 * applied to a layout. They differ in content and in nothing else, so a second
 * painter would be a fork with no reason to exist.
 *
 * ⚠ AND THE STRINGS ARE SHORT BECAUSE THE GEOMETRY SAYS SO, not because the
 * shape is lazy. A 20 ft-wide column at 430 ft carries **5.4 characters** at the
 * legibility floor (`boardAtlas.test` prints the measurement). These panels
 * therefore carry NUMBERS — `#31`, `2-1`, `108`, `R` — and `fitRun` truncates
 * anything longer with a visible mark rather than shrinking it out of the rule.
 */
export interface BoardSideRow {
  /** Small caption above the value. */
  label: string;
  /** The number. This is the thing that is meant to be read from the seats. */
  value: string;
}

export interface BoardSide {
  heading: string;
  rows: BoardSideRow[];
}

/**
 * The wide strip below — a line score in the general case.
 *
 * ⚠ DATA-DRIVEN COLUMNS, so the derby and the duel are one strip. A duel is
 * three inning columns plus `R H E`; a derby is three ROUND columns plus a
 * total. Charter rule 4: content is data, not a branch.
 */
export interface BoardStripRow {
  name: string;
  /** One per `columns`. `null` prints as a blank cell — an inning not yet played. */
  cells: Array<number | null>;
  /** One per `totals`. */
  totals: number[];
}

export interface BoardStrip {
  columns: string[];
  totals: string[];
  rows: BoardStripRow[];
}

/**
 * The ribbon band's content — a train of short items that scrolls round the ring.
 *
 * The caller owns the words; the module owns the motion. During a home run the
 * items are IGNORED and the ribbon runs the celebration, because the whole array
 * moves together (see `boardRibbon.ts`).
 */
export interface BoardRibbon {
  items: string[];
}

/** Everything on every surface, at one instant. */
export interface BoardArray {
  main: BoardScreen;
  left: BoardSide | null;
  right: BoardSide | null;
  strip: BoardStrip | null;
  ribbon: BoardRibbon;
}

// ---------------------------------------------------------------------------
// Normalisation — the key's other half
// ---------------------------------------------------------------------------

/**
 * ⚠ ROUNDED TO THE PRECISION THE PICTURE ACTUALLY PRINTS, AND THE PAINTERS READ
 * THE SAME ROUNDED VALUE. This is a performance fix with a correctness trap in
 * it, so both halves are here in one function rather than only in the key.
 *
 * The problem: `bestFt`, `chainX`, `distFt`, `evMph` and `laDeg` are FLOATS off
 * the sim, and the HUD polls on an interval. Two polls a frame apart can hand in
 * `428.4001` and `428.4002` — a different key, a full 2.0 MB repaint, and a
 * byte-identical picture, because every one of those fields is printed through
 * `toFixed(0)` or `toFixed(2)`.
 *
 * The trap: rounding ONLY in the key would break the invariant the whole upload
 * policy rests on — "the key changes whenever the picture would" — the moment a
 * painter read an unrounded field. So `boardOps` normalises first and paints the
 * normalised screen, and the key is taken of the same value. The two can never
 * disagree because there is only one rounding.
 */
const r0 = (v: number) => Math.round(v);
const r2 = (v: number) => Math.round(v * 100) / 100;

export function normaliseScreen(s: BoardScreen): BoardScreen {
  switch (s.kind) {
    case 'derbyBatter':
      return {
        ...s,
        score: r0(s.score),
        chainX: s.chainX === null ? null : r2(s.chainX),
        bestFt: s.bestFt === null ? null : r0(s.bestFt),
      };
    case 'homeRun':
      return {
        ...s,
        distFt: r0(s.distFt),
        evMph: r0(s.evMph),
        laDeg: r0(s.laDeg),
        points: r0(s.points),
        chainX: s.chainX === null ? null : r2(s.chainX),
      };
    case 'roundSummary':
      return { ...s, roundScore: r0(s.roundScore), bestFt: r0(s.bestFt), total: r0(s.total) };
    case 'duelScore':
      return {
        ...s,
        away: { ...s.away, runs: r0(s.away.runs) },
        home: { ...s.home, runs: r0(s.home.runs) },
      };
    default:
      return s;
  }
}

export function normaliseArray(a: BoardArray): BoardArray {
  return {
    ...a,
    main: normaliseScreen(a.main),
    strip: a.strip
      ? {
          ...a.strip,
          rows: a.strip.rows.map((row) => ({
            ...row,
            cells: row.cells.map((c) => (c === null ? null : r0(c))),
            totals: row.totals.map(r0),
          })),
        }
      : null,
  };
}

/**
 * A string that changes whenever the PICTURE would.
 *
 * `JSON.stringify` is chosen for a stated reason: it can produce a spurious
 * change (two objects with the same fields in a different key order), which
 * costs one extra upload, but it can never MISS one — and a missed repaint is a
 * board showing the last batter's numbers.
 *
 * ⚠ AND "CAN NEVER MISS ONE" IS NOW TESTED THE WAY IT IS CLAIMED. The old key
 * test walked `derbyBatter`'s fields only, so keying home runs on `chainX` alone
 * and the duel on `inning` alone passed it — two home runs of different
 * distances back to back, or a count going 2-1 → 3-1, would have left stale
 * numbers on the biggest surface in the park. The test is now table-driven over
 * every screen and every scalar field it contains, and it does NOT compute the
 * expected key by calling this function.
 */
export const boardScreenKey = (s: BoardScreen): string => JSON.stringify(normaliseScreen(s));

export const boardArrayKey = (a: BoardArray): string => JSON.stringify(normaliseArray(a));
