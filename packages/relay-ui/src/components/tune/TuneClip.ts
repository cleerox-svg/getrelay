import { useCallback, useEffect, useRef, useState } from 'react';

// Owns a single HTMLAudioElement for one round's song-preview clip.
//
// Key constraints, all enforced here so TuneGame doesn't have to think
// about them:
//  - Mobile autoplay needs a user gesture: play() must be called from
//    inside the tap handler, NEVER on a timer. If audio.play() is
//    rejected (no gesture / interrupted) we flip `needsTap` so the UI
//    can offer a "Tap to play" retry.
//  - The clip must stop at the round's max length. timeupdate fires only
//    ~4x/s, so we cap via a timeupdate check AND a setTimeout backstop.
//  - MVP plays from 0, no seeking. pause()/play() resume in place, so a
//    game-level pause can freeze the clip and continue it later.
//  - Everything is torn down (pause + listeners) on unmount and whenever
//    the src changes between rounds. Plain <audio> playback needs no
//    Web Audio API and no CORS headers.

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
  // Start / resume playback. MUST be called from a user gesture.
  play: () => void;
  // Freeze playback where it is (game pause / on guess). Keeps
  // secondsHeard so scoring and the meter stay correct.
  pause: () => void;
}

export function useTuneClip(src: string | null, maxClipMs: number): TuneClip {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const capTimerRef = useRef<number | null>(null);
  const maxMsRef = useRef(maxClipMs);
  maxMsRef.current = maxClipMs;

  const [secondsHeard, setSecondsHeard] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [started, setStarted] = useState(false);
  const [ended, setEnded] = useState(false);
  const [needsTap, setNeedsTap] = useState(false);

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

    if (!src) {
      audioRef.current = null;
      return;
    }

    const el = new Audio();
    el.preload = 'auto';
    el.src = src;
    audioRef.current = el;

    const onTime = () => {
      const maxS = maxMsRef.current / 1000;
      if (el.currentTime >= maxS) {
        cap();
        return;
      }
      setSecondsHeard(el.currentTime);
    };
    // A preview shorter than the round's budget ends on its own.
    const onEnded = () => cap();
    el.addEventListener('timeupdate', onTime);
    el.addEventListener('ended', onEnded);

    return () => {
      clearCapTimer();
      el.pause();
      el.removeEventListener('timeupdate', onTime);
      el.removeEventListener('ended', onEnded);
      el.removeAttribute('src');
      if (audioRef.current === el) audioRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [src]);

  const play = useCallback(() => {
    const el = audioRef.current;
    if (!el || ended) return;
    setStarted(true);
    // Arm the setTimeout backstop from the current position — timeupdate
    // alone (~4x/s) is too coarse to stop cleanly on the last tick.
    clearCapTimer();
    const remainingMs = Math.max(0, maxMsRef.current - el.currentTime * 1000);
    capTimerRef.current = window.setTimeout(cap, remainingMs + 120);

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
  }, [ended, cap]);

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
    play,
    pause,
  };
}
