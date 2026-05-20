import { useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { wireWsToStore } from './lib/store';
import { AddContact } from './routes/AddContact';
import { Chat } from './routes/Chat';
import { Chats } from './routes/Chats';
import { Onboarding } from './routes/Onboarding';
import { Profile } from './routes/Profile';
import { RequireAuth } from './routes/RequireAuth';
import { SignIn } from './routes/SignIn';

export function App() {
  useEffect(() => {
    wireWsToStore();
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/signin" element={<SignIn />} />
        <Route element={<RequireAuth />}>
          <Route path="/onboarding" element={<Onboarding />} />
          <Route path="/chats" element={<Chats />} />
          <Route path="/chats/:id" element={<Chat />} />
          <Route path="/add-contact" element={<AddContact />} />
          <Route path="/profile" element={<Profile />} />
        </Route>
        <Route path="/" element={<Navigate to="/chats" replace />} />
        <Route path="*" element={<Navigate to="/chats" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
