// The videoboard's TYPEFACE — a stroked vector alphabet, drawn as polylines.
//
// ⚠ WHY NOT `fillText`. Two reasons, and the first one is a GATE, not a taste.
//
// (1) DETERMINISM. `baseball-visual-qa` fails on any pixel difference between
//     two runs, and canvas text is the one drawing primitive whose output is a
//     function of the MACHINE rather than of the code: the family actually used
//     is whatever fontconfig resolves, and a family that is missing is
//     substituted SILENTLY. Measured in this container's headless Chromium — the
//     exact `--use-angle=swiftshader` configuration `shoot-baseball.mjs` launches
//     — over three separate browser launches:
//
//       hash of a text-only canvas   cd773f2975cbba3f  ×3   identical
//       hash of a geometry canvas    341e640ba28a9252  ×3   identical
//
//     So text IS stable run-to-run HERE. What is not stable is text ACROSS
//     environments, and the same measurement says why: of sixteen families
//     probed, `Impact`, `Verdana`, `Tahoma`, `Roboto`, `Georgia`,
//     `Trebuchet MS` and `ui-monospace` are NOT INSTALLED and fall back, while
//     `Arial`/`Helvetica` resolve to Liberation Sans and `system-ui` to DejaVu
//     Sans — three different faces, three different widths for the same string
//     (768.5, 937.6 and a 716.4 fallback px at 700 64px). Worse,
//     `document.fonts.check()` returned **true for every one of them, including
//     a family that does not exist**, so the obvious runtime guard cannot detect
//     the substitution. A board drawn with `fillText` is therefore reproducible
//     on the machine that photographed it and different on the next one, which
//     is exactly the class of failure the byte-identical rule exists to catch.
//     Polylines have no such surface: `moveTo`/`lineTo`/`stroke` rasterise from
//     our own coordinates.
//
// (2) LEGIBILITY AT 400 FT. See `boardPaint.ts`'s `MIN_LEGIBLE_H` derivation —
//     the board is ~2.2 CSS px per foot from the batter camera on a phone, so
//     every glyph on it is near the bottom of the readable range. A heavy
//     round-capped stroke face holds up there; a hinted system face at the same
//     cap height does not, because the hinting that helps it at 12 px is
//     resolved on the TEXTURE and then minified away.
//
// ⚠ WHAT THE HASHES ABOVE ARE AND ARE NOT. They are 64-bit digests printed as
// sixteen hex characters, and they came from a ONE-OFF MEASUREMENT: the canvas
// call log was dumped, replayed against a real 2D context in that Chromium and
// the resulting PNG hashed, three launches. **That replay is not committed and
// is therefore not a standing guard** — nothing in `scripts/` re-runs it, so it
// cannot regress and must not be cited as though it could. An earlier draft of
// this header called them "the same SHA-256", which they are not. What IS a
// standing guard is the source scan in `scoreboard.test.ts` (no `fillText`, no
// `.font =`) and `glyphTableHash()` below.
//
// ⚠ THE COST, STATED HONESTLY: this is a display face, not a text face. It is
// upper-case only (input is upper-cased), monospaced, and covers A–Z, 0–9 and
// nineteen marks. Anything outside that renders as `FALLBACK` — a hollow box —
// which is deliberately conspicuous rather than silently blank, because a
// missing glyph on a scoreboard should look like a missing glyph.
//
// No image assets, no font files, no new dependencies — the charter's rule 6.

/**
 * The subset of `CanvasRenderingContext2D` this whole feature is allowed to use.
 *
 * ⚠ IT IS DELIBERATELY TINY, AND THAT IS A TESTING DECISION. The unit suite
 * drives every screen through a RECORDING stub of this interface and asserts the
 * operations that came out — so the smaller the surface, the more completely a
 * recorded op log describes the picture. Notably absent: `fillText` (see the
 * header), `createLinearGradient` (a second rasteriser to reason about),
 * `translate`/`scale`/`rotate` (every coordinate below is absolute, so an
 * assertion about a number in the log is an assertion about a pixel) and
 * `globalAlpha` (blend state that would leak between ops).
 *
 * `fillStyle`/`strokeStyle` carry the full DOM union so that a real
 * `CanvasRenderingContext2D` structurally satisfies this type — proved at
 * compile time by `_CtxIsABoard2D` below, not asserted in prose.
 */
export interface Board2D {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  clearRect(x: number, y: number, w: number, h: number): void;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  closePath(): void;
  fill(): void;
  stroke(): void;
}

type Assert<T extends true> = T;
/** Compile-time proof that the real thing is a `Board2D`. Fails the typecheck. */
export type _CtxIsABoard2D = Assert<CanvasRenderingContext2D extends Board2D ? true : false>;

