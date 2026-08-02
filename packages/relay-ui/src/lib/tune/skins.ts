// Skin system for the "Guess the Tune" player. Each skin is pure data:
// a bag of design tokens the player reads as CSS custom properties on a
// scoped `.tune-skin` wrapper (see components/tune/TuneGame.tsx and
// styles/tune-skin.css). Adding a skin is one more entry in TUNE_SKINS.
//
// These are ORIGINAL, late-'90s-media-player-INSPIRED recreations built
// from our own CSS/SVG. No trademarked skin bitmaps, no "base" skin art,
// and no product name/logo is used anywhere — the retro skins are
// labelled generically ("Retro '98", "Classic", "Matrix").

import type { CSSProperties } from 'react';

export interface TuneSkinTokens {
  // Outer player chrome.
  chromeBg: string;
  chromeBorder: string;
  bevelLight: string; // raised-bevel highlight (top-left)
  bevelDark: string; // raised-bevel shadow (bottom-right)
  radius: string;
  // Faux titlebar strip.
  titlebarBg: string;
  titlebarText: string;
  // Inset LCD-style readout.
  readoutBg: string;
  readoutText: string;
  readoutDim: string;
  readoutRadius: string;
  font: string;
  // Meter fill / warning + spectrum accents.
  accent: string;
  warn: string;
  // Transport / play button.
  btnBg: string;
  btnText: string;
  btnBorder: string;
  playRadius: string;
  // Spectrum-analyzer strip.
  vizBg: string;
  vizBar: string;
  // Answer choice buttons.
  choiceBg: string;
  choiceText: string;
  choiceBorder: string;
  choiceRadius: string;
  choiceAnswerBg: string;
  choiceAnswerText: string;
  choiceWrongBg: string;
  choiceWrongText: string;
}

export interface TuneSkin {
  id: string;
  name: string;
  tokens: TuneSkinTokens;
}

// Token key → CSS custom property name. The player only ever references
// these `var(--tune-*)` names, so restyling is entirely data-driven.
const VAR: Record<keyof TuneSkinTokens, string> = {
  chromeBg: '--tune-chrome-bg',
  chromeBorder: '--tune-chrome-border',
  bevelLight: '--tune-bevel-light',
  bevelDark: '--tune-bevel-dark',
  radius: '--tune-radius',
  titlebarBg: '--tune-titlebar-bg',
  titlebarText: '--tune-titlebar-text',
  readoutBg: '--tune-readout-bg',
  readoutText: '--tune-readout-text',
  readoutDim: '--tune-readout-dim',
  readoutRadius: '--tune-readout-radius',
  font: '--tune-font',
  accent: '--tune-accent',
  warn: '--tune-warn',
  btnBg: '--tune-btn-bg',
  btnText: '--tune-btn-text',
  btnBorder: '--tune-btn-border',
  playRadius: '--tune-play-radius',
  vizBg: '--tune-viz-bg',
  vizBar: '--tune-viz-bar',
  choiceBg: '--tune-choice-bg',
  choiceText: '--tune-choice-text',
  choiceBorder: '--tune-choice-border',
  choiceRadius: '--tune-choice-radius',
  choiceAnswerBg: '--tune-choice-answer-bg',
  choiceAnswerText: '--tune-choice-answer-text',
  choiceWrongBg: '--tune-choice-wrong-bg',
  choiceWrongText: '--tune-choice-wrong-text',
};

// Turn a skin into the inline style bag of CSS vars to spread onto the
// `.tune-skin` wrapper. Scoped there so skins never leak app-wide.
export function skinVars(skin: TuneSkin): CSSProperties {
  const out: Record<string, string> = {};
  (Object.keys(skin.tokens) as (keyof TuneSkinTokens)[]).forEach((k) => {
    out[VAR[k]] = skin.tokens[k];
  });
  return out as CSSProperties;
}

const MONO = "'Courier New', ui-monospace, 'DejaVu Sans Mono', monospace";

// Default skin: the flat, theme-aware look the player shipped with.
// Tokens reference the app's theme vars so it still follows light/dark.
const modern: TuneSkin = {
  id: 'modern',
  name: 'Modern',
  tokens: {
    chromeBg: 'var(--card-bg)',
    chromeBorder: 'var(--separator)',
    bevelLight: 'transparent',
    bevelDark: 'transparent',
    radius: '18px',
    titlebarBg: 'transparent',
    titlebarText: 'var(--text-dim)',
    readoutBg: 'transparent',
    readoutText: 'var(--text)',
    readoutDim: 'var(--text-dim)',
    readoutRadius: '12px',
    font: 'inherit',
    accent: 'var(--accent)',
    warn: 'var(--ping)',
    btnBg: 'var(--accent)',
    btnText: '#FFFFFF',
    btnBorder: 'transparent',
    playRadius: '999px',
    vizBg: 'var(--bubble-them)',
    vizBar: 'var(--accent)',
    choiceBg: 'var(--card-bg)',
    choiceText: 'var(--text)',
    choiceBorder: 'var(--separator)',
    choiceRadius: '12px',
    choiceAnswerBg: 'var(--online)',
    choiceAnswerText: '#FFFFFF',
    choiceWrongBg: 'var(--ping)',
    choiceWrongText: '#FFFFFF',
  },
};

