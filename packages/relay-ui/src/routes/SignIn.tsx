import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { GOOGLE_SIGNIN_URL } from '../lib/api';
import { useStore } from '../lib/store';

export function SignIn() {
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.meLoaded);
  const loadMe = useStore((s) => s.loadMe);
  const nav = useNavigate();

  useEffect(() => {
    if (!loaded) loadMe();
  }, [loaded, loadMe]);

  useEffect(() => {
    if (me) nav('/chats', { replace: true });
  }, [me, nav]);

  return (
    <div
      className="app-shell"
      style={{ padding: 24, justifyContent: 'space-between', minHeight: '100dvh' }}
    >
      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          gap: 48,
        }}
      >
        <h1 style={{ fontSize: 56, letterSpacing: '0.06em', fontWeight: 700, margin: 0 }}>
          RELAY
        </h1>
        <div style={{ width: '100%' }}>
          <a className="btn-primary" href={GOOGLE_SIGNIN_URL} style={{ display: 'block', textAlign: 'center' }}>
            ▸ Continue with Google
          </a>
        </div>
        <div style={{ color: 'var(--text-dim)', lineHeight: 1.8 }}>
          <div>No phone number.</div>
          <div>No tracking.</div>
          <div>Just a PIN.</div>
        </div>
      </div>
    </div>
  );
}
