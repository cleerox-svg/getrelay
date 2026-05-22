#!/usr/bin/env node
// Regenerates all bitmap icons from the canonical SVGs.
// Run: pnpm icons
//
// Web / PWA (public/) — what the browser and PWA installer use:
//   - public/icon.svg          -> icon-192.png, icon-512.png, apple-touch-icon.png
//   - public/favicon.svg       -> favicon-32.png
//   - public/icon-maskable.svg (untouched — already a square SVG; PWA picks it up natively)
//
// Native shell (assets/) — feeds `@capacitor/assets generate`, which writes
// platform-specific icons into android/app/src/main/res/. Without these
// the Capacitor android project ships the default template icon, not the
// Relay mark.

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');
const assetsDir = path.join(here, '..', 'assets');

async function render(srcDir, srcName, outDir, outName, size) {
  const svg = await readFile(path.join(srcDir, srcName));
  // Render at 2x the target for crisp downscaling. limitInputPixels:false
  // is required because the 2732px splash exceeds sharp's default 16.7M
  // input-pixel cap when supersampled.
  const density = Math.max(96, size * 2);
  const buf = await sharp(svg, { density, limitInputPixels: false })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(outDir, outName), buf);
  const rel = path.relative(path.join(here, '..'), path.join(outDir, outName));
  console.log(`wrote ${rel} (${size}x${size}, ${(buf.length / 1024).toFixed(1)} KB)`);
}

await mkdir(assetsDir, { recursive: true });

await Promise.all([
  // Web / PWA
  render(publicDir, 'favicon.svg', publicDir, 'favicon-32.png', 32),
  render(publicDir, 'icon.svg', publicDir, 'apple-touch-icon.png', 180),
  render(publicDir, 'icon.svg', publicDir, 'icon-192.png', 192),
  render(publicDir, 'icon.svg', publicDir, 'icon-512.png', 512),

  // Native shell — sources for @capacitor/assets. File names follow the
  // tool's Custom Mode convention: icon-only / icon-foreground / icon-
  // background / splash[-dark].
  render(assetsDir, 'icon-only.svg', assetsDir, 'icon-only.png', 1024),
  render(assetsDir, 'icon-foreground.svg', assetsDir, 'icon-foreground.png', 1024),
  render(assetsDir, 'icon-background.svg', assetsDir, 'icon-background.png', 1024),
  render(assetsDir, 'splash.svg', assetsDir, 'splash.png', 2732),
  render(assetsDir, 'splash-dark.svg', assetsDir, 'splash-dark.png', 2732),
]);
