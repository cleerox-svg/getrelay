import { Link } from 'react-router-dom';
import { Avatar } from '../components/Avatar';
import { useStore } from '../lib/store';

interface Props {
  title: string;
  blurb: string;
}

export function Placeholder({ title, blurb }: Props) {
  const me = useStore((s) => s.me);
  return (
    <>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '14px 16px 4px',
        }}
      >
        <Link to="/profile" aria-label="Profile">
          <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={32} />
        </Link>
        <div style={{ flex: 1 }} />
      </div>

      <h1 className="large-title">{title}</h1>

      <div
        style={{
          flex: 1,
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          textAlign: 'center',
          padding: 24,
          gap: 8,
        }}
      >
        <div
          style={{
            background: 'var(--surface)',
            color: 'var(--accent)',
            padding: '6px 14px',
            borderRadius: 999,
            fontSize: 12,
            fontWeight: 700,
            letterSpacing: '0.06em',
          }}
        >
          COMING IN V1
        </div>
        <div style={{ color: 'var(--text-dim)', maxWidth: 280, lineHeight: 1.5 }}>{blurb}</div>
      </div>
    </>
  );
}