/**
 * Glyph cell width, as a fraction of cell HEIGHT, and the gap after each cell.
 *
 * MONOSPACED on purpose. A scoreboard is a grid of lit modules and reads as one;
 * more usefully, a monospaced advance makes a text run's width a pure function
 * of its character count, so `boardTextWidthPx` needs no per-glyph table and the
 * layout in `boardPaint.ts` can be reasoned about — and asserted — arithmetically
 * instead of by measuring.
 */
export const GLYPH_W = 0.62;
export const GLYPH_TRACK = 0.18;

/** Stroke width as a fraction of cell height. A display face wants a heavy one. */
export const GLYPH_WEIGHT = 0.13;

/**
 * The alphabet, as a compact DSL: polylines separated by `|`, points by a space,
 * coordinates by a comma, in a unit cell with **y pointing DOWN** (canvas
 * convention) so that `0,0` is the top-left of the cell and `1,1` the
 * bottom-right. Curves are polygonal — an `O` is an octagon — because at the
 * sizes this face is ever rasterised at (≤ 90 px on the texture, ≤ 34 screen px)
 * a Bézier and an octagon are the same picture, and the octagon is one primitive
 * fewer in `Board2D`.
 *
 * `validateGlyphs()` below is run as a test, so a typo in this table is a test
 * failure rather than a glyph that quietly renders as a smear (charter rule 4:
 * content is data, and bad data is a failing test).
 */
const GLYPH_SRC: Record<string, string> = {
  ' ': '',
  A: '0,1 .5,0 1,1|.19,.62 .81,.62',
  B: '0,0 0,1|0,0 .7,0 1,.17 1,.33 .7,.5 0,.5|.7,.5 1,.67 1,.83 .7,1 0,1',
  C: '1,.2 .75,0 .25,0 0,.25 0,.75 .25,1 .75,1 1,.8',
  D: '0,0 0,1|0,0 .6,0 1,.3 1,.7 .6,1 0,1',
  E: '1,0 0,0 0,1 1,1|0,.5 .75,.5',
  F: '1,0 0,0 0,1|0,.5 .7,.5',
  G: '1,.2 .75,0 .25,0 0,.25 0,.75 .25,1 .75,1 1,.8 1,.55 .55,.55',
  H: '0,0 0,1|1,0 1,1|0,.5 1,.5',
  I: '.5,0 .5,1|.15,0 .85,0|.15,1 .85,1',
  J: '.85,0 .85,.75 .6,1 .25,1 0,.8',
  K: '0,0 0,1|1,0 0,.55|.32,.38 1,1',
  L: '0,0 0,1 1,1',
  M: '0,1 0,0 .5,.55 1,0 1,1',
  N: '0,1 0,0 1,1 1,0',
  O: '.25,0 .75,0 1,.25 1,.75 .75,1 .25,1 0,.75 0,.25 .25,0',
  P: '0,1 0,0 .72,0 1,.2 1,.42 .72,.6 0,.6',
  Q: '.25,0 .75,0 1,.25 1,.75 .75,1 .25,1 0,.75 0,.25 .25,0|.6,.7 1,1',
  R: '0,1 0,0 .72,0 1,.2 1,.42 .72,.6 0,.6|.5,.6 1,1',
  S: '1,.15 .75,0 .25,0 0,.2 0,.35 .25,.5 .75,.5 1,.65 1,.8 .75,1 .25,1 0,.85',
  T: '0,0 1,0|.5,0 .5,1',
  U: '0,0 0,.75 .25,1 .75,1 1,.75 1,0',
  V: '0,0 .5,1 1,0',
  W: '0,0 .2,1 .5,.4 .8,1 1,0',
  X: '0,0 1,1|1,0 0,1',
  Y: '0,0 .5,.5 1,0|.5,.5 .5,1',
  Z: '0,0 1,0 0,1 1,1',
  '0': '.25,0 .75,0 1,.25 1,.75 .75,1 .25,1 0,.75 0,.25 .25,0|.78,.22 .22,.78',
  '1': '.18,.22 .5,0 .5,1|.15,1 .85,1',
  '2': '0,.22 .25,0 .75,0 1,.22 1,.42 0,1 1,1',
  '3': '0,.15 .25,0 .75,0 1,.2 1,.35 .7,.5 1,.65 1,.8 .75,1 .25,1 0,.85',
  '4': '.75,1 .75,0 0,.7 1,.7',
  '5': '1,0 0,0 0,.4 .7,.4 1,.6 1,.8 .75,1 .25,1 0,.85',
  '6': '.9,.12 .7,0 .3,0 0,.35 0,.78 .25,1 .72,1 1,.78 1,.62 .72,.45 .25,.45 0,.62',
  '7': '0,0 1,0 .35,1',
  '8': '.25,.5 0,.32 0,.18 .25,0 .75,0 1,.18 1,.32 .75,.5 .25,.5|.75,.5 1,.68 1,.85 .75,1 .25,1 0,.85 0,.68 .25,.5',
  '9': '.1,.88 .3,1 .7,1 1,.65 1,.22 .75,0 .28,0 0,.22 0,.38 .28,.55 .75,.55 1,.38',
  '.': '.42,.99 .58,.99',
  '·': '.42,.55 .58,.55',
  ':': '.5,.3 .5,.38|.5,.72 .5,.8',
  '+': '.5,.22 .5,.78|.22,.5 .78,.5',
  '-': '.15,.5 .85,.5',
  // ⚠ THE EM DASH IS HERE BECAUSE `swingCopy.describeSwing` USES IT — "Off the
  // wall — 395 ft". A glyph the copy layer emits and this table lacks would
  // render as the fallback box on the biggest surface in the stadium.
  '—': '.02,.5 .98,.5',
  '!': '.5,0 .5,.68|.5,.94 .5,1',
  '/': '.85,0 .15,1',
  '°': '.35,.06 .6,.06 .7,.16 .7,.3 .6,.4 .35,.4 .25,.3 .25,.16 .35,.06',
  '×': '.18,.32 .82,.86|.82,.32 .18,.86',
  // ⚠ THE SECOND BATCH, AND EVERY ONE OF THEM IS A REAL STRING THE BOARD NOW
  // BUILDS. A card name is allowed an apostrophe — `O'BRIEN` drew the fallback
  // box on the biggest surface in the park — the pitcher panel prints `#31`, the
  // strip prints `(3)` for an inning in progress and the derby prints a `%`
  // contact rate. `…` is the TRUNCATION MARK `fitRun` appends, so it is not
  // decoration: without it a name that will not fit is cut with no signal that
  // anything was removed. Comma is here because a four-digit score is the one
  // number a player reads at a glance.
  "'": '.5,.02 .42,.26',
  ',': '.55,.86 .4,1',
  '(': '.68,0 .35,.3 .35,.7 .68,1',
  ')': '.32,0 .65,.3 .65,.7 .32,1',
  '%': '.15,.02 .3,.02 .3,.22 .15,.22 .15,.02|.85,0 .15,1|.7,.78 .85,.78 .85,.98 .7,.98 .7,.78',
  '#': '.3,.1 .2,.9|.7,.1 .6,.9|.12,.35 .82,.35|.08,.65 .78,.65',
  '…': '.08,.99 .2,.99|.44,.99 .56,.99|.8,.99 .92,.99',
};

