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
// onto the three geometric axes `batSim` already takes, and the bookkeeping.
// That mapping is the only new reasoning in the file and it is argued at
// `resolveSwing` below. The FORMAT, the payout and every constant live next
// door in `derbyRules.ts`, extracted at the 500-line cap.
//
// ⚠ FIELDING IS NOT CALLED, ON PURPOSE. A home run derby has no fielders: the
// format is "clear the wall or it's an out", which is exactly `resolveFence`'s
// five-way answer. `fielding.ts` is the DUEL's dependency, and wiring it here
// would put a defender rating into a game mode that has no defence.
//
// ⚠ AND `PITCH_TEMPO` IS NOT IMPORTED. `simulatePitch` precomputes the whole
// flight at TRUE physical time; the render layer plays that track back slowly.
// `swing(tapTimeS)` therefore takes TRUE physical seconds since release, and it
// is the RENDERER's job to divide its wall clock by `PITCH_TEMPO` before calling
// in. Contact resolves at the true physical state or the break numbers are a
// lie. `determinism.test.ts` reads this source to keep it that way.

import { vLen, vec3 } from './airPhysics';
import { LOC_DISTANCE_IN, M_PER_FT, SWEET_SPOT_M } from './bat';
import { contactGeometry, swingContact } from './batSim';
import type { Swing } from './batSim';
import { simulateBattedBall } from './battedBallSim';
import {
  BAT_HANDLE_LIMIT_M,
  BAT_TIP_M,
  DERBY_MIX,
  RETICLE_RADIUS_FT,
  RETICLE_REACH_FT,
  SERVE_SPREAD,
  SWING_UNDERCUT_IN,
  derbyDraw,
  homeRunPoints,
  resolveDerbyConfig,
} from './derbyRules';
import type { DerbyConfig, DerbyOutcome, DerbyPhase, ResolvedConfig } from './derbyRules';
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

/** Everything one swing produced. `last` in `getState()`; the ExitVelo tag's row. */
export interface SwingResult {
  outcome: DerbyOutcome;
  points: number;
  /** + = LATE, s, true physical time against the plate crossing. */
  timingErrorS: number;
  undercutIn: number;
  /** + = the pitch was further from the batter than the reticle, in. */
  lateralIn: number;
  /** Where on the bat it landed, m from the knob. null on a whiff/take. */
  contactZM: number | null;
  evMph: number;
  laDeg: number;
  sprayDeg: number;
  /** PROJECTED carry, ft — the number a broadcast calls "distance". */
  distFt: number;
  hangS: number;
  apexFt: number;
  barrel: boolean;
  /** `resolveFence`'s raw five-way answer, kept so nothing is lost in mapping. */
  fence: FenceOutcome | null;
  fenceDistFt: number;
  pitchId: PitchId;
  plateX: number;
  plateH: number;
  plateSpeedMph: number;
  strike: boolean;
}

interface ServedPitch {
  id: PitchId;
  targetX: number;
  targetH: number;
  result: PitchResult;
}

/** What a HUD polls at ~120 ms. Built fresh; nothing here is shared state. */
export interface DerbyState {
  phase: DerbyPhase;
  round: number;
  rounds: number;
  pitch: number;
  pitchesPerRound: number;
  pitchesThrown: number;
  totalPitches: number;
  outs: number;
  strikes: number;
  homeRuns: number;
  barrels: number;
  roundScore: number;
  score: number;
  roundScores: number[];
  bestFt: number;
  reticle: { x: number; h: number };
  pitchId: PitchId | null;
  flightTimeS: number;
  plate: { x: number; h: number; speedMph: number; strike: boolean } | null;
  last: SwingResult | null;
  /** What gets submitted: `rounds` is DERBY ROUNDS, never swings. */
  roundsPlayed: number;
  maxScore: number;
}

