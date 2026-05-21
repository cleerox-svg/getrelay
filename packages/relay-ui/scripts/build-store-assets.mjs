#!/usr/bin/env node
// Renders the Google Play store-listing assets (feature graphic +
// phone screenshots, plus a 7-inch and 10-inch tablet variant of
// each phone screenshot) from the canonical SVGs in store-listing/.
//
// Run: pnpm store-assets

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sharp from 'sharp';

const here = path.dirname(fileURLToPath(import.meta.url));
const dir = path.join(here, '..', 'store-listing');

async function render(src, out, w, h, density = 96) {
  const svg = await readFile(path.join(dir, src));
  const buf = await sharp(svg, { density })
    .resize(w, h, { fit: 'fill' })
    .png({ compressionLevel: 9 })
    .toBuffer();
  await writeFile(path.join(dir, out), buf);
  console.log(`wrote ${out} (${w}x${h}, ${(buf.length / 1024).toFixed(1)} KB)`);
}

// Feature graphic — exact 1024x500 Play Console spec.
await render('feature-graphic.svg', 'feature-graphic.png', 1024, 500, 192);

// Phone screenshots — 1080x1920 (9:16, well over the 1080px-per-side
// promotability threshold).
const screenshots = [
  'screenshot-1-chats.svg',
  'screenshot-2-chat.svg',
  'screenshot-3-classic.svg',
  'screenshot-4-updates.svg',
];

for (const src of screenshots) {
  const stem = src.replace(/\.svg$/, '');
  await mkdir(path.join(dir, 'phone'), { recursive: true });
  await mkdir(path.join(dir, 'tablet-7'), { recursive: true });
  await mkdir(path.join(dir, 'tablet-10'), { recursive: true });

  // Phone: 1080 x 1920
  await render(src, path.join('phone', `${stem}.png`), 1080, 1920, 120);
  // 7-inch tablet: 1200 x 1920 (slightly wider; Play accepts as
  // long as both sides are between 320 and 3840).
  await render(src, path.join('tablet-7', `${stem}.png`), 1200, 1920, 120);
  // 10-inch tablet: 1600 x 2560 (larger; meets the >=1080px-per-side
  // minimum for 10-inch).
  await render(src, path.join('tablet-10', `${stem}.png`), 1600, 2560, 160);
}
