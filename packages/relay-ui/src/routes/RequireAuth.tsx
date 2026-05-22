import { useEffect } from 'react';
import { Navigate, Outlet, useLocation } from 'react-router-dom';
import { stopSportsPoller, useStore, wireSportsPoller } from '../lib/store';
import { ws } from '../lib/ws';

export function RequireAuth() {
  const me = useStore((s) => s.me);
  const loaded = useStore((s) => s.meLoaded);
  const loadMe = useStore((s) => s.loadMe);
  const location = useLocation();

  useEffect(() => {
    if (!loaded) loadMe();
  }, [loaded, loadMe]);

  useEffect(() => {
    if (me) ws.start();
  }, [me]);

  // Start the sports poller when the user lands signed-in; stop it
  // on sign-out. Lives at this level (not inside MainLayout or the
  // /sports route) so the bottom-nav live-game badge stays current
  // even when the user is on a different tab.
  useEffect(() => {
    if (me) {
      wireSportsPoller();
      return () => stopSportsPoller();
    }
    return undefined;
  }, [me]);

  if (!loaded) {
    return (
      <div className="app-shell" style={{ alignItems: 'center', justifyContent: 'center' }}>
        <p style={{ color: 'var(--text-dim)' }}>Loading…</p>
      </div>
    );
  }
  if (!me) {
    return <Navigate to="/signin" replace state={{ from: location.pathname }} />;
  }
  return <Outlet />;
}
