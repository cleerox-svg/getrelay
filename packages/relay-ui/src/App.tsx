import { useEffect, useRef, useState } from 'react';
import {
  BrowserRouter,
  Navigate,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import { App as KonstaApp } from 'konsta/react';
import { Capacitor } from '@capacitor/core';
import { useLegacyUi } from './lib/legacy';
import { watchNativePushToken } from './lib/native-push';
import { KONSTA_THEME } from './lib/platform';
import { wireWsToStore } from './lib/store';
import { AddContact } from './routes/AddContact';
import { AddGroupMembers } from './routes/AddGroupMembers';
import { Chat } from './routes/Chat';
import { Chats } from './routes/Chats';
import { ContactProfile } from './routes/ContactProfile';
import { Contacts } from './routes/Contacts';
import { EditGroup } from './routes/EditGroup';
import { Feeds } from './routes/Feeds';
import { Games, GamesDeepLink } from './routes/Games';
import { GroupInfo } from './routes/GroupInfo';
import { LegacyChat } from './routes/LegacyChat';
import { LegacyChats } from './routes/LegacyChats';
import { MainLayout } from './routes/MainLayout';
import { NewGroup } from './routes/NewGroup';
import { Onboarding } from './routes/Onboarding';
import { Privacy } from './routes/Privacy';
import { Profile } from './routes/Profile';
import { RequireAuth } from './routes/RequireAuth';
import { SignIn } from './routes/SignIn';
import { Sports } from './routes/Sports';
import { SportsDetail } from './routes/SportsDetail';
import { SportsSettings } from './routes/SportsSettings';

function useIsDark(): boolean {
  const [dark, setDark] = useState<boolean>(() => resolveDark());
  useEffect(() => {
    const onMq = () => setDark(resolveDark());
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    mq.addEventListener('change', onMq);
    const obs = new MutationObserver(() => setDark(resolveDark()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => {
      mq.removeEventListener('change', onMq);
      obs.disconnect();
    };
  }, []);
  return dark;
}

function resolveDark(): boolean {
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

function SwNavigationBridge() {
  const nav = useNavigate();
  useEffect(() => {
    if (!('serviceWorker' in navigator)) return;
    const onMsg = (e: MessageEvent) => {
      const data = e.data as { type?: string; path?: string } | undefined;
      if (data?.type === 'navigate' && data.path) nav(data.path);
    };
    navigator.serviceWorker.addEventListener('message', onMsg);
    return () => navigator.serviceWorker.removeEventListener('message', onMsg);
  }, [nav]);
  return null;
}

// Native (Capacitor) equivalent of SwNavigationBridge: when the user taps
// an FCM/APNs notification, route to the chat or deep-link it carries.
function NativePushNavigationBridge() {
  const nav = useNavigate();
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let handle: { remove: () => void } | undefined;
    let cancelled = false;
    import('@capacitor/push-notifications')
      .then(({ PushNotifications }) =>
        PushNotifications.addListener('pushNotificationActionPerformed', (action) => {
          const data = (action?.notification?.data ?? {}) as { url?: string; chatId?: string };
          const path =
            typeof data.url === 'string' && data.url.startsWith('/')
              ? data.url
              : data.chatId
                ? `/chats/${data.chatId}`
                : null;
          if (path) nav(path);
        }),
      )
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [nav]);
  return null;
}

// Re-registers this device's push token with the worker whenever Firebase
// rotates it. Separate from the tap router above so each can be reasoned
// about (and detached) on its own.
function NativePushTokenBridge() {
  useEffect(() => {
    if (!Capacitor.isNativePlatform()) return;
    let detach: (() => void) | undefined;
    let cancelled = false;
    watchNativePushToken()
      .then((d) => {
        if (cancelled) d();
        else detach = d;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      detach?.();
    };
  }, []);
  return null;
}

// The Chats tab is the app's home / exit point. Pressing Android back here
// exits (standard Android behavior at the top of the stack).
const HOME_PATH = '/chats';

// Android hardware/gesture back. Without a listener, Capacitor's default is
// to exit the app on every back press — so from a chat, a detail screen, or
// even a secondary tab, "back" would drop you straight out. Wire it to the
// router instead: from the Chats home tab, exit; from anywhere else, step
// back to the last screen you were on (a previous tab or a drilled-in view,
// since tab switches push history), falling back to Chats when a screen was
// opened directly with no history (e.g. a notification tap).
function AndroidBackButton() {
  const nav = useNavigate();
  const location = useLocation();
  const locationRef = useRef(location);
  locationRef.current = location;
  useEffect(() => {
    if (Capacitor.getPlatform() !== 'android') return;
    let handle: { remove: () => void } | undefined;
    let cancelled = false;
    import('@capacitor/app')
      .then(({ App: CapApp }) =>
        CapApp.addListener('backButton', ({ canGoBack }) => {
          const path = locationRef.current.pathname;
          if (path === HOME_PATH) CapApp.exitApp();
          else if (canGoBack) nav(-1);
          else nav(HOME_PATH);
        }),
      )
      .then((h) => {
        if (cancelled) h.remove();
        else handle = h;
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
      handle?.remove();
    };
  }, [nav]);
  return null;
}

export function App() {
  useEffect(() => {
    wireWsToStore();
  }, []);
  const dark = useIsDark();
  const legacy = useLegacyUi();

  return (
    <KonstaApp theme={KONSTA_THEME} dark={dark} safeAreas>
      <BrowserRouter>
        <SwNavigationBridge />
        <NativePushNavigationBridge />
        <NativePushTokenBridge />
        <AndroidBackButton />
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route element={<RequireAuth />}>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/chats/:id" element={legacy ? <LegacyChat /> : <Chat />} />
            <Route path="/contacts/:id" element={<ContactProfile />} />
            <Route path="/add-contact" element={<AddContact />} />
            <Route path="/add" element={<AddContact />} />
            <Route path="/new-group" element={<NewGroup />} />
            <Route path="/groups/:id" element={<GroupInfo />} />
            <Route path="/groups/:id/add" element={<AddGroupMembers />} />
            <Route path="/groups/:id/edit" element={<EditGroup />} />
            <Route path="/profile" element={<Profile />} />
            <Route path="/sports/:league/:id" element={<SportsDetail />} />
            <Route path="/settings/sports" element={<SportsSettings />} />

            {/* Games used to live at /discover (the old Discover placeholder).
                Kept as a redirect so installed PWAs, pinned shortcuts and any
                stale link still resolve. It sits OUTSIDE the MainLayout group
                on purpose: the tab bar's active check is an exact pathname
                match, so redirecting before MainLayout renders means the tab
                highlights on /games instead of flashing with nothing active. */}
            <Route path="/discover" element={<Navigate to="/games" replace />} />

            {/* Deep link into one game — the worker's golf-challenge pushes
                send url: '/games/golf'. Same reasoning as /discover above, so
                it sits outside MainLayout too: GamesDeepLink validates the id
                and redirects to /games (replace) carrying it in history
                state, which the hub reads as its initial selection. Games are
                state, not subroutes; see the header comment in Games.tsx. */}
            <Route path="/games/:game" element={<GamesDeepLink />} />

            <Route element={<MainLayout />}>
              <Route path="/chats" element={legacy ? <LegacyChats /> : <Chats />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route path="/sports" element={<Sports />} />
              <Route path="/feeds" element={<Feeds />} />
              <Route path="/games" element={<Games />} />
            </Route>
          </Route>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Routes>
      </BrowserRouter>
    </KonstaApp>
  );
}
