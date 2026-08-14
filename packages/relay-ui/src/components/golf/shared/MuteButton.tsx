import { useAudioPrefs } from '../../../lib/audio';

// A quick-mute control shared by the golf HUDs. It toggles the master `muted`
// audio pref (persisted via lib/audio/prefs, read live by the engine so the
// change is instant). Two shapes:
//   • 'sheet' — a full-width secondary button matching the pause-sheet buttons
//     (Putt + Range pause sheets).
//   • 'icon'  — a compact icon button for a HUD top bar (Course, which has no
//     pause sheet).
// A simple speaker glyph doubles as the state read-out (🔈 on / 🔇 muted).

export function MuteButton({ variant = 'sheet' }: { variant?: 'sheet' | 'icon' }) {
  const [prefs, setPrefs] = useAudioPrefs();
  const muted = prefs.muted;
  const toggle = () => setPrefs({ muted: !muted });
  const label = muted ? 'Unmute sound' : 'Mute sound';

  if (variant === 'icon') {
    return (
      <button
        type="button"
        onClick={toggle}
        aria-label={label}
        aria-pressed={muted}
        title={label}
        style={{
          width: 34,
          height: 34,
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          borderRadius: 999,
          fontSize: 15,
          lineHeight: 1,
          background: 'var(--card-bg)',
          color: muted ? 'var(--text-dim)' : 'var(--text)',
          border: '1px solid var(--separator)',
          boxShadow: '0 2px 8px rgba(0,0,0,0.16)',
          pointerEvents: 'auto',
        }}
      >
        {muted ? '🔇' : '🔈'}
      </button>
    );
  }

  return (
    <button
      type="button"
      onClick={toggle}
      aria-pressed={muted}
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
      {muted ? '🔇 Sound off' : '🔈 Sound on'}
    </button>
  );
}
