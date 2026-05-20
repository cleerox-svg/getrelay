// Emoji picker backed by emoji-mart (Missive). Full Unicode set, search,
// categories, recents, skin tones — all out of the box. Uses the
// "native" set so iOS gets Apple Color Emoji and Android gets Noto Color
// Emoji without us shipping any image assets.

import { useEffect, useState } from 'react';
import data from '@emoji-mart/data';
import Picker from '@emoji-mart/react';

interface Props {
  open: boolean;
  onSelect: (emoji: string) => void;
}

function osIsDark(): boolean {
  if (typeof window === 'undefined') return false;
  const explicit = document.documentElement.getAttribute('data-theme');
  if (explicit === 'dark') return true;
  if (explicit === 'light') return false;
  return window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export default function EmojiPicker({ open, onSelect }: Props) {
  const [dark, setDark] = useState<boolean>(osIsDark);

  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const onMq = () => setDark(osIsDark());
    mq.addEventListener('change', onMq);
    const obs = new MutationObserver(() => setDark(osIsDark()));
    obs.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['data-theme'],
    });
    return () => {
      mq.removeEventListener('change', onMq);
      obs.disconnect();
    };
  }, []);

  if (!open) return null;
  return (
    <div
      role="dialog"
      aria-label="Emoji picker"
      style={{
        position: 'sticky',
        bottom: 'calc(64px + env(safe-area-inset-bottom, 0px))',
        zIndex: 10,
        display: 'flex',
        justifyContent: 'center',
        padding: '0 8px 8px',
      }}
    >
      <Picker
        data={data}
        onEmojiSelect={(e: { native?: string }) => {
          if (e.native) onSelect(e.native);
        }}
        theme={dark ? 'dark' : 'light'}
        set="native"
        previewPosition="none"
        skinTonePosition="search"
        emojiButtonSize={44}
        emojiSize={26}
        navPosition="bottom"
        maxFrequentRows={2}
        // Pin to the parent's width so the picker fits nicely in our 460 px
        // app shell on mobile, and a card-y feel on desktop.
        style={{ width: '100%', maxWidth: 460, borderRadius: 12 }}
      />
    </div>
  );
}
