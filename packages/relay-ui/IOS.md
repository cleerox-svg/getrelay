# iOS build & release

The user-facing checklist for shipping Relay to the App Store. Every build
step runs in GitHub Actions on a macOS runner — **no Mac and no Xcode
required on your machine**.

The iOS app is the same Capacitor shell as Android: a WKWebView that loads
`https://relay.averrow.com`, with native push, native Google Sign-In and a
native launcher icon. `ios/` is **not committed** — CI scaffolds it with
`cap add ios` on every run and patches the generated files from
`capacitor.config.ts` plus repo secrets, exactly like `android/`.

## One-time setup

### 1. Apple Developer Program

You need a paid membership ($99/yr). Individual is fine.

### 2. Register the app in App Store Connect

App Store Connect → **Apps → +** → New App:

- **Platform:** iOS
- **Bundle ID:** `com.averrow.relay` — create it first under
  [Certificates, Identifiers & Profiles → Identifiers](https://developer.apple.com/account/resources/identifiers/list),
  and tick **Push Notifications** on the App ID.
- **SKU:** anything (`relay`).

### 3. App Store Connect API key

This is what replaces certificates, provisioning profiles, and fastlane
match. There is nothing to renew.

App Store Connect → **Users and Access → Integrations → App Store Connect
API → +**:

- **Access:** `App Manager`. Not `Developer` — a Developer-role key uploads
  fine but is rejected by TestFlight with a bare `Unauthorized`.
- Download the `AuthKey_XXXXXXXXXX.p8`. **Apple lets you download it once.**

Then add four repo secrets (Settings → Secrets and variables → Actions):

| Secret | Where it comes from |
|---|---|
| `APPSTORE_KEY_ID` | The `XXXXXXXXXX` in the key filename |
| `APPSTORE_ISSUER_ID` | Shown above the key list on the same page |
| `APPSTORE_PRIVATE_KEY` | The whole contents of the `.p8` file |
| `APPSTORE_TEAM_ID` | Apple Developer → Membership details → Team ID |

### 4. Native push and sign-in

Both have their own runbooks — do them before the first release build:

- **[IOS-PUSH.md](./IOS-PUSH.md)** — Firebase iOS app + APNs auth key →
  `GOOGLE_SERVICE_INFO_PLIST`.
- **[IOS-AUTH.md](./IOS-AUTH.md)** — iOS OAuth client →
  `GOOGLE_IOS_CLIENT_ID` (often derivable, see the doc).

Neither is required to *build*: with the secrets unset the IPA still
compiles and installs, those features just don't work. That's deliberate —
the same degrade-safely property the Android build has.

## Cutting a build

Actions tab → **Build iOS IPA** → Run workflow.

| Input | Use |
|---|---|
| `build_type` | `release-ipa` for TestFlight/App Store; `simulator-unsigned` to prove it compiles with no Apple account at all |
| `publish` | `true` uploads to TestFlight automatically |
| `server_url` | Leave as `https://relay.averrow.com` |
| `build_number` | Blank = auto (minutes since 2024-01-01, same scheme as Android's `versionCode`) |

Start with **`simulator-unsigned`**. It exercises every step that can fail
without Apple in the loop — Capacitor scaffolding, the Firebase pods, the
patched `AppDelegate`, the icon generation — so signing problems get
debugged on their own rather than tangled up with build problems.

Then `release-ipa` + `publish=true`. The build appears in TestFlight a few
minutes after the run goes green.

## When do you need a new build?

**Almost never.** Same rule as Android, and worth internalising because App
Review is slower than Play review.

The WKWebView loads from `server_url`, so the app is a thin shell over the
deployed UI. **Web-only changes reach iOS users the moment `deploy-ui`
finishes** — new routes, components, worker endpoints, D1 schema, styling.
No IPA, no review.

Cut a new IPA only when something ships *inside* the app:

- a Capacitor plugin added / removed / upgraded;
- a new `Info.plist` usage string, entitlement, or capability;
- native push / deep-link / `capacitor.config.ts` changes;
- app icon or splash;
- deployment-target, bundle-id or signing changes;
- a `server_url` change or a cosmetic version bump for the listing.

Batch native changes into one build. `cancel-in-progress` means a newer run
supersedes one still building.

## The review risk worth knowing about

Apple's **Guideline 4.2 (Minimum Functionality)** is aimed at apps that are
just a website in a wrapper, and Relay is closer to that line than the Play
Store cares about. What argues against a rejection: the app registers for
native push notifications, signs in with the native Google SDK, and uses the
camera for QR scanning — real device integration, not just a viewport.

If it does get flagged, the usual fix is to lean harder on native
capability rather than to restructure the app. Don't be surprised by a
first-submission rejection; it's common for WebView-backed apps and is
normally resolved in the reply thread.

## Troubleshooting

| Symptom | Cause |
|---|---|
| `No profiles for 'com.averrow.relay' were found` | The App ID doesn't exist yet, or the API key lacks App Manager access |
| `No such module 'FirebaseCore'` | `pod install` didn't resolve the Firebase pods — check the `Podfile.lock` grep in the workflow log |
| Build uploads, then TestFlight says "Waiting for export compliance" | `ITSAppUsesNonExemptEncryption` didn't apply; the workflow also passes the flag to the upload action, so check both |
| App crashes instantly on launch | A missing `Info.plist` usage string (iOS terminates rather than prompting), or `FirebaseApp.configure()` without the plist — the patched AppDelegate guards the latter |
| Push toggle errors `apns_token_not_fcm` | The AppDelegate patch didn't apply — see [IOS-PUSH.md](./IOS-PUSH.md) |
