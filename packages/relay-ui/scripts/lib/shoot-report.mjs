// Shared GPU report for the screenshot harnesses.
//
// `/GRAPHICS.md` §4 rule 5: "Numeric budgets are committed and enforced. Draw
// calls and triangles are printed per scene by the harness and checked against a
// committed budget file; a regression exits non-zero."
//
// `scripts/shoot-baseball.mjs` grew its own copy of that first. This module is
// the game-neutral version so the second game did not grow a third: golf uses it
// today, and baseball can adopt it without a rewrite (its budget file is a
// separate `budgets.baseball.json` — the numbers are per-game, only the
// mechanism is shared). Nothing here knows what a hole or a stadium is.
//
// ⚠ IT RETURNS ITS VERDICT, IT DOES NOT MERELY PRINT IT. The baseball harness
// records the reason: a version of this that only printed let a deliberately
// 5 ft-wrong outfield wall exit 0. `checkSceneStats()` hands back violations and
// the caller must count them.

import { readFileSync, writeFileSync } from 'node:fs';

/**
 * Headroom applied when generating a baseline from a real run.
 *
 * The two costs do not grow the same way, so they do not get the same multiple:
 *
 *  • DRAW CALLS are the dominant mobile cost and should grow by ONES as art
 *    lands (a merged belt of reeds is one call; a tree grove is one). 1.5× plus
 *    a floor of 8 catches the "somebody gave every feature its own material"
 *    regression while leaving room for a handful of honest additions.
 *  • TRIANGLES are cheap per instance and expensive per bad decision. A denser
 *    terrain grid or a merged foliage belt legitimately adds tens of thousands
 *    inside one call, so a tight ceiling here would fire on correct work and get
 *    raised — which is how a budget becomes a formality. 1.4×, rounded up to a
 *    round number, still catches what actually goes wrong (an unmerged reed per
 *    draw, a 64-segment sphere per dimple) because those land in the millions.
 *
 * ⚠ If a cap has to move, it moves WITH THE MEASUREMENT that justified it —
 * which is why every entry carries the `measured` numbers it was derived from.
 * "The scene got bigger" is not a measurement.
 */
const DRAW_HEADROOM = 1.5;
const TRI_HEADROOM = 1.4;
const TRI_ROUND_TO = 5000;

const capDraws = (n) => Math.max(8, Math.ceil(n * DRAW_HEADROOM));
const capTris = (n) => Math.max(TRI_ROUND_TO, Math.ceil((n * TRI_HEADROOM) / TRI_ROUND_TO) * TRI_ROUND_TO);

/** Read a committed budget file. Returns `{ scenes: {} }` when absent. */
export function loadBudgets(file) {
  try {
    const parsed = JSON.parse(readFileSync(file, 'utf8'));
    return { scenes: {}, ...parsed };
  } catch {
    return { scenes: {} };
  }
}

/**
 * One line of numbers per scene, in a fixed-width layout so a column of scenes
 * can be scanned for the odd one out.
 *
 * ⚠ `frameMs` is deliberately NOT printed. It is wall-clock, so printing it
 * would make the harness's own output differ between two runs of unchanged code
 * — and "two runs of unchanged code produce the same output" is the property the
 * whole visual gate rests on. The sample still carries it, so a human holding a
 * handset can read it off `window.__golfStats`, which is where it is useful.
 *
 * `@fN` is the frame the sample came from. Under SwiftShader (~3 fps) that is
 * usually the early frame-3 sample; it is quoted so a reader can tell whether
 * two scenes were measured at comparable points.
 */
export function formatStatsLine(stats) {
  if (!stats) return '  GPU   (no sample — the scene never reported)';
  return (
    `  GPU   draws ${String(stats.drawCalls).padStart(3)}` +
    `  tris ${String(stats.triangles).padStart(7)}` +
    `  progs ${String(stats.programs).padStart(2)}` +
    `  geos ${String(stats.geometries).padStart(3)}` +
    `  texs ${String(stats.textures).padStart(3)}` +
    `  tier ${stats.tier} (${stats.shadowMapSize}²${stats.shadows ? '' : ', off'})` +
    ` @f${stats.frame} — ${stats.qualityReason}`
  );
}

/**
 * Judge one scene's sample. Returns the list of violations; empty means pass.
 *
 * A MISSING SAMPLE IS A FAILURE, not a warning. The scene publishes its stats
 * from inside the render loop, so their absence after the readiness beacon means
 * no frame path ever ran — which is strictly worse than a number being wrong,
 * because nothing at all was measured.
 *
 * A missing BUDGET ENTRY is also a failure: a new scene must arrive with a
 * committed number, or the gate silently stops covering it.
 */
export function checkSceneStats(id, stats, budgets) {
  const violations = [];
  if (!stats) return [`${id}: no GPU sample — the scene never reported stats`];
  const cap = budgets.scenes?.[id];
  if (!cap) {
    return [`${id}: no entry in the budget file — regenerate it (see the harness header)`];
  }
  if (stats.drawCalls > cap.maxDrawCalls) {
    violations.push(`${id}: draw calls ${stats.drawCalls} > ceiling ${cap.maxDrawCalls}`);
  }
  if (stats.triangles > cap.maxTriangles) {
    violations.push(`${id}: triangles ${stats.triangles} > ceiling ${cap.maxTriangles}`);
  }
  return violations;
}

/**
 * Write a fresh baseline from a completed run.
 *
 * Deliberately explicit (a `--update-budgets` flag on the harness), never
 * automatic: a gate that rewrites its own thresholds when they fail is not a
 * gate. `measured` is stored beside every cap so a later reviewer can see what
 * the number was derived from without re-running anything.
 */
export function writeBudgets(file, samples, meta = {}) {
  const scenes = {};
  for (const id of Object.keys(samples).sort()) {
    const s = samples[id];
    if (!s) continue;
    scenes[id] = {
      maxDrawCalls: capDraws(s.drawCalls),
      maxTriangles: capTris(s.triangles),
      measured: {
        drawCalls: s.drawCalls,
        triangles: s.triangles,
        programs: s.programs,
        geometries: s.geometries,
        textures: s.textures,
        tier: s.tier,
        shadowMapSize: s.shadowMapSize,
      },
    };
  }
  const doc = {
    _readme:
      'Committed GPU ceilings, one entry per harness scene. Generated from a real ' +
      'SwiftShader run with `node scripts/shoot-golf.mjs --update-budgets`; caps are ' +
      `measured × ${DRAW_HEADROOM} (draw calls, floor 8) and × ${TRI_HEADROOM} ` +
      `(triangles, rounded up to ${TRI_ROUND_TO}). A run exceeding one of these exits ` +
      'non-zero. Raising a cap is a claim that the new cost was measured and is ' +
      'justified — say so in the commit.',
    _caveat:
      'These count what the CPU SUBMITTED (renderer.info). They are blind to fill ' +
      'rate, VRAM and shadow-map size, which is the class of cost that actually ' +
      'killed an Android WebView GPU process. "Renders fine in SwiftShader" is not ' +
      'evidence of on-device safety.',
    ...meta,
    scenes,
  };
  writeFileSync(file, `${JSON.stringify(doc, null, 2)}\n`);
  return doc;
}

/** Print the violations block and return the count. */
export function reportViolations(violations) {
  if (!violations.length) return 0;
  console.error(`\n✗ GPU budget: ${violations.length} violation(s)`);
  for (const v of violations) console.error(`  ${v}`);
  return violations.length;
}
