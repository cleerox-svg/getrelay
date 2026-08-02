// Shared Deezer fetch helper for the music-backed games (Guess the Tune song
// previews in tunes.ts, Fog album art in itunes.ts).
//
// Deezer's public API rate-limits per source IP, and every Cloudflare Worker
// request egresses through a small shared pool of datacenter IPs. A single
// game start fires a BURST of searches (availability probe + up to 4 seed
// searches for round one + the next-round prefetch), which trips Deezer's
// ~5s quota window. Deezer answers that throttle with either HTTP 429 or a
// 200 body carrying its error envelope, e.g. { error: { code: 4, ... } }.
//
// Treating that transient throttle as a hard failure falls straight through
// to the iTunes fallback, which 403s Workers' egress IPs → null → the round
// build fails → "Couldn't reach the music service." So instead we retry the
// same request a couple of times with jittered backoff, spilling into the
// next quota window before giving up.

interface DeezerErrorEnvelope {
  error?: { code?: number; message?: string };
}

// Deezer error codes that indicate a transient throttle worth retrying (as
// opposed to a genuine error, which stays a normal miss → iTunes fallback):
//   4   — "Quota limit exceeded"
//   700 — "Service busy / temporarily unavailable"
const RETRYABLE_DEEZER_CODES = new Set([4, 700]);

// Jittered backoff schedule (ms) between retries — [base, added-jitter].
// Deezer's quota window is ~5s, so spreading retries across ~350–600ms then
// ~800–1200ms lands the second attempt in a fresh window. Worst-case total
// sleep is ~1.8s (well under the client's 8s per-search timeout, and the
// ~2.5s cap the fix targets). Math.random()/setTimeout are available in the
// Workers runtime (this is app code, not a workflow script).
const BACKOFF_MS: ReadonlyArray<readonly [number, number]> = [
  [350, 250],
  [800, 400],
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// A 200 body is a retryable throttle only when it is Deezer's error envelope
// AND the code is a known quota/busy code. Any other { error } code (or an
// empty result) is a normal miss and must NOT be retried.
function isThrottleBody(data: unknown): boolean {
  const err = (data as DeezerErrorEnvelope | null)?.error;
  if (!err || typeof err !== 'object') return false;
  const code = (err as { code?: number }).code;
  return typeof code === 'number' && RETRYABLE_DEEZER_CODES.has(code);
}

// Fetch a Deezer search URL, retrying a rate-limit/throttle up to 2 times
// (≈3 attempts total) with jittered backoff. Returns the parsed JSON body,
// or null on a network error, a non-OK (non-429) status, or a throttle that
// survives every retry. On null the caller's Deezer→iTunes `??` fallback runs
// exactly as before — only the throttle path now recovers instead of failing.
export async function fetchDeezerJson<T>(url: string): Promise<T | null> {
  // attempt 0 is the initial try; entries in BACKOFF_MS drive the retries.
  for (let attempt = 0; ; attempt++) {
    let retryable = false;
    try {
      const r = await fetch(url, { headers: { accept: 'application/json' } });
      if (r.status === 429) {
        // Drain the throttle body so the connection can be reused on retry.
        void r.body?.cancel();
        retryable = true;
      } else if (!r.ok) {
        return null;
      } else {
        const data = (await r.json()) as T;
        if (isThrottleBody(data)) {
          retryable = true;
        } else {
          return data;
        }
      }
    } catch {
      return null;
    }
    // Retryable throttle: back off and try again, unless retries are spent.
    const backoff = retryable ? BACKOFF_MS[attempt] : undefined;
    if (!backoff) return null;
    await sleep(backoff[0] + Math.random() * backoff[1]);
  }
}
