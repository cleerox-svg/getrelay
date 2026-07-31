import { useEffect, useRef, useState } from 'react';
import { FogCanvas } from './FogCanvas';
import type { FogCanvasHandle } from './FogCanvas';
import type { BrushHardness } from '../../lib/fog/engine';
import { api } from '../../lib/api';
import type { SportsTeamMeta } from '../../lib/types';

// Free-play sandbox: doodle in the condensation with adjustable brush
// and fog, over any background — flat color, a team logo, a Giphy
// result (animated is fine here since nothing is scored), or a photo
// from the device.

type RefogSpeed = 'off' | 'slow' | 'med' | 'fast';
const REFOG_RATES: Record<RefogSpeed, number> = {
  off: 0,
  slow: 0.004,
  med: 0.01,
  fast: 0.02,
};

const COLOR_SWATCHES = [
  '#E4573D', '#F5A623', '#FBC02D', '#4CAF6D', '#2EC4B6',
  '#4A90D9', '#7E57C2', '#F48FB1', '#3B4754', '#FFFFFF',
];

type Background =
  | { type: 'color'; value: string }
  | { type: 'image'; url: string };

type BgTab = 'colors' | 'teams' | 'gifs' | 'upload';

export function FreePlay() {
  const canvasRef = useRef<FogCanvasHandle | null>(null);
  const [brushSize, setBrushSize] = useState(44);
  const [hardness, setHardness] = useState<BrushHardness>('soft');
  const [density, setDensity] = useState(0.9);
  const [refogSpeed, setRefogSpeed] = useState<RefogSpeed>('slow');
  const [bg, setBg] = useState<Background>({ type: 'color', value: '#4A90D9' });
  const [showControls, setShowControls] = useState(true);
  const [bgTab, setBgTab] = useState<BgTab>('colors');

  // Teams tab
  const [teams, setTeams] = useState<SportsTeamMeta[] | null>(null);
  useEffect(() => {
    if (bgTab !== 'teams' || teams !== null) return;
    api
      .getSportsTeams()
      .then((r) => setTeams([...r.nhl, ...r.mlb].filter((t) => t.logo)))
      .catch(() => setTeams([]));
  }, [bgTab, teams]);

  // GIFs tab
  const [gifQ, setGifQ] = useState('');
  const [gifItems, setGifItems] = useState<{ id: string; previewUrl: string; gifUrl: string; description: string }[]>([]);
  const [gifError, setGifError] = useState<string | null>(null);
  const [gifLoading, setGifLoading] = useState(false);
  function searchGifs(q: string) {
    setGifLoading(true);
    setGifError(null);
    api
      .searchGifs(q)
      .then((r) => setGifItems(r.items))
      .catch((e: Error) => {
        setGifItems([]);
        setGifError(e.message === 'gifs_not_configured' ? 'GIFs aren’t configured yet.' : 'Couldn’t load GIFs.');
      })
      .finally(() => setGifLoading(false));
  }
  useEffect(() => {
    if (bgTab === 'gifs' && gifItems.length === 0 && !gifError) searchGifs('');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bgTab]);

  // Upload tab — object URLs must be revoked when replaced or on
  // unmount, or every picked photo leaks its blob for the session.
  const objectUrlRef = useRef<string | null>(null);
  useEffect(
    () => () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    },
    [],
  );
  function onUpload(file: File | null) {
    if (!file) return;
    if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    setBg({ type: 'image', url });
  }
  function setImageBg(url: string) {
    // Switching away from an uploaded photo releases its blob.
    if (objectUrlRef.current && url !== objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = null;
    }
    setBg({ type: 'image', url });
  }

  const chipStyle = (active: boolean): React.CSSProperties => ({
    border: '1px solid var(--separator)',
    background: active ? 'var(--accent)' : 'var(--card-bg)',
    color: active ? '#FFFFFF' : 'var(--text)',
    borderRadius: 999,
    padding: '6px 12px',
    fontSize: 13,
    fontWeight: 600,
  });

  return (
    <div className="px-4">
      <FogCanvas
        ref={canvasRef}
        imageUrl={bg.type === 'image' ? bg.url : null}
        background={bg.type === 'color' ? bg.value : null}
        refogRate={REFOG_RATES[refogSpeed]}
        brushSizePx={brushSize}
        brushHardness={hardness}
        fogDensity={density}
        wipeEnabled
      />

      {/* Action row */}
      <div className="flex gap-2 pt-3">
        <button type="button" style={chipStyle(false)} onClick={() => canvasRef.current?.breathe()}>
          Breathe
        </button>
        <button type="button" style={chipStyle(false)} onClick={() => canvasRef.current?.clearFog()}>
          Clear fog
        </button>
        <button type="button" style={chipStyle(false)} onClick={() => canvasRef.current?.reset()}>
          Reset
        </button>
        <button
          type="button"
          className="ml-auto"
          style={chipStyle(showControls)}
          onClick={() => setShowControls((v) => !v)}
        >
          Controls
        </button>
      </div>

      {showControls ? (
        <div
          className="mt-3 rounded-2xl p-4 flex flex-col gap-4"
          style={{ background: 'var(--card-bg)', border: '1px solid var(--separator)' }}
        >
          <label className="flex items-center gap-3 text-sm" style={{ color: 'var(--text)' }}>
            <span className="w-20 shrink-0" style={{ color: 'var(--text-dim)' }}>Brush</span>
            <input
              type="range"
              min={12}
              max={96}
              value={brushSize}
              onChange={(e) => setBrushSize(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-10 text-right tabular-nums text-xs" style={{ color: 'var(--text-dim)' }}>
              {brushSize}px
            </span>
          </label>

          <div className="flex items-center gap-3 text-sm">
            <span className="w-20 shrink-0" style={{ color: 'var(--text-dim)' }}>Edge</span>
            {(['soft', 'hard'] as const).map((h) => (
              <button key={h} type="button" style={chipStyle(hardness === h)} onClick={() => setHardness(h)}>
                {h === 'soft' ? 'Soft' : 'Hard'}
              </button>
            ))}
          </div>

          <label className="flex items-center gap-3 text-sm" style={{ color: 'var(--text)' }}>
            <span className="w-20 shrink-0" style={{ color: 'var(--text-dim)' }}>Fog</span>
            <input
              type="range"
              min={0.75}
              max={1}
              step={0.01}
              value={density}
              onChange={(e) => setDensity(Number(e.target.value))}
              className="flex-1"
            />
            <span className="w-10 text-right tabular-nums text-xs" style={{ color: 'var(--text-dim)' }}>
              {Math.round(density * 100)}%
            </span>
          </label>

          <div className="flex items-center gap-2 text-sm flex-wrap">
            <span className="w-20 shrink-0" style={{ color: 'var(--text-dim)' }}>Refog</span>
            {(['off', 'slow', 'med', 'fast'] as const).map((s) => (
              <button key={s} type="button" style={chipStyle(refogSpeed === s)} onClick={() => setRefogSpeed(s)}>
                {s}
              </button>
            ))}
          </div>

          {/* Background picker */}
          <div>
            <div className="flex gap-2 pb-3">
              {(
                [
                  ['colors', 'Colors'],
                  ['teams', 'Teams'],
                  ['gifs', 'GIFs'],
                  ['upload', 'Photo'],
                ] as const
              ).map(([key, label]) => (
                <button key={key} type="button" style={chipStyle(bgTab === key)} onClick={() => setBgTab(key)}>
                  {label}
                </button>
              ))}
            </div>

            {bgTab === 'colors' ? (
              <div className="flex gap-2 flex-wrap">
                {COLOR_SWATCHES.map((c) => (
                  <button
                    key={c}
                    type="button"
                    aria-label={`background ${c}`}
                    onClick={() => setBg({ type: 'color', value: c })}
                    className="w-9 h-9 rounded-full"
                    style={{
                      background: c,
                      border:
                        bg.type === 'color' && bg.value === c
                          ? '3px solid var(--accent)'
                          : '1px solid var(--separator)',
                    }}
                  />
                ))}
              </div>
            ) : bgTab === 'teams' ? (
              teams === null ? (
                <div className="text-sm" style={{ color: 'var(--text-dim)' }}>Loading teams…</div>
              ) : teams.length === 0 ? (
                <div className="text-sm" style={{ color: 'var(--text-dim)' }}>Couldn’t load teams.</div>
              ) : (
                <div className="grid grid-cols-6 gap-2">
                  {teams.map((t) => (
                    <button
                      key={`${t.key}-${t.abbr}`}
                      type="button"
                      aria-label={t.name}
                      onClick={() => t.logo && setImageBg(t.logo)}
                      className="rounded-lg p-1"
                      style={{ border: '1px solid var(--separator)', background: 'var(--page-bg)' }}
                    >
                      <img src={t.logo ?? ''} alt="" className="w-full aspect-square object-contain" />
                    </button>
                  ))}
                </div>
              )
            ) : bgTab === 'gifs' ? (
              <div className="flex flex-col gap-2">
                <form
                  className="flex gap-2"
                  onSubmit={(e) => {
                    e.preventDefault();
                    searchGifs(gifQ);
                  }}
                >
                  <input
                    value={gifQ}
                    onChange={(e) => setGifQ(e.target.value)}
                    placeholder="Search GIFs"
                    className="flex-1 rounded-full px-3 py-2 text-sm outline-none"
                    style={{
                      border: '1px solid var(--separator)',
                      background: 'var(--page-bg)',
                      color: 'var(--text)',
                    }}
                  />
                  <button type="submit" style={chipStyle(false)}>
                    Search
                  </button>
                </form>
                {gifError ? (
                  <div className="text-sm" style={{ color: 'var(--text-dim)' }}>{gifError}</div>
                ) : gifLoading ? (
                  <div className="text-sm" style={{ color: 'var(--text-dim)' }}>Loading…</div>
                ) : (
                  <div className="grid grid-cols-3 gap-1">
                    {gifItems.map((it) => (
                      <button
                        key={it.id}
                        type="button"
                        aria-label={it.description || 'GIF'}
                        onClick={() => setImageBg(it.gifUrl)}
                        className="rounded-lg overflow-hidden"
                        style={{ border: 0, padding: 0, background: 'transparent' }}
                      >
                        <img
                          src={it.previewUrl}
                          alt=""
                          loading="lazy"
                          className="w-full aspect-square object-cover block"
                          style={{ background: 'rgba(0,0,0,0.05)' }}
                        />
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <label
                className="flex items-center justify-center rounded-xl py-6 text-sm cursor-pointer"
                style={{ border: '1px dashed var(--separator)', color: 'var(--text-dim)' }}
              >
                Pick a photo…
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onUpload(e.target.files?.[0] ?? null)}
                />
              </label>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
