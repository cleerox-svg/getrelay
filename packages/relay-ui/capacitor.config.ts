import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the Vite-built web bundle (./dist) into a native shell.
// The build workflow sets CAPACITOR_SERVER_URL=https://relay.averrow.com
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
  plugins: {
    GoogleAuth: {
      scopes: ['profile', 'email'],
      serverClientId: googleWebClientId,
      forceCodeForRefreshToken: false,
    },
  },
};

export default config;
