// The Duel — the GAME LOOP, and nothing else.
//
// This file writes NO physics. Every number it reports comes out of a module
// that was calibrated and mutation-tested before it existed:
//
//   pitchSim.simulatePitch    → the pitch and its true-time PitchTrack
//   batterAim.aimSwing        → the ONE reticle/tap → Swing mapping (shared with
//                               the derby; the geometry argument lives there)
//   batSim.swingContact       → the one oblique impulse solve (EV/LA/spray/spin)
//   battedBallSim             → the flight, on stage 1's RK4
//   parks.resolveFence        → home run / off the wall / foul / roof
//   fielding.fieldBattedBall  → and THEN out / 1B / 2B / 3B / HR, which for a
//                               ball on the dirt runs groundBall.groundOut —
//                               the roll, the race, the throw and the runner
//
// ⚠ THIS IS `fielding.ts`'s FIRST REAL CALLER, and that is the difference
// between the two modes. `derbySim.ts`'s header says in as many words that it
// deliberately does NOT call it, because a home run derby has no defence. A duel
// does, so the batted ball goes fence-first and then through the fielding
// lookup, and the defender rating is a real input on both halves — the human's
// `cfg.defense` when the AI bats, `ai.aiDefenseRating(difficulty)` when he does.
//
// What IS here is the loop: the count, the outs, the bases, the score, the
// halves and the game-over condition, plus the mapping from the two roles' inputs
// onto the axes the modules above already take. The half-inning STATE MACHINE is
// next door in `duelInnings.ts` (pure, and testable without integrating a
// trajectory), the format and the command map in `duelRules.ts`, and everything
// this class is READ through in `duelState.ts`. Five modules along real seams —
// data, machine, mapping, loop, readouts — the way the derby was split, and
// never a raised cap.
//
// ⚠ THE SCOPE CAP IS THE DESIGN, restated here because this is where a branch
// would be added: no stolen bases, no errors, no substitutions, no pitching
// changes, no defensive shifts, no pickoffs, no leads, no double plays, no
// fielder's choice, no cutoffs and no outfield assists, and baserunners advance
// BY FORCE ONLY. ⚠ There IS a throw now — exactly one, always to first, inside
// `groundBall.ts` — and its own header states the cap it sits under.
// `duelRules.advanceRunners` states the forced-advance
// simplification, states that it biases scoring DOWN, and is pinned by a test.
// BRANCHES GROWING IN THIS FILE IS THE SIGNAL TO DESIGN THE NEXT MILESTONE.
//
// ⚠ AND `PITCH_TEMPO` IS NOT IMPORTED. `simulatePitch` precomputes the whole
// flight at TRUE physical time; the render layer plays that track back slowly.
// `swing(tapTimeS)` takes TRUE physical seconds since release, and it is the
// RENDERER's job to MULTIPLY its wall clock by the tempo before calling in —
// `trueS = wallS × PITCH_TEMPO`. DIVIDING is the direction that looks plausible
// and is wrong; `derbySim.ts`'s header carries the arithmetic. Contact resolves
// at the true physical state or every break number in the game is a lie, and
// `determinism.test.ts` reads this source to keep the tempo out of it.

import { vLen, vec3 } from './airPhysics';
import { aiDefenseRating, aiPitchCommand, aiSwingDecision } from './ai';
import type { PitchCommand } from './ai';
import { aimSwing, clampReticle } from './batterAim';
import { swingContact } from './batSim';
import { simulateBattedBall } from './battedBallSim';
import {
  addLineRuns,
  advanceHalf,
  applyPa,
  battingTeam,
  countAfter,
  halfIsOver,
  isWalkOff,
  paOutcomeOf,
  winnerOf,
} from './duelInnings';
import type { PaOutcome, Situation } from './duelInnings';
import { DUEL_ASSIST, EMPTY_BASES, pitchLocation, resolveDuelConfig } from './duelRules';
import type {
  Bases,
  DuelConfig,
  DuelPhase,
  Half,
  PitchOutcome,
  ResolvedDuelConfig,
  Winner,
} from './duelRules';
import { duelRestore, duelSnapshot, duelState } from './duelState';
import type { DuelSnapshot, DuelState, PaResult, PitchRecord, ServedPitch } from './duelState';
import { fieldBattedBall } from './fielding';
import type { PlayResult } from './fielding';
import { parkConditions, resolveFence } from './parks';
import { pitchById } from './pitches';
import { simulatePitch } from './pitchSim';
import type { PitchResult } from './pitchSim';
import { simDraw } from './rng';
import { isBarrel } from './tuning';
import { reticleToPlate } from './zone';

