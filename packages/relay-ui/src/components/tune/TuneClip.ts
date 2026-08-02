import { useCallback, useEffect, useRef, useState } from 'react';

// Owns a single HTMLAudioElement for one round's song-preview clip.
//
// Key constraints, all enforced here so TuneGame doesn't have to think
// about them:
//  - Mobile autoplay needs a user gesture: play() must be called from
//    inside the tap handler, NEVER on a timer. If audio.play() is
//    rejected (no gesture / interrupted) we flip `needsTap` so the UI
//    can offer a "Tap to play" retry.
//  - The clip must stop after maxClipMs of LISTENING. timeupdate fires
//    only ~4x/s, so we cap via a timeupdate check AND a setTimeout
//    backstop — both measured from the random start offset, not 0.
//  - Playback begins at a random offset into the ~30s preview (not always
//    the intro) so replays of the same track differ. `secondsHeard`
//    measures elapsed listening time from that offset, so scoring (based
//    on seconds heard vs. clip length) is unaffected by where we started.
//    pause()/play() resume in place, so a game-level pause can freeze the
//    clip and continue it later.
//  - Everything is torn down (pause + listeners) on unmount and whenever
//    the src changes between rounds. Plain <audio> playback needs no
//    Web Audio API and no CORS headers.
//
// HYBRID audio-reactive equalizer — safety first
// ----------------------------------------------
// Plain <audio> playback is, and always remains, the source of truth for
// SOUND. Real FFT analysis needs the Web Audio API, and routing a
// cross-origin media element through Web Audio MUTES it unless the CDN
// sends CORS headers. So real analysis is engaged ONLY behind a one-time
// session capability probe that has CONFIRMED CORS works, and playback
// correctness always wins:
//  - The probe (startCorsProbe) races canplaythrough/loadeddata against
//    error/timeout on a THROWAWAY element — it never plays or routes the
//    element that carries the game's audio.
//  - `crossOrigin` must be set BEFORE `src`, so it's decided at element
//    creation from the CACHED probe result. The very first round always
//    plays plain (probe not yet resolved) + decorative bars; later rounds
//    upgrade to a CORS-enabled element only once the probe says OK.
//  - Wiring (AudioContext + MediaElementSource + AnalyserNode) happens
//    inside the play tap (mobile autoplay needs the gesture) and is fully
//    guarded: any throw, and if source-node creation succeeds but wiring
//    fails we reconnect the source straight to the speakers so the clip is
//    never left muted.
//  - Defensive: if a CORS-enabled element still errors on load we rebuild
//    it plain (playback recovers); and if the analyser reads all-zeros for
//    ~1s while playback advances we disable real analysis for the session
//    and fall back to the decorative CSS bars.
// A silent clip is unacceptable; a merely-decorative EQ is fine.

export interface TuneClip {
  // Seconds of the clip actually heard so far, capped at maxSeconds.
  secondsHeard: number;
  maxSeconds: number;
  playing: boolean;
  // True once the clip has been started at least once this round.
  started: boolean;
  // Reached the round's max clip length (or the preview ended).
  ended: boolean;
  // audio.play() was rejected — a fresh gesture (re-tap) is required.
  needsTap: boolean;
  // Per-bar spectrum levels (0..1) when REAL Web Audio analysis is live
  // for this clip, else null. TuneVisualizer renders real bar heights from
  // this and falls back to its decorative CSS animation when it's null.
  levels: number[] | null;
  // True while real analysis is driving `levels` (as opposed to the
  // always-safe decorative animation). Purely informational.
  reactive: boolean;
  // Start / resume playback. MUST be called from a user gesture.
  play: () => void;
  // Freeze playback where it is (game pause / on guess). Keeps
  // secondsHeard so scoring and the meter stay correct.
  pause: () => void;
}

// iTunes previews are ~30s. Assume this when the element hasn't reported a
// duration yet, so we can still pick a sane start window.
const PREVIEW_SECONDS = 30;

// Number of spectrum bars we expose — matches TuneVisualizer's default so
// the strip's bar count is identical whether real or decorative.
const ANALYSER_BARS = 20;
// How long to wait for the CORS probe before treating the CDN as blocked.
const PROBE_TIMEOUT_MS = 2500;
// Publish cadence for `levels` (ms). The visualizer eases toward each
// target at 60fps, so a coarse publish keeps re-renders bounded without
// making the bars look choppy.
const PUBLISH_MS = 50;

