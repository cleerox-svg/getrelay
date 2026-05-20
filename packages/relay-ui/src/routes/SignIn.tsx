import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Block, Button, Page } from 'konsta/react';
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
    <Page>
      <div className="flex flex-col items-center justify-between h-full px-6 py-12 text-center">
        <div />
        <div className="flex flex-col items-center gap-2">
          <div className="text-[56px] font-extrabold tracking-tight" style={{ color: 'var(--accent)' }}>
            Relay
          </div>
          <div className="text-base" style={{ color: 'var(--text-dim)' }}>
            BBM-inspired messaging
          </div>
        </div>
        <div className="w-full flex flex-col gap-6">
          <Button
            large
            onClick={() => {
              window.location.href = GOOGLE_SIGNIN_URL;
            }}
          >
            Continue with Google
          </Button>
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
