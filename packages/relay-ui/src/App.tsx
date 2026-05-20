import { useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { App as KonstaApp } from 'konsta/react';
import { wireWsToStore } from './lib/store';
import { AddContact } from './routes/AddContact';
import { Chat } from './routes/Chat';
import { Chats } from './routes/Chats';
import { Contacts } from './routes/Contacts';
import { MainLayout } from './routes/MainLayout';
import { Onboarding } from './routes/Onboarding';
import { Placeholder } from './routes/Placeholder';
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

export function App() {
  useEffect(() => {
    wireWsToStore();
  }, []);
  const dark = useIsDark();

  return (
    <KonstaApp theme="ios" dark={dark} safeAreas>
      <BrowserRouter>
        <Routes>
          <Route path="/signin" element={<SignIn />} />
          <Route element={<RequireAuth />}>
            <Route path="/onboarding" element={<Onboarding />} />
            <Route path="/chats/:id" element={<Chat />} />
            <Route path="/add-contact" element={<AddContact />} />
            <Route path="/profile" element={<Profile />} />

            <Route element={<MainLayout />}>
              <Route path="/chats" element={<Chats />} />
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
              <Route
                path="/feeds"
                element={
                  <Placeholder
                    title="Feeds"
                    blurb="Status updates from your contacts. Lands in v1 alongside group chats."
                  />
                }
              />
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
