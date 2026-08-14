// Golf audio engine — a tiny Web Audio SFX + music layer.
//
// Design constraints (see the golf task brief):
//   • NEVER touches the deterministic sim. Nothing here is called from any
//     sim substep()/predict()/snapshot()/restore(); SFX fire only from the GL
//     render layer / HUD event handlers.
//   • Gesture-gated: mobile/PWA autoplay policy forbids audio before a user
//     gesture. `unlockAudio()` (called from a pointer/click handler) lazily
//     creates + resumes the single AudioContext. Until then play() is a no-op.
//   • Safe no-op when disabled, muted, or before unlock — never throws, even
//     when Web Audio is unavailable (older WebViews, SSR, tests).
//
// HYBRID-READY, SYNTH-FIRST registry
// ----------------------------------
// Each SoundId maps to a SoundDef with an OPTIONAL procedural `synth` AND an
// OPTIONAL `src` (a file URL). v1 ships synth-only (no binary assets to
// source/license mid-build). To upgrade a sound to a real royalty-free file
// later, add `src: '/audio/strike.mp3'` to its registry entry — nothing at any
// call site changes:
//   • on unlock() every entry with a `src` is fetched + decoded once into an
//     AudioBuffer cache (decode-on-first-gesture);
//   • play() prefers a decoded buffer over the synth, applying {rate, gain}
//     via playbackRate + a per-shot gain node exactly as the synth path does.
// So `src` transparently shadows `synth`; drop files in, no code churn.

import { getAudioPrefs, subscribeAudioPrefs, type AudioPrefs } from './prefs';

export type SoundId =
  | 'strike' // club/putter contact — brightness+level scale with shot power
  | 'land' // ball's first ground contact / a bounce
  | 'roll' // ball rolling on turf (subtle, throttled)
  | 'splash' // ball into water
  | 'fence' // ball off the boundary fence
  | 'rest' // ball comes to rest
  | 'sink' // ball drops in the cup (rewarding)
  | 'penalty' // water/OB penalty (dissonant buzzer)
  | 'ding' // generic positive confirm / target hit
  | 'ui-club' // club selector change
  | 'ui-tick' // small UI tick (armed / stepper)
  | 'ui-power'; // power meter feedback

export interface PlayOpts {
  // Playback rate multiplier (buffer path) / synth pitch scale (synth path).
  rate?: number;
  // Per-shot gain multiplier (0..~2). Combined with the sfx bus level.
  gain?: number;
}

type SynthFn = (
  ctx: AudioContext,
  out: AudioNode, // per-shot gain node → sfx bus
  when: number, // ctx.currentTime at trigger
  opts: PlayOpts,
) => void;

interface SoundDef {
  id: SoundId;
  synth?: SynthFn;
  // Asset seam — set to a file URL to back this sound with a decoded
  // AudioBuffer instead of the synth (see the module header).
  src?: string;
}

// Bus levels. The sfx/music prefs gate these to 0 when off; master mute gates
// the master to 0. Kept conservative so the game never blares.
const SFX_LEVEL = 0.6;
const MUSIC_LEVEL = 0.35;

// The longest synth tail across the registry is ~0.4 s (sink/ding); disconnect
// each per-shot synth gain node after this so dead nodes don't accumulate.
const MAX_SYNTH_TAIL_MS = 600;

// --- Singleton graph (created lazily on the first unlock) ------------------
let ctx: AudioContext | null = null;
let masterGain: GainNode | null = null;
let sfxBus: GainNode | null = null;
let musicBus: GainNode | null = null;
let unlocked = false;
let prefs: AudioPrefs = getAudioPrefs();

// Decoded file-backed buffers (asset seam). Keyed by SoundId; only populated
// for registry entries that declare a `src`.
const buffers = new Map<SoundId, AudioBuffer>();

// A reusable 1s white-noise buffer for the noise-based synths (splash, land,
// fence tick, ui). Built once per context.
let noiseBuffer: AudioBuffer | null = null;

function getNoise(context: AudioContext): AudioBuffer {
  if (noiseBuffer && noiseBuffer.sampleRate === context.sampleRate) return noiseBuffer;
  const len = Math.floor(context.sampleRate); // 1s
  const buf = context.createBuffer(1, len, context.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < len; i++) data[i] = Math.random() * 2 - 1;
  noiseBuffer = buf;
  return buf;
}