export class DuelSim {
  cfg: ResolvedDuelConfig;
  conditionsSeed: number;
  rngState: number;
  inning = 1;
  half: Half = 'top';
  outs = 0;
  balls = 0;
  strikes = 0;
  bases: Bases = EMPTY_BASES;
  awayScore = 0;
  homeScore = 0;
  lineAway: number[] = [];
  lineHome: number[] = [];
  phase: DuelPhase = 'ready';
  served: ServedPitch | null = null;
  last: PitchRecord | null = null;
  lastPa: PaResult | null = null;
  reticleX: number;
  reticleH: number;
  pitchCount = 0;
  paCount = 0;
  winner: Winner | null = null;

  constructor(config: DuelConfig) {
    this.cfg = resolveDuelConfig(config);
    this.rngState = this.cfg.seed;
    // One weather draw for the whole game, taken from the same stream, exactly
    // as the derby takes one per session. Under a shut roof it is inert by
    // construction (`parkConditions` pins the air and returns exactly-zero wind).
    const c = this.next();
    this.conditionsSeed = Math.floor(c * 0xffffffff) >>> 0;
    const centre = reticleToPlate(0, 0);
    this.reticleX = centre.x;
    this.reticleH = centre.h;
  }

  private next(): number {
    const { value, next } = simDraw(this.rngState);
    this.rngState = next;
    return value;
  }

  // -------------------------------------------------------------------------
  // Roles
  // -------------------------------------------------------------------------

  /** Who is at bat right now. `top` is the away team, as in baseball. */
  battingTeam() {
    return battingTeam(this.half);
  }

  /** Is it the HUMAN's half at the plate? The HUD switches its whole UI on this. */
  isHumanBatting(): boolean {
    return this.battingTeam() === this.cfg.humanBats;
  }

  /** The bat-speed modulator in force — the human's card, or nothing for the AI. */
  private batSpeed(): number | undefined {
    return this.isHumanBatting() ? this.cfg.batSpeedMph : undefined;
  }

  // -------------------------------------------------------------------------
  // Inputs
  // -------------------------------------------------------------------------

  /** Place the batter's reticle, REPORT ft. Between pitches — no time pressure. */
  setReticle(x: number, h: number): void {
    const c = clampReticle(x, h);
    this.reticleX = c.x;
    this.reticleH = c.h;
  }

  /**
   * Throw the next pitch and hand back the precomputed track for the renderer.
   *
   * `cmd` is the PITCHER's two numbers plus his pitch: an intended plate location
   * (REPORT ft — the HUD maps its slingshot pull through `zone.reticleToPlate`)
   * and the accuracy sweep's signed stop error. THE SIM TAKES NUMBERS, NOT
   * GESTURES; `duelRules.pitchLocation` turns the error into a displacement and
   * argues the derivation.
   *
   * Omit `cmd` and the AI on the mound decides for itself. Omitting it while the
   * HUMAN is pitching THROWS rather than quietly auto-playing his half — a duel
   * that pitched itself would be a mode, and this game does not have modes.
   * Passing one explicitly during the AI's half is legal and is how a test
   * scripts an exact pitch.
   */
  servePitch(cmd?: PitchCommand): PitchResult {
    if (this.phase === 'done') throw new Error('the duel is over');
    if (this.phase === 'inFlight') throw new Error('a pitch is already in flight');
    const humanPitching = !this.isHumanBatting();
    if (!cmd && humanPitching) {
      throw new Error('the human is pitching: servePitch() needs a PitchCommand');
    }
    const c =
      cmd ??
      aiPitchCommand(() => this.next(), this.cfg.difficulty, {
        balls: this.balls,
        strikes: this.strikes,
      });
    // `missScale` is the HUMAN pitcher's command card and applies on his half
    // alone; the AI's command lives in its own difficulty-scaled spread, and
    // multiplying the two would price one skill twice.
    const target = pitchLocation(
      { x: c.intentX, h: c.intentH },
      c.stopError,
      this.cfg.pitcherHand,
      humanPitching ? this.cfg.missScale : 1,
    );
    const result = simulatePitch({
      pitch: pitchById(c.id),
      hand: this.cfg.pitcherHand,
      target,
    });
    this.served = {
      id: c.id,
      intentX: c.intentX,
      intentH: c.intentH,
      targetX: target.x,
      targetH: target.h,
      stopError: c.stopError,
      result,
    };
    this.phase = 'inFlight';
    return result;
  }

  /**
   * Swing, at `tapTimeS` TRUE PHYSICAL seconds since release. ⚠ NOT playback
   * seconds — see the header.
   */
  swing(tapTimeS: number): PitchRecord {
    const r = this.resolve(tapTimeS);
    this.commit(r.record, r.paOutcome);
    return r.record;
  }

