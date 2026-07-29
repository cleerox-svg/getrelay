# Native Android push (Firebase Cloud Messaging)

The Android app is a Capacitor WebView, which doesn't support **Web Push**
(no `PushManager`). So on the native build, notifications go through
**Firebase Cloud Messaging (FCM)** instead:

```
app (@capacitor/push-notifications) ──register──▶ FCM
        │  device token
        ▼
POST /me/push/native/register  { token }   (worker stores it)
        ⋮  later, when someone messages you / your team scores …
worker ──FCM HTTP v1 (service account)──▶ FCM ──▶ your phone
```

The code is wired on both sides:

- **App** — `src/lib/native-push.ts` registers a token and posts it; the
  Profile screen shows a native notifications toggle on native platforms.
  Tapping a notification routes to the chat (`App.tsx`).
- **Worker** — `POST /me/push/native/register` / `/unregister`
  (`src/push.ts`), delivery via `src/lib/fcm.ts`, fanned out alongside Web
  Push in `pushToUser` (messages) and the sports broadcast.
- **Build** — `.github/workflows/build-android.yml` drops
  `google-services.json` into the AAB when the `GOOGLE_SERVICES_JSON` secret
  is set. Capacitor's generated Gradle already applies the google-services
  plugin when that file is present.

Everything **degrades safely when unconfigured**: no secret → the AAB still
builds (push just doesn't register), and the worker skips FCM (Web Push is
unaffected).

## One-time setup (you must do this)

Native push won't work until all of these are done.

### 1. Firebase project + `google-services.json`

1. [Firebase Console](https://console.firebase.google.com/) → add a project
   (or attach the existing Google Cloud project you use for OAuth).
2. **Add app → Android**. Package name: `com.averrow.relay`.
3. Download the generated **`google-services.json`**.
4. GitHub → repo **Settings → Secrets and variables → Actions → New secret**:
   - **Name:** `GOOGLE_SERVICES_JSON`
   - **Value:** the entire contents of `google-services.json`.

### 2. Service account for the worker (to send messages)

1. Firebase Console → **Project settings → Service accounts → Generate new
   private key**. This downloads a JSON key (has `client_email` +
   `private_key`).
2. Worker vars/secrets:
   - Set `FCM_PROJECT_ID` in `packages/relay-worker/wrangler.toml`
     (`[vars]` and `[env.production.vars]`) to your Firebase **project id**.
   - Store the service-account JSON as a secret:
     ```sh
     cd packages/relay-worker
     wrangler secret put FCM_SERVICE_ACCOUNT_JSON --env production
     # paste the whole JSON file, then Ctrl-D
     ```
3. Make sure the **Firebase Cloud Messaging API (v1)** is enabled for the
   project (Google Cloud Console → APIs & Services).

### 3. Database migration

Apply the `native_push_tokens` table (idempotent):

```sh
gh workflow run "Seed contacts" -F file=0005_native_push_tokens.sql
```

(or `pnpm --filter @relay/worker db:apply:remote`).

### 4. Cut a new AAB

Run **Build Android APK / AAB** (`release-aab`). With `GOOGLE_SERVICES_JSON`
set the build wires in Firebase; the worker side ships with the next
`deploy-worker`. Then, on the phone: Profile → Notifications → **Enable**,
accept the Android permission prompt, and send yourself a test message with
the app closed.

## Notes

- **iOS** would additionally need APNs configured in Firebase and a push
  entitlement; the code is platform-agnostic but only Android is wired in
  the build today.
- Message + sports pushes are sent to Web Push **and** native tokens, so a
  user signed in on both a browser PWA and the app gets one on each.
- Dead tokens (app uninstalled) are pruned automatically when FCM reports
  them `UNREGISTERED`.
