import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, Button, Page } from 'konsta/react';
import { Capacitor } from '@capacitor/core';
import { api, GOOGLE_SIGNIN_URL } from '../lib/api';
import { useStore } from '../lib/store';

export function SignIn() {
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.meLoaded);
  const loadMe = useStore((s) => s.loadMe);
  const nav = useNavigate();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!loaded) loadMe();
  }, [loaded, loadMe]);

  useEffect(() => {
    if (me) nav('/chats', { replace: true });
  }, [me, nav]);

  // On the web the redirect OAuth flow works fine. Inside the Capacitor
  // WebView it doesn't (Google blocks embedded WebViews and the OAuth
  // state cookie doesn't survive the round-trip), so the native build
  // uses the platform Google Sign-In plugin to get an ID token and
  // exchanges it for a session via POST /auth/google/native.
  async function handleSignIn() {
    if (!Capacitor.isNativePlatform()) {
      window.location.href = GOOGLE_SIGNIN_URL;
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { GoogleAuth } = await import('@codetrix-studio/capacitor-google-auth');
      // Picks up serverClientId/scopes from capacitor.config on native.
      await GoogleAuth.initialize();
      const result = await GoogleAuth.signIn();
      const idToken = result?.authentication?.idToken;
      if (!idToken) throw new Error('no_id_token');
      const { isNew } = await api.googleNativeSignIn(idToken);
      await loadMe();
      nav(isNew ? '/onboarding' : '/chats', { replace: true });
    } catch (e) {
      // Surface the underlying reason. The native Google plugin reports a
      // bare code when the Cloud Console side isn't set up — most commonly
      // "10" (DEVELOPER_ERROR: no Android OAuth client for this package +
      // signing SHA-1, or a serverClientId that isn't the Web client id).
      // See ANDROID-AUTH.md. Showing it turns a silent "never worked" into
      // something diagnosable; "12501"/"canceled" just means the user
      // dismissed the sheet, so keep that quiet.
      const err = e as { message?: string; code?: string | number } | null;
      let reason = err?.message || (err?.code != null ? String(err.code) : '');
      if (!reason) {
        try {
          reason = typeof e === 'string' ? e : JSON.stringify(e);
        } catch {
          /* non-serializable error object */
        }
      }
      const canceled = /12501|cancel/i.test(reason);
      setError(
        canceled
          ? null
          : reason
            ? `Sign-in failed (${reason}). If this persists, the app's Google sign-in isn't configured yet.`
            : 'Sign-in failed. Please try again.',
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <Page>
      <div className="flex flex-col items-center justify-between h-full px-6 py-12 text-center">
        <div />
        <div className="flex flex-col items-center gap-2">
          <div className="text-[56px] font-extrabold tracking-tight" style={{ color: 'var(--accent)' }}>
            Relay
          </div>
          <div className="text-base" style={{ color: 'var(--text-dim)' }}>
            Pin-to-pin messaging
          </div>
        </div>
        <div className="w-full flex flex-col gap-6">
          <Button large onClick={handleSignIn} disabled={busy}>
            {busy ? 'Signing in…' : 'Continue with Google'}
          </Button>
          {error && (
            <Block strong className="!my-0 text-sm" style={{ color: 'var(--accent)' }}>
              {error}
            </Block>
          )}
          <div className="leading-7" style={{ color: 'var(--text-dim)' }}>
            <div>No phone number.</div>
            <div>No tracking.</div>
            <div>Just a PIN.</div>
          </div>
        </div>
      </div>
    </Page>
  );
}
