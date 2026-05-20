// Minimal Web Push sender for Cloudflare Workers.
//
// Implements:
//   - VAPID JWT (RFC 8292) — ES256
//   - aes128gcm content-encoding (RFC 8188) with ECDH (RFC 8291)
//
// Uses only crypto.subtle so it runs in Workers without Node polyfills.

export interface PushSubscription {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export interface VapidKeys {
  publicKey: string;   // base64url, raw uncompressed P-256 point (65 bytes)
  privateKey: string;  // base64url, raw P-256 scalar (32 bytes)
  subject: string;     // mailto:...
}

// ---------- base64url ----------
function b64urlEncode(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const norm = s.replace(/-/g, '+').replace(/_/g, '/') + pad;
  const bin = atob(norm);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const p of parts) len += p.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const TE = new TextEncoder();

// ---------- VAPID JWT ----------
async function importVapidJwk(
  publicKey: string,
  privateKey: string,
  use: 'sign' | 'verify',
): Promise<CryptoKey> {
  const pub = b64urlDecode(publicKey);
  if (pub.length !== 65 || pub[0] !== 0x04) {
    throw new Error('VAPID public key must be 65-byte uncompressed P-256');
  }
  const x = pub.slice(1, 33);
  const y = pub.slice(33, 65);
  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(x),
    y: b64urlEncode(y),
    d: b64urlEncode(b64urlDecode(privateKey)),
    ext: true,
  };
  return crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    [use],
  );
}

async function signVapid(
  audience: string,
  keys: VapidKeys,
  ttlSeconds = 12 * 3600,
): Promise<string> {
  const header = b64urlEncode(TE.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const now = Math.floor(Date.now() / 1000);
  const payload = b64urlEncode(
    TE.encode(
      JSON.stringify({
        aud: audience,
        exp: now + ttlSeconds,
        sub: keys.subject,
      }),
    ),
  );
  const signingInput = `${header}.${payload}`;
  const key = await importVapidJwk(keys.publicKey, keys.privateKey, 'sign');
  const sig = new Uint8Array(
    await crypto.subtle.sign(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      TE.encode(signingInput),
    ),
  );
  return `${signingInput}.${b64urlEncode(sig)}`;
}

// ---------- aes128gcm content encryption (RFC 8188 + 8291) ----------

async function hkdf(
  ikm: Uint8Array,
  salt: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info },
    key,
    length * 8,
  );
  return new Uint8Array(bits);
}

function toArrayBuffer(u8: Uint8Array): ArrayBuffer {
  // Copy into a fresh ArrayBuffer so the result isn't SharedArrayBuffer-tainted.
  const out = new ArrayBuffer(u8.byteLength);
  new Uint8Array(out).set(u8);
  return out;
}

async function deriveEcdhBits(
  privateKey: CryptoKey,
  remotePublicRaw: Uint8Array,
): Promise<Uint8Array> {
  const remote = await crypto.subtle.importKey(
    'raw',
    toArrayBuffer(remotePublicRaw),
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  // The workers-types declaration calls this `$public`, but the workerd
  // runtime expects the W3C-standard `public` field. Use the runtime name
  // and cast through `any` to silence the stale type.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const ecdhAlg: any = { name: 'ECDH', public: remote };
  const bits = await crypto.subtle.deriveBits(ecdhAlg, privateKey, 256);
  return new Uint8Array(bits);
}

async function encryptPayload(
  payload: Uint8Array,
  ua_p256dh: Uint8Array, // 65 bytes, recipient's public key
  ua_auth: Uint8Array,   // 16 bytes, recipient's auth secret
): Promise<{ body: Uint8Array; serverPublicRaw: Uint8Array }> {
  // 1. Generate ephemeral ECDH keypair on the server.
  const serverKeyPair = (await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' },
    true,
    ['deriveBits'],
  )) as CryptoKeyPair;
  const serverPublicRaw = new Uint8Array(
    (await crypto.subtle.exportKey('raw', serverKeyPair.publicKey)) as ArrayBuffer,
  );

  // 2. ECDH(serverPrivate, ua_p256dh).
  const ecdh = await deriveEcdhBits(serverKeyPair.privateKey, ua_p256dh);

  // 3. Salt (16 random bytes).
  const salt = crypto.getRandomValues(new Uint8Array(16));

  // 4. PRK_key = HKDF-Extract(auth_secret, ecdh_shared)
  //    key_info = "WebPush: info\0" || ua_public || as_public
  //    IKM = HKDF-Expand(PRK_key, key_info, 32)
  const keyInfo = concat(
    TE.encode('WebPush: info\0'),
    ua_p256dh,
    serverPublicRaw,
  );
  const ikm = await hkdf(ecdh, ua_auth, keyInfo, 32);

  // 5. CEK_info = "Content-Encoding: aes128gcm\0"
  //    CEK = HKDF-Expand(PRK_ikm, CEK_info, 16) with salt as ikm-extract salt
  const cek = await hkdf(ikm, salt, TE.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, salt, TE.encode('Content-Encoding: nonce\0'), 12);

  // 6. Add padding delimiter (0x02) then encrypt with AES-128-GCM.
  const plaintext = concat(payload, new Uint8Array([0x02]));
  const aesKey = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aesKey, plaintext),
  );

  // 7. Header: salt(16) | rs(4, BE) | idlen(1) | keyid(65 = server pubkey)
  const rs = new Uint8Array(4);
  new DataView(rs.buffer).setUint32(0, 4096, false);
  const header = concat(
    salt,
    rs,
    new Uint8Array([serverPublicRaw.length]),
    serverPublicRaw,
  );

  return { body: concat(header, ciphertext), serverPublicRaw };
}

// ---------- send ----------
export interface SendResult {
  status: number;
  ok: boolean;
  endpoint: string;
  body?: string;
}

export async function sendPush(
  subscription: PushSubscription,
  payload: unknown,
  keys: VapidKeys,
): Promise<SendResult> {
  const ua_p256dh = b64urlDecode(subscription.keys.p256dh);
  const ua_auth = b64urlDecode(subscription.keys.auth);
  const payloadBytes = TE.encode(typeof payload === 'string' ? payload : JSON.stringify(payload));

  const { body } = await encryptPayload(payloadBytes, ua_p256dh, ua_auth);

  const endpointUrl = new URL(subscription.endpoint);
  const audience = `${endpointUrl.protocol}//${endpointUrl.host}`;
  const jwt = await signVapid(audience, keys);

  const headers = new Headers({
    'content-type': 'application/octet-stream',
    'content-encoding': 'aes128gcm',
    // 24 h. A short TTL (e.g. 60s) is the most common reason FCM silently
    // drops a push when the device is sleeping or offline.
    ttl: '86400',
    // FCM and Mozilla both honor this. `normal` lets the push wait when the
    // device is dozing; `high` would force immediate wakeup.
    urgency: 'normal',
    authorization: `vapid t=${jwt}, k=${keys.publicKey}`,
  });

  const res = await fetch(subscription.endpoint, {
    method: 'POST',
    headers,
    body: new Uint8Array(body), // copy so the fetch input is a plain BufferSource
  });

  let resBody: string | undefined;
  if (!res.ok) {
    try {
      resBody = (await res.text()).slice(0, 400);
    } catch {
      /* ignore */
    }
  }

  return {
    status: res.status,
    ok: res.ok,
    endpoint: subscription.endpoint,
    body: resBody,
  };
}