// Re-apply prefs to the live gain buses. Cheap; called on every pref change so
// mute/enable is instant.
function applyPrefs(): void {
  if (!masterGain || !sfxBus || !musicBus || !ctx) return;
  const t = ctx.currentTime;
  masterGain.gain.setTargetAtTime(prefs.muted ? 0 : 1, t, 0.01);
  sfxBus.gain.setTargetAtTime(prefs.sfx ? SFX_LEVEL : 0, t, 0.01);
  musicBus.gain.setTargetAtTime(prefs.music ? MUSIC_LEVEL : 0, t, 0.01);
}

subscribeAudioPrefs((p) => {
  prefs = p;
  applyPrefs();
  // Music pref honored at the node level: stop the pad's oscillators when music
  // is turned off, and (re)create them when it's turned back on and a track is
  // still wanted (never before an unlock gesture).
  if (!prefs.music) stopMusicNodes();
  else if (desiredMusicTrack != null && !musicNodes && isAudioUnlocked()) actuallyStartMusic();
});

// Lazily construct the AudioContext + bus graph. Returns false if Web Audio is
// unavailable (never throws).
function ensureContext(): boolean {
  if (ctx) return true;
  try {
    const AC: typeof AudioContext | undefined =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AC) return false;
    ctx = new AC();
    masterGain = ctx.createGain();
    sfxBus = ctx.createGain();
    musicBus = ctx.createGain();
    sfxBus.connect(masterGain);
    musicBus.connect(masterGain);
    masterGain.connect(ctx.destination);
    prefs = getAudioPrefs();
    applyPrefs();
    return true;
  } catch {
    ctx = null;
    return false;
  }
}

// Kick off decode of any file-backed sounds (asset seam). Fire-and-forget; a
// failed fetch/decode leaves the synth fallback in place.
function decodeAssets(): void {
  if (!ctx) return;
  for (const def of Object.values(REGISTRY)) {
    if (!def.src || buffers.has(def.id)) continue;
    void fetch(def.src)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx!.decodeAudioData(ab))
      .then((buf) => buffers.set(def.id, buf))
      .catch(() => {
        /* keep synth fallback */
      });
  }
}

// Call from a pointer/click handler on the first user interaction in a mode.
// Idempotent and safe to call every gesture; only the first does real work.
export function unlockAudio(): void {
  if (!ensureContext() || !ctx) return;
  if (ctx.state === 'suspended') void ctx.resume().catch(() => {});
  if (!unlocked) {
    unlocked = true;
    decodeAssets();
  }
  // Start any music requested before the first gesture (autoplay-safe deferral).
  if (desiredMusicTrack != null && !musicNodes) actuallyStartMusic();
}

export function isAudioUnlocked(): boolean {
  return unlocked;
}

// --- Playback --------------------------------------------------------------
export function play(id: SoundId, opts: PlayOpts = {}): void {
  // No-op before unlock, when muted, or when SFX are disabled. Never throws.
  if (!unlocked || !ctx || !sfxBus || prefs.muted || !prefs.sfx) return;
  try {
    const when = ctx.currentTime;
    const shot = ctx.createGain();
    shot.gain.value = opts.gain ?? 1;
    shot.connect(sfxBus);

    const buf = buffers.get(id);
    if (buf) {
      const src = ctx.createBufferSource();
      src.buffer = buf;
      src.playbackRate.value = opts.rate ?? 1;
      src.connect(shot);
      src.start(when);
      src.onended = () => shot.disconnect();
      return;
    }
    REGISTRY[id]?.synth?.(ctx, shot, when, opts);
    // The synth's own oscillator/source nodes stop themselves, but the per-shot
    // `shot` gain stays connected to the sfx bus (unlike the buffer path, which
    // disconnects via src.onended). Release it after the longest synth tail so
    // the graph doesn't accumulate dead gain nodes over a session.
    setTimeout(() => shot.disconnect(), MAX_SYNTH_TAIL_MS);
  } catch {
    /* audio must never break the game */
  }
}

