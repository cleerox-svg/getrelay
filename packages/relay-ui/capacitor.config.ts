import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the Vite-built web bundle (./dist) into a native shell.
// The build workflow sets CAPACITOR_SERVER_URL=https://relay.averrow.com
// so the WebView loads from production. That's important for OAuth:
// Google's redirect URI is https://relay-api.averrow.com/auth/google/callback,
// which sets a session cookie on .averrow.com — that cookie only reaches
// the app when the app is actually on a *.averrow.com origin (not file://).
//
// To produce a fully offline-bundled build, run the workflow with
// server_url blank. You'll then need a native Google Sign-In plugin
// (e.g. @capacitor-community/google-auth) wired to the worker, since
// the redirect-based flow can't bounce back into file:// origins.

const remote = process.env.CAPACITOR_SERVER_URL ?? '';

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
};

export default config;
