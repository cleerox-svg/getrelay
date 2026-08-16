// Home Run Derby — the GAME LOOP, and nothing else.
//
// This file writes NO physics. Every number it reports comes out of a module
// that was calibrated and mutation-tested before this one existed:
//
//   pitchSim.simulatePitch  → the served pitch and its true-time PitchTrack
//   batSim.contactGeometry  → where on the bat a mistimed swing lands
//   batSim.swingContact     → the one oblique impulse solve (EV/LA/spray/spin)
//   battedBallSim           → the flight, on stage 1's RK4
//   parks.resolveFence      → home run / off the wall / foul / roof
//
// What IS here is the loop: the seeded serve, the mapping from the two player
// inputs — a reticle placed between pitches and a single tap during the flight —
// onto the geometric axes `batSim` already takes, and the bookkeeping.
// That mapping is the only new reasoning in the file and it is argued at
// `resolveSwing` below. The FORMAT, the payout and every constant live next
// door in `derbyRules.ts`, and everything this class is READ through —
// `getState`, `snapshot`, `restore` and the record types — in `derbyState.ts`.
// Both were extracted at the 500-line cap, along real seams: data, loop,
// readouts.
//
// ⚠ FIELDING IS NOT CALLED, ON PURPOSE. A home run derby has no fielders: the
// format is "clear the wall or it's an out", which is exactly `resolveFence`'s
// five-way answer. `fielding.ts` is the DUEL's dependency, and wiring it here
// would put a defender rating into a game mode that has no defence.
//
// ⚠ AND `PITCH_TEMPO` IS NOT IMPORTED. `simulatePitch` precomputes the whole
// flight at TRUE physical time; the render layer plays that track back slowly.
// `swing(tapTimeS)` therefore takes TRUE physical seconds since release, and it
// is the RENDERER's job to MULTIPLY its wall clock by `PITCH_TEMPO` before
// calling in — `trueS = wallS × PITCH_TEMPO`, so 0.55 makes a 0.41 s pitch take
// 0.75 s of wall clock. `DerbyGame.trueTimeOf` is that map and `pitchSim.ts`'s
// `sampleTrack` states the same identity. DIVIDING is the direction that looks
// plausible and is wrong: it would hand this file 1.36 s at the moment the ball
// reached the plate, 3.3× past the crossing, i.e. every single swing a whiff
// against a ±26 ms contact window. Contact resolves at the true physical state
// or the break numbers are a lie. `determinism.test.ts` reads this source to
// keep the tempo out of it.

