// Headless screenshot harness for the baseball stadium scene — the VISUAL GATE.
//
// It boots a Vite dev server for @relay/ui, drives the pre-installed Chromium
// with software GL (SwiftShader), loads baseballpreview.html for each scene,
// waits for a real render (window.__baseballReady, set by
// src/baseballpreview.tsx once three frames have drawn) and writes PNGs to
// packages/relay-ui/.baseball-shots/ (git-ignored). This is what the
// baseball-visual-qa agent runs; humans run it via `pnpm shoot:baseball`.
//
// ⚠ IT CAPTURES console.error AS WELL AS pageerror, AND THIS IS NOT OPTIONAL.
// three logs shader compile/link failures to console.error and then SILENTLY
// SKIPS the mesh. Without the console hook a broken material renders as a
// plausible-looking stadium minus one object, and every check a human is not
// personally squinting at passes.
//
// ⚠ IT ASSERTS NUMBERS, IT DOES NOT MERELY PRINT THEM, AND THAT DISTINCTION IS
// THE WHOLE POINT OF THE FILE. An adversarial review drew the outfield wall 5 ft
// wrong on purpose; this harness printed `worst |Δ| — distance 5.002 ft` and then
// exited 0. A gate that observes the failure and returns success is not a gate.
// Two families of number are checked, and every one of them can fail the run:
//   • draw calls and triangles per scene — the charter's rule 7 demands a numeric
//     GPU budget, so there are ceilings below and they are enforced;
//   • the fence distance and height at 0°/±22°/±45° MEASURED OUT OF THE BUILT
//     GEOMETRY, beside what parks.ts says. A read-back of the builder's own
//     input would prove nothing; this reads the BufferGeometry vertices, so a
//     wall drawn from the five knots instead of the pchip shows up as a delta —
//     and now as a non-zero exit code.
//
// ⚠ SwiftShader validates composition, geometry and materials but NOT real-GPU
// behaviour. "Renders fine in SwiftShader" is not evidence of on-device safety —
// see the shadow-map note in stadium/quality.ts.
//
// Usage:
//   node scripts/shoot-baseball.mjs                 # all scenes
//   node scripts/shoot-baseball.mjs batter wide     # one or more scene ids

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgDir, '.baseball-shots');

// The scene matrix. Four camera MODES over one scene, plus the second park —
// `park-alpine` is the proof that a park is data: a different fence row must
// produce a visibly different wall (347/390/415/375/350 against Harbourfront's
// symmetric 328/375/400, a 16 ft wall in left-centre against a uniform 10, and
// NO ROOF at all against a 282 ft ring).
const SCENES = {
  batter: { query: 'scene=batter', label: 'batter' },
  pitcher: { query: 'scene=pitcher', label: 'pitcher' },
  wide: { query: 'scene=wide', label: 'wide' },
  flight: { query: 'scene=flight', label: 'flight' },
  'park-alpine': { query: 'scene=wide&park=alpine', label: 'park-alpine-wide' },
};

// Portrait, a phone screen. Same shape as the golf harness so the two sets of
// shots are comparable side by side.
const VIEWPORT = { width: 900, height: 1600 };
const READY_TIMEOUT_MS = 20000;

// Bearings the fence table is printed at: dead centre, the two power alleys and
// both foul lines. −45/0/+45 are sampled knots in both parks; ±22 is a knot in
// Harbourfront and an OFF-KNOT pchip evaluation in Alpine (whose knots are
// ±20), which is exactly the case a knots-only renderer would get wrong.
const FENCE_BEARINGS = [-45, -22, 0, 22, 45];

/**
 * How far the DRAWN wall may sit from `parks.ts`, ft — distance and height.
 *
 * This is a SAMPLING-RESIDUAL tolerance, not a taste one, and it is derived
 * rather than picked. The wall is a chord polyline through `fenceAt` evaluated
 * every `quality.fenceStepDeg`, and `sample()` reads it back by interpolating
 * linearly between two adjacent posts, so the only legitimate error is the
 * chord's sagitta against the pchip across one step. Measured:
 *
 *     tier      step     worst |Δ| dist   worst |Δ| height
 *     high      0.5°     0.000 ft         0.000 ft
 *     medium    1.5°     0.006 ft         0.005 ft      ← the harness default
 *     low       3.0°     0.027 ft         0.021 ft
 *
 * (Measured by forcing `?quality=` over both parks — the `wide` scene, whose
 * geometry is the same wall every mode draws.) Chord error goes as step², which
 * the medium → low row confirms: 4× the error for 2× the step, on both columns.
 * 0.05 ft is therefore ~8× the default tier's residual and 1.9× the coarsest tier
 * the game can ever run at, and it is 100× SMALLER than the 4.97 ft
 * knots-vs-pchip gap this whole read-back exists to catch — a wall drawn from the
 * five knots, or a builder that quietly rounds, cannot hide under it. It is also
 * far below anything a player could see: 0.05 ft is 0.6 in on a 10 ft wall.
 */
