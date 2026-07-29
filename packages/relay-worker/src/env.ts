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

  // Giphy v1 API key. Free, registered at developers.giphy.com.
  // /gifs returns 404 ("gifs_not_configured") when this isn't set.
  GIPHY_API_KEY?: string;

  // Firebase Cloud Messaging (native Android/iOS push). PROJECT_ID is the
  // Firebase project id (a plain var); SERVICE_ACCOUNT_JSON is the full
  // service-account JSON (client_email + private_key with the Firebase
  // Cloud Messaging API role), set via `wrangler secret put`. When either
  // is unset, native push is skipped — Web Push is unaffected. See
  // ../../relay-ui/ANDROID-PUSH.md.
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}
