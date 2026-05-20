import { Link } from 'react-router-dom';
import { Block, Navbar, Page } from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { useStore } from '../lib/store';

interface Props {
  title: string;
  blurb: string;
}

export function Placeholder({ title, blurb }: Props) {
  const me = useStore((s) => s.me);
  return (
    <Page>
      <Navbar
        title={<BrandTitle />}
        left={
          <Link to="/profile" className="px-3">
            <Avatar src={me?.avatarUrl ?? null} name={me?.displayName ?? me?.email ?? 'Me'} size={30} />
          </Link>
        }
      />

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">{title}</h1>

      <Block className="flex flex-col items-center text-center gap-2 mt-12">
        <span
          className="inline-block px-3 py-1 rounded-full text-xs font-bold tracking-wider"
          style={{ background: 'var(--surface, #F2F2F7)', color: 'var(--accent)' }}
        >
          COMING IN V1
        </span>
        <div className="max-w-xs leading-relaxed text-sm" style={{ color: 'var(--text-dim)' }}>
          {blurb}
        </div>
      </Block>
    </Page>
  );
}