/** The conspicuous "no such glyph" box. Never blank — see the header. */
const FALLBACK = '.12,.06 .88,.06 .88,.94 .12,.94 .12,.06';

/** One glyph: a list of polylines, each a flat `[x0, y0, x1, y1, …]` in the cell. */
export type Glyph = number[][];

function parseGlyph(src: string): Glyph {
  if (src === '') return [];
  return src.split('|').map((line) =>
    line
      .split(' ')
      .flatMap((pt) => pt.split(',').map(Number)),
  );
}

const GLYPHS: Record<string, Glyph> = Object.fromEntries(
  Object.entries(GLYPH_SRC).map(([ch, src]) => [ch, parseGlyph(src)]),
);
const FALLBACK_GLYPH = parseGlyph(FALLBACK);

/** The glyph for a character, upper-cased. Unknown characters get the box. */
export function glyphFor(ch: string): Glyph {
  return GLYPHS[ch.toUpperCase()] ?? FALLBACK_GLYPH;
}

/** True when the table has an entry — i.e. the fallback box will NOT be used. */
export function hasGlyph(ch: string): boolean {
  return Object.prototype.hasOwnProperty.call(GLYPHS, ch.toUpperCase());
}

/**
 * Data validation, run as a test. Every complaint is a separate string so a
 * broken table names its own defect rather than failing one opaque boolean.
 */
export function validateGlyphs(): string[] {
  const bad: string[] = [];
  for (const [ch, glyph] of Object.entries(GLYPHS)) {
    if (ch === ' ') {
      if (glyph.length !== 0) bad.push('space must be empty');
      continue;
    }
    if (glyph.length === 0) bad.push(`${ch}: no polylines`);
    glyph.forEach((line, i) => {
      if (line.length < 4) bad.push(`${ch}[${i}]: fewer than 2 points`);
      if (line.length % 2 !== 0) bad.push(`${ch}[${i}]: odd coordinate count`);
      line.forEach((v, k) => {
        if (!Number.isFinite(v)) bad.push(`${ch}[${i}][${k}]: not a number`);
        else if (v < 0 || v > 1) bad.push(`${ch}[${i}][${k}]: ${v} outside the unit cell`);
      });
    });
  }
  return bad;
}