  /** Let it go by. The umpire calls it on `zone.isStrike`'s CALLED zone. */
  take(): PitchRecord {
    const r = this.resolve(null);
    this.commit(r.record, r.paOutcome);
    return r.record;
  }

  /**
   * What `swing(t)` WOULD do, without committing it — the seam the renderer's
   * swing preview and the benches use, and why `resolve` mutates nothing.
   *
   * ⚠ THE RETURNED RECORD'S `pa` IS ALWAYS NULL. Whether a pitch ends the plate
   * appearance is known before committing, but the PaResult reports the score,
   * the bases and the outs AFTER, which only `commit` can produce. A preview
   * that invented them would be describing a game that has not happened.
   */
  predict(tapTimeS: number | null): PitchRecord {
    return this.resolve(tapTimeS).record;
  }

  /**
   * The AI's turn at the plate: it decides, places its reticle and swings or
   * takes. Throws on the human's half — the human's decision is his to make.
   */
  aiBat(): PitchRecord {
    if (this.isHumanBatting()) throw new Error('the human is batting');
    const served = this.served;
    if (!served || this.phase !== 'inFlight') throw new Error('no pitch in flight');
    const plate = served.result.plate;
    const d = aiSwingDecision(() => this.next(), this.cfg.difficulty, {
      balls: this.balls,
      strikes: this.strikes,
      plateX: plate.x,
      plateH: plate.h,
      plateT: plate.t,
      plateSpeedFps: vLen(plate.v),
    });
    this.setReticle(d.reticleX, d.reticleH);
    return d.swing && d.tapTimeS !== null ? this.swing(d.tapTimeS) : this.take();
  }

  // -------------------------------------------------------------------------
  // The one resolution path — PURE, mutates nothing
  // -------------------------------------------------------------------------

  private resolve(tapTimeS: number | null): {
    record: PitchRecord;
    paOutcome: PaOutcome | null;
  } {
    const served = this.served;
    if (!served || this.phase !== 'inFlight') throw new Error('no pitch in flight');
    const pr = served.result;
    const base = {
      pitchId: served.id,
      balls: this.balls,
      strikes: this.strikes,
      plateX: pr.plate.x,
      plateH: pr.plate.h,
      plateSpeedMph: pr.plate.speedMph,
      strike: pr.plate.strike,
      swung: false,
      timingErrorS: 0,
      undercutIn: 0,
      lateralIn: 0,
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
      play: null,
      fielder: '',
      flight: null,
      pa: null,
    };

    const finish = (
      r: Omit<PitchRecord, 'ballsAfter' | 'strikesAfter'>,
      play: PlayResult | null,
    ): { record: PitchRecord; paOutcome: PaOutcome | null } => {
      const c = countAfter({ balls: this.balls, strikes: this.strikes }, r.outcome);
      return {
        record: { ...r, ballsAfter: c.balls, strikesAfter: c.strikes },
        paOutcome: paOutcomeOf(r.outcome, c, play),
      };
    };

    // ---- a take: the umpire, and nothing else ----
    if (tapTimeS === null || !Number.isFinite(tapTimeS)) {
      const outcome: PitchOutcome = pr.plate.strike ? 'calledStrike' : 'ball';
      return finish({ ...base, outcome }, null);
    }

    // ---- a swing ----
    const timingErrorS = tapTimeS - pr.plate.t;
    const aim = aimSwing({
      hand: this.cfg.batterHand,
      plateX: pr.plate.x,
      plateH: pr.plate.h,
      plateSpeedFps: vLen(pr.plate.v),
      reticleX: this.reticleX,
      reticleH: this.reticleH,
      timingErrorS,
      batSpeedMph: this.batSpeed(),
      // The DUEL's shoulder, not the derby's — `duelRules.DUEL_ASSIST` carries
      // the measurement and both calibrations.
      assist: DUEL_ASSIST,
    });
    const swung = { ...base, swung: true, timingErrorS, undercutIn: aim.undercutIn, lateralIn: aim.lateralIn };
    if (!aim.onBat) return finish({ ...swung, outcome: 'swingingStrike' }, null);

    const contact = swingContact({ v: pr.plate.v, omega: pr.omega }, aim.swing);
    const cond = parkConditions(this.cfg.park, this.cfg.roofClosed, this.conditionsSeed);
    // Hit where the ball actually is: the plate crossing height, not a nominal.
    const flight = simulateBattedBall(
      { p: vec3(0, 0, pr.plate.h), v: contact.v, omega: contact.omega },
      cond.air,
      cond.windFps,
    );
    const fence = resolveFence(flight, this.cfg.park, cond.roofClosed);
    // ⚠ THE DEFENDER RATING IS THE FIELDING SIDE'S, and the two halves really do
    // use different ones — the human's card when the AI bats, the AI's
    // difficulty-derived rating when the human does. One scalar each way, which
    // is all `fielding.ts` accepts and all it may ever accept.
    const play = fieldBattedBall(
      {
        outcome: fence.outcome,
        distFt: fence.distFt,
        bearingDeg: fence.bearingDeg,
        hangS: fence.hangS,
        // The ROLLING PHASE's starting speed, straight off the integrator. It is
        // the horizontal component at the bounce, not the landing speed — see
        // `BattedFlight.landingGroundFps`.
        landingGroundFps: flight.landingGroundFps,
        foulTerritoryFt: this.cfg.park.foulTerritoryFt,
      },
      this.isHumanBatting() ? aiDefenseRating(this.cfg.difficulty) : this.cfg.defense,
    );
    // ⚠ A CAUGHT FOUL POP IS `inPlay`, NOT `foul` — see `duelState.PitchOutcome`.
    // `foul` in that enum means "went foul and nobody caught it", which is the
    // only case the count cares about. `record.fence` keeps the raw answer.
    const outcome: PitchOutcome = play.result === 'FOUL' ? 'foul' : 'inPlay';
    return finish(
      {
        ...swung,
        outcome,
        contactZM: aim.contactZM,
        evMph: contact.evMph,
        laDeg: contact.laDeg,
        sprayDeg: contact.sprayDeg,
        distFt: flight.carryFt,
        hangS: flight.hangS,
        apexFt: flight.apexFt,
        barrel: isBarrel(contact.evMph, contact.laDeg),
        fence: fence.outcome,
        fenceDistFt: fence.fenceDistFt,
        play: play.result,
        fielder: play.nearest,
        // The object reported IS the object drawn — see `PitchRecord.flight`.
        flight,
      },
      play.result,
    );
  }

