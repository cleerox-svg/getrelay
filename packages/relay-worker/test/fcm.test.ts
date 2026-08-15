// FCM sender tests — focuses on the message shape sendFcm POSTs to the
// FCM HTTP v1 endpoint, in particular the time-to-live handling that
// keeps time-sensitive alerts (sports start/score/final) from being
// delivered stale. Runs inside workerd via @cloudflare/vitest-pool-workers;
// crypto.subtle signs the service-account JWT for real, and the pool's
// fetchMock stubs both the OAuth token exchange and the FCM send so no
// real network is hit.
import { beforeAll, describe, expect, it } from 'vitest';
import { fetchMock } from 'cloudflare:test';
import { sendFcm } from '../src/lib/fcm';
import type { Env } from '../src/env';

let saJson = '';

// Build a throwaway RSA service account so getAccessToken can sign a real
// RS256 JWT (the token endpoint is mocked, but the signing is genuine).
async function makeServiceAccountJson(): Promise<string> {
  const kp = (await crypto.subtle.generateKey(
    {
      name: 'RSASSA-PKCS1-v1_5',
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: 'SHA-256',
    },
    true,
    ['sign', 'verify'],
  )) as CryptoKeyPair;
  const pkcs8 = new Uint8Array(
    (await crypto.subtle.exportKey('pkcs8', kp.privateKey)) as ArrayBuffer,
  );
  let bin = '';
  for (const b of pkcs8) bin += String.fromCharCode(b);
  const b64 = (btoa(bin).match(/.{1,64}/g) ?? []).join('\n');
  const pem = `-----BEGIN PRIVATE KEY-----\n${b64}\n-----END PRIVATE KEY-----\n`;
  return JSON.stringify({
    client_email: 'test@proj.iam.gserviceaccount.com',
    private_key: pem,
    token_uri: 'https://oauth2.googleapis.com/token',
  });
}

function fcmEnv(): Env {
  return {
    FCM_PROJECT_ID: 'test-proj',
    FCM_SERVICE_ACCOUNT_JSON: saJson,
  } as unknown as Env;
}

// Register the (persistent) OAuth token mock. getAccessToken caches the
// token in-isolate, so only the first send exchanges — persist keeps any
// later exchange satisfied too.
function mockTokenEndpoint() {
  fetchMock
    .get('https://oauth2.googleapis.com')
    .intercept({ path: '/token', method: 'POST' })
    .reply(
      200,
      { access_token: 'test-access-token', expires_in: 3600 },
      { headers: { 'content-type': 'application/json' } },
    )
    .persist();
}

// Single-use FCM send mock that captures the parsed request body into the
// caller's slot, then returns a success envelope.
function mockFcmSend(capture: (body: Record<string, unknown>) => void) {
  fetchMock
    .get('https://fcm.googleapis.com')
    .intercept({ path: (p) => p.includes('/messages:send'), method: 'POST' })
    .reply(200, (opts) => {
      capture(JSON.parse(String(opts.body)) as Record<string, unknown>);
      return { name: 'projects/test-proj/messages/1' };
    });
}

// Pull message.android out of a captured request body without fighting the
// index-signature types.
function androidOf(body: Record<string, unknown>): Record<string, unknown> {
  const message = body.message as Record<string, unknown>;
  return message.android as Record<string, unknown>;
}

// Same, for the iOS half of the message.
function apnsOf(body: Record<string, unknown>): {
  headers: Record<string, string>;
  payload: { aps: Record<string, unknown> };
} {
  const message = body.message as Record<string, unknown>;
  return message.apns as { headers: Record<string, string>; payload: { aps: Record<string, unknown> } };
}

beforeAll(async () => {
  saJson = await makeServiceAccountJson();
  fetchMock.activate();
  fetchMock.disableNetConnect();
  mockTokenEndpoint();
});

