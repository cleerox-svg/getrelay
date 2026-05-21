import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Actions,
  ActionsButton,
  ActionsGroup,
  Block,
  Button,
  List,
  ListInput,
  Navbar,
  Page,
} from 'konsta/react';
import { Avatar } from '../components/Avatar';
import { BrandTitle } from '../components/BrandTitle';
import { ApiError, api } from '../lib/api';
import { useStore } from '../lib/store';
import type { StatusPost } from '../lib/types';

const MAX_BODY = 280;

function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)}d`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

export function Feeds() {
  const me = useStore((s) => s.me);
  const [posts, setPosts] = useState<StatusPost[]>([]);
  const [composer, setComposer] = useState('');
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [actionsFor, setActionsFor] = useState<StatusPost | null>(null);
  const pressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressFiredRef = useRef(false);

  async function refresh() {
    try {
      const { posts } = await api.listFeed();
      setPosts(posts);
    } catch {
      /* swallow */
    }
  }

  useEffect(() => {
    refresh();
  }, []);

  async function submit() {
    const text = composer.trim();
    if (!text || posting) return;
    setPosting(true);
    setError(null);
    try {
      await api.postStatus(text);
      setComposer('');
      await refresh();
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.code === 'too_long') setError('280 characters max.');
        else if (err.code === 'empty') setError('Type something first.');
        else setError(err.code);
      } else setError('Failed');
    } finally {
      setPosting(false);
    }
  }

  function pressStart(p: StatusPost) {
    if (!p.mine) return;
    longPressFiredRef.current = false;
    if (pressTimer.current) clearTimeout(pressTimer.current);
    pressTimer.current = setTimeout(() => {
      longPressFiredRef.current = true;
      setActionsFor(p);
    }, 450);
  }
  function pressEnd() {
    if (pressTimer.current) {
      clearTimeout(pressTimer.current);
      pressTimer.current = null;
    }
  }

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

      <h1 className="text-[34px] font-bold tracking-tight px-4 pt-3 pb-1">Feeds</h1>

      {/* Composer */}
      <List strongIos insetIos>
        <ListInput
          type="textarea"
          placeholder="What's up?"
          value={composer}
          maxLength={MAX_BODY}
          onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setComposer(e.target.value)}
        />
      </List>
      <div className="px-4 flex items-center justify-between -mt-2">
        <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
          {composer.trim().length}/{MAX_BODY}
        </span>
        <Button
          small
          onClick={submit}
          className={!composer.trim() || posting ? 'opacity-50 pointer-events-none' : undefined}
        >
          {posting ? 'Posting…' : 'Post'}
        </Button>
      </div>
      {error ? (
        <Block className="text-center text-sm !py-1" style={{ color: 'var(--ping)' }}>
          {error}
        </Block>
      ) : null}

      {/* Feed */}
      {posts.length === 0 ? (
        <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
          <div className="text-base mb-2">No posts yet</div>
          <div className="text-sm">
            Post the first one above, or add contacts to see theirs here.
          </div>
        </Block>
      ) : (
        <div className="px-4 pb-24">
          {posts.map((p) => (
            <div
              key={p.id}
              onMouseDown={() => pressStart(p)}
              onMouseUp={pressEnd}
              onMouseLeave={pressEnd}
              onTouchStart={() => pressStart(p)}
              onTouchEnd={pressEnd}
              onTouchCancel={pressEnd}
              style={{
                background: 'var(--bg)',
                border: '1px solid var(--separator, rgba(0,0,0,0.08))',
                borderRadius: 12,
                padding: '12px 14px',
                marginTop: 10,
                display: 'flex',
                gap: 12,
                alignItems: 'flex-start',
              }}
            >
              <Avatar src={p.avatarUrl} name={p.displayName} size={36} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="flex items-baseline gap-2">
                  <strong style={{ fontSize: 15 }}>{p.displayName}</strong>
                  <span className="text-xs" style={{ color: 'var(--text-dim)' }}>
                    {formatRelative(p.createdAt)}
                  </span>
                </div>
                <div
                  style={{
                    marginTop: 4,
                    fontSize: 15,
                    lineHeight: 1.35,
                    whiteSpace: 'pre-wrap',
                    wordBreak: 'break-word',
                  }}
                >
                  {p.body}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <Actions opened={!!actionsFor} onBackdropClick={() => setActionsFor(null)}>
        <ActionsGroup>
          <ActionsButton
            className="!text-red-500"
            onClick={async () => {
              if (actionsFor) {
                await api.deleteStatus(actionsFor.id).catch(() => undefined);
                setActionsFor(null);
                await refresh();
              }
            }}
          >
            Delete post
          </ActionsButton>
        </ActionsGroup>
        <ActionsGroup>
          <ActionsButton bold onClick={() => setActionsFor(null)}>
            Cancel
          </ActionsButton>
        </ActionsGroup>
      </Actions>
    </Page>
  );
}