const FENCE_TOL_FT = 0.05;

/**
 * The GPU ceiling, per scene. Charter rule 7: "GPU budget with a number", and a
 * number nobody enforces is a comment.
 *
 * Today's worst scene is `wide` at 18 draws / 1,845 triangles (11–18 and
 * 1,365–1,845 across the five). The two ceilings are deliberately NOT set the
 * same multiple of that, because the two costs do not grow the same way:
 *
 *   • DRAW CALLS are the dominant mobile cost and the one thing the charter
 *     legislates directly — the crowd is ONE `InstancedMesh`, repeated geometry
 *     is instanced or merged. Draw calls should therefore grow by ones as M2 art
 *     lands (crowd, lights, scoreboard, skyline, ball, bat), not by multiples.
 *     40 is 2.2× today's worst, leaving 22 new draws for the whole M2 art pass,
 *     and sits UNDER 3 × 18 = 54, so the "somebody gave every seating section its
 *     own material" regression trips it. That is the failure this number exists
 *     for.
 *   • TRIANGLES are cheap per instance and expensive per bad decision. An
 *     instanced crowd legitimately adds six figures of triangles inside ONE draw
 *     call, so a 3× ceiling here would fire on correct M2 art and get raised,
 *     which is how a budget becomes a formality. 120,000 is a real static-scene
 *     budget for a mid-range mobile GPU and still catches what actually goes
 *     wrong — an un-instanced crowd or a 64-segment sphere per seat lands in the
 *     millions, not the tens of thousands.
 *
 * ⚠ If one of these has to move, it moves with a comment saying what was
 * measured, exactly like the line caps in `budget.test.ts`. "The scene got
 * bigger" is not a measurement.
 */
const MAX_DRAW_CALLS = 40;
const MAX_TRIANGLES = 120000;

const requested = process.argv.slice(2);
const ids = requested.length ? requested : Object.keys(SCENES);
for (const id of ids) {
  if (!SCENES[id]) {
    console.error(`Unknown scene "${id}". Known: ${Object.keys(SCENES).join(', ')}`);
    process.exit(2);
  }
}