// The star: beveled gray chrome, sunken green-on-black LCD readout,
// chunky raised transport buttons, spectrum-analyzer bars. Original art,
// late-'90s vibe.
const retro98: TuneSkin = {
  id: 'retro98',
  name: "Retro '98",
  tokens: {
    chromeBg: '#c3c7cb',
    chromeBorder: '#0a0a0a',
    bevelLight: '#ffffff',
    bevelDark: '#5b5f66',
    radius: '3px',
    titlebarBg: '#20347e',
    titlebarText: '#eaf0ff',
    readoutBg: '#04120a',
    readoutText: '#31ff86',
    readoutDim: '#1f9a55',
    readoutRadius: '3px',
    font: MONO,
    accent: '#31ff86',
    warn: '#ffd23f',
    btnBg: '#c3c7cb',
    btnText: '#0a0a0a',
    btnBorder: '#0a0a0a',
    playRadius: '4px',
    vizBg: '#04120a',
    vizBar: '#31ff86',
    choiceBg: '#c3c7cb',
    choiceText: '#0a0a0a',
    choiceBorder: '#0a0a0a',
    choiceRadius: '3px',
    choiceAnswerBg: '#0a8a3c',
    choiceAnswerText: '#ffffff',
    choiceWrongBg: '#b21f2a',
    choiceWrongText: '#ffffff',
  },
};

// Dark/amber variant of the retro chrome — reads like an old hi-fi
// display.
const classic: TuneSkin = {
  id: 'classic',
  name: 'Classic',
  tokens: {
    chromeBg: '#2b2b2b',
    chromeBorder: '#000000',
    bevelLight: '#5a5a5a',
    bevelDark: '#080808',
    radius: '3px',
    titlebarBg: '#4a3a12',
    titlebarText: '#ffcf6b',
    readoutBg: '#160f02',
    readoutText: '#ffb63f',
    readoutDim: '#a06a1c',
    readoutRadius: '3px',
    font: MONO,
    accent: '#ffb63f',
    warn: '#ff5a3f',
    btnBg: '#3a3a3a',
    btnText: '#ffcf6b',
    btnBorder: '#000000',
    playRadius: '4px',
    vizBg: '#160f02',
    vizBar: '#ffb63f',
    choiceBg: '#3a3a3a',
    choiceText: '#ffcf6b',
    choiceBorder: '#000000',
    choiceRadius: '3px',
    choiceAnswerBg: '#3f8f4f',
    choiceAnswerText: '#ffffff',
    choiceWrongBg: '#8f2f2f',
    choiceWrongText: '#ffffff',
  },
};

// Phosphor green-on-black variant.
const matrix: TuneSkin = {
  id: 'matrix',
  name: 'Matrix',
  tokens: {
    chromeBg: '#0b120b',
    chromeBorder: '#000000',
    bevelLight: '#1f3a1f',
    bevelDark: '#000000',
    radius: '3px',
    titlebarBg: '#04180a',
    titlebarText: '#39ff14',
    readoutBg: '#000000',
    readoutText: '#39ff14',
    readoutDim: '#1f7a1f',
    readoutRadius: '3px',
    font: MONO,
    accent: '#39ff14',
    warn: '#c8ff00',
    btnBg: '#0f1f0f',
    btnText: '#39ff14',
    btnBorder: '#000000',
    playRadius: '4px',
    vizBg: '#000000',
    vizBar: '#39ff14',
    choiceBg: '#0f1f0f',
    choiceText: '#39ff14',
    choiceBorder: '#1f3a1f',
    choiceRadius: '3px',
    choiceAnswerBg: '#1f9a2f',
    choiceAnswerText: '#eafff0',
    choiceWrongBg: '#8f2f1f',
    choiceWrongText: '#ffffff',
  },
};

export const TUNE_SKINS: readonly TuneSkin[] = [modern, retro98, classic, matrix];

export const DEFAULT_TUNE_SKIN_ID = 'modern';

const KEY = 'relay.tuneSkin';

export function resolveSkin(id: string | null | undefined): TuneSkin {
  return TUNE_SKINS.find((s) => s.id === id) ?? TUNE_SKINS[0]!;
}

// Persisted choice. Defaults to `modern`. Private-mode / disabled storage
// degrades to the default rather than throwing.
export function getTuneSkinId(): string {
  try {
    return localStorage.getItem(KEY) ?? DEFAULT_TUNE_SKIN_ID;
  } catch {
    return DEFAULT_TUNE_SKIN_ID;
  }
}

export function setTuneSkinId(id: string): void {
  try {
    localStorage.setItem(KEY, id);
  } catch {
    /* storage unavailable — selection stays per-session */
  }
}
