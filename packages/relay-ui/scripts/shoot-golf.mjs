// Headless screenshot harness for the golf 3D scenes — the committed, repeatable
// replacement for the throwaway golfpreview workflow GOLF.md used to describe.
//
// It boots a Vite dev server for @relay/ui, drives the pre-installed Chromium
// with software GL (SwiftShader), loads golfpreview.html for each scene, waits
// for a real render (window.__golfReady, set by src/golfpreview.tsx), and writes
// PNGs to packages/relay-ui/.golf-shots/ (git-ignored). This is what the
// golf-visual-qa agent runs; humans can run it too via `pnpm shoot:golf`.
//
// Requirements (provided by this managed environment; the script fails loudly if
// missing): a global Playwright install and a Chromium build under
// PLAYWRIGHT_BROWSERS_PATH. We import Playwright from the GLOBAL npm root rather
// than adding @playwright/test as a workspace devDep (a screenshot utility
// doesn't need the test-runner framework, and it would bloat install for every
// UI contributor). SwiftShader validates composition/materials but NOT real-GPU
// behaviour — see the on-device shadow-map caveat in GOLF.md.
//
// Usage:
//   node scripts/shoot-golf.mjs                 # all scenes
//   node scripts/shoot-golf.mjs course          # one or more scene ids
//   node scripts/shoot-golf.mjs course range
//   node scripts/shoot-golf.mjs augusta12       # a named real-course hole shot

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgDir, '.golf-shots');

// Scene matrix: id → preview query. Portrait viewport ~ a phone screen.
// `drag` scenes perform a pointer pull-back (down near the ball, move up) and
// screenshot the AIMING state — the only way to capture the aim arc/reticles,
// which pointer events drive.
// `sequence` scenes need a bespoke multi-step driver (see runSequence): the
// generic single-drag path can't express "aim, fire, roll to rest, aim again".
const SCENES = {
  course: { query: 'scene=course', label: 'course-hole1' },
  green: { query: 'scene=course&at=green', label: 'course-green' },
  approach: { query: 'scene=course&at=approach', label: 'course-approach' },
  aim: { query: 'scene=course&at=fairway', label: 'course-aim-iron', drag: true },
  played: { query: 'scene=course&at=played', label: 'course-played-aim', drag: true },
  celebrate: { query: 'scene=course&at=holed', label: 'course-celebrate' },
  range: { query: 'scene=range&layout=fairway', label: 'range-fairway' },
  // Mini-golf (PuttGL). Holes are 0-based into the default GARDEN course; each
  // shows a signature feature so golf-visual-qa can read the displaced slope,
  // the ramp and a banked rail. `putt-drag` pulls back from the ball to capture
  // the in-scene dashed aim line + power tip (the only way to render aiming).
  putt: { query: 'scene=putt&hole=0', label: 'putt-hole1-slope' },
  'putt-slope': { query: 'scene=putt&hole=6', label: 'putt-sidehill' },
  'putt-ramp': { query: 'scene=putt&hole=3', label: 'putt-ramp' },
  'putt-bank': { query: 'scene=putt&hole=1', label: 'putt-bank-rail' },
  // The mini-golf ball sits higher on screen than the course tee, so start the
  // pull ON the ball (dragFrom, viewport fractions) — the grab test needs the
  // pointer-down within the ball's grab radius.
  'putt-drag': {
    query: 'scene=putt&hole=0',
    label: 'putt-aim',
    drag: true,
    dragFrom: { x: 0.5, y: 0.69 },
  },
  // Phase-2 obstacle/hazard scenes. Moving obstacles read the sim's simTime, so
  // `&t=<seconds>` pre-advances the clock to catch a windmill/gate MID-rotation
  // (not frozen at angle 0); tunnels/hazards are static so they need no phase.
  // Courses: windmill-links (windmills + gates), pirate-cove (tunnels + water +
  // sand). Holes are 0-based indices into each course.
  'putt-windmill': {
    query: 'scene=putt&course=windmill-links&hole=0&t=0.34',
    label: 'putt-windmill',
  },
  'putt-pendulum': {
    query: 'scene=putt&course=windmill-links&hole=2&t=0.3',
    label: 'putt-pendulum',
  },
  'putt-tunnel': { query: 'scene=putt&course=pirate-cove&hole=2', label: 'putt-tunnel' },
  'putt-water': { query: 'scene=putt&course=pirate-cove&hole=1', label: 'putt-water' },
  'putt-sand': { query: 'scene=putt&course=pirate-cove&hole=0', label: 'putt-sand' },
  // Regression guard for the frustum-cull second-aim bug: the aim arc/reticles
  // were culled on the SECOND rendered aim (stale cached boundingSphere from the
  // tee) and the shot rendered blank. Only reproducible by driving TWO real
  // rendered aims with a real fire between them — see runSecondAim().
  secondAim: { query: 'scene=course', label: 'course-second-aim', sequence: 'secondAim' },
  // Named REAL-COURSE shots for QA of the authored holes (hole is a 0-based
  // index into the course's holes[]). These exercise the signature features and
  // scene framing at extremes — the plain `course`/`secondAim` scenes above stay
  // on HOLE_1 and are unaffected.
  augusta12: { query: 'scene=course&course=augusta&hole=11', label: 'augusta-12-golden-bell' },
  augusta13: { query: 'scene=course&course=augusta&hole=12', label: 'augusta-13-azalea' },
  augusta2: { query: 'scene=course&course=augusta&hole=1', label: 'augusta-2-pink-dogwood' },
  listowelHeritage3: {
    query: 'scene=course&course=listowel-heritage&hole=2',
    label: 'listowel-heritage-3',
  },
};
const VIEWPORT = { width: 900, height: 1600 };
const READY_TIMEOUT_MS = 15000;
// Sim fixed timestep (mirror of tuning.ts FIXED_MS) — used to step a fired shot
// to true rest deterministically, since headless rAF is throttled.
const FIXED_MS = 1000 / 120;

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

