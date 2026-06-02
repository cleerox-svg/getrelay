# Android native Google Sign-In

The Android app is a Capacitor WebView that loads `https://relay.averrow.com`.
The **web** sign-in uses the redirect OAuth flow (`/auth/google` →
`/auth/google/callback`). That flow **cannot complete inside the WebView**:

- Google blocks OAuth from embedded WebViews (`disallowed_useragent`), and
- the OAuth `state` cookie set on `/auth/google` doesn't survive the bounce
  through Google back into the app, so the callback throws and the user sees
  a bare **"Internal Server Error"**.

So the native build signs in differently:

```
app (native plugin) ──Google Sign-In──▶ Google
        │  ID token (aud = web client id)
        ▼
POST https://relay-api.averrow.com/auth/google/native  { idToken }
        │  worker verifies token (aud + iss + email_verified) via
        │  https://oauth2.googleapis.com/tokeninfo, then mints the same
        │  relay_session cookie the web callback does
        ▼
app reloads /me → signed in
```

The code is already wired:

- **App** — `src/routes/SignIn.tsx` calls the plugin only when
  `Capacitor.isNativePlatform()`; the browser keeps using the redirect flow.
- **Plugin** — `@codetrix-studio/capacitor-google-auth`, configured in
  `capacitor.config.ts` (`plugins.GoogleAuth.serverClientId`).
- **Worker** — `POST /auth/google/native` in `relay-worker/src/auth.ts`.
- **Build** — `.github/workflows/build-android.yml` injects
  `GOOGLE_WEB_CLIENT_ID` into `capacitor.config.json` and Android
  `strings.xml` (`server_client_id`).

## One-time setup required (you must do this)

Native Google Sign-In will **not** work until both of these are done.

### 1. GitHub secret `GOOGLE_WEB_CLIENT_ID`

Repo → Settings → Secrets and variables → Actions → **New repository secret**:

- **Name:** `GOOGLE_WEB_CLIENT_ID`
- **Value:** your **Web** OAuth 2.0 client id (the same value as the worker's
  `GOOGLE_ID`, ending in `.apps.googleusercontent.com`).

This must be the *Web* client id, not the Android one — the ID token the
plugin returns is minted for this audience, and the worker verifies
`aud === GOOGLE_ID`.

### 2. Android OAuth client in Google Cloud Console

APIs & Services → Credentials → **Create credentials → OAuth client ID →
Android**:

- **Package name:** `com.averrow.relay`
- **SHA-1 certificate fingerprints** — add **both**:
  - **Play app-signing key** SHA-1 (Play Console → your app → Test and
    release → Setup → **App integrity** → App signing key certificate). This
    is what installed Play builds are actually signed with.
  - **Upload key** SHA-1, so artifact/sideloaded builds also work:
    ```
    keytool -list -v -keystore upload-keystore.jks -alias <ANDROID_KEY_ALIAS>
    ```
    (decode the `ANDROID_KEYSTORE_BASE64` secret to get `upload-keystore.jks`).

You do **not** put the Android client id anywhere in the app — registering it
in the same Google Cloud project is what lets Google issue an ID token for the
app; the token's audience stays the Web client id.

After both are set, cut a new AAB (run the **Build Android APK / AAB**
workflow). The worker side ships with the next `deploy-worker`.
