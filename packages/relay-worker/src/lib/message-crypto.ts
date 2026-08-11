// Envelope encryption at rest for chat message bodies.
//
// Key hierarchy (see the plan / RELAY_BUILD_SPEC):
//   - KEK (root, per-version) lives in `env.MESSAGE_KEK` as a JSON version map
//     `{"1":"<base64 32-byte key>"}`. The highest version is "current".
//   - DEK (per chat, 256-bit AES-GCM) is generated lazily on first use, stored
//     wrapped under the current KEK in the `chat_keys` table, and cached here.
//   - Each message body is AES-256-GCM encrypted under its chat's DEK with a
//     fresh random 12-byte IV; the GCM tag provides integrity.
//
// This is at-rest only: the WS/live path and push previews stay plaintext.
// Legacy rows have `body_iv IS NULL`, meaning `body` is plaintext — those pass
// through unchanged.
//
// Crypto is all `crypto.subtle` (no Node polyfills), mirroring lib/web-push.ts.

import type { Env } from '../env';

// ---------- base64 (standard, not base64url) ----------
function b64Encode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64Decode(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const TE = new TextEncoder();
const TD = new TextDecoder();

const IV_BYTES = 12;
const DEK_BYTES = 32;

// ---------- KEK (root key) ----------
/**
 * Systemic KEK misconfiguration (secret unset/empty/malformed, or a referenced
 * version absent from the map). This is a setup/config fault, not a per-row
 * data fault: it must propagate loudly (let the route 500) rather than be
 * swallowed to a null body, which would make all encrypted history look empty.
 */
export class KekConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KekConfigError';
  }
}

function parseKekMap(env: Env): Record<string, string> {
  if (!env.MESSAGE_KEK) {
    throw new KekConfigError('MESSAGE_KEK is not set');
  }
  let map: unknown;
  try {
    map = JSON.parse(env.MESSAGE_KEK);
  } catch {
    throw new KekConfigError('MESSAGE_KEK is not valid JSON');
  }
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new KekConfigError(
      'MESSAGE_KEK must be a JSON object of {version: base64Key}',
    );
  }
  return map as Record<string, string>;
}

/** Highest numeric version in the KEK map — the "current" key for new wraps. */
export function currentKekVersion(env: Env): number {
  const versions = Object.keys(parseKekMap(env))
    .map((k) => Number(k))
    .filter((n) => Number.isInteger(n));
  if (versions.length === 0) throw new KekConfigError('MESSAGE_KEK has no versions');
  return Math.max(...versions);
}

/**
 * Import the KEK for `version` (default: current) as an AES-GCM key. Used to
 * wrap/unwrap per-chat DEKs by AES-GCM encrypting/decrypting their raw bytes.
 */
export async function loadKek(env: Env, version?: number): Promise<CryptoKey> {
  const map = parseKekMap(env);
  const v = version ?? currentKekVersion(env);
  const b64 = map[String(v)];
  if (!b64) throw new KekConfigError(`MESSAGE_KEK missing version ${v}`);
  const raw = b64Decode(b64);
  if (raw.length !== DEK_BYTES) {
    throw new KekConfigError(
      `MESSAGE_KEK version ${v} must be a base64 32-byte key`,
    );
  }
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------- DEK wrap / unwrap ----------
/** AES-GCM-encrypt the 32 raw DEK bytes under the KEK; returns base64. */
export async function wrapDek(
  kek: CryptoKey,
  dekRaw: ArrayBuffer,
): Promise<{ wrapped: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, dekRaw);
  return { wrapped: b64Encode(new Uint8Array(ct)), iv: b64Encode(iv) };
}

/** AES-GCM-decrypt a wrapped DEK and import it as an AES-GCM CryptoKey. */
export async function unwrapDek(
  kek: CryptoKey,
  wrapped: string,
  iv: string,
): Promise<CryptoKey> {
  const raw = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(iv) },
    kek,
    b64Decode(wrapped),
  );
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, [
    'encrypt',
    'decrypt',
  ]);
}

// ---------- per-chat DEK cache + resolution ----------
// Unwrapping is a local AES-GCM op (no network), but repeats add up across a
// history page, so keep resolved DEKs in a module-level cache keyed by chatId.
const dekCache = new Map<string, CryptoKey>();

