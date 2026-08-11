// Envelope-encryption crypto tests for lib/message-crypto.ts. Runs inside
// workerd via @cloudflare/vitest-pool-workers, so crypto.subtle is the real
// WebCrypto and env.DB is a real (isolated-storage) D1 — writes made in a
// test roll back afterwards, while the beforeAll DDL persists for the file.
//
// KEKs are minted in-test from crypto.getRandomValues (never a checked-in
// secret): MESSAGE_KEK is a JSON version map {"<n>":"<base64 32-byte key>"}.
import { beforeAll, describe, expect, it } from 'vitest';
import { env } from 'cloudflare:test';
import type { Env } from '../src/env';
import {
  KekConfigError,
  currentKekVersion,
  loadKek,
  wrapDek,
  unwrapDek,
  getChatDek,
  encryptBody,
  decryptBody,
  decryptStoredBody,
} from '../src/lib/message-crypto';

const testEnv = env as unknown as Env;

// ---------- helpers ----------
function b64(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

function b64ToBytes(s: string): Uint8Array {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** A fresh AES-256-GCM DEK as a CryptoKey (importKey typed as CryptoKey,
 *  unlike generateKey which widens to CryptoKey | CryptoKeyPair). */
function makeDek(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    crypto.getRandomValues(new Uint8Array(32)),
    { name: 'AES-GCM' },
    false,
    ['encrypt', 'decrypt'],
  );
}

/** A JSON KEK version map with a fresh random 32-byte key per version. */
function makeKekJson(versions: number[] = [1]): string {
  const map: Record<string, string> = {};
  for (const v of versions) {
    map[String(v)] = b64(crypto.getRandomValues(new Uint8Array(32)));
  }
  return JSON.stringify(map);
}

/** An Env carrying only MESSAGE_KEK (enough for the key-derivation paths). */
function kekEnv(json?: string): Env {
  return { MESSAGE_KEK: json } as unknown as Env;
}

// A single stable KEK for the round-trip / DB tests in this file.
const KEK_JSON = makeKekJson([1]);

beforeAll(async () => {
  // The pool does not auto-apply schema.sql; create just chat_keys.
  await testEnv.DB.prepare(
    `CREATE TABLE IF NOT EXISTS chat_keys (
       chat_id     TEXT PRIMARY KEY,
       wrapped_dek TEXT NOT NULL,
       dek_iv      TEXT NOT NULL,
       kek_version INTEGER NOT NULL,
       created_at  INTEGER NOT NULL
     )`,
  ).run();
});

describe('encryptBody / decryptBody', () => {
  it('round-trips plaintext and produces ciphertext that differs from it', async () => {
    const dek = await makeDek();
    const plaintext = 'hello, envelope 🌫️ — secret body';

    const { cipher, iv } = await encryptBody(dek, plaintext);
    expect(cipher).not.toBe(plaintext);
    // base64 IV of a 12-byte value.
    expect(b64ToBytes(iv).length).toBe(12);

    const back = await decryptBody(dek, cipher, iv);
    expect(back).toBe(plaintext);
  });

  it('uses a fresh IV so two encrypts of the same text diverge', async () => {
    const dek = await makeDek();
    const plaintext = 'same text, twice';

    const a = await encryptBody(dek, plaintext);
    const b = await encryptBody(dek, plaintext);
    expect(a.iv).not.toBe(b.iv);
    expect(a.cipher).not.toBe(b.cipher);
    // Both still decrypt to the original.
    expect(await decryptBody(dek, a.cipher, a.iv)).toBe(plaintext);
    expect(await decryptBody(dek, b.cipher, b.iv)).toBe(plaintext);
  });

  it('rejects a tampered ciphertext (AES-GCM tag failure)', async () => {
    const dek = await makeDek();
    const { cipher, iv } = await encryptBody(dek, 'do not tamper');

    // Flip one bit of the first ciphertext byte and re-encode.
    const bytes = b64ToBytes(cipher);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    const corrupted = b64(bytes);
    expect(corrupted).not.toBe(cipher);

    await expect(decryptBody(dek, corrupted, iv)).rejects.toThrow();
  });
});

describe('wrapDek / unwrapDek', () => {
  it('round-trips a DEK: the unwrapped key decrypts what the original encrypted', async () => {
    const kek = await loadKek(kekEnv(KEK_JSON));

    // A raw DEK we control, imported once to encrypt a sample body...
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const originalDek = await crypto.subtle.importKey(
      'raw',
      dekRaw,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    const sample = 'derive a body through both keys';
    const { cipher, iv } = await encryptBody(originalDek, sample);

    // ...wrap it, unwrap it, and confirm the unwrapped key is the same key.
    const { wrapped, iv: wrapIv } = await wrapDek(kek, dekRaw.buffer);
    const unwrapped = await unwrapDek(kek, wrapped, wrapIv);

    expect(await decryptBody(unwrapped, cipher, iv)).toBe(sample);

    // And a body encrypted under the unwrapped key decrypts under the
    // original — proving both handles wrap the identical key material.
    const round = await encryptBody(unwrapped, sample);
    expect(await decryptBody(originalDek, round.cipher, round.iv)).toBe(sample);
  });

  it('unwrap fails when the wrapped DEK is tampered', async () => {
    const kek = await loadKek(kekEnv(KEK_JSON));
    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const { wrapped, iv } = await wrapDek(kek, dekRaw.buffer);

    const bytes = b64ToBytes(wrapped);
    bytes[0] = (bytes[0] ?? 0) ^ 0x01;
    await expect(unwrapDek(kek, b64(bytes), iv)).rejects.toThrow();
  });
});

describe('decryptStoredBody legacy / null passthrough', () => {
  it('returns body unchanged when body_iv is null (legacy plaintext row)', async () => {
    const out = await decryptStoredBody(
      kekEnv(KEK_JSON),
      testEnv.DB,
      'chat-legacy',
      'plaintext legacy body',
      null,
    );
    expect(out).toBe('plaintext legacy body');
  });

  it('returns null when body is null', async () => {
    const out = await decryptStoredBody(
      kekEnv(KEK_JSON),
      testEnv.DB,
      'chat-legacy',
      null,
      null,
    );
    expect(out).toBeNull();

    // Even with a present IV, a null body stays null (nothing to decrypt).
    const out2 = await decryptStoredBody(
      kekEnv(KEK_JSON),
      testEnv.DB,
      'chat-legacy',
      null,
      b64(crypto.getRandomValues(new Uint8Array(12))),
    );
    expect(out2).toBeNull();
  });
});

describe('KekConfigError boundaries', () => {
  it('throws when MESSAGE_KEK is unset or empty', async () => {
    await expect(loadKek(kekEnv(undefined))).rejects.toBeInstanceOf(KekConfigError);
    expect(() => currentKekVersion(kekEnv(undefined))).toThrow(KekConfigError);
    await expect(loadKek(kekEnv(''))).rejects.toBeInstanceOf(KekConfigError);
    expect(() => currentKekVersion(kekEnv(''))).toThrow(KekConfigError);
  });

  it('throws on invalid JSON', async () => {
    await expect(loadKek(kekEnv('not json {'))).rejects.toBeInstanceOf(KekConfigError);
    expect(() => currentKekVersion(kekEnv('not json {'))).toThrow(KekConfigError);
  });

  it('throws when MESSAGE_KEK is not a JSON object map', async () => {
    await expect(loadKek(kekEnv('[]'))).rejects.toBeInstanceOf(KekConfigError);
    await expect(loadKek(kekEnv('42'))).rejects.toBeInstanceOf(KekConfigError);
  });

  it('throws when the map has no integer versions', () => {
    expect(() => currentKekVersion(kekEnv('{"abc":"x"}'))).toThrow(KekConfigError);
  });

  it('throws when the requested version is absent from the map', async () => {
    const oneVersion = makeKekJson([1]);
    await expect(loadKek(kekEnv(oneVersion), 2)).rejects.toBeInstanceOf(KekConfigError);
  });

  it('throws when a version key is not a base64 32-byte key', async () => {
    // Valid JSON map, but the key is only 16 bytes.
    const short = JSON.stringify({ '1': b64(crypto.getRandomValues(new Uint8Array(16))) });
    await expect(loadKek(kekEnv(short))).rejects.toBeInstanceOf(KekConfigError);
  });

  it('currentKekVersion picks the highest integer version', () => {
    expect(currentKekVersion(kekEnv(makeKekJson([1, 2, 5])))).toBe(5);
  });
});

describe('getChatDek (D1-backed)', () => {
  it('mints + persists a chat_keys row on first use, reuses it after', async () => {
    const chatId = `chat-mint-${crypto.randomUUID()}`;
    const cryptoEnv = kekEnv(KEK_JSON);

    // Nothing stored yet.
    const before = await testEnv.DB.prepare(
      `SELECT chat_id FROM chat_keys WHERE chat_id = ?`,
    )
      .bind(chatId)
      .first();
    expect(before).toBeNull();

    // First call mints + INSERTs.
    const dek1 = await getChatDek(cryptoEnv, testEnv.DB, chatId);
    const row = await testEnv.DB.prepare(
      `SELECT wrapped_dek, dek_iv, kek_version FROM chat_keys WHERE chat_id = ?`,
    )
      .bind(chatId)
      .first<{ wrapped_dek: string; dek_iv: string; kek_version: number }>();
    expect(row).not.toBeNull();
    expect(row?.kek_version).toBe(1);

    // A body encrypted under the first key...
    const { cipher, iv } = await encryptBody(dek1, 'mint once, reuse');

    // ...decrypts under the key returned by a second call (same DEK).
    const dek2 = await getChatDek(cryptoEnv, testEnv.DB, chatId);
    expect(await decryptBody(dek2, cipher, iv)).toBe('mint once, reuse');
  });

  it('unwraps an already-stored chat_keys row into a working key', async () => {
    // Seed a row directly by wrapping a DEK we control, so this exercises the
    // existing-row read path rather than the mint path or the in-memory cache.
    const chatId = `chat-stored-${crypto.randomUUID()}`;
    const cryptoEnv = kekEnv(KEK_JSON);
    const kek = await loadKek(cryptoEnv);

    const dekRaw = crypto.getRandomValues(new Uint8Array(32));
    const seedDek = await crypto.subtle.importKey(
      'raw',
      dekRaw,
      { name: 'AES-GCM' },
      false,
      ['encrypt', 'decrypt'],
    );
    const { cipher, iv } = await encryptBody(seedDek, 'stored row body');

    const { wrapped, iv: wrapIv } = await wrapDek(kek, dekRaw.buffer);
    await testEnv.DB.prepare(
      `INSERT INTO chat_keys (chat_id, wrapped_dek, dek_iv, kek_version, created_at)
       VALUES (?, ?, ?, 1, ?)`,
    )
      .bind(chatId, wrapped, wrapIv, Date.now())
      .run();

    const dek = await getChatDek(cryptoEnv, testEnv.DB, chatId);
    expect(await decryptBody(dek, cipher, iv)).toBe('stored row body');
  });

  it('decryptStoredBody encrypts under the chat DEK and reads it back', async () => {
    const chatId = `chat-store-read-${crypto.randomUUID()}`;
    const cryptoEnv = kekEnv(KEK_JSON);

    const dek = await getChatDek(cryptoEnv, testEnv.DB, chatId);
    const { cipher, iv } = await encryptBody(dek, 'end-to-end stored body');

    const out = await decryptStoredBody(cryptoEnv, testEnv.DB, chatId, cipher, iv);
    expect(out).toBe('end-to-end stored body');
  });
});
