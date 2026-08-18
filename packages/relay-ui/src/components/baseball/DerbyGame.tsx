import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api';
import { play } from '../../lib/audio';
import { vLen } from '../../lib/baseball/airPhysics';
import { contactWindowS } from '../../lib/baseball/contactWindow';
import { DerbySim } from '../../lib/baseball/derbySim';
import type { DerbyState, SwingResult } from '../../lib/baseball/derbyState';
import type { Park } from '../../lib/baseball/parks';
import { PITCH_TEMPO } from '../../lib/baseball/tuning';
import { MONO_NUM, frostedSurface } from '../golf/shared/frosted';
import { CountChip } from './shared/CountChip';
import { useDerbyBoard } from './shared/derbyBoard';
import { ExitVeloTag } from './shared/ExitVeloTag';
import { useDaylight } from './shared/prefs';
import { TimingBar } from './shared/TimingBar';
import { coachSwing, describeSwing, parkCopyNumbers } from './shared/swingCopy';
import { ZoneReticle } from './shared/ZoneReticle';
import type { CameraMode, StadiumApi } from './StadiumGL';
import type { FlightPaths } from './stadium/flight';
import type { PitchTrack } from '../../lib/baseball/pitchSim';

// Home Run Derby — the HUD. Three layers, and this file is the middle one.
//
//   SIM owns state   `DerbySim`. Every number below was produced by it.
//   GL renders       `StadiumGL`, told where the ball and the reticle are.
//   HUD polls        this file, at POLL_MS, and never renders per frame.
//
// ⚠ `three` IS LAZY. `StadiumGL` is the only `lazy()` import here, so the whole
// renderer lands in its own chunk and the Games hub does not pay for it. Nothing
// else in this file — `derbySim`, `derbyState`, `tuning`, the widgets — may
// touch `three`, and `budget.test.ts` asserts it rather than trusting it.
//
// ⚠ THE ONE CLOCK, AND THE DIRECTION OF THE TEMPO. `pitchSim` integrates at TRUE
// physical time and cannot see `PITCH_TEMPO`; the playback here is
//
//     trueS = wallElapsedS × PITCH_TEMPO           (0.45 → slow motion)
//
// so a 0.41 s pitch takes 0.91 s of wall clock, and `swing()` is called with the
// TRUE time. It is a MULTIPLY. Dividing instead (wall / 0.45) would hand the sim
// 2.02 s at the moment the ball reached the plate — 4.9× past the crossing,
// which is 1600 ms of "late" against a ±26.4 ms contact window, i.e. every
// single swing a whiff and the bug looking like broken collision physics.
// `StadiumGL`'s own live-playback branch multiplies for the same reason; this is
// the same identity written once more because this file, not that one, is what
// reaches `DerbySim.swing`.

const StadiumGL = lazy(() => import('./StadiumGL'));

/** HUD poll period, ms. The charter's number: a HUD does not render per frame. */
const POLL_MS = 120;

/**
 * Wall-clock beat between pressing Pitch and the ball leaving the hand, ms.
 *
 * ⚠ FEEL KNOB — and it is also load-bearing. `flight` reaches `StadiumGL` on the
 * next React commit, so a clock that started at `performance.now()` would ask
 * the renderer for a time on a track it had not been given yet. The lead makes
 * the play clock NEGATIVE until release (the ball is simply not drawn), which
 * covers the commit with room to spare and reads as a wind-up.
 */
const PITCH_LEAD_MS = 380;

/** How long the result sits on screen before the next aim, ms. FEEL KNOB. */
const RESULT_HOLD_MS = 1500;

/** Extra true-physical seconds a late tap is still accepted for. FEEL KNOB. */
const SWING_TAIL_S = 0.06;

