const COOKIE_NAME = 'relay_session';

export interface CookieOptions {
  domain: string;
  maxAgeSeconds: number;
}

export function makeSessionCookie(token: string, opts: CookieOptions): string {
  const parts = [
    `${COOKIE_NAME}=${token}`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    `Max-Age=${opts.maxAgeSeconds}`,
  ];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  return parts.join('; ');
}

export function clearSessionCookie(domain: string): string {
  const parts = [
    `${COOKIE_NAME}=`,
    'HttpOnly',
    'Secure',
    'SameSite=Lax',
    'Path=/',
    'Max-Age=0',
  ];
  if (domain) parts.push(`Domain=${domain}`);
  return parts.join('; ');
}

export function readSessionCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  for (const raw of cookieHeader.split(';')) {
    const [k, ...rest] = raw.trim().split('=');
    if (k === COOKIE_NAME) return rest.join('=');
  }
  return null;
}