describe('sendFcm android.ttl', () => {
  it('emits ttl as a seconds Duration string when ttlSeconds is set', async () => {
    let captured: Record<string, unknown> = {};
    mockFcmSend((b) => (captured = b));

    const res = await sendFcm(
      fcmEnv(),
      'device-token-1',
      { title: 'T', body: 'B', tag: 'sports-MLB-141-start' },
      { highPriority: true, ttlSeconds: 900 },
    );

    expect(res.ok).toBe(true);
    const android = androidOf(captured);
    expect(android.ttl).toBe('900s');
    expect(android.priority).toBe('HIGH');
    // tag still rides along on the android notification (collapse key).
    expect(android.notification).toEqual({ tag: 'sports-MLB-141-start' });
  });

  it('omits ttl entirely when ttlSeconds is not provided', async () => {
    let captured: Record<string, unknown> = {};
    mockFcmSend((b) => (captured = b));

    await sendFcm(fcmEnv(), 'device-token-2', { title: 'T', body: 'B' }, { highPriority: true });

    const android = androidOf(captured);
    expect('ttl' in android).toBe(false);
  });

  it('floors fractional and clamps negative ttlSeconds', async () => {
    let frac: Record<string, unknown> = {};
    mockFcmSend((b) => (frac = b));
    await sendFcm(fcmEnv(), 'device-token-3', { title: 'T', body: 'B' }, { ttlSeconds: 1800.9 });
    expect(androidOf(frac).ttl).toBe('1800s');

    let neg: Record<string, unknown> = {};
    mockFcmSend((b) => (neg = b));
    await sendFcm(fcmEnv(), 'device-token-4', { title: 'T', body: 'B' }, { ttlSeconds: -5 });
    expect(androidOf(neg).ttl).toBe('0s');
  });
});

// iOS installs register FCM tokens too (Firebase relays to APNs), so the same
// message must carry an `apns` block whose urgency/expiry/collapse mirror the
// android one. FCM applies only the block matching the token's platform.
describe('sendFcm apns', () => {
  it('mirrors android priority + collapse key and sets an absolute expiration', async () => {
    let captured: Record<string, unknown> = {};
    mockFcmSend((b) => (captured = b));

    const before = Math.floor(Date.now() / 1000);
    await sendFcm(
      fcmEnv(),
      'ios-token-1',
      { title: 'T', body: 'B', tag: 'sports-MLB-141-start' },
      { highPriority: true, ttlSeconds: 900 },
    );
    const after = Math.floor(Date.now() / 1000);

    const apns = apnsOf(captured);
    expect(apns.headers['apns-priority']).toBe('10');
    expect(apns.headers['apns-collapse-id']).toBe('sports-MLB-141-start');
    // apns-expiration is an ABSOLUTE unix timestamp, not a duration — the
    // distinction that makes this worth a test.
    const exp = Number(apns.headers['apns-expiration']);
    expect(exp).toBeGreaterThanOrEqual(before + 900);
    expect(exp).toBeLessThanOrEqual(after + 900);
    expect(apns.payload.aps.sound).toBe('default');
    expect(apns.payload.aps['thread-id']).toBe('sports-MLB-141-start');
  });

  it('uses priority 5 for non-urgent payloads and omits expiration without a ttl', async () => {
    let captured: Record<string, unknown> = {};
    mockFcmSend((b) => (captured = b));

    await sendFcm(fcmEnv(), 'ios-token-2', { title: 'T', body: 'B' }, { highPriority: false });

    const apns = apnsOf(captured);
    expect(apns.headers['apns-priority']).toBe('5');
    expect('apns-expiration' in apns.headers).toBe(false);
    expect('apns-collapse-id' in apns.headers).toBe(false);
    expect('thread-id' in apns.payload.aps).toBe(false);
  });

  it('passes a zero ttl through as "0" (APNs: try once, then drop)', async () => {
    let captured: Record<string, unknown> = {};
    mockFcmSend((b) => (captured = b));

    await sendFcm(fcmEnv(), 'ios-token-3', { title: 'T', body: 'B' }, { ttlSeconds: 0 });

    // 0 must NOT become "now + 0" — APNs treats a literal 0 as its own mode,
    // and a computed timestamp would be indistinguishable from an expiry.
    expect(apnsOf(captured).headers['apns-expiration']).toBe('0');
  });

  it('truncates an over-long collapse id to the 64-byte APNs limit', async () => {
    let captured: Record<string, unknown> = {};
    mockFcmSend((b) => (captured = b));

    const longTag = 'c'.repeat(200);
    await sendFcm(fcmEnv(), 'ios-token-4', { title: 'T', body: 'B', tag: longTag }, {});

    // Over 64 bytes and APNs 400s the whole request — better a truncated
    // collapse key than a dropped notification.
    expect(apnsOf(captured).headers['apns-collapse-id']).toBe('c'.repeat(64));
  });
});