// Multi-aim regression driver. Renders a REAL first aim at the tee (a genuine
// pointer drag so CourseGL renders the aim aids and CACHES the aim-aid
// boundingSphere near the tee), fires it through the sim's own pipeline, rolls
// the ball to true rest in the fairway, then renders a REAL second aim from
// that rest position and screenshots it. The second aim's predicted arc +
// landing reticle + dispersion edges MUST be visible; before the frustum-cull
// fix they were culled against the stale tee-cached sphere and the shot was
// blank. This is the only sequence that reproduces the class — the `played`
// scene fires the tee shot programmatically, so no first aim ever renders.
async function runSecondAim(page, label) {
  const cx = VIEWPORT.width / 2;
  const y0 = VIEWPORT.height * 0.8;

  // FIRST aim (real, near the tee). Moderate pull so the tee shot rests in the
  // fairway (not on the green). Hold long enough that several frames render the
  // aim aids VISIBLE at the tee — this is what caches the soon-stale sphere.
  const pull1 = 165;
  await page.mouse.move(cx, y0);
  await page.mouse.down();
  for (let s = 1; s <= 6; s++) await page.mouse.move(cx, y0 - (pull1 * s) / 6);
  await page.waitForTimeout(600);
  await page.mouse.up(); // arm

  // FIRE + roll to true rest downrange. Deterministic stepping (headless rAF is
  // throttled, so the live loop would still be rolling when we drag again —
  // exactly the device situation the fix targets). CourseGL's loop then no-ops.
  const rested = await page.evaluate((fixedMs) => {
    const s = window.__sim;
    if (!s) return { err: 'no __sim' };
    s.fireArmed(0);
    const dt = fixedMs / 1000;
    let g = 0;
    while (s.ball.inFlight && g++ < 300000) s.substep(dt);
    const st = s.getState();
    return { lie: st.lie, dist: st.distToPin, d: Math.round(s.ball.d), strokes: st.strokes, resting: st.resting };
  }, FIXED_MS);
  // Let the render loop hide the (now stale-sphere) aim aids and settle the
  // camera downrange before we re-aim.
  await page.waitForTimeout(500);

  // SECOND aim (real, from the fairway) — the shot that would have been blank.
  const pull2 = 220;
  await page.mouse.move(cx, y0);
  await page.mouse.down();
  for (let s = 1; s <= 6; s++) await page.mouse.move(cx, y0 - (pull2 * s) / 6);
  await page.waitForTimeout(600);
  const secondAim = await page.evaluate(() => {
    const s = window.__sim;
    if (!s) return { err: 'no __sim' };
    const st = s.getState();
    const p = s.predict(0);
    return {
      aiming: st.aiming,
      power: Math.round(s.power * 100) / 100,
      lie: st.lie,
      dist: st.distToPin,
      putting: st.putting,
      pathLen: p.path.length,
      landing: p.landing ? { d: Math.round(p.landing.d), x: Math.round(p.landing.x) } : null,
    };
  });
  const file = path.join(outDir, `${label}.png`);
  await page.screenshot({ path: file });
  await page.mouse.up();
  console.log(`  DBG secondAim rested: ${JSON.stringify(rested)}`);
  console.log(`  DBG secondAim aim   : ${JSON.stringify(secondAim)}`);
  return file;
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
  // Everything after the server is listening goes through this finally so the
  // Vite server is always closed — even if chromium.launch throws.
  let browser;
  try {
    const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
    if (!base) throw new Error('Vite dev server did not report a local URL.');
    browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const id of ids) {
      const { query, label, drag, sequence, dragFrom } = SCENES[id];
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const url = `${base}/golfpreview.html?${query}`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        await page.waitForFunction('window.__golfReady === true', { timeout: READY_TIMEOUT_MS });
        // Let one more frame land after the ready beacon.
        await page.waitForTimeout(150);
        if (sequence === 'secondAim') {
          const file = await runSecondAim(page, label);
          saved.push(file);
          console.log(`✓ ${id.padEnd(7)} → ${path.relative(pkgDir, file)}`);
          if (errors.length) console.log(`  (page errors: ${errors.slice(0, 3).join(' | ')})`);
          continue;
        }
        if (drag) {
          // Pull back from near the ball to load power + aim, and hold — the aim
          // arc/reticles render only while aiming. Default start is lower-middle
          // (course tee); a scene may override with dragFrom (viewport fractions,
          // e.g. mini-golf whose ball sits higher on screen).
          const cx = (dragFrom?.x ?? 0.5) * VIEWPORT.width;
          const y0 = (dragFrom?.y ?? 0.8) * VIEWPORT.height;
          await page.mouse.move(cx, y0);
          await page.mouse.down();
          for (let s = 1; s <= 6; s++) await page.mouse.move(cx, y0 - (250 * s) / 6);
          await page.waitForTimeout(300);
        }
        if (drag) {
          const dbg = await page.evaluate(() => {
            const sim = window.__sim;
            if (!sim) return { err: 'no __sim' };
            const st = sim.getState();
            let pathLen = -1;
            let landing = null;
            let err = null;
            try {
              const p = sim.predict(0);
              pathLen = p.path.length;
              landing = p.landing ? { d: Math.round(p.landing.d), x: Math.round(p.landing.x) } : null;
            } catch (e) {
              err = String(e);
            }
            return {
              aiming: st.aiming,
              power: Math.round(sim.power * 100) / 100,
              lie: st.lie,
              dist: st.distToPin,
              club: st.clubId,
              putting: st.putting,
              inFlight: st.inFlight,
              pathLen,
              landing,
              err,
            };
          });
          console.log(`  DBG ${id}: ${JSON.stringify(dbg)}`);
        }
        const file = path.join(outDir, `${label}.png`);
        await page.screenshot({ path: file });
        if (drag) await page.mouse.up();
        saved.push(file);
        console.log(`✓ ${id.padEnd(7)} → ${path.relative(pkgDir, file)}`);
        if (errors.length) {
          console.log(`  (page errors: ${errors.slice(0, 3).join(' | ')})`);
        }
      } catch (e) {
        failed++;
        console.error(`✗ ${id}: ${e.message}`);
        if (errors.length) console.error(`  page errors: ${errors.slice(0, 3).join(' | ')}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  console.log(`\n${saved.length}/${ids.length} scene(s) captured in ${path.relative(process.cwd(), outDir)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