/**
 * Shortest hang time that earns the pull-back to the deck camera, s. FEEL KNOB.
 *
 * ⚠ IT EXISTS BECAUSE THE EASE HAS A LENGTH. `stadium/camera.ts` takes
 * `CAMERA_EASE_S = 0.8` to travel from the box to the upper deck, so on a ball
 * hanging 1.0 s the camera arrives as the ball lands and immediately reverses —
 * a swoop out and straight back, spent on a routine grounder the batter camera
 * already contains (it lands inside the infield arc, 128–156 ft out, dead
 * ahead). A presentation decision, which is the HUD's to make: no sim, score or
 * fielding number reads it. `DerbyGame.camera.test.tsx` asserts both sides.
 */
const FOLLOW_MIN_HANG_S = 1.2;

/** The play clock: a WALL ms origin, and the crossing it changes rate at. */
interface PlayClock {
  t0: number;
  endS: number;
  plateT: number;
  /** Wall seconds from `t0` to the plate crossing — DERIVED, see `trueTimeOf`. */
  wallAtPlate: number;
}

/**
 * Wall ms since `t0` → TRUE PHYSICAL seconds since release.
 *
 * ⚠ THE PLAYBACK RATE IS PIECEWISE, AND `dt` IS STILL NEVER TOUCHED. Before the
 * plate the track is played at `PITCH_TEMPO`, which is what makes a 0.41 s pitch
 * reactable at all. AFTER it the batted ball plays at REAL TIME, because a fly
 * ball hangs 5.7 s and nothing about that needs slowing down — at 0.45 the same
 * home run takes 12.7 s of wall clock and a 24-pitch session becomes five
 * minutes of watching a dot. Measured on `derbySim.test.ts`'s own numbers
 * (hang 5.66 s on the 105 mph reference fly); real time makes it 6.4 s of play
 * and the session about three minutes.
 *
 * This is a RENDER-LAYER clock and nothing else. Both branches ask the sim's
 * precomputed track for a TRUE physical instant, so no integration step, no
 * gravity/aero weighting and no break, exit-velocity or carry number moves by a
 * single digit. `PITCH_TEMPO` still cannot reach `lib/baseball` — a source guard
 * enforces it — and `swing()` is still handed the output of THIS function.
 */
function trueTimeOf(c: PlayClock, wallS: number): number {
  const t = wallS <= c.wallAtPlate ? wallS * PITCH_TEMPO : c.plateT + (wallS - c.wallAtPlate);
  return Math.min(c.endS, t);
}

export interface DerbyGameResult {
  score: number;
  /** DERBY ROUNDS, never swings — `derbyState.roundsPlayed` says so. */
  roundsPlayed: number;
  bestStreak: number;
  homeRuns: number;
  barrels: number;
  bestFt: number;
}

export interface DerbyGameProps {
  /**
   * Session seed. A seed replays a session exactly — same pitches, same
   * locations, same weather.
   *
   * ⚠ OPTIONAL, AND THE DEFAULT IS THE ONLY WALL-CLOCK READ THAT CAN CHANGE THE
   * OUTCOME. It is taken ONCE, in a lazy initialiser, and never again; pass a
   * seed and the whole session replays. (`performance.now()` is read in three
   * more places — the pause shift, the play loop and `swingNow` — but every one
   * of them is the PLAY CLOCK, i.e. when the player's tap landed, which is
   * input, not sim state. A fixture that drives `performance.now()` itself,
   * which `DerbyGame.test.tsx` does, therefore gets a byte-identical session.)
   * `Math.random` is not used here or anywhere in baseball — `determinism.test`
   * reads the sim sources, and the byte-identical-PNG guarantee depends on it.
   */
  seed?: number;
  park?: Park;
  paused?: boolean;
  onFinish?: (result: DerbyGameResult) => void;
  /** Leave mid-session. The partial run is banked by the unmount net below. */
  onExit?: () => void;
}

type Stage = 'aim' | 'flight' | 'result' | 'over';

function Spinner() {
  return (
    <div
      style={{
        position: 'absolute',
        inset: 0,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: 14,
        fontWeight: 600,
      }}
    >
      Building the park…
    </div>
  );
}