// ---- session-wide (module-level) capability cache ----
// null = not yet probed; true = CDN sends CORS (real analysis allowed);
// false = blocked / probe failed (decorative only, forever this session).
let corsProbe: boolean | null = null;
let corsProbePromise: Promise<boolean> | null = null;
// Latched true if real analysis ever misbehaves (all-zeros while playing)
// or a CORS-enabled element errors — hard-disables analysis for the
// session so every later round is plain + decorative.
let analyserSessionDisabled = false;

// One-time, side-channel CORS probe. Creates a THROWAWAY element (never
// played, never routed through Web Audio), points it at a real preview
// URL with crossOrigin set, and races a successful load against error /
// timeout. Caches the boolean for the session. Fire-and-forget: the first
// round plays plain regardless; the result only gates LATER rounds.
function startCorsProbe(url: string): Promise<boolean> {
  if (corsProbe !== null) return Promise.resolve(corsProbe);
  if (corsProbePromise) return corsProbePromise;
  corsProbePromise = new Promise<boolean>((resolve) => {
    let done = false;
    let probe: HTMLAudioElement | null = null;
    let timer = 0;
    const cleanup = () => {
      window.clearTimeout(timer);
      if (probe) {
        probe.removeEventListener('canplaythrough', onOk);
        probe.removeEventListener('loadeddata', onOk);
        probe.removeEventListener('error', onErr);
        try {
          probe.removeAttribute('src');
          probe.load();
        } catch {
          /* ignore */
        }
        probe = null;
      }
    };
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      corsProbe = ok;
      cleanup();
      resolve(ok);
    };
    const onOk = () => finish(true);
    const onErr = () => finish(false);
    try {
      probe = new Audio();
      probe.crossOrigin = 'anonymous';
      probe.preload = 'auto';
      // Belt-and-braces: even though we never call play(), keep it muted.
      probe.muted = true;
      probe.addEventListener('canplaythrough', onOk);
      probe.addEventListener('loadeddata', onOk);
      probe.addEventListener('error', onErr);
      probe.src = url;
      probe.load();
      timer = window.setTimeout(() => finish(false), PROBE_TIMEOUT_MS);
    } catch {
      finish(false);
    }
  });
  return corsProbePromise;
}

// Downsample the analyser's byte-frequency data to `barCount` levels in
// 0..1. Music energy sits in the lower bins, so the mostly-empty top
// quarter of the spectrum is dropped before averaging into bars.
function computeBars(data: Uint8Array, barCount: number): number[] {
  const usable = Math.max(barCount, Math.floor(data.length * 0.75));
  const per = usable / barCount;
  const out = new Array<number>(barCount);
  for (let b = 0; b < barCount; b++) {
    const start = Math.floor(b * per);
    const end = Math.max(start + 1, Math.floor((b + 1) * per));
    let sum = 0;
    let n = 0;
    for (let i = start; i < end && i < usable; i++) {
      sum += data[i] ?? 0;
      n++;
    }
    const avg = n ? sum / n : 0;
    // Gentle gain so quiet passages still show life; clamp to 0..1.
    out[b] = Math.min(1, (avg / 255) * 1.15);
  }
  return out;
}

