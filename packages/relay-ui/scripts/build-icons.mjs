#!/usr/bin/env node
// Regenerates all bitmap icons from the canonical SVGs in public/.
// Run: pnpm icons
//
// Sources:
//   - public/icon.svg          -> icon-192.png, icon-512.png, apple-touch-icon.png
//   - public/favicon.svg       -> favicon-32.png
//   - public/icon-maskable.svg (untouched — already a square SVG; PWA picks it up natively)

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(here, '..', 'public');

async function render(srcName, outName, size) {
  const svg = await readFile(path.join(publicDir, srcName));
  // density=384 keeps lines crisp at 192px; bumps proportionally for bigger.
  const buf = await sharp(svg, { density: Math.max(96, size * 2) })
    .resize(size, size, { fit: 'contain' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(publicDir, outName), buf);
  console.log(`wrote ${outName} (${size}x${size}, ${(buf.length / 1024).toFixed(1)} KB)`);
}

await Promise.all([
  render('favicon.svg', 'favicon-32.png', 32),
  render('icon.svg', 'apple-touch-icon.png', 180),
  render('icon.svg', 'icon-192.png', 192),
  render('icon.svg', 'icon-512.png', 512),
]);