export function DerbyGame({ seed, park, paused = false, onFinish, onExit }: DerbyGameProps) {
  const [sim] = useState(
    () => new DerbySim({ seed: seed ?? (Date.now() >>> 0), ...(park ? { park } : {}) }),
  );
  const [readout, setReadout] = useState<DerbyState>(() => sim.getState());
  const [stage, setStage] = useState<Stage>('aim');
  const [mode, setMode] = useState<CameraMode>('batter');
  const [flight, setFlight] = useState<FlightPaths | null>(null);
  const [last, setLast] = useState<SwingResult | null>(null);
  const [flightTimeS, setFlightTimeS] = useState(0);
  const [contactMs, setContactMs] = useState(0);

  // The fence numbers the coaching copy quotes — the HUD READING park data, not
  // computing gameplay. `sim.cfg.park` rather than the prop so the default park
  // is the one the sim actually resolved.
  const { deepFt, gapFt, clearFt } = parkCopyNumbers(sim.cfg.park);

  const apiRef = useRef<StadiumApi | null>(null);
  const pitchTrackRef = useRef<PitchTrack | null>(null);
  // The play clock. `t0` is a WALL ms origin; everything derived from it is TRUE
  // physical seconds. null = nothing in flight, and the ball is not drawn.
  const clockRef = useRef<PlayClock | null>(null);
  const elapsedRef = useRef(0);
  const swungRef = useRef(false);
  const stageRef = useRef<Stage>('aim');
  stageRef.current = stage;
  const pausedRef = useRef(paused);
  const pauseAtRef = useRef(0);
  const resultAtRef = useRef(0);
  const reportedRef = useRef(false);
  const onFinishRef = useRef(onFinish);
  onFinishRef.current = onFinish;

  // --- pause. Shifts the clock ORIGIN rather than stopping the loop, so a
  // resume continues the pitch from exactly where it froze instead of teleporting
  // the ball forward by however long the sheet was up.
  useEffect(() => {
    if (paused === pausedRef.current) return;
    pausedRef.current = paused;
    if (paused) {
      pauseAtRef.current = performance.now();
      return;
    }
    // Both clocks are WALL origins, so both are shifted by the paused interval.
    // Shifting only the pitch clock would leave the result hold thinking the
    // pause counted toward it and skip straight to the next aim on resume.
    const held = performance.now() - pauseAtRef.current;
    if (clockRef.current) clockRef.current.t0 += held;
    resultAtRef.current += held;
  }, [paused]);

  // --- the HUD poll. Not a render loop: the sim's counters change a handful of
  // times per pitch, so this reads them a few times a second and commits only
  // when the readout actually differs.
  const sigRef = useRef('');
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = sim.getState();
      // `last` carries a whole sampled flight; stringifying it every 120 ms
      // would be the most expensive thing in the HUD. The counters are what the
      // chip shows, so they are what the signature is built from.
      const sig = `${next.phase}|${next.round}|${next.pitch}|${next.outs}|${next.strikes}|${next.homeRuns}|${next.barrels}|${next.score}|${next.bestFt}`;
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      setReadout(next);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [sim]);

  // --- the play loop. It drives ONE thing: `StadiumGL.setBallTime`. Every
  // gameplay decision it makes (auto-take, end of flight) is a call INTO the sim;
  // it computes no physics and holds no state the sim does not already own.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      // ⚠ THE GAME DOES NOT WAIT FOR THE RENDERER. `apiRef` is null until
      // `StadiumGL` — a `lazy()` chunk over a network — has drawn three frames,
      // and an earlier draft nested everything below inside `if (gl)`. The
      // effect was that a pitch served before the scene resolved simply never
      // advanced: no auto-take, no end of play, a HUD wedged on "flight"
      // forever. It also made the HUD unmountable without WebGL, which is
      // exactly what the screenshot fixture needs to do. The renderer is now
      // told the time if it is there, and the game runs either way.
      const c = clockRef.current;
      const gl = apiRef.current;
      if (!c) {
        gl?.setBallTime(-1);
      } else if (pausedRef.current) {
        gl?.setBallTime(elapsedRef.current);
      } else {
        const t = trueTimeOf(c, (performance.now() - c.t0) / 1000);
        elapsedRef.current = t;
        gl?.setBallTime(t);
        if (stageRef.current === 'flight') {
          if (!swungRef.current && t >= c.plateT + SWING_TAIL_S) commit(sim.take());
          else if (t >= c.endS) endPlay();
        }
      }
      if (
        stageRef.current === 'result' &&
        !pausedRef.current &&
        performance.now() - resultAtRef.current >= RESULT_HOLD_MS
      ) {
        nextPitch();
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // --- the three transitions, as plain functions closed over by the loop above.

  function commit(r: SwingResult) {
    swungRef.current = true;
    setLast(r);
    // ⚠ NO COUNTERS ARE BOOKED HERE. The home-run streak used to be, in a ref,
    // which made it the one gameplay number the HUD owned: outside
    // `derbySnapshot`, outside the determinism guard, and un-round-trippable by
    // `restore()` — while still being submitted to the leaderboard. It lives in
    // `DerbySim.commit()` now, beside `homeRuns`, `barrels`, `score` and
    // `bestFt`, and this function only moves the render forward.
    const c = clockRef.current;
    if (r.flight && c && pitchTrackRef.current) {
      // The object reported IS the object drawn — `SwingResult.flight` is the
      // `BattedFlight` the sim integrated, handed straight to the renderer.
      setFlight({ pitch: pitchTrackRef.current, batted: r.flight.track, contactTS: c.plateT });
      clockRef.current = { ...c, endS: c.plateT + r.flight.hangS };
      // ⚠ THE CAMERA IS TOLD AFTER CONTACT HAS RESOLVED, and that is the whole
      // of "hold the batter camera through contact": by this line the tap is
      // taken and `sim.swing()` has produced the ball, so no camera motion can
      // precede the frame the player timed against. The move is an EASE
      // (`stadium/camera.ts`) whose quintic has covered 10 % at 25 % of its
      // duration — ~190 ms more of near-hold before the pull-back is visible.
      if (r.flight.hangS >= FOLLOW_MIN_HANG_S) setMode('flight');
      play('swing');
      if (r.outcome === 'homeRun') play('ding');
    }
    // ⚠ A WHIFF DOES NOT CUT THE PLAY SHORT. The loop ends it at `endS` like any
    // other pitch, so a swing 30 ms early does not yank the ball off the screen
    // before it reaches the plate — which is precisely the frame the player
    // needs to see in order to learn that they were early.
  }

  function endPlay() {
    if (stageRef.current !== 'flight') return;
    stageRef.current = 'result';
    resultAtRef.current = performance.now();
    setStage('result');
    // ⚠ COME BACK HERE, NOT IN `nextPitch`. The return is an ease now and needs
    // somewhere to spend its 0.8 s; `RESULT_HOLD_MS` (1500) is the beat doing
    // nothing else. Starting it at `nextPitch` would run the camera home WHILE
    // the aim UI and the zone reticle were already up — the player asked to aim
    // at a plate still sliding into place. A no-op when the camera never left
    // (whiff, take, or a hang under FOLLOW_MIN_HANG_S): the rig ignores a
    // re-select of the mode it is already on.
    setMode('batter');
  }

  function nextPitch() {
    if (sim.phase === 'done') {
      stageRef.current = 'over';
      clockRef.current = null;
      setStage('over');
      finish();
      return;
    }
    stageRef.current = 'aim';
    clockRef.current = null;
    elapsedRef.current = 0;
    setStage('aim');
    // ⚠ NO `setMode` HERE, AND ITS ABSENCE IS THE POINT. `endPlay` sent the
    // camera home 1500 ms ago; this call was a second mechanism covering the
    // same case — deleting `endPlay`'s failed 0 of 3 camera tests while this one
    // silently did the job at the wrong moment. `endPlay` is the only setter of
    // stage 'result' and this is only reached FROM 'result', so the ease cannot
    // have been skipped. One mechanism; the TIMING is what is asserted now.
    setFlight(null);
    setLast(null);
  }

  function serve() {
    if (stageRef.current !== 'aim' || sim.phase !== 'ready') return;
    const pr = sim.servePitch();
    pitchTrackRef.current = pr.track;
    setFlight({ pitch: pr.track, batted: null, contactTS: pr.plate.t });
    setFlightTimeS(pr.flightTimeS);
    // The contact band `TimingBar` draws, DERIVED for this pitch — the window
    // narrows as the ball arrives faster. Taken here, from the served pitch,
    // rather than off the 120 ms poll: the bar goes live on this same commit and
    // a poll-latency band would be drawn from the PREVIOUS pitch's speed.
    setContactMs(contactWindowS(vLen(pr.plate.v), sim.cfg.batSpeedMph) * 1000);
    setLast(null);
    swungRef.current = false;
    elapsedRef.current = -PITCH_LEAD_MS / 1000;
    clockRef.current = {
      t0: performance.now() + PITCH_LEAD_MS,
      endS: pr.plate.t + SWING_TAIL_S,
      plateT: pr.plate.t,
      wallAtPlate: pr.plate.t / PITCH_TEMPO,
    };
    stageRef.current = 'flight';
    setStage('flight');
    play('ui-tick');
  }

  /** Returns whether the tap was TAKEN as a swing — `ZoneReticle` latches on it. */
  function swingNow(): boolean {
    const c = clockRef.current;
    if (!c || swungRef.current || stageRef.current !== 'flight') return false;
    // The SAME wall→true map the loop uses. Two copies of this arithmetic is how
    // the ball on screen and the instant the sim resolves contact at drift apart.
    const trueS = trueTimeOf(c, (performance.now() - c.t0) / 1000);
    // ⚠ THE WIND-UP IS NOT LIVE, AND THE STAGE ALONE DOES NOT SAY SO. `serve()`
    // sets stage 'flight' immediately, but the play clock runs NEGATIVE until
    // `PITCH_LEAD_MS`; the ball is not drawn yet. Guarding on the stage alone
    // meant a tap 100 ms into the wind-up was clamped to t = 0 and resolved as
    // "Swing and a miss −456 ms EARLY" against a ball that had not left the
    // hand — reachable by a plain double-tap on "Pitch it in", since that button
    // unmounts on serve and `ZoneReticle`'s full-bleed layer is live underneath
    // it. A tap before release is not a swing; it is not anything — and saying
    // so has to reach `ZoneReticle`, whose one-shot latch would otherwise eat
    // the real swing that follows and burn the pitch anyway.
    if (trueS < 0) return false;
    commit(sim.swing(trueS));
    return true;
  }

  // --- results. TWO paths, and they are deliberately NOT one function.
  //
  // ⚠ `bank()` DOES NOT TELL THE PARENT ANYTHING. Golf's nets say it in one
  // line — "No setState here — the whole route may be unmounting" — and this
  // file used to funnel the abandon path and the natural finish through a
  // single `finish()` that called `onFinish`. Measured, one pitch played and
  // "‹ Exit" pressed with history ['/chats','/games']: the run was banked, and
  // then the parent was told the SESSION HAD ENDED, so `BaseballScreen` put
  // "Derby complete" over the menu the player had just asked for AND called
  // `consumeHistoryEntry('guess')` a second time — before `histGameRef` had
  // re-rendered — which fired a second `nav(-1)` and landed on /chats. One
  // press, two pops, out of the Games tab entirely. The back gesture broke the
  // same way at its second press.
  //
  // So: banking is what an unmount owes the player, and `onFinish` is what a
  // FINISHED session owes the parent. Different events, different functions.
  function bank(): DerbyGameResult | null {
    if (reportedRef.current) return null;
    const st = sim.getState();
    if (st.pitchesThrown < 1) return null;
    reportedRef.current = true;
    const result: DerbyGameResult = {
      score: st.score,
      roundsPlayed: st.roundsPlayed,
      bestStreak: st.bestStreak,
      homeRuns: st.homeRuns,
      barrels: st.barrels,
      bestFt: st.bestFt,
    };
    api
      .submitGameScore({
        score: result.score,
        rounds: result.roundsPlayed,
        bestStreak: result.bestStreak,
        game: 'bbderby',
      })
      .catch(() => undefined);
    return result;
  }
  const bankRef = useRef(bank);
  bankRef.current = bank;

  /**
   * The NATURAL finish — the last pitch of the last round. Banks, then reports.
   *
   * ⚠ `if (result)` IS UNREACHABLE TODAY, and it is written down rather than
   * left for the next reader to go hunting for the case. `bank()` returns null
   * on exactly two conditions: `reportedRef` already set, or no pitch thrown.
   * The only caller is `nextPitch()`, and only after `sim.phase === 'done'` —
   * which needs a full session of pitches — with `stageRef` moved to 'over' on
   * the same line, so the unmount net cannot have run first and nothing can
   * re-enter. It is kept because the alternative is `onFinish` firing with a
   * result the bank refused, and because the day a second caller appears the
   * guard is the difference between a no-op and a double report.
   */
  function finish() {
    const result = bank();
    if (result) onFinishRef.current?.(result);
  }

  // Abandon safety net — the same shape golf's `GolfGame` / `RangeGame` use:
  // unmounted with at least one pitch thrown and nothing reported yet, bank it.
  // `bank()`, never `finish()`; see above.
  //
  // ⚠ AND BANKING IS ALL IT DOES. This used to also null `apiRef`, on the stated
  // ground that "`StadiumGL` may outlive this" — which cannot happen: it is a
  // CHILD of this component and unmounts with it, and the ref object dies with
  // the fibre either way, so the write released nothing. Both readers of the
  // handle — the play loop above and `ExitVeloTag`'s rAF through
  // `getBallScreen` — cancel their own frame in their own cleanup, so there is
  // no post-unmount call to guard against. Recorded so it is not re-added.
  useEffect(() => {
    return () => {
      bankRef.current();
    };
  }, []);

  // --- stable callbacks. Each is read from inside somebody else's rAF, so they
  // must not be re-created per render or the animation restarts every poll.
  const onReady = useCallback(
    (a: StadiumApi) => {
      apiRef.current = a;
      a.setReticle(sim.reticleX, sim.reticleH);
    },
    [sim],
  );
  const getReticle = useCallback(() => ({ x: sim.reticleX, h: sim.reticleH }), [sim]);
  const onAim = useCallback(
    (x: number, h: number) => {
      // The SIM clamps (to RULE_ZONE ± RETICLE_REACH_FT) and the renderer is
      // then told where the sim actually put it. One clamp, one truth.
      sim.setReticle(x, h);
      apiRef.current?.setReticle(sim.reticleX, sim.reticleH);
    },
    [sim],
  );
  const getElapsedS = useCallback(() => elapsedRef.current, []);
  const getBallScreen = useCallback(() => apiRef.current?.ballScreen() ?? null, []);

  // The videoboard. The HUD owns WHAT it says and WHEN that screen appeared;
  // `StadiumGL` owns `now` and therefore `tS`. See `useDerbyBoard`.
  const boardFeed = useDerbyBoard(readout, sim.cfg.park, last, stage === 'over');
  const [daylight] = useDaylight();
  const aiming = stage === 'aim';
  const coachLine = last ? coachSwing(last, gapFt, clearFt) : null;
  // The zone frame and the reticle stay up THROUGH the flight, not just while
  // aiming: the aid's whole value is watching the ball arrive against the spot
  // you chose. They come down for the result, when the camera has cut away.
  const showZone = stage === 'aim' || stage === 'flight';
  const chrome = { position: 'absolute', zIndex: 30, pointerEvents: 'none' } as const;

  return (
    <div style={{ position: 'absolute', inset: 0, background: '#0b1220', overflow: 'hidden' }}>
      <Suspense fallback={<Spinner />}>
        <StadiumGL
          park={park}
          mode={mode}
          daylight={daylight}
          seed={sim.cfg.seed}
          aiming={showZone}
          flight={flight}
          board={boardFeed}
          onReady={onReady}
        />
      </Suspense>

      <ZoneReticle
        mode={paused ? 'idle' : aiming ? 'aim' : stage === 'flight' ? 'swing' : 'idle'}
        getReticle={getReticle}
        onAim={onAim}
        onSwing={swingNow}
      />

      {/* ⚠ `follow` IS WHAT STOPS THE TAG AND THE CAMERA FIGHTING. The tag is
          correct in WORLD space, so a moving camera moves it — right while the
          ball is live, wrong once the play is over, when the camera eases back
          to the box and would drag the graphic after a ball that has stopped.
          `false` parks it where the ball finished, as a broadcast does. */}
      <ExitVeloTag
        result={stage === 'aim' ? null : last}
        follow={stage === 'flight'}
        getBallScreen={getBallScreen}
      />

      <div
        style={{
          ...chrome,
          top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
          left: 0,
          right: 0,
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'center',
          gap: 8,
          padding: '0 10px',
        }}
      >
        <CountChip state={readout} />
      </div>

      {onExit && (
        <button
          type="button"
          onClick={onExit}
          style={{
            ...frostedSurface(999),
            position: 'absolute',
            zIndex: 31,
            top: 'calc(env(safe-area-inset-top, 0px) + 10px)',
            left: 10,
            color: '#fff',
            fontSize: 12,
            fontWeight: 700,
            padding: '8px 12px',
          }}
        >
          ‹ Exit
        </button>
      )}

      <div
        style={{
          ...chrome,
          left: 0,
          right: 0,
          bottom: 'calc(env(safe-area-inset-bottom, 0px) + 22px)',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          gap: 12,
        }}
      >
        {last && (
          <div
            style={{
              ...frostedSurface(14),
              ...MONO_NUM,
              color: last.outcome === 'homeRun' ? '#b6f4c8' : '#fff',
              padding: '7px 14px',
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {describeSwing(last)}
          </div>
        )}

        {last && coachLine && (
          <div
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#ffd9a0',
              textShadow: '0 1px 4px rgba(0,0,0,0.8)',
              textAlign: 'center',
              maxWidth: 300,
              marginTop: -6,
            }}
          >
            {coachLine}
          </div>
        )}

        <TimingBar
          live={stage === 'flight'}
          flightTimeS={flightTimeS}
          contactMs={contactMs}
          getElapsedS={getElapsedS}
          errorMs={last && last.outcome !== 'take' ? last.timingErrorS * 1000 : null}
          contact={!!last && last.contactZM !== null}
        />

        {aiming && (
          <button
            type="button"
            onClick={serve}
            disabled={paused}
            style={{
              ...frostedSurface(999),
              pointerEvents: 'auto',
              color: '#fff',
              fontSize: 15,
              fontWeight: 800,
              letterSpacing: 0.4,
              padding: '12px 26px',
            }}
          >
            Pitch it in
          </button>
        )}

        {aiming && (
          <div
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.78)',
              textShadow: '0 1px 4px rgba(0,0,0,0.7)',
              textAlign: 'center',
              maxWidth: 300,
            }}
          >
            Drag anywhere to aim the reticle — where you put it across the plate is your pull /
            oppo intent. Then one tap, anywhere, to swing.
            {readout.homeRuns === 0 && (
              // ⚠ THE FIRST-RUN HALF OF THE TEACH, and it retires ITSELF. It is
              // gone the moment the player hits one out, so an experienced
              // player never reads it twice — the charter's "must not become a
              // permanent nag", enforced by the condition rather than promised
              // in a comment. The numbers come from the park's own fence data,
              // so a second park prints its own.
              <>
                {' '}
                The wall is {deepFt.toFixed(0)} ft to dead centre and {gapFt.toFixed(0)} to the
                gaps — shading off the middle is shorter.
              </>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
