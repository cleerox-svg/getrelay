import { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { play } from '../../lib/audio';
import { vLen } from '../../lib/baseball/airPhysics';
import type { PitchCommand } from '../../lib/baseball/ai';
import { contactWindowS } from '../../lib/baseball/contactWindow';
import { DuelSim } from '../../lib/baseball/duelSim';
import type { DuelState, PitchRecord } from '../../lib/baseball/duelState';
import type { Park } from '../../lib/baseball/parks';
import type { PitchId } from '../../lib/baseball/pitches';
import type { PitchTrack } from '../../lib/baseball/pitchSim';
import { MONO_NUM, frostedSurface } from '../golf/shared/frosted';
import { useDuelBoard } from './shared/duelBoard';
import { DuelChip } from './shared/DuelChip';
import { describePitch } from './shared/duelCopy';
import { ExitVeloTag } from './shared/ExitVeloTag';
import { MoundControl } from './shared/MoundControl';
import {
  FOLLOW_MIN_HANG_S,
  PITCH_LEAD_MS,
  POLL_MS,
  RESULT_HOLD_MS,
  SWING_TAIL_S,
  playClockFor,
  trueTimeOf,
} from './shared/playClock';
import { useDaylight } from './shared/prefs';
import { TimingBar } from './shared/TimingBar';
import { ZoneReticle } from './shared/ZoneReticle';
import type { CameraMode, StadiumApi } from './StadiumGL';
import type { FlightPaths } from './stadium/flight';

// The Duel — the HUD. Three layers, and this file is the middle one.
//
//   SIM owns state   `DuelSim`. Every number below was produced by it.
//   GL renders       `StadiumGL`, told where the ball and the reticle are.
//   HUD polls        this file, at POLL_MS, and never renders per frame.
//
// ⚠ IT ALTERNATES, AND THAT IS THE WHOLE SHAPE OF THE FILE. One sim, one play
// clock, one flight, one result beat — and TWO input controls, switched by
// `sim.isHumanBatting()`:
//
//   the human's half at bat   `ZoneReticle` + `TimingBar`, Sit-and-Swing
//                             EXACTLY as the derby plays it, and the AI on the
//                             mound decides its own pitch (`servePitch()` with
//                             no command).
//   the human's half pitching `MoundControl` — a pitch, a pull, a sweep — and
//                             `DuelSim.aiBat()` resolves the swing at the plate
//                             crossing.
//
// Everything between those two — the clock, the loop, the camera, the board, the
// result beat — is ONE path with no branch in it, which is why this is one
// component and not two screens sharing a name. A second screen is the parity
// tax GOLF.md's rendering chapter records; the same argument applies a layer up.
//
// ⚠ `three` IS LAZY. `StadiumGL` is the only `lazy()` import here. Nothing else
// in this file may touch it, and `budget.test.ts` asserts that rather than
// trusting it.
//
// ⚠ THE ONE CLOCK IS `shared/playClock.ts`, shared with `DerbyGame`, and the
// direction of the `PITCH_TEMPO` multiply is argued there. `swing()` is handed
// TRUE PHYSICAL seconds.
//
// ⚠ AND `servePitch()` IS NEVER CALLED BARE ON THE HUMAN'S MOUND. The sim throws
// if the human is pitching and no `PitchCommand` arrives — deliberately, because
// a duel that pitched itself would be a mode — so `serve()` below takes the
// command as an argument and the two call sites are the two halves.

const StadiumGL = lazy(() => import('./StadiumGL'));

export interface DuelGameResult {
  /** The human's runs, and the opponent's. */
  runsFor: number;
  runsAgainst: number;
  /** 'win' | 'loss' | 'tie', from `DuelState.winner` against `humanBats`. */
  outcome: 'win' | 'loss' | 'tie';
  inningsPlayed: number;
  pitchCount: number;
}

export interface DuelGameProps {
  /**
   * Session seed. A seed replays a duel exactly — same pitches, same AI, same
   * weather. Optional, and the default is the only wall-clock read that can
   * change the outcome; it is taken ONCE, in a lazy initialiser.
   * `DerbyGame`'s prop carries the full argument.
   */
  seed?: number;
  park?: Park;
  /** AI skill, 0..1. `ai.ts` owns the curve; this is a pass-through. */
  difficulty?: number;
  paused?: boolean;
  onFinish?: (result: DuelGameResult) => void;
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

export function DuelGame({ seed, park, difficulty, paused = false, onFinish, onExit }: DuelGameProps) {
  const [sim] = useState(
    () =>
      new DuelSim({
        seed: seed ?? (Date.now() >>> 0),
        ...(park ? { park } : {}),
        ...(difficulty === undefined ? {} : { difficulty }),
      }),
  );
  const [readout, setReadout] = useState<DuelState>(() => sim.getState());
  const [stage, setStage] = useState<Stage>('aim');
  const [mode, setMode] = useState<CameraMode>(sim.isHumanBatting() ? 'batter' : 'pitcher');
  const [flight, setFlight] = useState<FlightPaths | null>(null);
  const [last, setLast] = useState<PitchRecord | null>(null);
  const [flightTimeS, setFlightTimeS] = useState(0);
  const [contactMs, setContactMs] = useState(0);
  const [pitchId, setPitchId] = useState<PitchId>('ff');

  const apiRef = useRef<StadiumApi | null>(null);
  const pitchTrackRef = useRef<PitchTrack | null>(null);
  const clockRef = useRef<ReturnType<typeof playClockFor> | null>(null);
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
  // resume continues the pitch from where it froze. Both clocks are wall
  // origins, so both are shifted — `DerbyGame` records what shifting only one
  // did to the result beat.
  useEffect(() => {
    if (paused === pausedRef.current) return;
    pausedRef.current = paused;
    if (paused) {
      pauseAtRef.current = performance.now();
      return;
    }
    const held = performance.now() - pauseAtRef.current;
    if (clockRef.current) clockRef.current.t0 += held;
    resultAtRef.current += held;
  }, [paused]);

  // --- the HUD poll. Not a render loop: the sim's counters change a handful of
  // times per pitch, so this reads them a few times a second and commits only
  // when the readout actually differs. The signature is built from the COUNTERS
  // — stringifying `last`, which carries a whole sampled flight, would be the
  // most expensive thing in the HUD.
  const sigRef = useRef('');
  useEffect(() => {
    const id = window.setInterval(() => {
      const next = sim.getState();
      const sig = `${next.phase}|${next.inning}|${next.half}|${next.outs}|${next.balls}|${next.strikes}|${next.bases.join('')}|${next.awayScore}|${next.homeScore}|${next.pitchCount}`;
      if (sig === sigRef.current) return;
      sigRef.current = sig;
      setReadout(next);
    }, POLL_MS);
    return () => window.clearInterval(id);
  }, [sim]);

  // --- the play loop. It drives ONE thing: `StadiumGL.setBallTime`. Every
  // gameplay decision it makes is a call INTO the sim; it computes no physics
  // and holds no state the sim does not already own.
  //
  // ⚠ THE GAME DOES NOT WAIT FOR THE RENDERER. `apiRef` is null until the
  // `lazy()` chunk has drawn, and the loop must advance anyway — that is what
  // lets the screenshot fixture mount this HUD with no WebGL at all.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
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
        if (stageRef.current === 'flight' && !swungRef.current) {
          // ⚠ TWO TRIGGERS, AND THEY ARE NOT THE SAME INSTANT. A HUMAN batter
          // gets `SWING_TAIL_S` past the crossing before the pitch is given up
          // as a take — the tail is what makes a fractionally late tap still a
          // swing. The AI batter has already decided (`aiSwingDecision` ran off
          // the served pitch), so its swing resolves AT the crossing; giving it
          // the tail too would just hold a decided pitch on screen for 60 ms of
          // nothing.
          if (sim.isHumanBatting()) {
            if (t >= c.plateT + SWING_TAIL_S) commit(sim.take());
          } else if (t >= c.plateT) {
            commit(sim.aiBat());
          }
        }
        if (stageRef.current === 'flight' && t >= (clockRef.current?.endS ?? c.endS)) endPlay();
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

  // --- the transitions, as plain functions closed over by the loop above.

  /** The camera for whoever's half it is NOW. Read from the sim, never cached. */
  const roleCamera = (): CameraMode => (sim.isHumanBatting() ? 'batter' : 'pitcher');

  function commit(r: PitchRecord) {
    swungRef.current = true;
    setLast(r);
    const c = clockRef.current;
    if (r.flight && c && pitchTrackRef.current) {
      // The object reported IS the object drawn — `PitchRecord.flight` is the
      // `BattedFlight` the sim integrated, handed straight to the renderer.
      setFlight({ pitch: pitchTrackRef.current, batted: r.flight.track, contactTS: c.plateT });
      clockRef.current = { ...c, endS: c.plateT + r.flight.hangS };
      // ⚠ TOLD AFTER CONTACT HAS RESOLVED: by this line the swing is taken and
      // the ball exists, so no camera motion can precede the frame the player
      // timed against.
      if (r.flight.hangS >= FOLLOW_MIN_HANG_S) setMode('flight');
      play('swing');
      if (r.play === 'HR') play('ding');
    }
    // ⚠ A WHIFF DOES NOT CUT THE PLAY SHORT. The loop ends it at `endS` like any
    // other pitch, which is precisely the frame the player needs in order to see
    // that they were early.
  }

  function endPlay() {
    if (stageRef.current !== 'flight') return;
    stageRef.current = 'result';
    resultAtRef.current = performance.now();
    setStage('result');
    // Come back HERE, not in `nextPitch`: the return is an ease and needs
    // somewhere to spend its 0.8 s, and `RESULT_HOLD_MS` is the beat doing
    // nothing else. The pitch that ended a half has already flipped the sim, so
    // `roleCamera()` is the camera the NEXT pitch wants.
    setMode(roleCamera());
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
    setFlight(null);
    setLast(null);
  }

  /**
   * Start a pitch. `cmd` is the human pitcher's command, or omitted on his half
   * at bat — in which case the AI on the mound decides for itself.
   *
   * ⚠ THE ARGUMENT IS NOT OPTIONAL IN PRACTICE, AND THE SIM ENFORCES IT.
   * `DuelSim.servePitch()` THROWS when the human is pitching and no command
   * arrives. This function passes through whatever it is given rather than
   * defending against that, because defending would mean deciding what the
   * player meant to throw.
   */
  function serve(cmd?: PitchCommand) {
    if (stageRef.current !== 'aim' || sim.phase !== 'ready') return;
    const pr = cmd ? sim.servePitch(cmd) : sim.servePitch();
    pitchTrackRef.current = pr.track;
    setFlight({ pitch: pr.track, batted: null, contactTS: pr.plate.t });
    setFlightTimeS(pr.flightTimeS);
    // The contact band `TimingBar` draws, DERIVED for this pitch — taken here,
    // from the served pitch, rather than off the 120 ms poll, so the bar is
    // never drawn from the PREVIOUS pitch's speed.
    setContactMs(contactWindowS(vLen(pr.plate.v), sim.cfg.batSpeedMph) * 1000);
    setLast(null);
    swungRef.current = false;
    elapsedRef.current = -PITCH_LEAD_MS / 1000;
    clockRef.current = playClockFor(performance.now() + PITCH_LEAD_MS, pr.plate.t);
    stageRef.current = 'flight';
    setStage('flight');
    play('ui-tick');
  }

  /** Returns whether the tap was TAKEN as a swing — `ZoneReticle` latches on it. */
  function swingNow(): boolean {
    const c = clockRef.current;
    if (!c || swungRef.current || stageRef.current !== 'flight') return false;
    if (!sim.isHumanBatting()) return false;
    // The SAME wall→true map the loop uses. Two copies of this arithmetic is how
    // the ball on screen and the instant contact resolves at drift apart.
    const trueS = trueTimeOf(c, (performance.now() - c.t0) / 1000);
    // ⚠ THE WIND-UP IS NOT LIVE, AND THE STAGE ALONE DOES NOT SAY SO. The play
    // clock runs NEGATIVE until `PITCH_LEAD_MS`; a tap before release is not a
    // swing, and saying so has to reach `ZoneReticle`, whose one-shot latch
    // would otherwise eat the real swing that follows.
    if (trueS < 0) return false;
    commit(sim.swing(trueS));
    return true;
  }

  /** The finished mound command. The ONE place a gesture becomes a pitch. */
  const onPitch = useCallback((cmd: PitchCommand) => serve(cmd), []); // eslint-disable-line react-hooks/exhaustive-deps

  /**
   * The game is over: report it once.
   *
   * ⚠ NO `bank()` TWIN, AND THE ASYMMETRY WITH `DerbyGame` IS DELIBERATE. A
   * derby's partial run is a SCORE — abandoning one still earned points, so its
   * unmount net banks it to the leaderboard. An abandoned duel is not a result:
   * a 3-inning game walked out of in the second has no winner, and inventing one
   * (or submitting a partial line score) would be the HUD deciding an outcome.
   * The ladder and the economy are `baseball-progression`'s, and when they want
   * a forfeit rule it is theirs to write.
   */
  function finish() {
    if (reportedRef.current) return;
    const st = sim.getState();
    if (st.winner === null) return;
    reportedRef.current = true;
    const human = st.humanBats;
    onFinishRef.current?.({
      runsFor: human === 'home' ? st.homeScore : st.awayScore,
      runsAgainst: human === 'home' ? st.awayScore : st.homeScore,
      outcome: st.winner === 'tie' ? 'tie' : st.winner === human ? 'win' : 'loss',
      inningsPlayed: st.inning,
      pitchCount: st.pitchCount,
    });
  }

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
      // The SIM clamps and the renderer is then told where the sim actually put
      // it. One clamp, one truth.
      sim.setReticle(x, h);
      apiRef.current?.setReticle(sim.reticleX, sim.reticleH);
    },
    [sim],
  );
  /**
   * The PITCHER's intent, drawn at the plate.
   *
   * ⚠ IT DOES NOT GO THROUGH `sim.setReticle`, and that is the layer rule rather
   * than an oversight. The sim's reticle belongs to the BATTER — on this half
   * that is the AI, and `aiBat()` sets it from its own decision. The pitcher's
   * intent is HUD input state until `servePitch` takes it as a `PitchCommand`;
   * the renderer is simply being told what to draw, which is all a renderer ever
   * is here. Writing it into the sim would hand the AI batter the player's aim.
   */
  const onMoundAim = useCallback((x: number, h: number) => {
    apiRef.current?.setReticle(x, h);
  }, []);
  const getElapsedS = useCallback(() => elapsedRef.current, []);
  const getBallScreen = useCallback(() => apiRef.current?.ballScreen() ?? null, []);

  const [daylight] = useDaylight();
  const boardFeed = useDuelBoard(readout, sim.cfg.park, last, stage === 'over');
  const humanBatting = sim.isHumanBatting();
  const aiming = stage === 'aim';
  // The zone frame and the reticle stay up THROUGH the flight, not just while
  // aiming: the aid's whole value is watching the ball arrive against the spot
  // you chose. Both roles get it — a pitcher wants to see where his pitch went
  // against where he asked for it.
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

      {humanBatting && (
        <ZoneReticle
          mode={paused ? 'idle' : aiming ? 'aim' : stage === 'flight' ? 'swing' : 'idle'}
          getReticle={getReticle}
          onAim={onAim}
          onSwing={swingNow}
        />
      )}

      {!humanBatting && aiming && (
        <MoundControl
          paused={paused}
          pitchId={pitchId}
          onSelect={setPitchId}
          onAim={onMoundAim}
          onPitch={onPitch}
        />
      )}

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
        <DuelChip state={readout} />
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
              color: last.play === 'HR' ? '#b6f4c8' : '#fff',
              padding: '7px 14px',
              fontSize: 14,
              fontWeight: 800,
            }}
          >
            {describePitch(last)}
          </div>
        )}

        {/* The timing bar is the BATTER's instrument, so it is up on the human's
            half alone. On the mound the equivalent readout is the accuracy
            sweep's own stop, which `MoundControl` owns. */}
        {humanBatting && (
          <TimingBar
            live={stage === 'flight'}
            flightTimeS={flightTimeS}
            contactMs={contactMs}
            getElapsedS={getElapsedS}
            errorMs={last && last.swung ? last.timingErrorS * 1000 : null}
            contact={!!last && last.contactZM !== null}
          />
        )}

        {humanBatting && aiming && (
          <button
            type="button"
            onClick={() => serve()}
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
            Step in
          </button>
        )}

        {stage === 'over' && (
          <div
            style={{
              ...frostedSurface(14),
              ...MONO_NUM,
              color: '#fff',
              padding: '10px 18px',
              fontSize: 16,
              fontWeight: 800,
            }}
          >
            {readout.winner === 'tie'
              ? 'Tie game'
              : readout.winner === readout.humanBats
                ? 'You win'
                : 'You lose'}
          </div>
        )}
      </div>
    </div>
  );
}
