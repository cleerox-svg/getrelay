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
//    the src changes between rounds.
//
// The audio element is ALWAYS a plain <audio>: `new Audio()` with
// `preload='auto'` and the src set directly, no `crossOrigin` and no Web
// Audio API. Deezer's 30s previews are cross-origin and don't reliably
// send CORS headers, so anything that needs CORS (a routed
// MediaElementSource / real FFT analysis) would MUTE the clip or fail to
// load it. Plain playback is the only reliable path; the equalizer strip
// in TuneVisualizer is a purely decorative CSS animation keyed off
// playback state, never real analysis.
//
// Because a small fraction of preview URLs are dead / expired /
// geo-blocked and simply error on load, we surface a `loadFailed` signal
// (set from the element's `error` event, distinguished from benign
// events by `el.error` being populated) so the game can transparently
// swap in a fresh track instead of stranding the player on a silent clip.

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
  // The media element hit a genuine load/decode error (dead/expired/geo-
  // blocked preview URL). The game watches this to swap in a fresh track.
  // Reset to false whenever a new src is loaded.
  loadFailed: boolean;
  // Start / resume playback. MUST be called from a user gesture.
  play: () => void;
  // Freeze playback where it is (game pause / on guess). Keeps
  // secondsHeard so scoring and the meter stay correct.
  pause: () => void;
}

// iTunes/Deezer previews are ~30s. Assume this when the element hasn't
// reported a duration yet, so we can still pick a sane start window.
const PREVIEW_SECONDS = 30;

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

  const [secondsHeard, setSecondsHeard] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);

  const clearCapTimer = () => {
    if (capTimerRef.current != null) {
      window.clearTimeout(capTimerRef.current);
      capTimerRef.current = null;
    }
  };

  // Freeze at the clip budget: pause, drop the backstop, pin the meter to
  // the max and mark the round's audio done.
  const cap = useCallback(() => {
    clearCapTimer();
    const el = audioRef.current;
    if (el) el.pause();
    setSecondsHeard(maxMsRef.current / 1000);
    setPlaying(false);
    setEnded(true);
  }, []);

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
    setSecondsHeard(0);
    setPlaying(false);
    setStarted(false);
    setEnded(false);
    setNeedsTap(false);
    setLoadFailed(false);
    startOffsetRef.current = 0;
    seekAppliedRef.current = false;

    if (!src) {
      audioRef.current = null;
      return;
    }

    // Always a plain element: no crossOrigin, no Web Audio. This is the
    // only reliable way to play cross-origin Deezer previews.
    const el = new Audio();
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
    // Genuine load/decode failure (dead / expired / geo-blocked preview).
    // The `error` event only fires for real media errors and populates
    // `el.error`; guard on it so benign events can't trip the signal. The
    // game reacts by transparently swapping in a fresh track.
    const onError = () => {
      if (el.error != null) setLoadFailed(true);
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
      // Drop the error listener BEFORE detaching the source so removing the
      // src can't fire a stray 'error' that trips loadFailed on teardown.
      el.removeEventListener('error', onError);
      el.pause();
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeEventListener('loadedmetadata', onSeekable);
      el.removeEventListener('canplay', onSeekable);
      el.removeEventListener('playing', onPlaying);
      el.removeEventListener('waiting', onWaiting);
      el.removeAttribute('src');
      if (audioRef.current === el) audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

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
          setNeedsTap(true);
          setPlaying(false);
        },
      );
    } else {
      setNeedsTap(false);
      setPlaying(true);
    }
  }, [ended, applyStartOffset, armBackstop]);

  const pause = useCallback(() => {
    clearCapTimer();
    const el = audioRef.current;
    if (el) el.pause();
    setPlaying(false);
  }, []);

  return {
    secondsHeard,
    maxSeconds: maxClipMs / 1000,
    playing,
    started,
    ended,
    needsTap,
    loadFailed,
    play,
    pause,
  };
}
