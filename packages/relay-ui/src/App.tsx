import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { App as KonstaApp } from 'konsta/react';
import { useLegacyUi } from './lib/legacy';
import { wireWsToStore } from './lib/store';
import { AddContact } from './routes/AddContact';
import { Chat } from './routes/Chat';
import { Chats } from './routes/Chats';
import { ContactProfile } from './routes/ContactProfile';
import { Contacts } from './routes/Contacts';
import { Feeds } from './routes/Feeds';
import { LegacyChat } from './routes/LegacyChat';
import { LegacyChats } from './routes/LegacyChats';
import { MainLayout } from './routes/MainLayout';
import { NewGroup } from './routes/NewGroup';
import { Onboarding } from './routes/Onboarding';
import { Placeholder } from './routes/Placeholder';
import { Privacy } from './routes/Privacy';
import { Profile } from './routes/Profile';
import { RequireAuth } from './routes/RequireAuth';
import { SignIn } from './routes/SignIn';

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

export function App() {
  useEffect(() => {
    wireWsToStore();
  }, []);
  const dark = useIsDark();
  const legacy = useLegacyUi();

  return (
    <KonstaApp theme="ios" dark={dark} safeAreas>
      <BrowserRouter>
        <SwNavigationBridge />
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route path="/privacy" element={<Privacy />} />
          <Route element={<RequireAuth />}>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/chats/:id" element={legacy ? <LegacyChat /> : <Chat />} />
            <Route path="/contacts/:id" element={<ContactProfile />} />
            <Route path="/add-contact" element={<AddContact />} />
            <Route path="/new-group" element={<NewGroup />} />
            <Route path="/profile" element={<Profile />} />

            <Route element={<MainLayout />}>
              <Route path="/chats" element={legacy ? <LegacyChats /> : <Chats />} />
              <Route path="/contacts" element={<Contacts />} />
              <Route
                path="/calls"
                element={
                  <Placeholder
                    title="Calls"
                    blurb="Voice and video calls between Relay users. Lands in v1 once WebRTC signaling is in place."
                  />
                }
              />
              <Route path="/feeds" element={<Feeds />} />
              <Route
                path="/discover"
                element={
                  <Placeholder
                    title="Discover"
                    blurb="Channels and curated content. Lands in v1."
                  />
                }
              />
            </Route>
          </Route>
          <Route path="/" element={<Navigate to="/chats" replace />} />
          <Route path="*" element={<Navigate to="/chats" replace />} />
        </Routes>
      </BrowserRouter>
    </KonstaApp>
  );
}
