// HS256 JWT — handwritten to avoid a dep, ~30 lines.

interface Header { alg: 'HS256'; typ: 'JWT' }
export interface JwtClaims { sub: string; jti: string; iat: number; exp: number }

const enc = new TextEncoder();
const dec = new TextDecoder();

function b64urlEncode(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function signJwt(claims: JwtClaims, secret: string): Promise<string> {
  const header: Header = { alg: 'HS256', typ: 'JWT' };
  const headerB64 = b64urlEncode(enc.encode(JSON.stringify(header)));
  const payloadB64 = b64urlEncode(enc.encode(JSON.stringify(claims)));
  const signingInput = `${headerB64}.${payloadB64}`;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(signingInput));
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

export async function verifyJwt(token: string, secret: string): Promise<JwtClaims | null> {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [h, p, s] = parts as [string, string, string];
  const ok = await crypto.subtle.verify(
    'HMAC',
    await hmacKey(secret),
    b64urlDecode(s),
    enc.encode(`${h}.${p}`),
  );
  if (!ok) return null;
  const claims = JSON.parse(dec.decode(b64urlDecode(p))) as JwtClaims;
  if (claims.exp < Math.floor(Date.now() / 1000)) return null;
  return claims;
}
