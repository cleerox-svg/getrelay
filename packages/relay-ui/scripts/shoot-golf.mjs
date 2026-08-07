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

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgDir, '.golf-shots');

// Scene matrix: id → preview query. Portrait viewport ~ a phone screen.
const SCENES = {
  course: { query: 'scene=course', label: 'course-hole1' },
  green: { query: 'scene=course&at=green', label: 'course-green' },
  range: { query: 'scene=range&layout=fairway', label: 'range-fairway' },
};
const VIEWPORT = { width: 900, height: 1600 };
const READY_TIMEOUT_MS = 15000;

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
      const { query, label } = SCENES[id];
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(String(e)));
      const url = `${base}/golfpreview.html?${query}`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 20000 });
        await page.waitForFunction('window.__golfReady === true', { timeout: READY_TIMEOUT_MS });
        // Let one more frame land after the ready beacon.
        await page.waitForTimeout(150);
        const file = path.join(outDir, `${label}.png`);
        await page.screenshot({ path: file });
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