interface ChatKeyRow {
  wrapped_dek: string;
  dek_iv: string;
  kek_version: number;
}

/**
 * Resolve the DEK for `chatId`: unwrap the stored `chat_keys` row, or mint one
 * on first use (generate, wrap under the current KEK, INSERT OR IGNORE, then
 * re-SELECT so a colliding concurrent insert still yields the winning row).
 */
export async function getChatDek(
  env: Env,
  db: D1Database,
  chatId: string,
): Promise<CryptoKey> {
  const cached = dekCache.get(chatId);
  if (cached) return cached;

  const existing = await db
    .prepare(
      `SELECT wrapped_dek, dek_iv, kek_version FROM chat_keys WHERE chat_id = ?`,
    )
    .bind(chatId)
    .first<ChatKeyRow>();
  if (existing) {
    const kek = await loadKek(env, existing.kek_version);
    const dek = await unwrapDek(kek, existing.wrapped_dek, existing.dek_iv);
    dekCache.set(chatId, dek);
    return dek;
  }

  // Mint a fresh DEK and try to persist it.
  const dekRaw = crypto.getRandomValues(new Uint8Array(DEK_BYTES));
  const version = currentKekVersion(env);
  const kek = await loadKek(env, version);
  const { wrapped, iv } = await wrapDek(kek, dekRaw.buffer);
  await db
    .prepare(
      `INSERT OR IGNORE INTO chat_keys (chat_id, wrapped_dek, dek_iv, kek_version, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    )
    .bind(chatId, wrapped, iv, version, Date.now())
    .run();

  // Re-read the winning row: a concurrent writer may have inserted first, in
  // which case OUR insert was ignored and their DEK is authoritative.
  const stored = await db
    .prepare(
      `SELECT wrapped_dek, dek_iv, kek_version FROM chat_keys WHERE chat_id = ?`,
    )
    .bind(chatId)
    .first<ChatKeyRow>();
  if (!stored) {
    // Should be impossible (we just inserted), but never hand back a DEK that
    // isn't the persisted one.
    throw new Error(`chat_keys row missing after insert for ${chatId}`);
  }
  const storedKek = await loadKek(env, stored.kek_version);
  const dek = await unwrapDek(storedKek, stored.wrapped_dek, stored.dek_iv);
  dekCache.set(chatId, dek);
  return dek;
}

// ---------- body encrypt / decrypt ----------
/** AES-256-GCM encrypt a plaintext body; returns base64 cipher + base64 IV. */
export async function encryptBody(
  dek: CryptoKey,
  plaintext: string,
): Promise<{ cipher: string; iv: string }> {
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    dek,
    TE.encode(plaintext),
  );
  return { cipher: b64Encode(new Uint8Array(ct)), iv: b64Encode(iv) };
}

/** Inverse of encryptBody. Throws on a bad tag / tampered ciphertext. */
export async function decryptBody(
  dek: CryptoKey,
  cipher: string,
  iv: string,
): Promise<string> {
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64Decode(iv) },
    dek,
    b64Decode(cipher),
  );
  return TD.decode(pt);
}

/**
 * Read-path convenience: turn a stored (body, body_iv) pair back into
 * plaintext. Legacy rows (`bodyIv` null) and rows with no body pass through
 * unchanged.
 *
 * Two failure classes are handled differently:
 *   - A per-row cryptographic failure (bad GCM tag / tampered ciphertext on a
 *     single message) is logged and yields null rather than throwing, so one
 *     bad row can't break a whole history/chat-list load.
 *   - A systemic KEK misconfiguration (`KekConfigError`) is rethrown so the
 *     route fails loudly (500) instead of rendering all encrypted bodies as
 *     empty — which would be indistinguishable from mass data loss.
 */
export async function decryptStoredBody(
  env: Env,
  db: D1Database,
  chatId: string,
  body: string | null,
  bodyIv: string | null,
): Promise<string | null> {
  if (bodyIv === null || body === null) return body;
  try {
    const dek = await getChatDek(env, db, chatId);
    return await decryptBody(dek, body, bodyIv);
  } catch (err) {
    // Config/setup faults must propagate — never swallow them to null.
    if (err instanceof KekConfigError) throw err;
    console.error(
      `message-crypto: body decrypt failed for chat ${chatId}:`,
      err,
    );
    return null;
  }
}
