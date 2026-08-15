import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the Vite-built web bundle (./dist) into a native shell —
// one config drives BOTH the Android (build-android.yml) and iOS
// (build-ios.yml) apps, and neither android/ nor ios/ is committed: CI
// scaffolds them with `cap add` on every run and patches the generated
// native files from this config plus repo secrets.
//
// The build workflows set CAPACITOR_SERVER_URL=https://relay.averrow.com
// so the WebView loads from production. That's important for OAuth:
// Google's redirect URI is https://relay-api.averrow.com/auth/google/callback,
// which sets a session cookie on .averrow.com — that cookie only reaches
// the app when the app is actually on a *.averrow.com origin (not file://).
//
// Sign-in inside the WebView uses the native Google Sign-In plugin
// (@codetrix-studio/capacitor-google-auth) rather than the redirect flow,
// which Google blocks in embedded WebViews. The plugin needs the *web*
// OAuth client id as its serverClientId so the ID token it returns is
// minted for the audience the worker verifies (GOOGLE_ID). The build
// workflow injects it via GOOGLE_WEB_CLIENT_ID. See ANDROID-AUTH.md.

const remote = process.env.CAPACITOR_SERVER_URL ?? '';
const googleWebClientId = process.env.GOOGLE_WEB_CLIENT_ID ?? '';
// iOS additionally needs its OWN OAuth client id — Google's iOS SDK refuses
// to start with only a web client id. serverClientId still drives the ID
// token's audience (what the worker verifies); iosClientId only identifies
// the app to Google. build-ios.yml falls back to the CLIENT_ID inside
// GoogleService-Info.plist when this is unset. See IOS-AUTH.md.
const googleIosClientId = process.env.GOOGLE_IOS_CLIENT_ID ?? '';

const config: CapacitorConfig = {
  appId: 'com.averrow.relay',
  appName: 'Relay',
  webDir: 'dist',
  ...(remote
    ? {
        server: {
          url: remote,
          cleartext: false,
        },
      }
    : {}),
  android: {
    // Allow http for LAN dev builds only. Production AAB stays https-only
    // since the bundled web assets are file:// loaded.
    allowMixedContent: false,
  },
  ios: {
    // WKWebView pins content below the status bar by default via its own
    // inset handling, which double-counts against the CSS env(safe-area-*)
    // padding the app already applies everywhere. 'never' hands safe-area
    // control entirely to CSS, so the native shell matches the PWA.
    contentInset: 'never',
    // Match the brand background so overscroll rubber-banding shows black
    // rather than a white flash against the dark UI.
    backgroundColor: '#0A0A0A',
  },
  plugins: {
    GoogleAuth: {
      scopes: ['profile', 'email'],
      serverClientId: googleWebClientId,
      ...(googleIosClientId ? { iosClientId: googleIosClientId } : {}),
      forceCodeForRefreshToken: false,
    },
    // Native push. BOTH platforms go through FCM: Android natively, iOS by
    // having Firebase relay to APNs (build-ios.yml patches AppDelegate so the
    // registration event yields an FCM token, not the raw APNs one — the
    // plugin's iOS default). presentationOptions is what makes iOS show a
    // notification while the app is FOREGROUNDED; without it iOS silently
    // swallows those, where Android displays them either way.
    // See ANDROID-PUSH.md / IOS-PUSH.md for the per-platform Firebase setup.
    PushNotifications: {
      presentationOptions: ['badge', 'sound', 'alert'],
    },
  },
};

export default config;
