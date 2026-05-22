import { STICKERS, stickerUrl, type Sticker } from '../lib/stickers';

interface Props {
  open: boolean;
  onClose: () => void;
  onPick: (url: string) => void;
}

// Bottom-sheet sticker picker. Mirrors GifPicker's overlay pattern but
// the catalog is static (bundled SVGs from /public/stickers/), so no
// search, no pagination, no loading state — just a grid of stickers,
// tap-to-send.
export function StickerPicker({ open, onClose, onPick }: Props) {
  if (!open) return null;

  function pick(s: Sticker) {
    onPick(stickerUrl(s));
    onClose();
  }

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Sticker picker"
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
          maxHeight: '60vh',
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
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ fontSize: 14, fontWeight: 600, paddingLeft: 6 }}>Stickers</span>
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

        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: 8,
            overflowY: 'auto',
            minHeight: 0,
            padding: 4,
          }}
        >
          {STICKERS.map((s) => (
            <button
              key={s.id}
              type="button"
              onClick={() => pick(s)}
              aria-label={`Send ${s.label} sticker`}
              className="sticker-cell"
            >
              <img
                src={s.path}
                alt={s.label}
                draggable={false}
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
