// Skin system for the "Guess the Tune" player. Each skin is pure data:
// a bag of design tokens the player reads as CSS custom properties on a
// scoped `.tune-skin` wrapper (see components/tune/TuneGame.tsx and
// styles/tune-skin.css). Adding a skin is one more entry in TUNE_SKINS.
//
// These are ORIGINAL, late-'90s-media-player-INSPIRED recreations built
// from our own CSS/SVG. No trademarked skin bitmaps, no "base" skin art,
// and no product name/logo is used anywhere — the retro skins are
// labelled generically ("Retro '98", "Classic", "Matrix", "Dolphin").
//
// A skin may also opt into an animated LCD "screen" via the optional
// `screen` field (see the "Dolphin" skin). The token bag stays pure data;
// `screen` just names a self-contained animation the player renders behind
// the status readout (components/tune/TuneDolphin.tsx). The "Dolphin" look
// is an original, from-scratch homage to the leaping-dolphin idle screens
// on late-'90s/early-'00s car head units — our own SVG silhouette and CSS
// keyframes, no product name, logo or captured bitmap.

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
  // Optional animated LCD screen the player renders behind the status
  // readout. Only 'dolphin' today (the leaping-dolphin idle screen). Skins
  // without it show the plain readout, exactly as before.
  screen?: 'dolphin';
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
    // Desaturated blue-gray beveled metal body (Winamp "base" family), NOT
    // light Win95 gray. A top-lit vertical sheen sells the pressed metal;
    // lighter silver highlight top-left + near-black shadow bottom-right give
    // the 3D edge. Gradient lives in the token string so no shared CSS change
    // is needed and the other skins are untouched.
    chromeBg: 'linear-gradient(180deg, #44444f 0%, #3a3a47 55%, #313139 100%)',
    chromeBorder: '#0b0b10',
    bevelLight: '#6f6f80',
    bevelDark: '#131319',
    radius: '3px',
    // Dark charcoal blue-gray titlebar with light silver text (not bright blue),
    // a subtle metal sheen top-to-bottom.
    titlebarBg: 'linear-gradient(180deg, #34343f 0%, #272730 50%, #1d1d25 100%)',
    titlebarText: '#c8ccd9',
    // Sunken green-on-black LCD readout with bright green mono text.
    readoutBg: '#02140a',
    readoutText: '#22ee5a',
    readoutDim: '#178f42',
    readoutRadius: '3px',
    font: MONO,
    // Green meter + gold/amber accent (the classic EQ-slider gold).
    accent: '#22ee5a',
    warn: '#ffcf3f',
    // Beveled metal transport button — same metal family as the chrome, dark glyph.
    btnBg: 'linear-gradient(180deg, #4a4a58 0%, #3d3d4a 100%)',
    btnText: '#0c0c11',
    btnBorder: '#0b0b10',
    playRadius: '4px',
    // Dark inset spectrum strip with bright green bars.
    vizBg: '#02140a',
    vizBar: '#22ee5a',
    // Answer choices: dark metal panels, light silver text, beveled — part of the unit.
    choiceBg: 'linear-gradient(180deg, #4a4a58 0%, #3d3d4a 100%)',
    choiceText: '#d2d5e0',
    choiceBorder: '#0b0b10',
    choiceRadius: '3px',
    choiceAnswerBg: '#178f3c',
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

// Homage to the leaping-dolphin idle screens on late-'90s/early-'00s car
// head units: a glossy black faceplate, a deep blue-black LCD glowing
// cyan, amber-backlit transport glyphs — and a dolphin arcing over a
// shimmering waterline on the screen (see TuneDolphin). Original SVG + CSS;
// no product name, logo or captured art.
const dolphin: TuneSkin = {
  id: 'dolphin',
  name: 'Dolphin',
  screen: 'dolphin',
  tokens: {
    // Glossy black head-unit faceplate with a faint top-lit sheen.
    chromeBg: 'linear-gradient(180deg, #1b1e25 0%, #101319 55%, #05070a 100%)',
    chromeBorder: '#000000',
    bevelLight: '#343842',
    bevelDark: '#000000',
    radius: '7px',
    // Dark faceplate strip with a cyan display-font label.
    titlebarBg: 'linear-gradient(180deg, #14171d 0%, #0a0c11 100%)',
    titlebarText: '#3fe6ff',
    // Deep blue-black LCD, bright cyan segment glow.
    readoutBg: '#00131c',
    readoutText: '#41e8ff',
    readoutDim: '#1f7f96',
    readoutRadius: '5px',
    font: MONO,
    // Cyan display + warm amber warning (the classic head-unit two-tone).
    accent: '#41e8ff',
    warn: '#ffb020',
    // Beveled black transport button with an amber-backlit glyph.
    btnBg: 'linear-gradient(180deg, #23272f 0%, #12151b 100%)',
    btnText: '#ffb020',
    btnBorder: '#000000',
    playRadius: '7px',
    // Cyan spectrum on the same blue-black glass as the LCD.
    vizBg: '#00131c',
    vizBar: '#41e8ff',
    // Answer choices: dark faceplate panels, soft cyan labels.
    choiceBg: 'linear-gradient(180deg, #1a1d24 0%, #0e1116 100%)',
    choiceText: '#9fecff',
    choiceBorder: '#000000',
    choiceRadius: '6px',
    choiceAnswerBg: '#0f7d4a',
    choiceAnswerText: '#eafff4',
    choiceWrongBg: '#8f2f2f',
    choiceWrongText: '#ffffff',
  },
};

export const TUNE_SKINS: readonly TuneSkin[] = [modern, retro98, classic, matrix, dolphin];

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
