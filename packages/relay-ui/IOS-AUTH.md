# iOS native Google Sign-In

Same problem and same solution as Android. The iOS app is a WKWebView loading
`https://relay.averrow.com`, and the **web** redirect OAuth flow
(`/auth/google` → `/auth/google/callback`) **cannot complete inside it**:
Google blocks OAuth from embedded WebViews (`disallowed_useragent`).

So the native build signs in through the plugin instead:

```
app (native plugin) ──Google Sign-In──▶ Google
        │  ID token (aud = WEB client id)
        ▼
POST https://relay-api.averrow.com/auth/google/native  { idToken }
        │  worker verifies aud + iss + email_verified, then mints the
        │  same relay_session cookie the web callback does
        ▼
app reloads /me → signed in
```

Nothing about this is iOS-specific on the worker side — `POST
/auth/google/native` is the endpoint Android already uses, and
`src/routes/SignIn.tsx` branches on `Capacitor.isNativePlatform()`, not on
the platform.

## The two client ids (the thing that trips people up)

Google's iOS SDK needs **two** OAuth client ids, and they do different jobs:

| Config key | Which client id | Job |
|---|---|---|
| `serverClientId` | **Web** | The audience the ID token is minted for. The worker verifies `aud === GOOGLE_ID`, so this must equal the Android one. |
| `iosClientId` | **iOS** | Identifies the app to Google. The SDK refuses to start without it. |

Using the iOS client id for `serverClientId` produces a token the worker
rejects; omitting `iosClientId` means sign-in never starts. Both are set in
`capacitor.config.ts` from build-time env.

## One-time setup

### 1. iOS OAuth client in Google Cloud Console

APIs & Services → Credentials → **Create credentials → OAuth client ID →
iOS**:

- **Bundle ID:** `com.averrow.relay`

Create it in the **same Google Cloud project** as the web client, so Google
will issue an ID token with the web client's audience for this app.

### 2. Secrets

`GOOGLE_WEB_CLIENT_ID` is already set for the Android build — the iOS
workflow reuses it, nothing to do.

`GOOGLE_IOS_CLIENT_ID` is **usually optional**: if you added the iOS app to
Firebase for push ([IOS-PUSH.md](./IOS-PUSH.md)), the downloaded
`GoogleService-Info.plist` already contains that client id and its
`REVERSED_CLIENT_ID`, and the workflow reads the URL scheme straight out of
the plist.

Set the secret explicitly only when the OAuth client you want isn't the one
Firebase generated:

- **Name:** `GOOGLE_IOS_CLIENT_ID`
- **Value:** the **iOS** client id, ending in `.apps.googleusercontent.com`

### 3. Callback URL scheme

Handled automatically. The plugin returns through a custom URL scheme equal to
the **reversed** iOS client id (`com.googleusercontent.apps.<id>`), and the
workflow writes it into `Info.plist` as a `CFBundleURLTypes` entry — derived
from `GOOGLE_IOS_CLIENT_ID` when set, otherwise from the plist's
`REVERSED_CLIENT_ID`.

If neither is available the build still succeeds and logs a warning; native
sign-in just won't return from Google.

## Verifying

Fresh install → **Sign in with Google**. The native account sheet should
appear (not a web view), and you should land signed-in without a browser
bounce. A hang after picking an account almost always means the URL scheme
in `Info.plist` doesn't match the client id the SDK was initialised with —
check the "Registered Google Sign-In URL scheme" line in the build log.
