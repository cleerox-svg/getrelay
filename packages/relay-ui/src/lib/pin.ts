// PIN rendering: always mono, uppercase, formatted as XXXX·XXXX.

const PIN_RE = /^[0-9ABCDEFGHJKMNPQRSTVWXYZ]{8}$/;

export function formatPin(pin: string): string {
  const clean = pin.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
  if (clean.length !== 8) return clean;
  return `${clean.slice(0, 4)}·${clean.slice(4)}`;
}

export function stripPin(s: string): string {
  return s.replace(/[^0-9A-Za-z]/g, '').toUpperCase();
}

export function isValidPin(s: string): boolean {
  return PIN_RE.test(s);
}

// Public deep-link form a Relay user can share. Encoded into the QR.
// A Relay user's phone camera lands them in the app at /add?pin=...
// (which auto-submits). Anyone else lands on the SPA and is funnelled
// through sign-in first.
export function pinShareUrl(pin: string, origin?: string): string {
  const base = origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
  return `${base}/add?pin=${stripPin(pin)}`;
}

// Accepts: a bare PIN (any case, with or without separators), or a URL
// whose `pin` query param holds the PIN. Returns the 8-char canonical
// PIN, or null if nothing extractable.
export function parsePinFromQr(raw: string): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  // URL form first — covers https://relay.averrow.com/add?pin=XXXX·XXXX
  // and any custom-scheme variant.
  try {
    const url = new URL(trimmed);
    const fromQuery = url.searchParams.get('pin');
    if (fromQuery) {
      const cleaned = stripPin(fromQuery);
      if (isValidPin(cleaned)) return cleaned;
    }
  } catch {
    // not a URL — fall through to bare-PIN parse
  }
  const cleaned = stripPin(trimmed);
  return isValidPin(cleaned) ? cleaned : null;
}