export function useTuneClip(src: string | null, maxClipMs: number): TuneClip {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const capTimerRef = useRef<number | null>(null);
  const maxMsRef = useRef(maxClipMs);
  maxMsRef.current = maxClipMs;
  // Random start offset (seconds) into the preview for the current src, and
  // a latch so it's chosen exactly once per round. secondsHeard is always
  // (currentTime - startOffset), so scoring stays measured from the offset.
  const startOffsetRef = useRef(0);
  const seekAppliedRef = useRef(false);

  // ---- Web Audio analyser plumbing (all guarded, all optional) ----
  // One AudioContext is reused across rounds for this hook instance and
  // closed on unmount. The source/analyser are per-element (recreated each
  // round). `elCorsEligibleRef` records whether the CURRENT element was
  // created CORS-enabled — only such elements may be routed through Web
  // Audio.
  const ctxRef = useRef<AudioContext | null>(null);
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);
  const dataRef = useRef<Uint8Array<ArrayBuffer> | null>(null);
  const wiredElRef = useRef<HTMLAudioElement | null>(null);
  const elCorsEligibleRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const lastPublishRef = useRef(0);
  const zeroSinceRef = useRef(0);
  const lastCtRef = useRef(0);

  const [secondsHeard, setSecondsHeard] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [levels, setLevels] = useState<number[] | null>(null);
  const [reactive, setReactive] = useState(false);
  // Flipped true (per instance) when a CORS-enabled element errors on load,
  // forcing the element to be rebuilt plain so playback always recovers.
  const [disableCrossOrigin, setDisableCrossOrigin] = useState(false);

  const clearCapTimer = () => {
    if (capTimerRef.current != null) {
      window.clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  };

  const cancelRaf = useCallback(() => {
    if (rafRef.current != null) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
  }, []);

  // Hard-disable real analysis for the session and fall back to decorative.
  // The audio graph is left intact (source → analyser → destination), so
  // whether or not we READ the analyser has no effect on audibility; only
  // future rounds change (built plain, analyserSessionDisabled now set).
  // Defensive recovery: the element is permanently routed through the
  // context, so if the graph fell silent because the context suspended, try
  // to resume it — that (not a reconnect) is what makes the current round
  // audible again, since the graph already reaches destination.
  const disableAnalyser = useCallback(() => {
    analyserSessionDisabled = true;
    cancelRaf();
    const ctx = ctxRef.current;
    if (ctx && ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
    setReactive(false);
    setLevels(null);
  }, [cancelRaf]);

  // rAF sampling loop: read the spectrum, watch for the all-zeros-while-
  // playing failure, and publish downsampled bar levels at PUBLISH_MS.
  const startRaf = useCallback(() => {
    if (rafRef.current != null) return; // already running
    const loop = () => {
      const analyser = analyserRef.current;
      const el = audioRef.current;
      const data = dataRef.current;
      if (!analyser || !el || !data) {
        rafRef.current = null;
        return;
      }
      analyser.getByteFrequencyData(data);
      let sum = 0;
      for (let i = 0; i < data.length; i++) sum += data[i] ?? 0;
      const ct = el.currentTime;
      // Defensive: silence FROM the analyser while playback advances means
      // the graph is muted/broken — bail to decorative for the session.
      if (sum === 0) {
        if (ct > lastCtRef.current + 0.01) {
          if (zeroSinceRef.current === 0) zeroSinceRef.current = performance.now();
          else if (performance.now() - zeroSinceRef.current > 1000) {
            disableAnalyser();
            return;
          }
        }
      } else {
        zeroSinceRef.current = 0;
      }
      lastCtRef.current = ct;
      const now = performance.now();
      if (now - lastPublishRef.current >= PUBLISH_MS) {
        lastPublishRef.current = now;
        setLevels(computeBars(data, ANALYSER_BARS));
      }
      rafRef.current = requestAnimationFrame(loop);
    };
    zeroSinceRef.current = 0;
    lastCtRef.current = audioRef.current?.currentTime ?? 0;
    rafRef.current = requestAnimationFrame(loop);
  }, [disableAnalyser]);

  // Lazily build/reuse the Web Audio graph for the current element. Returns
  // true only when real analysis is safely wired. NEVER throws to the
  // caller and never leaves the element muted: if the source node is
  // created but wiring fails, the source is reconnected straight to the
  // speakers before bailing.
  const ensureAnalyser = useCallback((el: HTMLAudioElement): boolean => {
    if (analyserSessionDisabled) return false;
    if (corsProbe !== true) return false;
    if (!elCorsEligibleRef.current) return false;
    try {
      let ctx = ctxRef.current;
      if (!ctx) {
        const AC =
          window.AudioContext ||
          (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
        if (!AC) return false;
        ctx = new AC();
        ctxRef.current = ctx;
      }
      // The play tap is our gesture. A MediaElementSource routes the element
      // EXCLUSIVELY through the context, so the clip goes SILENT while the
      // context is suspended — and resume() is async. So only wire once the
      // context is actually running; if it isn't yet, kick off resume() and
      // stay decorative for now (the element keeps playing natively, fully
      // audible). Real analysis then engages on a later tap/round once the
      // shared context is running. This is what stops a suspended context
      // from ever muting a round.
      if (ctx.state !== 'running') {
        if (ctx.state === 'suspended') void ctx.resume().catch(() => undefined);
        return false;
      }
      // Reuse across pause/resume within a round; (re)build per element.
      if (wiredElRef.current !== el || !sourceRef.current) {
        if (sourceRef.current) {
          try {
            sourceRef.current.disconnect();
          } catch {
            /* ignore */
          }
          sourceRef.current = null;
        }
        if (analyserRef.current) {
          try {
            analyserRef.current.disconnect();
          } catch {
            /* ignore */
          }
          analyserRef.current = null;
        }
        // A MediaElementSource re-routes the element's audio EXCLUSIVELY
        // through the graph — from here the element is silent unless we
        // connect through to the destination.
        const source = ctx.createMediaElementSource(el);
        try {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 128;
          analyser.smoothingTimeConstant = 0.8;
          source.connect(analyser);
          analyser.connect(ctx.destination);
          sourceRef.current = source;
          analyserRef.current = analyser;
          dataRef.current = new Uint8Array(new ArrayBuffer(analyser.frequencyBinCount));
          wiredElRef.current = el;
        } catch {
          // Wiring failed AFTER the element was captured — restore a direct
          // path so the clip is never muted, then fall back to decorative.
          try {
            source.connect(ctx.destination);
          } catch {
            /* ignore */
          }
          sourceRef.current = source;
          wiredElRef.current = el;
          return false;
        }
      }
      // Only report reactive when an analyser is actually wired. Guards the
      // re-tap-after-wiring-failure case, where source+wiredEl are set but
      // analyser is null: without this a re-tap would falsely return true.
      return analyserRef.current != null;
    } catch {
      // createMediaElementSource (or context) threw before capturing the
      // element — playback is untouched; just stay decorative.
      return false;
    }
  }, []);

  // Freeze at the clip budget: pause, drop the backstop, pin the meter to
  // the max and mark the round's audio done.
  const cap = useCallback(() => {
    clearCapTimer();
    cancelRaf();
    const el = audioRef.current;
    if (el) el.pause();
    setSecondsHeard(maxMsRef.current / 1000);
    setPlaying(false);
    setEnded(true);
  }, [cancelRaf]);

  // (Re)arm the setTimeout backstop from the ACTUAL listened position.
  // timeupdate (~4x/s) is the accurate stop; this coarse net just catches
  // the last tick. It's re-armed on every real 'playing' tick and cleared
  // on a stall ('waiting'), so a mid-clip rebuffer after the random seek
  // can't let wall-clock outrun playback and cut the clip short.
  const armBackstop = useCallback(() => {
    const el = audioRef.current;
    if (!el) return;
    clearCapTimer();
    const heardMs = Math.max(0, (el.currentTime - startOffsetRef.current) * 1000);
    const remainingMs = Math.max(0, maxMsRef.current - heardMs);
    capTimerRef.current = window.setTimeout(cap, remainingMs + 120);
  }, [cap]);

  // Choose (once per round) a random start offset into the preview and
  // seek there. Called when the media is seekable (loadedmetadata/canplay)
  // and again, forced, at play() time. If seeking isn't possible we fall
  // back to start = 0. Latched by seekAppliedRef so it runs exactly once.
  const applyStartOffset = useCallback((force: boolean) => {
    const el = audioRef.current;
    if (!el || seekAppliedRef.current) return;
    const hasMeta = Number.isFinite(el.duration) && el.duration > 0;
    // Without metadata we can't trust a seek; wait for it unless forced
    // (play() must proceed even if metadata is somehow still pending).
    if (!hasMeta && !force) return;
    const dur = hasMeta ? el.duration : PREVIEW_SECONDS;
    const maxS = maxMsRef.current / 1000;
    // Latest start that still leaves a full clip's worth of audio.
    const startWindow = Math.max(0, Math.min(PREVIEW_SECONDS, dur) - maxS);
    const canSeek = el.seekable && el.seekable.length > 0 && startWindow > 0.05;
    let start = 0;
    if (canSeek) {
      start = Math.random() * startWindow;
      try {
        el.currentTime = start;
      } catch {
        start = 0; // seeking rejected — begin at the intro
      }
    }
    startOffsetRef.current = start;
    seekAppliedRef.current = true;
  }, []);

  // Build a fresh element per src (per round). Reset all state, wire the
  // timeupdate stop/track and the natural-ended stop, tear everything
  // down on the next src change / unmount.
  useEffect(() => {
    clearCapTimer();
    cancelRaf();
    setSecondsHeard(0);
    setPlaying(false);
    setStarted(false);
    setEnded(false);
    setNeedsTap(false);
    setLevels(null);
    setReactive(false);
    startOffsetRef.current = 0;
    seekAppliedRef.current = false;
    elCorsEligibleRef.current = false;

    if (!src) {
      audioRef.current = null;
      return;
    }

    // Kick the one-time CORS probe on the first clip. Fire-and-forget: this
    // round always plays plain; the cached result only gates later rounds.
    if (corsProbe === null) void startCorsProbe(src);

    // Decide crossOrigin at CREATION (it must precede src). Only enable it
    // once the probe has CONFIRMED CORS, analysis hasn't been disabled, and
    // a prior CORS error hasn't forced this instance back to plain.
    const wantCors = corsProbe === true && !analyserSessionDisabled && !disableCrossOrigin;

    const el = new Audio();
    if (wantCors) {
      try {
        el.crossOrigin = 'anonymous';
      } catch {
        /* ignore — element stays plain */
      }
    }
    elCorsEligibleRef.current = wantCors;
    el.preload = 'auto';
    el.src = src;
    audioRef.current = el;

    const onTime = () => {
      const maxS = maxMsRef.current / 1000;
      // Listening time elapsed since the (possibly non-zero) start offset.
      const heard = el.currentTime - startOffsetRef.current;
      if (heard >= maxS) {
        cap();
        return;
      }
      setSecondsHeard(Math.max(0, heard));
    };
    // A preview shorter than the round's budget ends on its own.
    const onEnded = () => cap();
    // Seek to the random start once the media can be seeked.
    const onSeekable = () => applyStartOffset(false);
    // Keep the coarse backstop honest against buffering: re-arm from the
    // real position when playback (re)starts, drop it while stalled.
    const onPlaying = () => armBackstop();
    const onWaiting = () => clearCapTimer();
    // Safety net: if a CORS-enabled element errors (its URL's CDN may not
    // actually allow CORS), rebuild it PLAIN so playback is never lost —
    // reactivity is sacrificed, never sound. No-op for plain elements, so
    // today's error handling (via the play() promise) is unchanged.
    const onError = () => {
      if (!wantCors) return;
      analyserSessionDisabled = true;
      corsProbe = false;
      setDisableCrossOrigin(true);
    };
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);
    el.addEventListener('loadedmetadata', onSeekable);
    el.addEventListener('canplay', onSeekable);
    el.addEventListener('playing', onPlaying);
    el.addEventListener('waiting', onWaiting);
    el.addEventListener('error', onError);

    return () => {
      clearCapTimer();
      cancelRaf();
      el.pause();
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('loadedmetadata', onSeekable);
      el.removeEventListener('canplay', onSeekable);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeEventListener('error', onError);
      // Detach this round's Web Audio nodes (keep the shared context alive
      // for the next round — one context, reused, is intentional).
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {
          /* ignore */
        }
        sourceRef.current = null;
      }
      if (analyserRef.current) {
        try {
          analyserRef.current.disconnect();
        } catch {
          /* ignore */
        }
        analyserRef.current = null;
      }
      wiredElRef.current = null;
      dataRef.current = null;
      el.removeAttribute('src');
      if (audioRef.current === el) audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src, disableCrossOrigin]);

  // Close the AudioContext exactly once, on unmount.
  useEffect(() => {
    return () => {
      cancelRaf();
      if (sourceRef.current) {
        try {
          sourceRef.current.disconnect();
        } catch {
          /* ignore */
        }
        sourceRef.current = null;
      }
      if (analyserRef.current) {
        try {
          analyserRef.current.disconnect();
        } catch {
          /* ignore */
        }
        analyserRef.current = null;
      }
      const ctx = ctxRef.current;
      ctxRef.current = null;
      if (ctx) {
        try {
          void ctx.close();
        } catch {
          /* ignore */
        }
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const play = useCallback(() => {
    const el = audioRef.current;
    if (!el || ended) return;
    setStarted(true);
    // Make sure the random start offset is applied before we arm the
    // backstop (forced: play() must not stall waiting on metadata).
    applyStartOffset(true);
    // Arm an initial backstop now; the 'playing' listener re-arms it from
    // the real listened position once playback actually starts (post-seek
    // buffering can delay that), so a stall can't cut the clip short.
    armBackstop();

    // Wire real analysis INSIDE the gesture (autoplay policy) — fully
    // guarded so it can never interfere with the play() call below.
    let analysing = false;
    try {
      analysing = ensureAnalyser(el);
    } catch {
      analysing = false;
    }
    if (analysing) {
      setReactive(true);
      startRaf();
    }

    const p = el.play() as unknown as Promise<void> | undefined;
    if (p && typeof p.then === 'function') {
      p.then(
        () => {
          setNeedsTap(false);
          setPlaying(true);
        },
        () => {
          // Rejected (no gesture / interrupted): unwind and ask for a tap.
          clearCapTimer();
          cancelRaf();
          setNeedsTap(true);
          setPlaying(false);
        },
      );
    } else {
      setNeedsTap(false);
      setPlaying(true);
    }
  }, [ended, applyStartOffset, armBackstop, ensureAnalyser, startRaf, cancelRaf]);

  const pause = useCallback(() => {
    clearCapTimer();
    cancelRaf();
    const el = audioRef.current;
    if (el) el.pause();
    setPlaying(false);
  }, [cancelRaf]);

  return {
    secondsHeard,
    maxSeconds: maxClipMs / 1000,
    playing,
    started,
    ended,
    needsTap,
    levels,
    reactive,
    play,
    pause,
  };
}
