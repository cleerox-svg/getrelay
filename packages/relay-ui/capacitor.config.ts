import type { CapacitorConfig } from '@capacitor/cli';

// Capacitor wraps the Vite-built web bundle (./dist) into a native shell.
// We keep `server.url` unset so the app ships its assets locally — that
// means store builds work offline-on-launch and don't depend on the web
// host being up. If you ever want to point the wrapper at the live web
// app for faster iteration (no Play Store review per UI change), set
// CAPACITOR_SERVER_URL=https://relay.averrow.com when building.

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
