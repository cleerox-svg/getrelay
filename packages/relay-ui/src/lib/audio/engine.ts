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
// Each SoundId maps to a SoundDef with a procedural `synth`. v1 ships
// synth-only (no binary assets to source/license mid-build). Real royalty-free
// files are opted in ONE place — the SAMPLE_FILES manifest below — never at a
// call site:
//   • SAMPLE_FILES maps a SoundId (or 'music') to a filename under /audio/. It
//     ships EMPTY, so NO fetch/decode happens (zero network, zero 404s) until
//     the user drops a file in and uncomments its line.
//   • on unlock() every manifest entry is fetched + decoded once into an
//     AudioBuffer cache (decode-on-first-gesture);
//   • play() prefers a decoded buffer over the synth, applying {rate, gain}
//     via playbackRate + a per-shot gain node exactly as the synth path does.
// So a manifest entry transparently shadows the synth; drop files in, no code
// churn. A missing/failed file silently falls back to the synth.
// See public/audio/README.md for the drop-in shopping list.

import { getAudioPrefs, subscribeAudioPrefs, type AudioPrefs } from './prefs';

export type SoundId =
  | 'swing' // lofted club contact — airy whoosh + crisp crack; scales with power
  | 'putt' // putter contact — soft low "tock"; quiet, minimal power scaling
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

// Sample drop-in manifest (the ONE opt-in place for real audio). Maps a SoundId
// (or the 'music' loop) to a filename served from /audio/ on Pages. START EMPTY
// so nothing is fetched until a file is added. To activate a sound: drop the
// file in packages/relay-ui/public/audio/ and UNCOMMENT its line here.
const AUDIO_BASE = '/audio/';
const SAMPLE_FILES: Partial<Record<SoundId | 'music', string>> = {
  // swing: 'swing.mp3',
  // putt: 'putt.mp3',
  // land: 'bounce.mp3',
  // splash: 'splash.mp3',
  // sink: 'sink.mp3',
  // ding: 'ding.mp3',
  // music: 'music.mp3', // a seamless ~30–90s loop
};

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

