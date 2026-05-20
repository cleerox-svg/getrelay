export interface Env {
  DB: D1Database;
  CHAT_ROOM: DurableObjectNamespace;
  USER_HUB: DurableObjectNamespace;
  AVATARS: R2Bucket;

  GOOGLE_ID: string;
  GOOGLE_SECRET: string;
  JWT_SECRET: string;
  APP_URL: string;
  AUTH_COOKIE_DOMAIN: string;
  ADMIN_EMAILS: string;
}
