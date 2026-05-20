import { Outlet } from 'react-router-dom';
import { TabBar } from '../components/TabBar';
import { useStore } from '../lib/store';

export function MainLayout() {
  const unreadChats = useStore((s) => s.chats.reduce((n, c) => n + (c.unreadCount ?? 0), 0));
  return (
    <div className="app-shell" style={{ paddingBottom: 0 }}>
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
        <Outlet />
      </div>
      <TabBar unreadChats={unreadChats} />
    </div>
  );
}