// Kick off decode of any file-backed sounds declared in SAMPLE_FILES (the ONE
// opt-in place). With the manifest empty this loops zero times → no network at
// all. Fire-and-forget; a failed fetch/decode leaves the synth (or, for music,
// the synth bed) fallback in place. The 'music' key decodes to musicBuffer,
// which startMusic prefers over the synth bed.
function decodeAssets(): void {
  if (!ctx) return;
  for (const [key, name] of Object.entries(SAMPLE_FILES) as [SoundId | 'music', string][]) {
    if (!name) continue;
    const url = AUDIO_BASE + name;
    if (key === 'music') {
      if (musicBuffer) continue;
      void fetch(url)
        .then((r) => r.arrayBuffer())
        .then((ab) => ctx!.decodeAudioData(ab))
        .then((buf) => {
          musicBuffer = buf;
        })
        .catch(() => {
          /* keep synth-bed fallback */
        });
      continue;
    }
    if (buffers.has(key)) continue;
    void fetch(url)
      .then((r) => r.arrayBuffer())
      .then((ab) => ctx!.decodeAudioData(ab))
      .then((buf) => buffers.set(key, buf))
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

// --- Music -----------------------------------------------------------------
// Two backends, transparently: a decoded REAL looping track (drop-in — add
// SAMPLE_FILES['music'] and it wins), or a soft synth chord BED fallback. The
// old "root+fifth drone" read as a hum; the bed is a warm major voicing where
// each voice breathes on its own slow tremolo (never a static drone), kept low.
// Menu-vs-round is expressed by ducking (duckMusic).
//
// AUTOPLAY POLICY: music must NEVER create/resume the AudioContext on its own —
// that would log the "AudioContext was not allowed to start" warning. So
// startMusic only records the DESIRED track and starts playback if audio is
// already unlocked; otherwise unlockAudio() starts it the moment the first user
// gesture arrives. stopMusic clears the desire so a later unlock won't revive it.
const MUSIC_FULL = 0.5; // level in the menu/hub
const MUSIC_DUCK = 0.16; // ducked level during active play
let musicNodes: { sources: AudioScheduledSourceNode[]; gain: GainNode } | null = null;
let desiredMusicTrack: string | null = null; // non-null ⇒ music is wanted
let musicDucked = false;
// Decoded real track (drop-in). When present, startMusic loops it instead of the
// synth bed. Populated by decodeAssets from SAMPLE_FILES['music'].
let musicBuffer: AudioBuffer | null = null;

// Build the soft synth chord bed into `dest`, pushing every node onto `sources`
// so stopMusicNodes can stop them. A warm A-major-ish voicing (A2 C#3 E3 B3)
// behind a lowpass, each voice on a very slow, staggered tremolo LFO so the bed
// SHIMMERS rather than hums. Deliberately low level (this is only a fallback).
function buildMusicBed(dest: GainNode, sources: AudioScheduledSourceNode[]): void {
  if (!ctx) return;
  const lp = ctx.createBiquadFilter();
  lp.type = 'lowpass';
  lp.frequency.value = 950;
  lp.Q.value = 0.4;
  lp.connect(dest);
  const voices = [110, 138.59, 164.81, 246.94];
  voices.forEach((f, i) => {
    const o = ctx!.createOscillator();
    o.type = i === 0 ? 'sine' : 'triangle';
    o.frequency.value = f;
    const vg = ctx!.createGain();
    vg.gain.value = 0.15 - i * 0.02; // upper voices softer
    // Per-voice slow tremolo — the bed breathes instead of droning.
    const lfo = ctx!.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 0.05 + i * 0.019; // very slow, staggered per voice
    const lfoGain = ctx!.createGain();
    lfoGain.gain.value = 0.05;
    lfo.connect(lfoGain);
    lfoGain.connect(vg.gain);
    o.connect(vg);
    vg.connect(lp);
    o.start();
    lfo.start();
    sources.push(o, lfo);
  });
}

function actuallyStartMusic(): void {
  // Honor the music pref at the NODE level too: don't run oscillators when music
  // is off (the bus would silence them, but idle oscillators are wasteful). The
  // pref-change subscription (re)starts music when it's turned back on.
  if (!ctx || !musicBus || musicNodes || !prefs.music) return;
  try {
    const g = ctx.createGain();
    g.gain.value = 0.0001;
    g.connect(musicBus);
    const sources: AudioScheduledSourceNode[] = [];
    if (musicBuffer) {
      // Real track — seamless loop on the music bus.
      const src = ctx.createBufferSource();
      src.buffer = musicBuffer;
      src.loop = true;
      src.connect(g);
      src.start();
      sources.push(src);
    } else {
      buildMusicBed(g, sources);
    }
    // Fade in to avoid a click.
    g.gain.setTargetAtTime(musicDucked ? MUSIC_DUCK : MUSIC_FULL, ctx.currentTime, 1.5);
    musicNodes = { sources, gain: g };
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

// Fade + stop the live music nodes WITHOUT clearing the desired track, so a
// music-pref toggle can silence and later revive the same request. Works for
// both the real-track BufferSource and the synth-bed oscillators/LFOs.
function stopMusicNodes(): void {
  if (!ctx || !musicNodes) return;
  try {
    const { sources, gain } = musicNodes;
    gain.gain.setTargetAtTime(0, ctx.currentTime, 0.3);
    for (const s of sources) s.stop(ctx.currentTime + 1.2);
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
  // Lofted club contact (Range launch + Course full swings). A crisp contact
  // CRACK layered under an airy trailing WHOOSH (club/ball through air). `rate`
  // (from shot power) brightens both; the caller passes a matching `gain`.
  // rate 1 ≈ full swing.
  swing: {
    id: 'swing',
    synth: (ctx, out, when, opts) => {
      const r = opts.rate ?? 1;
      // Crisp contact crack — immediate + bright, scales with power.
      noise(ctx, out, when, 0.03, 0.6, 'highpass', 2200 + 2000 * r);
      blip(ctx, out, when, 'triangle', 200 + 120 * r, 0.055, 0.5, 80 + 40 * r);
      // Airy trailing whoosh — bandpassed noise that swells then falls, sweeping
      // brighter with power. This is what makes a swing read differently from a
      // putt: a woosh of air, not just a click.
      const dur = 0.24;
      const src = ctx.createBufferSource();
      src.buffer = getNoise(ctx);
      const bp = ctx.createBiquadFilter();
      bp.type = 'bandpass';
      bp.Q.value = 0.8;
      bp.frequency.setValueAtTime(900 + 700 * r, when);
      bp.frequency.exponentialRampToValueAtTime(2200 + 2600 * r, when + dur * 0.45);
      bp.frequency.exponentialRampToValueAtTime(700 + 400 * r, when + dur);
      const g = ctx.createGain();
      // Floor the gain at `when` (not later) — a GainNode holds its default
      // .value (1.0) for all times before the first scheduled event, which
      // would leak a full-scale click for the first frames of the whoosh.
      g.gain.setValueAtTime(0.0001, when);
      g.gain.exponentialRampToValueAtTime(0.34, when + 0.08); // swell
      g.gain.exponentialRampToValueAtTime(0.0001, when + dur);
      src.connect(bp);
      bp.connect(g);
      g.connect(out);
      src.start(when);
      src.stop(when + dur + 0.02);
    },
  },
  // Putter contact (Mini-Golf strokes + Course putts). A soft, low, short wooden
  // "tock" — quieter than a swing, NO whoosh, minimal power scaling (putts vary
  // little). Deliberately dull + rounded so it never sounds like a full swing.
  putt: {
    id: 'putt',
    synth: (ctx, out, when, opts) => {
      const r = opts.rate ?? 1;
      // Low rounded body — the "tock".
      blip(ctx, out, when, 'sine', 190 + 30 * r, 0.07, 0.42, 110);
      // A gentle click edge so the contact reads, but soft (triangle, low).
      blip(ctx, out, when, 'triangle', 340, 0.028, 0.14);
      // A whisper of mid noise for the felt-on-ball texture.
      noise(ctx, out, when, 0.012, 0.1, 'bandpass', 1500);
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
