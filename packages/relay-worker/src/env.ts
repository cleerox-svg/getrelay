export interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  AVATARS: R2Bucket;
  MEDIA: R2Bucket;

  GOOGLE_ID: string;
  GOOGLE_SECRET: string;
  JWT_SECRET: string;
  APP_URL: string;
  AUTH_COOKIE_DOMAIN: string;
  ADMIN_EMAILS: string;

  // Web Push VAPID — set via `wrangler secret put`. PUBLIC_KEY is the
  // P-256 raw uncompressed point as base64url; PRIVATE_KEY is the
  // matching scalar as base64url; SUBJECT is the mailto: identifier
  // (the push service contacts this address if something is wrong).
  VAPID_PUBLIC_KEY: string;
  VAPID_PRIVATE_KEY: string;
  VAPID_SUBJECT: string;
}
