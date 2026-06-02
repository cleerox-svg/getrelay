import { useEffect, useState } from 'react';
import { Block } from 'konsta/react';
import { api } from '../lib/api';
import type { SportsNewsArticle } from '../lib/types';
import { LeagueChip, sportsCardStyle } from '../components/sportsShared';

// Relative "2h ago" / "3d ago" label; falls back to empty when the
// upstream omitted a publish time (published === 0).
function relativeTime(ms: number): string {
  if (!ms) return '';
  const diff = Date.now() - ms;
  if (diff < 0) return '';
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' }).format(ms);
}

function ArticleCard({ article }: { article: SportsNewsArticle }) {
  return (
    <a
      href={article.url}
      target="_blank"
      rel="noopener noreferrer"
      style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}
    >
      <div className="sports-card" style={sportsCardStyle}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <LeagueChip league={article.league} />
          <span style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--text-dim)', fontWeight: 600 }}>
            {relativeTime(article.published)}
          </span>
        </div>
        <div style={{ display: 'flex', gap: 12 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: 15, fontWeight: 700, lineHeight: 1.25 }}>{article.headline}</div>
            {article.description ? (
              <div
                style={{
                  marginTop: 4,
                  fontSize: 13,
                  color: 'var(--text-dim)',
                  lineHeight: 1.35,
                  display: '-webkit-box',
                  WebkitLineClamp: 3,
                  WebkitBoxOrient: 'vertical',
                  overflow: 'hidden',
                }}
              >
                {article.description}
              </div>
            ) : null}
          </div>
          {article.imageUrl ? (
            <img
              src={article.imageUrl}
              alt=""
              width={72}
              height={72}
              style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 10, flex: '0 0 auto' }}
              onError={(e) => {
                (e.currentTarget as HTMLImageElement).style.display = 'none';
              }}
            />
          ) : null}
        </div>
      </div>
    </a>
  );
}

export function SportsNews() {
  const [articles, setArticles] = useState<SportsNewsArticle[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    api
      .sportsNews()
      .then((r) => {
        if (alive) setArticles(r.articles);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (failed) {
    return (
      <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
        <div className="text-sm">Couldn’t load news right now.</div>
      </Block>
    );
  }
  if (articles === null) {
    return (
      <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
        <div className="text-sm">Loading…</div>
      </Block>
    );
  }
  if (articles.length === 0) {
    return (
      <Block className="text-center !mt-8" style={{ color: 'var(--text-dim)' }}>
        <div className="text-sm">No headlines right now.</div>
      </Block>
    );
  }

  return (
    <div
      className="px-4"
      style={{ paddingBottom: 'calc(96px + env(safe-area-inset-bottom, 0px))' }}
    >
      {articles.map((a) => (
        <ArticleCard key={a.id} article={a} />
      ))}
    </div>
  );
}
