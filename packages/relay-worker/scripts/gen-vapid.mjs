#!/usr/bin/env node
// One-time VAPID keypair generator for Relay's Web Push setup.
//
// Run:  node packages/relay-worker/scripts/gen-vapid.mjs
//
// Prints three values you then store as GitHub Action secrets (and
// Wrangler secrets via the deploy workflow) — never commit them:
//   VAPID_PUBLIC_KEY   — base64url, raw uncompressed P-256 point (65 bytes)
//   VAPID_PRIVATE_KEY  — base64url, raw P-256 scalar (32 bytes)
//   VAPID_SUBJECT      — mailto:<address you control>
//
// The public key also needs to ship to the UI via the worker's
// GET /push/public-key endpoint — it doesn't need to be hard-coded.

import { webcrypto } from 'node:crypto';

const { subtle } = webcrypto;

function b64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

const kp = await subtle.generateKey(
  { name: 'ECDSA', namedCurve: 'P-256' },
  true,
  ['sign', 'verify'],
);

const jwk = await subtle.exportKey('jwk', kp.privateKey);
const rawPub = await subtle.exportKey('raw', kp.publicKey);

const publicKey = b64url(new Uint8Array(rawPub));
const privateKey = jwk.d;

console.log('VAPID_PUBLIC_KEY  =', publicKey);
console.log('VAPID_PRIVATE_KEY =', privateKey);
console.log('VAPID_SUBJECT     =  mailto:you@example.com  (change this)');
console.log();
console.log('Next steps:');
console.log('  1. GitHub repo → Settings → Secrets and variables → Actions → New secret');
console.log('     Add VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY, VAPID_SUBJECT with those values.');
console.log('  2. Push to main (or re-run deploy-worker.yml) — the workflow pushes them as');
console.log('     Wrangler secrets and the worker comes up with /push/public-key live.');