import { vLen, vec3 } from './airPhysics';
import { LOC_DISTANCE_IN, M_PER_FT, SWEET_SPOT_M } from './bat';
import { contactGeometry, swingContact } from './batSim';
import type { Swing } from './batSim';
import { simulateBattedBall } from './battedBallSim';
import {
  BAT_HANDLE_LIMIT_M,
  BAT_TIP_M,
  DERBY_MIX,
  RETICLE_REACH_FT,
  SERVE_SPREAD,
  SWING_UNDERCUT_IN,
  derbyDraw,
  homeRunPoints,
  pullIntentOffsetIn,
  reticleResidual,
  resolveDerbyConfig,
} from './derbyRules';
import type { DerbyConfig, DerbyOutcome, DerbyPhase, ResolvedConfig } from './derbyRules';
import { derbyRestore, derbySnapshot, derbyState } from './derbyState';
import type { DerbySnapshot, DerbyState, ServedPitch, SwingResult } from './derbyState';
import { parkConditions, resolveFence } from './parks';
import type { FenceOutcome } from './parks';
import { PITCHES } from './pitches';
import type { PitchId } from './pitches';
import { simulatePitch } from './pitchSim';
import type { PitchResult } from './pitchSim';
import { MAX_POINTS_PER_ROUND, isBarrel } from './tuning';
import { FT_TO_IN, IN_TO_FT } from './units';
import { RULE_ZONE, armSideX, reticleToPlate } from './zone';
import type { Handedness } from './zone';

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export class DerbySim {
  cfg: ResolvedConfig;
  conditionsSeed: number;
  rngState: number;
  roundIdx = 0;
  pitchIdx = 0;
  outs = 0;
  strikes = 0;
  homeRuns = 0;
  barrels = 0;
  /**
   * Consecutive home runs, and the best run of them this session.
   *
   * ⚠ THE SIM BOOKS THIS, AND IT DID NOT USE TO. `bestStreak` is submitted to
   * the leaderboard beside `score`, `homeRuns` and `bestFt` — every one of which
   * `commit()` already owned — but the streak lived in a `useRef` inside
   * `DerbyGame`. That put ONE gameplay counter outside `derbySnapshot`, so
   * `restore()` could not round-trip it and the ⚠ RULE in `derbyState.ts` was
   * true of four counters out of five. `commit()` already had the branch.
   */
  curStreak = 0;
  bestStreak = 0;
  score = 0;
  roundScore = 0;
  roundScores: number[] = [];
  bestFt = 0;
  reticleX: number;
  reticleH: number;
  phase: DerbyPhase = 'ready';
  served: ServedPitch | null = null;
  last: SwingResult | null = null;

  constructor(config: DerbyConfig) {
    this.cfg = resolveDerbyConfig(config);
    this.rngState = this.cfg.seed;
    // One weather draw for the whole session, taken from the same stream.
    const c = this.next();
    this.conditionsSeed = Math.floor(c * 0xffffffff) >>> 0;
    const centre = reticleToPlate(0, 0);
    this.reticleX = centre.x;
    this.reticleH = centre.h;
  }

  private next(): number {
    const { value, next } = derbyDraw(this.rngState);
    this.rngState = next;
    return value;
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** Place the reticle, REPORT ft. Between pitches — there is no time pressure. */
  setReticle(x: number, h: number): void {
    if (!Number.isFinite(x) || !Number.isFinite(h)) throw new Error('reticle must be finite');
    this.reticleX = clamp(x, RULE_ZONE.left - RETICLE_REACH_FT, RULE_ZONE.right + RETICLE_REACH_FT);
    this.reticleH = clamp(h, RULE_ZONE.bottom - RETICLE_REACH_FT, RULE_ZONE.top + RETICLE_REACH_FT);
  }

  /**
   * Serve the next pitch and hand back the precomputed track for the renderer.
   * The pitch id and the location are seeded, so a seed replays a session.
   */
  servePitch(): PitchResult {
    if (this.phase === 'done') throw new Error('derby is over');
    if (this.phase === 'inFlight') throw new Error('a pitch is already in flight');
    let roll = this.next();
    let id: PitchId = DERBY_MIX[0]?.id ?? 'ff';
    for (const m of DERBY_MIX) {
      if (roll < m.weight) {
        id = m.id;
        break;
      }
      roll -= m.weight;
    }
    const u = (this.next() * 2 - 1) * SERVE_SPREAD;
    const v = (this.next() * 2 - 1) * SERVE_SPREAD;
    const target = reticleToPlate(u, v);
    const pitch = PITCHES.find((p) => p.id === id);
    if (!pitch) throw new Error(`unknown pitch ${id}`);
    const result = simulatePitch({ pitch, hand: this.cfg.pitcherHand, target });
    this.served = { id, targetX: target.x, targetH: target.h, result };
    this.phase = 'inFlight';
    return result;
  }

  /**
   * Swing, at `tapTimeS` TRUE PHYSICAL seconds since release.
   *
   * ⚠ NOT playback seconds. The renderer plays the track back at `PITCH_TEMPO`
   * and must MULTIPLY its wall clock by it before calling in (`trueS = wallS ×
   * PITCH_TEMPO` — see `DerbyGame.trueTimeOf`, which is the one implementation
   * of that map). This file never sees the tempo, so a tempo change cannot move
   * a single break, exit velocity or carry number.
   */
  swing(tapTimeS: number): SwingResult {
    const r = this.resolveSwing(tapTimeS);
    this.commit(r);
    return r;
  }

  /** Let it go by. Costs the pitch, scores a strike, is never an out. */
  take(): SwingResult {
    const r = this.resolveSwing(null);
    this.commit(r);
    return r;
  }

  /**
   * What `swing(t)` WOULD do, without committing it. This is the seam the
   * renderer's swing preview and the timing bench both use, and it is why
   * `resolveSwing` mutates nothing.
   */
  predict(tapTimeS: number): SwingResult {
    return this.resolveSwing(tapTimeS);
  }

  // -------------------------------------------------------------------------
  // The one resolution path
  // -------------------------------------------------------------------------

  /**
   * The reticle/tap → `Swing` mapping. Two player inputs, FOUR geometric axes,
   * and the geometry decides which is which — nothing here is a channel invented
   * for the game; every one of them is a field `batSim.Swing` already had:
   *
   *  • VERTICAL (reticle h). The bat's centre line passes `undercutIn` below the
   *    ball's. A well-aimed swing carries `SWING_UNDERCUT_IN`; aiming above the
   *    pitch adds to it, below subtracts. Contact needs the two circles to
   *    overlap, `|undercut| ≤ LOC_DISTANCE_IN` = R_ball + R_bat = 2.70 in — a
   *    DERIVED whiff test with no knob in it.
   *  • ALONG THE BAT (reticle x). At contact the bat is a rod across the plate,
   *    so a lateral aim error moves contact up or down the barrel: `aimZM`. The
   *    sign is the batter's, and it is `zone.armSideX`'s mirror read once — a
   *    RHB stands on the third-base side, so a pitch further out is contact
   *    further toward the tip.
   *  • DEPTH (the tap). `timingErrorS` rotates the bat, and `contactGeometry`
   *    returns where on the bat that lands. Because R_c = d/cos θ_c > d for a
   *    miss in EITHER direction, ANY mistiming drives contact toward the tip —
   *    so the SAME "is the ball still over the bat" test closes the timing
   *    window too, at roughly ±26 ms. The timing window is DERIVED from the bat's
   *    length; it is not a knob, and it is symmetric early/late exactly as
   *    stage 3 asserted the collision is.
   *  • ACROSS THE BALL (reticle x, ABSOLUTE). The reticle's placement in the zone
   *    is a declared PULL/OPPO INTENT, and it becomes `horizontalOffsetIn` — the
   *    line-of-centres tilt across the swing plane, which `swingContact` has
   *    always taken and which `derbySim` never set. It is the ONLY input that
   *    moves spray without moving where on the bat contact lands, which is what
   *    lets a player trade direction against exit velocity instead of having
   *    both handed to him by the tap. `derbyRules.pullIntentOffsetIn` carries
   *    the argument, the measured sweep and the trough it exists to close.
   *
   * ⚠ RETICLE x IS READ TWICE, AND THE TWO READINGS ARE DIFFERENT QUANTITIES.
   * Its RESIDUAL against where the pitch actually crossed is a miss, and is paid
   * for along the bat; its ABSOLUTE position is a plan, made before the pitch,
   * and buys spray. That is the before and after of one placement, not one input
   * doing two jobs — and it is what makes intent free only when the guess was
   * right, since a big declared pull on a pitch over the middle is also a big
   * aim miss.
   *
   * ⚠ THE MODEL HAS NO JAMMING, and this mapping inherits that. Contact inside
   * the sweet spot RAISES exit velocity (BASEBALL.md § "The collision"), so an
   * aim error toward the hands is rewarded until it runs off the handle bound.
   * `derbySim.test.ts` measures and prints the asymmetry rather than papering
   * over it; the fix is a measured `e(z)`, not a knob here.
   *
   * ⚠ CONTACT IS TAKEN AT THE PLATE CROSSING STATE, not at the contact instant's
   * interpolated height. Sampling the ball lower on a late swing is physically
   * real (1.46 ft deeper at 25 ms ⇒ ~1.4 in of extra undercut) but it would break
   * the early/late exit-velocity symmetry stage 3 proved and asserts. The
   * counterfactual is computed and printed by the test as a finding for a later
   * stage, not smuggled in here.
   */
  private resolveSwing(tapTimeS: number | null): SwingResult {
    const served = this.served;
    if (!served || this.phase !== 'inFlight') throw new Error('no pitch in flight');
    const pr = served.result;
    const base = {
      points: 0,
      contactZM: null,
      evMph: 0,
      laDeg: 0,
      sprayDeg: 0,
      distFt: 0,
      hangS: 0,
      apexFt: 0,
      barrel: false,
      fence: null,
      fenceDistFt: 0,
      flight: null,
      pitchId: served.id,
      plateX: pr.plate.x,
      plateH: pr.plate.h,
      plateSpeedMph: pr.plate.speedMph,
      strike: pr.plate.strike,
    };

    if (tapTimeS === null || !Number.isFinite(tapTimeS)) {
      return { ...base, outcome: 'take', timingErrorS: 0, undercutIn: 0, lateralIn: 0 };
    }

    const timingErrorS = tapTimeS - pr.plate.t;
    // The reticle's aim MISS, faded through the two-radius shoulder: near the
    // centre the batter adjusts and the swing carries its reference undercut,
    // and the residual grows smoothly into the real geometric miss, so the
    // geometry beyond the knob is untouched physics. See `reticleResidual`.
    const dx = pr.plate.x - this.reticleX;
    const dh = pr.plate.h - this.reticleH;
    const k = reticleResidual(Math.hypot(dx, dh));
    const undercutIn = SWING_UNDERCUT_IN + dh * k * FT_TO_IN;
    // The batter stands on his own arm side of the plate, so "away from the
    // batter" is the opposite sign. One mirror, read from zone.ts.
    const away = -armSideX(this.cfg.batterHand);
    const lateralIn = away * dx * k * FT_TO_IN;
    // …and the reticle's ABSOLUTE placement is the pull/oppo intent, which is
    // the one input that moves spray without moving timing. `derbyRules` argues
    // it; here it is just the fourth field of the same `Swing`.
    const horizontalOffsetIn = pullIntentOffsetIn(this.reticleX, this.cfg.batterHand);
    const swing: Swing = {
      hand: this.cfg.batterHand,
      timingErrorS,
      undercutIn,
      horizontalOffsetIn,
      aimZM: SWEET_SPOT_M + lateralIn * IN_TO_FT * M_PER_FT,
      batSpeedMph: this.cfg.batSpeedMph,
    };

    const geom = contactGeometry(vLen(pr.plate.v), swing);
    // ⚠ THE OVERLAP TEST IS THE RESULTANT, NOT THE VERTICAL ALONE. `undercutIn`
    // and `horizontalOffsetIn` are the two components of ONE line-of-centres
    // offset in the plane across the bat — `swingContact` tilts n̂ by
    // `asin(component / LOC_DISTANCE_IN)` on each — so what has to stay inside
    // R_ball + R_bat is their hypotenuse. Testing only the vertical would let a
    // full-intent swing on a badly missed pitch make contact through the corner
    // of a square it has no business being in. Still DERIVED, no knob added:
    // declaring intent spends part of the same 2.70 in budget, which is the
    // honest price of asking to pull.
    const missIn = Math.hypot(undercutIn, horizontalOffsetIn);
    const onBat =
      Number.isFinite(geom.contactZM) &&
      geom.contactZM <= BAT_TIP_M &&
      geom.contactZM >= BAT_HANDLE_LIMIT_M &&
      missIn <= LOC_DISTANCE_IN;
    if (!onBat) {
      return { ...base, outcome: 'whiff', timingErrorS, undercutIn, lateralIn };
    }

    const contact = swingContact({ v: pr.plate.v, omega: pr.omega }, swing);
    const cond = parkConditions(this.cfg.park, this.cfg.roofClosed, this.conditionsSeed);
    // Hit where the ball actually is: the plate crossing height, not a nominal.
    const flight = simulateBattedBall(
      { p: vec3(0, 0, pr.plate.h), v: contact.v, omega: contact.omega },
      cond.air,
      cond.windFps,
    );
    const play = resolveFence(flight, this.cfg.park, cond.roofClosed);
    const outcome: DerbyOutcome =
      play.outcome === 'homeRun' ? 'homeRun' : play.outcome === 'foul' ? 'foul' : 'inPlay';
    return {
      ...base,
      outcome,
      timingErrorS,
      undercutIn,
      lateralIn,
      contactZM: geom.contactZM,
      points:
        outcome === 'homeRun'
          ? homeRunPoints(flight.carryFt, MAX_POINTS_PER_ROUND / this.cfg.pitchesPerRound)
          : 0,
      evMph: contact.evMph,
      laDeg: contact.laDeg,
      sprayDeg: contact.sprayDeg,
      distFt: flight.carryFt,
      hangS: flight.hangS,
      apexFt: flight.apexFt,
      barrel: isBarrel(contact.evMph, contact.laDeg),
      fence: play.outcome,
      fenceDistFt: play.fenceDistFt,
      // The object reported IS the object drawn. See `SwingResult.flight`.
      flight,
    };
  }

  private commit(r: SwingResult): void {
    this.last = r;
    this.roundScore += r.points;
    this.score += r.points;
    if (r.outcome === 'homeRun') {
      this.homeRuns++;
      this.curStreak++;
      if (this.curStreak > this.bestStreak) this.bestStreak = this.curStreak;
      if (r.distFt > this.bestFt) this.bestFt = r.distFt;
    } else {
      // Anything that is not over the wall ends the run — an out, a foul, a
      // whiff and a take alike. Same rule the HUD's ref used to apply.
      this.curStreak = 0;
      if (r.outcome === 'inPlay') this.outs++;
      else this.strikes++;
    }
    if (r.barrel) this.barrels++;
    this.pitchIdx++;
    if (this.pitchIdx >= this.cfg.pitchesPerRound) {
      this.roundScores.push(this.roundScore);
      this.roundScore = 0;
      this.pitchIdx = 0;
      this.roundIdx++;
    }
    this.phase = this.roundIdx >= this.cfg.rounds ? 'done' : 'ready';
  }

  // -------------------------------------------------------------------------
  // Readouts — the three of them live in `derbyState.ts`, which is where the
  // ⚠ RULE about snapshot totality is written down. They are thin delegates
  // here so that the class stays the LOOP and nothing else; the extraction is
  // the 500-line cap being met by extraction, exactly as `derbyRules.ts` was.
  // -------------------------------------------------------------------------

  getState(): DerbyState {
    return derbyState(this);
  }

  snapshot(): DerbySnapshot {
    return derbySnapshot(this);
  }

  restore(s: DerbySnapshot): void {
    derbyRestore(this, s);
  }
}
