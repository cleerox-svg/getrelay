import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../lib/api';
import { getGiphyRandomId } from '../lib/giphy';

export interface GifItem {
  id: string;
  description: string;
  previewUrl: string;
  previewWidth: number;
  previewHeight: number;
  gifUrl: string;
  gifWidth: number;
  gifHeight: number;
  analytics: { onload?: string; onclick?: string; onsent?: string };
}

interface Props {
  open: boolean;
  onClose: () => void;
  // Receives the full item so the caller can fire the onsent pingback once
  // the GIF is actually delivered to the chat.
  onPick: (gif: GifItem) => void;
}

// 250ms debounce on the search box so we don't fire on every keystroke.
function useDebounced<T>(value: T, ms = 250): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const t = window.setTimeout(() => setV(value), ms);
    return () => window.clearTimeout(t);
  }, [value, ms]);
  return v;
}

export function GifPicker({ open, onClose, onPick }: Props) {
  const [q, setQ] = useState('');
  const debouncedQ = useDebounced(q, 250);
  const [items, setItems] = useState<GifItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .searchGifs(debouncedQ)
      .then((r) => {
        if (cancelled) return;
        setItems(r.items);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setError(e.message);
        setItems([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [open, debouncedQ]);

  useEffect(() => {
    if (open) {
      // Brief delay before focus so the slide-up animation can finish.
      const t = window.setTimeout(() => inputRef.current?.focus(), 150);
      return () => window.clearTimeout(t);
    }
  }, [open]);

  // Crude two-column masonry: split items into two columns by index.
  // Good enough for a phone-sized picker without bringing in a layout lib.
  const columns = useMemo(() => {
    const left: GifItem[] = [];
    const right: GifItem[] = [];
    items.forEach((it, i) => (i % 2 === 0 ? left : right).push(it));
    return [left, right];
  }, [items]);

  if (!open) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="GIF picker"
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 50,
        background: 'rgba(0,0,0,0.4)',
        display: 'flex',
        alignItems: 'flex-end',
      }}
      onClick={onClose}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxHeight: '70vh',
          background: 'var(--bubble-them, #FFFFFF)',
          color: 'var(--text)',
          borderTopLeftRadius: 14,
          borderTopRightRadius: 14,
          display: 'flex',
          flexDirection: 'column',
          padding: 10,
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            ref={inputRef}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search GIFs"
            style={{
              flex: 1,
              padding: '8px 12px',
              borderRadius: 999,
              border: '1px solid var(--separator, rgba(0,0,0,0.1))',
              background: 'var(--page-bg, #FFFFFF)',
              color: 'var(--text)',
              fontSize: 14,
              outline: 'none',
            }}
          />
          <button
            type="button"
            onClick={onClose}
            style={{
              fontSize: 14,
              fontWeight: 600,
              color: 'var(--accent)',
              padding: '6px 8px',
              background: 'transparent',
              border: 0,
            }}
          >
            Done
          </button>
        </div>

        <div style={{ flex: 1, overflowY: 'auto', minHeight: 0 }}>
          {error ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>
              {error === 'gifs_not_configured'
                ? 'GIFs aren’t configured yet.'
                : 'Couldn’t load GIFs.'}
            </div>
          ) : loading && items.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>
              Loading…
            </div>
          ) : items.length === 0 ? (
            <div style={{ padding: 20, textAlign: 'center', color: 'var(--text-dim)' }}>
              No results.
            </div>
          ) : (
            <div style={{ display: 'flex', gap: 4 }}>
              {columns.map((col, ci) => (
                <div
                  key={ci}
                  style={{
                    flex: '1 1 0',
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    minWidth: 0,
                  }}
                >
                  {col.map((it) => {
                    const aspect =
                      it.previewWidth && it.previewHeight
                        ? `${it.previewWidth} / ${it.previewHeight}`
                        : '4 / 3';
                    return (
                      <button
                        key={it.id}
                        type="button"
                        onClick={() => {
                          // Register the click with Giphy, then hand the
                          // full item up so the caller can fire onsent.
                          api.registerGifAction(it.analytics.onclick, getGiphyRandomId());
                          onPick(it);
                          onClose();
                        }}
                        style={{
                          display: 'block',
                          width: '100%',
                          padding: 0,
                          border: 0,
                          background: 'transparent',
                          borderRadius: 8,
                          overflow: 'hidden',
                          cursor: 'pointer',
                        }}
                        aria-label={it.description || 'GIF'}
                      >
                        <img
                          src={it.previewUrl}
                          alt={it.description || ''}
                          loading="lazy"
                          style={{
                            display: 'block',
                            width: '100%',
                            aspectRatio: aspect,
                            objectFit: 'cover',
                            background: 'rgba(0,0,0,0.05)',
                          }}
                        />
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