  // -------------------------------------------------------------------------
  // The one place state moves
  // -------------------------------------------------------------------------

  /**
   * Copy a `Situation` back onto the sim, FIELD BY FIELD.
   *
   * ⚠ NOT `Object.assign(this, sit)`. This class satisfies `Situation`
   * structurally, so a blanket assign is only safe while the machine happens to
   * return nothing else — and `duelInnings.situationOf` exists on the other side
   * of the same seam for the same reason. Six fields in, six fields written.
   */
  private writeSituation(s: Situation): void {
    this.inning = s.inning;
    this.half = s.half;
    this.outs = s.outs;
    this.bases = s.bases;
    this.awayScore = s.awayScore;
    this.homeScore = s.homeScore;
  }

  private commit(rec: PitchRecord, pa: PaOutcome | null): void {
    this.pitchCount++;
    this.balls = rec.ballsAfter;
    this.strikes = rec.strikesAfter;
    this.last = rec;
    this.phase = 'ready';
    if (pa === null) return;

    const inning = this.inning;
    const half = this.half;
    const scoring = battingTeam(half);
    const basesBefore = this.bases;
    const applied = applyPa(this, pa);
    this.writeSituation(applied.sit);
    const basesAfter = this.bases;
    const outsAfter = this.outs;
    if (scoring === 'away') this.lineAway = addLineRuns(this.lineAway, inning, applied.runs);
    else this.lineHome = addLineRuns(this.lineHome, inning, applied.runs);
    this.balls = 0;
    this.strikes = 0;
    this.paCount++;

    // ⚠ THE WALK-OFF IS TESTED FIRST, AND MID-HALF. A run that puts the home team
    // ahead in the bottom of an inning at or past regulation ends the game on the
    // spot, whatever the out count and whoever is left on base. Only then does
    // the three-out test get a look in — and the two cannot fire together, since
    // in a forced-advance-only game no out ever scores a run.
    let over = isWalkOff(this, this.cfg.innings);
    if (!over && halfIsOver(this)) {
      const adv = advanceHalf(this, this.cfg.innings);
      this.writeSituation(adv.sit);
      over = adv.over;
    }
    if (over) {
      this.phase = 'done';
      this.winner = winnerOf(this);
    }
    this.lastPa = {
      outcome: pa,
      runs: applied.runs,
      battingTeam: scoring,
      inning,
      half,
      basesBefore,
      basesAfter,
      outsAfter,
      awayScore: this.awayScore,
      homeScore: this.homeScore,
      gameOver: over,
    };
    rec.pa = this.lastPa;
  }

  // -------------------------------------------------------------------------
  // Readouts — they live in `duelState.ts`, where the ⚠ RULE about snapshot
  // totality is written down. Thin delegates here so the class stays the LOOP.
  // -------------------------------------------------------------------------

  getState(): DuelState {
    return duelState(this);
  }

  snapshot(): DuelSnapshot {
    return duelSnapshot(this);
  }

  restore(s: DuelSnapshot): void {
    duelRestore(this, s);
  }
}
