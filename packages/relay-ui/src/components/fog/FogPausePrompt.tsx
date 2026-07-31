import { useEffect } from 'react';

// The pause sheet shown when a back gesture interrupts a guess game.
// Deliberately NOT a Konsta Dialog: this sits on top of a live, frozen
// canvas and has to read as "the game is still here, you're on top of
// it", so it's the same hand-rolled scrim + card idiom as the media
// pickers (StickerPicker/GifPicker) with the shared token palette.

interface Props {
  roundNo: number;
  rounds: number;
  score: number;
  onResume: () => void;
  onEnd: () => void;
}

export function FogPausePrompt({ roundNo, rounds, score, onResume, onEnd }: Props) {
  // Escape is the desktop twin of the back gesture — same meaning as
  // tapping outside: resume, never a silent end.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onResume();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onResume]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Game paused"
      onClick={onResume}
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        background: 'rgba(0,0,0,0.45)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        className="fade-in"
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth: 320,
          background: 'var(--card-bg)',
          color: 'var(--text)',
          border: '1px solid var(--separator)',
          borderRadius: 18,
          padding: 20,
          boxShadow: '0 16px 40px rgba(0,0,0,0.32)',
          textAlign: 'center',
        }}
      >
        <div style={{ fontSize: 19, fontWeight: 700 }}>Game paused</div>
        <div
          className="tabular-nums"
          style={{ fontSize: 13, paddingTop: 4, color: 'var(--text-dim)' }}
        >
          Round {roundNo} of {rounds} · {score.toLocaleString()} pts
        </div>
        <div style={{ fontSize: 13, paddingTop: 10, lineHeight: 1.45, color: 'var(--text-dim)' }}>
          Your fog, wipe budget and round clock are frozen right where you left
          them.
        </div>

        <button
          type="button"
          onClick={onResume}
          style={{
            width: '100%',
            marginTop: 16,
            borderRadius: 12,
            border: 0,
            padding: '13px 0',
            fontSize: 15,
            fontWeight: 700,
            background: 'var(--accent)',
            color: '#FFFFFF',
          }}
        >
          Resume
        </button>
        <button
          type="button"
          onClick={onEnd}
          style={{
            width: '100%',
            marginTop: 8,
            borderRadius: 12,
            border: '1px solid var(--separator)',
            padding: '13px 0',
            fontSize: 15,
            fontWeight: 600,
            background: 'transparent',
            color: 'var(--text)',
          }}
        >
          End game
        </button>
      </div>
    </div>
  );
}
