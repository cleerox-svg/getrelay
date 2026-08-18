// The BOARD PIXEL harness — a contact sheet of every videoboard state, at the
// shipping texture's own resolution, with no WebGL anywhere in it.
//
// ⚠ WHY IT EXISTS. The board slice found FIVE defects with a throwaway version
// of this while its 52 unit tests were green (a truncated caption, a rule bar
// struck through text, an exclamation dot on a zero, an unreadable ribbon
// celebration, and idle panels the same shade as the frame). It deleted the page
// as out of scope and recommended committing it. This is that, at ~40 lines,
// and it is the FIFTH time on this game that rendering-and-looking has beaten
// the suite.
//
// ⚠ IT IS DELIBERATELY NOT A GATE. `shoot-baseball.mjs` asserts numbers and
// exits non-zero; this one writes a picture and exits 0 unless the page itself
// threw. The defects it exists for are ones nobody knew to assert — a rule bar
// through a word is not a number — so an assertion here would be a guess and a
// green tick would be cover. The page errors ARE fatal, because a board that
// throws is not a board a human can review.
//
// Usage:  node scripts/shoot-board.mjs [scale]     (default scale 1)

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgDir, '.baseball-shots');
const scale = process.argv[2] ?? '1';
// The sheet is twelve 1024 × 512 atlases stacked, so the page is tall and the
// shot is fullPage. 1100 wide leaves a margin at scale 1.
const VIEWPORT = { width: 1100, height: 1200 };

async function loadPlaywright() {
  const gRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  for (const entry of ['playwright/index.mjs', 'playwright-core/index.mjs']) {
    try {
      return await import(path.join(gRoot, entry));
    } catch {
      /* try next */
    }
  }
  throw new Error(`Playwright not found in the global npm root (${gRoot}).`);
}

mkdirSync(outDir, { recursive: true });
const { createServer } = await import('vite');
const { chromium } = await loadPlaywright();
const server = await createServer({ root: pkgDir, logLevel: 'warn', server: { port: 0, host: '127.0.0.1' } });
await server.listen();

const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
const errors = [];
page.on('pageerror', (e) => errors.push(String(e)));
page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)));

const file = path.join(outDir, 'board-pixels.png');
try {
  await page.goto(`${base}/boardpixels.html?scale=${scale}`, { waitUntil: 'load', timeout: 25000 });
  await page.waitForFunction('window.__boardPixelsReady === true', null, { timeout: 20000 });
  await page.screenshot({ path: file, fullPage: true });
  console.log(`· board-pixels → ${path.relative(pkgDir, file)} (scale ${scale})`);
} finally {
  await browser.close();
  await server.close();
}

if (errors.length) {
  console.error(`✗ page errors (${errors.length}):`);
  for (const e of errors.slice(0, 6)) console.error(`    ${e}`);
  process.exit(1);
}
console.log('✓ board-pixels ok — now LOOK AT IT. That is the entire point of this script.');
