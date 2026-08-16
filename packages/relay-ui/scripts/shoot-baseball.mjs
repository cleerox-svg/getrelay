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
// ⚠ IT PRINTS NUMBERS, NOT JUST PICTURES. Two of them:
//   • draw calls and triangles per scene — the charter demands a numeric GPU
//     budget and this is where the number comes from;
//   • the fence distance and height at 0°/±22°/±45° MEASURED OUT OF THE BUILT
//     GEOMETRY, beside what parks.ts says. A read-back of the builder's own
//     input would prove nothing; this reads the BufferGeometry vertices, so a
//     wall drawn from the five knots instead of the pchip shows up as a delta.
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

function printReport(id, report) {
  if (!report || report.err) {
    console.log(`  ⚠ no scene handle: ${report?.err ?? 'window.__stadium missing'}`);
    return;
  }
  const s = report.stats;
  console.log(
    `  GPU   draws ${String(s.drawCalls).padStart(3)}  tris ${String(s.triangles).padStart(6)}` +
      `  progs ${s.programs}  geos ${s.geometries}  texs ${s.textures}` +
      `  tier ${s.tier} (${s.shadowMapSize}²) — ${s.qualityReason}`,
  );
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
    console.log(
      `      ${String(row.deg).padStart(4)}°  ${f2(row.geo?.distFt)}      ${f2(row.park?.distFt)}` +
        `  ${f2(dd)}  ${f2(row.geo?.heightFt)}  ${f2(row.park?.heightFt)}  ${f2(dh)}`,
    );
  }
  console.log(`    worst |Δ| — distance ${worstD.toFixed(3)} ft, height ${worstH.toFixed(3)} ft`);
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
        await page.waitForFunction('window.__baseballReady === true', {
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
        saved.push(file);
        console.log(`✓ ${id.padEnd(12)} → ${path.relative(pkgDir, file)}`);
        printReport(id, report);
        if (errors.length) {
          failed++;
          console.error(`  ✗ PAGE ERRORS (${errors.length}):`);
          for (const e of errors.slice(0, 6)) console.error(`      ${e}`);
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

  console.log(
    `\n${saved.length}/${ids.length} scene(s) captured in ${path.relative(process.cwd(), outDir)}`,
  );
  // A page error is a FAILURE here, not a footnote. See the header.
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