// --- Music (bus wired; a placeholder synth pad until real tracks land) ------
// A soft two-oscillator drone pad on the music bus. `track` is stored for the
// future file-backed swap (same seam as SFX) but the stub renders the same pad
// for every track; menu-vs-round is expressed by ducking (duckMusic).
//
// AUTOPLAY POLICY: music must NEVER create/resume the AudioContext on its own —
// that would log the "AudioContext was not allowed to start" warning. So
// startMusic only records the DESIRED track and starts the pad if audio is
// already unlocked; otherwise unlockAudio() starts it the moment the first user
// gesture arrives. stopMusic clears the desire so a later unlock won't revive it.
const MUSIC_FULL = 0.5; // pad level in the menu/hub
const MUSIC_DUCK = 0.16; // ducked level during active play
let musicNodes: { osc: OscillatorNode[]; gain: GainNode } | null = null;
let desiredMusicTrack: string | null = null; // non-null ⇒ music is wanted
let musicDucked = false;

function actuallyStartMusic(): void {
  // Honor the music pref at the NODE level too: don't run oscillators when music
  // is off (the bus would silence them, but idle oscillators are wasteful). The
  // pref-change subscription (re)starts the pad when music is turned back on.
  if (!ctx || !musicBus || musicNodes || !prefs.music) return;
  try {
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(musicBus);
    // Root + fifth drone (A2 + E3). Fades in to avoid a click.
    const freqs = [110, 164.81];
    const osc = freqs.map((f) => {
      const o = ctx!.createOscillator();
      o.type = 'sine';
      o.frequency.value = f;
      o.connect(g);
      o.start();
      return o;
    });
    g.gain.setTargetAtTime(musicDucked ? MUSIC_DUCK : MUSIC_FULL, ctx.currentTime, 1.5);
    musicNodes = { osc, gain: g };
  } catch {
    /* ignore */
  }
}

export function startMusic(track = 'default'): void {
  desiredMusicTrack = track;
  if (isAudioUnlocked()) actuallyStartMusic();
}

// Lower the music under active play (or raise it back in the menu). Safe before
// the pad exists — the level is remembered for actuallyStartMusic().
export function duckMusic(ducked: boolean): void {
  musicDucked = ducked;
  if (musicNodes && ctx) {
    musicNodes.gain.gain.setTargetAtTime(ducked ? MUSIC_DUCK : MUSIC_FULL, ctx.currentTime, 0.6);
  }
}

// Fade + stop the live pad nodes WITHOUT clearing the desired track, so a
// music-pref toggle can silence and later revive the same request.
function stopMusicNodes(): void {
  if (!ctx || !musicNodes) return;
  try {
    const { osc, gain } = musicNodes;
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    for (const o of osc) o.stop(ctx.currentTime + 1.2);
  } catch {
    /* ignore */
  }
  musicNodes = null;
}

export function stopMusic(): void {
  desiredMusicTrack = null;
  stopMusicNodes();
}

// ---------------------------------------------------------------------------
// Procedural synths. Each is a short, cheap graph feeding the per-shot `out`
// node. Kept deliberately compact; tuned by ear, not the physics harness.
// ---------------------------------------------------------------------------

// A pitched oscillator blip with an exponential AD envelope.
function blip(
  ctx: AudioContext,
  out: AudioNode,
  when: number,
  type: OscillatorType,
  freq: number,
  dur: number,
  peak: number,
  freqEnd?: number,
): void {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, when);
  if (freqEnd != null) o.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), when + dur);
  g.gain.setValueAtTime(0.0001, when);
  g.gain.exponentialRampToValueAtTime(peak, when + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  o.connect(g);
  g.connect(out);
  o.start(when);
  o.stop(when + dur + 0.02);
}

// A filtered noise burst (thud / splash / tick).
function noise(
  ctx: AudioContext,
  out: AudioNode,
  when: number,
  dur: number,
  peak: number,
  filter: BiquadFilterType,
  freq: number,
  freqEnd?: number,
): void {
  const src = ctx.createBufferSource();
  src.buffer = getNoise(ctx);
  const bp = ctx.createBiquadFilter();
  bp.type = filter;
  bp.frequency.setValueAtTime(freq, when);
  if (freqEnd != null) bp.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), when + dur);
  const g = ctx.createGain();
  g.gain.setValueAtTime(peak, when);
  g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
  src.connect(bp);
  bp.connect(g);
  g.connect(out);
  src.start(when);
  src.stop(when + dur + 0.02);
}