export interface DerbySnapshot {
  cfg: ResolvedConfig;
  conditionsSeed: number;
  rngState: number;
  roundIdx: number;
  pitchIdx: number;
  outs: number;
  strikes: number;
  homeRuns: number;
  barrels: number;
  score: number;
  roundScore: number;
  roundScores: number[];
  bestFt: number;
  reticleX: number;
  reticleH: number;
  phase: DerbyPhase;
  served: ServedPitch | null;
  last: SwingResult | null;
}

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
   * and must divide before calling in; this file never sees the tempo, so a
   * tempo change cannot move a single break, exit velocity or carry number.
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
   * The reticle/tap → `Swing` mapping. Three player inputs, three GEOMETRIC axes,
   * and the geometry decides which is which — there is no fourth channel:
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
    // The reticle is a DISC. Inside it the batter adjusts and the swing carries
    // its reference undercut; outside it the residual is measured radially from
    // the rim, so the geometry beyond the knob is untouched physics.
    const dx = pr.plate.x - this.reticleX;
    const dh = pr.plate.h - this.reticleH;
    const rMiss = Math.hypot(dx, dh);
    const k = rMiss > RETICLE_RADIUS_FT ? (rMiss - RETICLE_RADIUS_FT) / rMiss : 0;
    const undercutIn = SWING_UNDERCUT_IN + dh * k * FT_TO_IN;
    // The batter stands on his own arm side of the plate, so "away from the
    // batter" is the opposite sign. One mirror, read from zone.ts.
    const away = -armSideX(this.cfg.batterHand);
    const lateralIn = away * dx * k * FT_TO_IN;
    const swing: Swing = {
      hand: this.cfg.batterHand,
      timingErrorS,
      undercutIn,
      aimZM: SWEET_SPOT_M + lateralIn * IN_TO_FT * M_PER_FT,
      batSpeedMph: this.cfg.batSpeedMph,
    };

    const geom = contactGeometry(vLen(pr.plate.v), swing);
    const onBat =
      Number.isFinite(geom.contactZM) &&
      geom.contactZM <= BAT_TIP_M &&
      geom.contactZM >= BAT_HANDLE_LIMIT_M &&
      Math.abs(undercutIn) <= LOC_DISTANCE_IN;
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
    };
  }

  private commit(r: SwingResult): void {
    this.last = r;
    this.roundScore += r.points;
    this.score += r.points;
    if (r.outcome === 'homeRun') {
      this.homeRuns++;
      if (r.distFt > this.bestFt) this.bestFt = r.distFt;
    } else if (r.outcome === 'inPlay') this.outs++;
    else this.strikes++;
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
  // Readouts
  // -------------------------------------------------------------------------

  getState(): DerbyState {
    const pr = this.served?.result ?? null;
    const started = this.roundIdx + (this.pitchIdx > 0 || this.phase === 'inFlight' ? 1 : 0);
    const roundsPlayed = clamp(started, 1, this.cfg.rounds);
    return {
      phase: this.phase,
      round: Math.min(this.roundIdx + 1, this.cfg.rounds),
      rounds: this.cfg.rounds,
      pitch: this.pitchIdx + 1,
      pitchesPerRound: this.cfg.pitchesPerRound,
      pitchesThrown: this.roundIdx * this.cfg.pitchesPerRound + this.pitchIdx,
      totalPitches: this.cfg.rounds * this.cfg.pitchesPerRound,
      outs: this.outs,
      strikes: this.strikes,
      homeRuns: this.homeRuns,
      barrels: this.barrels,
      roundScore: this.roundScore,
      score: this.score,
      roundScores: [...this.roundScores],
      bestFt: this.bestFt,
      reticle: { x: this.reticleX, h: this.reticleH },
      pitchId: this.served?.id ?? null,
      flightTimeS: pr?.flightTimeS ?? 0,
      plate: pr
        ? { x: pr.plate.x, h: pr.plate.h, speedMph: pr.plate.speedMph, strike: pr.plate.strike }
        : null,
      last: this.last,
      roundsPlayed,
      maxScore: roundsPlayed * MAX_POINTS_PER_ROUND,
    };
  }

  /**
   * ⚠ RULE: EVERY own data property of this class must appear here. The guard
   * test enumerates `Object.keys(this)` and fails if one is missing, because a
   * field left out of the pair is a preview that silently leaks into the live
   * session. `served` and `last` are never mutated in place, so a reference is a
   * correct copy; `roundScores` is pushed to, so it is copied.
   */
  snapshot(): DerbySnapshot {
    return {
      cfg: this.cfg,
      conditionsSeed: this.conditionsSeed,
      rngState: this.rngState,
      roundIdx: this.roundIdx,
      pitchIdx: this.pitchIdx,
      outs: this.outs,
      strikes: this.strikes,
      homeRuns: this.homeRuns,
      barrels: this.barrels,
      score: this.score,
      roundScore: this.roundScore,
      roundScores: [...this.roundScores],
      bestFt: this.bestFt,
      reticleX: this.reticleX,
      reticleH: this.reticleH,
      phase: this.phase,
      served: this.served,
      last: this.last,
    };
  }

  /**
   * The inverse, written so that it CANNOT fall behind `snapshot()`: it copies
   * whatever keys the snapshot has rather than naming them again. Combined with
   * the guard test (snapshot keys ≡ own data props), a field added to the class
   * and forgotten in `snapshot()` fails the guard instead of half-restoring here.
   */
  restore(s: DerbySnapshot): void {
    Object.assign(this, s, { roundScores: [...s.roundScores] });
  }
}
