# Native iOS push (Firebase Cloud Messaging → APNs)

The iOS app is a WKWebView, which has no **Web Push** (`PushManager`). Like
Android, it registers a **Firebase Cloud Messaging** device token instead —
and deliberately uses the *same* FCM path, not a second APNs one:

```
app (@capacitor/push-notifications) ──register──▶ APNs
        │  APNs device token
        ▼  (AppDelegate hands it to Firebase, gets an FCM token back)
POST /me/push/native/register  { token, platform: 'ios' }
        ⋮  later, when someone messages you / your team scores …
worker ──FCM HTTP v1──▶ FCM ──APNs──▶ your phone
```

## Why FCM and not APNs directly

Talking to APNs from the worker would mean a second sender, a second
credential, and a second delivery path to keep in sync with the first. Worse,
**APNs is HTTP/2-only**, and the local `workerd` dev runtime can't negotiate
HTTP/2 — so the push path would be untestable outside production.

Routing iOS through Firebase means one sender (`lib/fcm.ts`), one credential
(`FCM_SERVICE_ACCOUNT_JSON`), one `native_push_tokens` table, and one code
path that both platforms exercise. Firebase relays to APNs on our behalf once
its APNs auth key is uploaded.

## The AppDelegate patch (the part that is easy to get wrong)

`@capacitor/push-notifications` returns the **APNs** token on iOS — a 64-char
hex string that FCM cannot address. Only Android gets an FCM token from the
stock plugin.

Rather than swap in a different push plugin (and churn the working Android
path), `.github/ios-appdelegate-firebase.swift` replaces the scaffolded
`AppDelegate` with one that:

1. calls `FirebaseApp.configure()` — but **only if** `GoogleService-Info.plist`
   is in the bundle, so a build without the secret doesn't trap on launch;
2. sets `Messaging.messaging().apnsToken` from the APNs callback;
3. posts the resulting **FCM** token to
   `.capacitorDidRegisterForRemoteNotifications`, which the plugin accepts as
   either `Data` or `String`;
4. re-posts on `didReceiveRegistrationToken` so a rotated token is
   re-registered with the worker instead of silently going dead.

Because the plugin's JS surface is unchanged, `src/lib/native-push.ts` is
identical on both platforms. There is one native push path, not two.

**If that patch ever stops applying**, registration would still "succeed" with
an APNs token and every later send would fail deep inside FCM where nobody is
looking. So the worker rejects it at the door: an iOS registration whose token
matches `^[0-9a-f]{64}$` returns **`apns_token_not_fcm`**, and the Profile
toggle shows it on the first tap.

## One-time setup (you must do this)

Native iOS push won't work until all of these are done. The worker side needs
**nothing new** — it's the same Firebase project and service account the
Android app already uses.

### 1. APNs auth key (this is what lets Firebase reach Apple)

1. [Apple Developer → Keys](https://developer.apple.com/account/resources/authkeys/list)
   → **+**, tick **Apple Push Notifications service (APNs)**.
2. Download the `AuthKey_XXXXXXXXXX.p8` — **one download only**.
3. Note the **Key ID** and your **Team ID**.

Use a `.p8` auth key, not a push *certificate*: keys don't expire, work for
every app under the team, and cover both sandbox and production. Certificates
expire annually and break push on a schedule.

### 2. Add the iOS app to the existing Firebase project

1. [Firebase Console](https://console.firebase.google.com/) → the **same
   project as Android** (`relay-7a444`) → **Add app → iOS**.
2. Bundle ID: `com.averrow.relay`.
3. Download **`GoogleService-Info.plist`**.
4. **Project settings → Cloud Messaging → APNs Authentication Key → Upload**:
   the `.p8` from step 1, plus its Key ID and your Team ID.

Skipping the key upload is the single most common cause of "everything looks
wired but nothing arrives" — FCM accepts the send and fails at the APNs hop.
`Send test notification` in Profile surfaces that as a real FCM status + body.

### 3. GitHub secret

Settings → Secrets and variables → Actions → **New repository secret**:

- **Name:** `GOOGLE_SERVICE_INFO_PLIST`
- **Value:** the entire contents of `GoogleService-Info.plist`

The workflow verifies the plist's `BUNDLE_ID` is `com.averrow.relay` and fails
the build if not, rather than shipping an IPA whose Firebase init misbehaves.

### 4. Cut a new IPA

Run **Build iOS IPA** (`release-ipa`). Then on the phone: Profile →
Notifications → **Enable**, accept the iOS permission prompt, and tap **Send
test notification**.

## Verifying it works

`Send test notification` (Profile, native builds) hits
`POST /me/push/native/test` and shows the raw per-device FCM result. That
separates the three failure modes without server logs:

| Result | Meaning |
|---|---|
| `fcm_not_configured` (503) | Worker has no `FCM_SERVICE_ACCOUNT_JSON` / `FCM_PROJECT_ID` |
| `no_tokens` (404) | This account has no registered device — the toggle never completed |
| A real FCM status + body | FCM is rejecting the send. A 401/404 naming the APNs key means step 1/2 above is incomplete |
| `✓ ios …abcd1234 · HTTP 200` | Delivered to FCM. If nothing appears on the phone, check Focus modes and per-app notification settings |

## Behaviour differences from Android worth knowing

- **Foreground notifications.** Android displays an FCM `notification` message
  while the app is open; iOS swallows it unless
  `presentationOptions` is set — it is, in `capacitor.config.ts`.
- **Collapse.** Android uses `notification.tag`; iOS uses the
  `apns-collapse-id` header. `lib/fcm.ts` sets both from the same `tag`,
  truncating to APNs' 64-byte cap (over it, APNs 400s the whole request).
- **Expiry.** `android.ttl` is a *duration* (`"900s"`); `apns-expiration` is an
  *absolute* unix timestamp. Same input, two encodings — covered by tests in
  `test/fcm.test.ts`.
- **Priority.** `HIGH`/`NORMAL` on Android maps to `apns-priority` `10`/`5`.

One message carries both the `android` and `apns` blocks; FCM applies the one
matching the token's platform and ignores the other, so there is no
per-platform branching in the send path.