const REGISTRY: Record<SoundId, SoundDef> = {
  // Club/putter contact. `rate` (from shot power) brightens the click and the
  // thump; the caller also passes a matching `gain`. rate 1 ≈ full swing.
  strike: {
    id: 'strike',
    synth: (ctx, out, when, opts) => {
      const r = opts.rate ?? 1;
      // Bright transient "click".
      noise(ctx, out, when, 0.045, 0.5, 'highpass', 1400 + 1600 * r);
      // Low "thwack" body — pitch and level rise with power.
      blip(ctx, out, when, 'triangle', 150 + 90 * r, 0.09, 0.6, 70 + 30 * r);
    },
  },
  // First ground contact / a bounce. Soft lowpassed thud.
  land: {
    id: 'land',
    synth: (ctx, out, when) => {
      noise(ctx, out, when, 0.07, 0.35, 'lowpass', 420, 160);
      blip(ctx, out, when, 'sine', 90, 0.08, 0.25, 55);
    },
  },
  // Rolling on turf — very short, dark, low gain (throttled by the caller).
  roll: {
    id: 'roll',
    synth: (ctx, out, when) => {
      noise(ctx, out, when, 0.05, 0.12, 'lowpass', 300, 220);
    },
  },
  // Into water — a downward-filtered noise "sploosh" plus a low blob.
  splash: {
    id: 'splash',
    synth: (ctx, out, when) => {
      noise(ctx, out, when, 0.32, 0.5, 'lowpass', 1800, 260);
      blip(ctx, out, when, 'sine', 240, 0.18, 0.3, 90);
    },
  },
  // Off the boundary fence — a short metallic clang (detuned partials + tick).
  fence: {
    id: 'fence',
    synth: (ctx, out, when) => {
      noise(ctx, out, when, 0.03, 0.4, 'highpass', 2600);
      blip(ctx, out, when, 'square', 520, 0.12, 0.28);
      blip(ctx, out, when, 'square', 690, 0.1, 0.2);
    },
  },
  // Ball comes to rest — a soft low settle.
  rest: {
    id: 'rest',
    synth: (ctx, out, when) => {
      blip(ctx, out, when, 'sine', 130, 0.12, 0.18, 90);
    },
  },
  // Drops in the cup — a hollow "plunk" then a bright confirming ding.
  sink: {
    id: 'sink',
    synth: (ctx, out, when) => {
      blip(ctx, out, when, 'sine', 300, 0.14, 0.45, 120); // plunk into the cup
      blip(ctx, out, when, 'sine', 880, 0.35, 0.32); // confirm
      blip(ctx, out, when, 'sine', 1320, 0.35, 0.18); // sparkle partial
    },
  },
  // Penalty — a dissonant descending buzzer.
  penalty: {
    id: 'penalty',
    synth: (ctx, out, when) => {
      blip(ctx, out, when, 'sawtooth', 300, 0.28, 0.32, 90);
      blip(ctx, out, when, 'sawtooth', 315, 0.28, 0.26, 95); // beating detune
    },
  },
  // Generic positive confirm / target hit — a clean bell.
  ding: {
    id: 'ding',
    synth: (ctx, out, when) => {
      blip(ctx, out, when, 'sine', 988, 0.4, 0.38);
      blip(ctx, out, when, 'sine', 1480, 0.4, 0.18);
    },
  },
  // Club selector change — a soft muted click.
  'ui-club': {
    id: 'ui-club',
    synth: (ctx, out, when) => {
      noise(ctx, out, when, 0.02, 0.25, 'bandpass', 1200);
      blip(ctx, out, when, 'triangle', 440, 0.05, 0.2);
    },
  },
  // Small UI tick (armed / stepper).
  'ui-tick': {
    id: 'ui-tick',
    synth: (ctx, out, when) => {
      blip(ctx, out, when, 'square', 1100, 0.03, 0.16);
    },
  },
  // Power-meter feedback — a short rising blip.
  'ui-power': {
    id: 'ui-power',
    synth: (ctx, out, when, opts) => {
      const r = opts.rate ?? 1;
      blip(ctx, out, when, 'triangle', 500 * r, 0.05, 0.18, 760 * r);
    },
  },
};