async function loadPlaywright() {
  let gRoot;
  try {
    gRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Could not run `npm root -g` to locate the global Playwright install.');
  }
  for (const entry of ['playwright/index.mjs', 'playwright-core/index.mjs']) {
    try {
      return await import(path.join(gRoot, entry));
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Playwright not found in the global npm root (${gRoot}). This harness needs a ` +
      `global Playwright + a Chromium under PLAYWRIGHT_BROWSERS_PATH.`,
  );
}

const f2 = (v) => (v === null || v === undefined ? '   —  ' : v.toFixed(2).padStart(7));

/**
 * Print the scene's numbers AND JUDGE THEM. Returns the list of violations —
 * an empty array means the scene passed.
 *
 * ⚠ IT RETURNS RATHER THAN PRINTS ITS VERDICT so the caller cannot forget to
 * count it. The version of this function that only printed is the reason a
 * deliberately 5 ft-wrong wall shipped a green run.
 */
function checkReport(report) {
  if (!report || report.err) {
    // ⚠ THIS IS A FAILURE, NOT A WARNING. It is the one branch in the file that
    // reports a problem, and it used to return success. `window.__stadium` is
    // set from StadiumGL's `onReady`, so its absence after the ready beacon means
    // the scene handle is broken — every number below is then unmeasured, which
    // is strictly worse than measured-and-wrong.
    console.error(`  ✗ no scene handle: ${report?.err ?? 'window.__stadium missing'}`);
    return ['no scene handle'];
  }
  const violations = [];
  const s = report.stats;
  console.log(
    `  GPU   draws ${String(s.drawCalls).padStart(3)}  tris ${String(s.triangles).padStart(6)}` +
      `  progs ${s.programs}  geos ${s.geometries}  texs ${s.textures}` +
      `  tier ${s.tier} (${s.shadowMapSize}²) — ${s.qualityReason}`,
  );
  if (s.drawCalls > MAX_DRAW_CALLS) {
    violations.push(`draw calls ${s.drawCalls} > ceiling ${MAX_DRAW_CALLS}`);
  }
  if (s.triangles > MAX_TRIANGLES) {
    violations.push(`triangles ${s.triangles} > ceiling ${MAX_TRIANGLES}`);
  }
  console.log(
    `  FENCE park=${report.parkId}  roofPeak ${report.roofPeakFt} ft  foul ${report.foulTerritoryFt} ft`,
  );
  console.log(
    '    bearing   geometry_ft   parks.ts_ft      Δft   geom_h    park_h     Δh',
  );
  let worstD = 0;
  let worstH = 0;
  for (const row of report.fence) {
    const dd = row.geo && row.park ? row.geo.distFt - row.park.distFt : null;
    const dh = row.geo && row.park ? row.geo.heightFt - row.park.heightFt : null;
    if (dd !== null) worstD = Math.max(worstD, Math.abs(dd));
    if (dh !== null) worstH = Math.max(worstH, Math.abs(dh));
    // A bearing the geometry cannot answer is a HOLE IN THE WALL, and it must not
    // pass as "no delta measured". −45/0/+45 are sampled knots in both parks.
    if (!row.geo || !row.park) violations.push(`fence unmeasurable at ${row.deg}°`);
    console.log(
      `      ${String(row.deg).padStart(4)}°  ${f2(row.geo?.distFt)}      ${f2(row.park?.distFt)}` +
        `  ${f2(dd)}  ${f2(row.geo?.heightFt)}  ${f2(row.park?.heightFt)}  ${f2(dh)}`,
    );
  }
  console.log(
    `    worst |Δ| — distance ${worstD.toFixed(3)} ft, height ${worstH.toFixed(3)} ft` +
      `  (tol ${FENCE_TOL_FT} ft)`,
  );
  if (worstD > FENCE_TOL_FT) {
    violations.push(`fence distance off by ${worstD.toFixed(3)} ft > tol ${FENCE_TOL_FT} ft`);
  }
  if (worstH > FENCE_TOL_FT) {
    violations.push(`fence height off by ${worstH.toFixed(3)} ft > tol ${FENCE_TOL_FT} ft`);
  }
  return violations;
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const { createServer } = await import('vite');
  const { chromium } = await loadPlaywright();

  const server = await createServer({
    root: pkgDir,
    logLevel: 'warn',
    server: { port: 0, host: '127.0.0.1' },
  });
  await server.listen();

  let failed = 0;
  const saved = [];
  let browser;
  try {
    const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
    if (!base) throw new Error('Vite dev server did not report a local URL.');
    browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const id of ids) {
      const { query, label } = SCENES[id];
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
      // See the header: three reports a failed shader to console.error and then
      // draws the scene minus that mesh. This hook is the only thing that sees it.
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`);
      });
      const url = `${base}/baseballpreview.html?${query}`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 25000 });
        // ⚠ THE `null` IS LOAD-BEARING. Playwright's signature is
        // `waitForFunction(pageFunction, arg, options)`, so passing the options
        // object second hands it to the page as `arg` and silently falls back to
        // Playwright's own 30 s default — `READY_TIMEOUT_MS` was dead code, and
        // the only symptom was a hung run reporting a timeout nobody had written.
        await page.waitForFunction('window.__baseballReady === true', null, {
          timeout: READY_TIMEOUT_MS,
        });
        // Let a couple more frames land after the beacon so the stats read are a
        // steady-state frame rather than the first one.
        await page.waitForTimeout(200);

        const report = await page.evaluate((bearings) => {
          const st = window.__stadium;
          const sim = window.__sim;
          if (!st || !sim) return { err: 'window.__stadium / __sim missing' };
          return {
            parkId: sim.parkId,
            roofPeakFt: sim.roofPeakFt,
            foulTerritoryFt: sim.foulTerritoryFt,
            stats: st.stats(),
            fence: bearings.map((deg) => ({
              deg,
              geo: st.measureFence(deg),
              park: sim.fenceAt(deg),
            })),
          };
        }, FENCE_BEARINGS);

        const file = path.join(outDir, `${label}.png`);
        await page.screenshot({ path: file });
        // ⚠ THE PNG IS WRITTEN BEFORE THE VERDICT ON PURPOSE — a failing scene's
        // picture is the most useful artefact there is — but the TICK IS PRINTED
        // AFTER. The previous order printed `✓` and counted the scene as captured
        // before the error check ran, so a shader-broken scene reported "5/5
        // captured" beside its own stack trace. The exit code was right and the
        // summary lied, which is the half a human reads.
        console.log(`· ${id.padEnd(12)} → ${path.relative(pkgDir, file)}`);
        const bad = checkReport(report);
        if (errors.length) {
          console.error(`  ✗ PAGE ERRORS (${errors.length}):`);
          for (const e of errors.slice(0, 6)) console.error(`      ${e}`);
          bad.push(`${errors.length} page error(s)`);
        }
        if (bad.length) {
          failed++;
          console.error(`✗ ${id.padEnd(12)} FAILED — ${bad.join('; ')}`);
        } else {
          saved.push(file);
          console.log(`✓ ${id.padEnd(12)} ok`);
        }
      } catch (e) {
        failed++;
        console.error(`✗ ${id}: ${e.message}`);
        if (errors.length) console.error(`  page errors: ${errors.slice(0, 4).join(' | ')}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  // `saved` counts scenes that PASSED, not scenes whose PNG got written — the
  // two used to be the same list and the summary was therefore always 5/5.
  console.log(
    `\n${saved.length}/${ids.length} scene(s) passed; PNGs in ${path.relative(process.cwd(), outDir)}`,
  );
  // A page error, a GPU-budget overrun and a wall that does not match parks.ts
  // are all FAILURES here, not footnotes. See the header.
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