/**
 * The mark `fitRun` appends when it has to cut a run short. Exported so the
 * layout does not re-type it and so the coverage test can prove it has a glyph.
 */
export const TRUNCATION_MARK = '…';

/**
 * A digest of the PARSED glyph table.
 *
 * ⚠ THIS IS THE ASSERTION `validateGlyphs()` CANNOT MAKE, and it exists because
 * a mutation proved the gap: swapping `E`'s and `F`'s polyline sources renders
 * every E as an F and every F as an E, and the whole suite stayed green.
 * `validateGlyphs` checks STRUCTURE — points in the cell, at least two per
 * polyline — which a swap preserves exactly. Per-glyph point counts would not
 * help either: E and F would still differ, but swapping two coordinates inside
 * one glyph, or two glyphs with the same shape budget, would not.
 *
 * FNV-1a over the parsed numbers, so it hashes the PICTURE and not the source
 * text: re-typing `.50` as `.5`, reordering whitespace or reflowing the table
 * leaves it unchanged, while any coordinate, any polyline split and any
 * character-to-shape assignment moves it. Object key order is Object.entries'
 * insertion order, so the table's ORDER is part of the digest too — which is
 * what makes a swap visible even when the two shapes are both still present.
 */
export function glyphTableHash(): string {
  let h = 0x811c9dc5;
  const feed = (s: string) => {
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  for (const [ch, glyph] of Object.entries(GLYPHS)) {
    feed(`${ch}:${glyph.map((line) => line.join(',')).join('|')};`);
  }
  feed(`FALLBACK:${FALLBACK_GLYPH.map((line) => line.join(',')).join('|')}`);
  return h.toString(16).padStart(8, '0');
}

/** Advance from one cell origin to the next, px, for a given cap height. */
export function boardAdvancePx(sizePx: number): number {
  return sizePx * (GLYPH_W + GLYPH_TRACK);
}

/** Width of a whole run, px. Monospaced, so: n cells less the trailing track. */
export function boardTextWidthPx(text: string, sizePx: number): number {
  if (text.length === 0) return 0;
  return text.length * boardAdvancePx(sizePx) - sizePx * GLYPH_TRACK;
}

export type BoardAlign = 'left' | 'centre' | 'right';

/**
 * Stroke a run of text.
 *
 * `xPx` is the anchor named by `align`; `yPx` is the TOP of the cell (not a
 * baseline — there are no descenders in this face, so a top is the unambiguous
 * datum). Returns the run's width in px so a caller can chain.
 *
 * ⚠ ONE `beginPath()`/`stroke()` PER PRINTABLE GLYPH, and that is load-bearing
 * for the tests as well as for the picture: it makes "how many glyphs were
 * drawn" a countable property of the recorded op log, and a space — which emits
 * nothing at all — distinguishable from a glyph that drew a blank.
 */
export function strokeBoardText(
  g: Board2D,
  text: string,
  xPx: number,
  yPx: number,
  sizePx: number,
  color: string,
  align: BoardAlign = 'left',
  weight = GLYPH_WEIGHT,
): number {
  const width = boardTextWidthPx(text, sizePx);
  const advance = boardAdvancePx(sizePx);
  const cell = sizePx * GLYPH_W;
  let x = align === 'left' ? xPx : align === 'right' ? xPx - width : xPx - width / 2;

  g.strokeStyle = color;
  g.lineWidth = Math.max(1, sizePx * weight);
  // ⚠ `round`/`round` IS THE INK MODEL, NOT A LOOK. The overlap check in
  // `scoreboard.test.ts` inflates every text box by half a `lineWidth` on all
  // four sides, and that inflation is EXACTLY the envelope a round cap and a
  // round join sweep. Under `miter` the apex of an `A`, `V`, `W` or `M` spikes
  // out to `lineWidth / (2·sin(θ/2))` — for the `V`'s ~53° apex that is 2.2×
  // the inflation — so the overlap check would silently stop describing the
  // ink while still passing. Changing either of these two lines used to pass
  // all 34 tests, because the recording stub did not write them down; it does
  // now, and the emitter test asserts both.
  g.lineCap = 'round';
  g.lineJoin = 'round';

  for (const ch of text) {
    const glyph = glyphFor(ch);
    if (glyph.length > 0) {
      g.beginPath();
      for (const line of glyph) {
        for (let i = 0; i + 1 < line.length; i += 2) {
          const px = x + line[i]! * cell;
          const py = yPx + line[i + 1]! * sizePx;
          if (i === 0) g.moveTo(px, py);
          else g.lineTo(px, py);
        }
      }
      g.stroke();
    }
    x += advance;
  }
  return width;
}
