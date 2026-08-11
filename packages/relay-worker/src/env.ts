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

  // Spotify Web API client-credentials app (id + secret), registered at
  // developer.spotify.com. Used only to resolve an exact
  // open.spotify.com/track/... URL for the "Guess the Tune" reveal screen.
  // Both are OPTIONAL: when EITHER is unset, /tunes/spotify returns
  // { url: null } and the client falls back to a Spotify search link.
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;

  // Envelope-encryption root key (KEK) for encrypting chat message bodies at
  // rest — set via `wrangler secret put MESSAGE_KEK`. Value is a JSON version
  // map of base64 32-byte AES-256 keys, e.g. {"1":"<base64 key>"}. Used to
  // wrap/unwrap the per-chat data-encryption keys (DEKs); never re-encrypts
  // bodies on rotation. See wrangler.toml for generation + rotation steps.
  MESSAGE_KEK: string;

  // Firebase Cloud Messaging (native Android/iOS push). PROJECT_ID is the
  // Firebase project id (a plain var); SERVICE_ACCOUNT_JSON is the full
  // service-account JSON (client_email + private_key with the Firebase
  // Cloud Messaging API role), set via `wrangler secret put`. When either
  // is unset, native push is skipped — Web Push is unaffected. See
  // ../../relay-ui/ANDROID-PUSH.md.
  FCM_PROJECT_ID?: string;
  FCM_SERVICE_ACCOUNT_JSON?: string;
}
