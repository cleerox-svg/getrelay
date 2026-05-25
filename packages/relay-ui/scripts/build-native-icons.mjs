#!/usr/bin/env node
// Generates the source images @capacitor/assets needs to produce native
// launcher icons + splash screens, then leaves them in ./assets for the
// CI step to consume:
//
//   assets/icon-only.png        1024² — legacy square / round launcher icon
//   assets/icon-foreground.png  1024² — adaptive-icon foreground (R mark)
//   assets/icon-background.png  1024² — adaptive-icon background (brand black)
//   assets/splash.png           2732² — launch splash (logo on brand black)
//   assets/splash-dark.png      2732² — dark-mode splash (identical here)
//
// Why this exists: the Android project is scaffolded fresh in CI via
// `cap add android`, which ships Capacitor's DEFAULT icon. The web
// manifest icons never reach the native launcher. Running
// `@capacitor/assets generate` against these sources overwrites the
// placeholder with the Relay mark.
//
// Sources are the canonical brand SVGs in public/ so the icon stays in
// lockstep with the favicon / PWA icons.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const publicDir = path.join(root, 'public');
const assetsDir = path.join(root, 'assets');

const SIZE = 1024;
const SPLASH = 2732;
const BRAND_BLACK = '#0A0A0A';

// The R mark, lifted from icon-maskable.svg (already sized to a
// conservative safe zone) on a transparent canvas — this is the
// adaptive-icon foreground layer.
const FOREGROUND_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <path fill="#C83C3C" fill-rule="evenodd" d="
    M 152 132 H 216 V 394 H 152 Z
    M 216 132 A 80 80 0 0 1 216 292 Z
    M 216 287 L 290 287 L 398 394 L 324 394 Z
    M 216 182 A 30 30 0 0 1 216 242 Z
  "/>
</svg>`;

async function renderSvg(svg, outName) {
  const buf = await sharp(Buffer.from(svg), { density: SIZE * 2 })
    .resize(SIZE, SIZE, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(assetsDir, outName), buf);
  console.log(`wrote assets/${outName}`);
}

async function renderSvgFile(srcName, outName) {
  const svg = await readFile(path.join(publicDir, srcName));
  await renderSvg(svg.toString(), outName);
}

async function solid(color, outName) {
  const buf = await sharp({
    create: { width: SIZE, height: SIZE, channels: 4, background: color },
  })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(assetsDir, outName), buf);
  console.log(`wrote assets/${outName}`);
}

// Splash: the circular brand mark centered on a brand-black field. The
// logo occupies ~35% of the canvas so it reads on a phone without
// crowding the edges Capacitor crops differently per device.
async function splash(outName) {
  const logoSize = Math.round(SPLASH * 0.35);
  const logo = await sharp(path.join(assetsDir, 'icon-only.png'))
    .resize(logoSize, logoSize, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .toBuffer();
  const buf = await sharp({
    create: { width: SPLASH, height: SPLASH, channels: 4, background: BRAND_BLACK },
  })
    .composite([{ input: logo, gravity: 'center' }])
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(assetsDir, outName), buf);
  console.log(`wrote assets/${outName}`);
}

await mkdir(assetsDir, { recursive: true });
// icon-only must exist before splash composites it, so run that first.
await Promise.all([
  renderSvgFile('icon.svg', 'icon-only.png'),
  renderSvg(FOREGROUND_SVG, 'icon-foreground.png'),
  solid(BRAND_BLACK, 'icon-background.png'),
]);
await Promise.all([splash('splash.png'), splash('splash-dark.png')]);
