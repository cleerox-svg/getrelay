// Home Run Derby — the READOUTS: what a swing produced, what a HUD polls, and
// the snapshot/restore pair.
//
// Split out of `derbySim.ts` at the 500-line cap — EXTRACTION, NOT A RAISED CAP,
// the same seam `derbyRules.ts` was taken along and for the same reason: that
// file is the LOOP (serve, map inputs onto the collision, book the result) and
// this one is everything the loop is READ through. Nothing here decides
// anything; every function is a pure projection of the sim's own fields.
//
// ⚠ THE CORE IS STRUCTURAL, NOT `DerbySim`. `DerbyCore` below names exactly the
// mutable fields the three functions touch, so this module does not import the
// class and there is no cycle to reason about — and a field added to the class
// but not to `DerbyCore` cannot be silently half-snapshotted, because the guard
// test compares the snapshot's keys against `Object.keys(sim)`.

import type { BattedFlight } from './battedBallSim';
import type { DerbyOutcome, DerbyPhase, ResolvedConfig } from './derbyRules';
import type { FenceOutcome } from './parks';
import type { PitchId } from './pitches';
import type { PitchResult } from './pitchSim';
import { MAX_POINTS_PER_ROUND } from './tuning';

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
  /**
   * The WHOLE batted flight, sampled — null on a whiff/take.
   *
   * ⚠ THIS IS THE OBJECT THE RENDERER DRAWS, and it is here because M2b found
   * the alternative and refused it: `resolveSwing` integrated a `BattedFlight`,
   * reported six scalars off it and dropped the track, so a HUD wanting to draw
   * the derby's own home run had to re-derive a launch from EV/LA/spray — which
   * loses the spin the oblique-impulse solve produced, i.e. draws a curve the
   * sim did not compute. `src/baseballpreview.tsx` says so in full and filed
   * "adding `flight: BattedFlight` to `SwingResult` is the fix". This is it.
   *
   * It is a reference to an object `simulateBattedBall` built fresh and nothing
   * mutates, so the shallow copies below are correct copies. The samples are the
   * sim's own — there is no second, prettier trajectory to be had here.
   */
  flight: BattedFlight | null;
  pitchId: PitchId;
  plateX: number;
  plateH: number;
  plateSpeedMph: number;
  strike: boolean;
}

export interface ServedPitch {
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

/** The mutable session `DerbySim` owns — named structurally, see the header. */
export interface DerbyCore extends Omit<DerbySnapshot, 'roundScores'> {
  roundScores: number[];
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function derbyState(s: DerbyCore): DerbyState {
  const pr = s.served?.result ?? null;
  const started = s.roundIdx + (s.pitchIdx > 0 || s.phase === 'inFlight' ? 1 : 0);
  const roundsPlayed = clamp(started, 1, s.cfg.rounds);
  return {
    phase: s.phase,
    round: Math.min(s.roundIdx + 1, s.cfg.rounds),
    rounds: s.cfg.rounds,
    pitch: s.pitchIdx + 1,
    pitchesPerRound: s.cfg.pitchesPerRound,
    pitchesThrown: s.roundIdx * s.cfg.pitchesPerRound + s.pitchIdx,
    totalPitches: s.cfg.rounds * s.cfg.pitchesPerRound,
    outs: s.outs,
    strikes: s.strikes,
    homeRuns: s.homeRuns,
    barrels: s.barrels,
    roundScore: s.roundScore,
    score: s.score,
    roundScores: [...s.roundScores],
    bestFt: s.bestFt,
    reticle: { x: s.reticleX, h: s.reticleH },
    pitchId: s.served?.id ?? null,
    flightTimeS: pr?.flightTimeS ?? 0,
    plate: pr
      ? { x: pr.plate.x, h: pr.plate.h, speedMph: pr.plate.speedMph, strike: pr.plate.strike }
      : null,
    // ⚠ A COPY, NOT THE LIVE OBJECT. `resolveSwing` builds a fresh literal every
    // call and never mutates it, so handing out `s.last` is benign TODAY — but
    // it is a mutable-typed field on a public readout, and `roundScores` proved
    // exactly this shape can rot: a mutation that returned it by reference
    // survived all 19 tests until the copy was asserted. Every other object this
    // function returns is built fresh; this one is now too, so the invariant is
    // "nothing `getState` hands back aliases sim state" with no exceptions to
    // remember.
    last: s.last ? { ...s.last } : null,
    roundsPlayed,
    maxScore: roundsPlayed * MAX_POINTS_PER_ROUND,
  };
}

/**
 * ⚠ RULE: EVERY own data property of `DerbySim` must appear here. The guard test
 * enumerates `Object.keys(sim)` and fails if one is missing, because a field
 * left out of the pair is a preview that silently leaks into the live session.
 * `served` is never mutated in place, so a reference is a correct copy;
 * `roundScores` is pushed to, so it is copied, and `last` is copied for the
 * reason `derbyState` gives.
 */
export function derbySnapshot(s: DerbyCore): DerbySnapshot {
  return {
    cfg: s.cfg,
    conditionsSeed: s.conditionsSeed,
    rngState: s.rngState,
    roundIdx: s.roundIdx,
    pitchIdx: s.pitchIdx,
    outs: s.outs,
    strikes: s.strikes,
    homeRuns: s.homeRuns,
    barrels: s.barrels,
    score: s.score,
    roundScore: s.roundScore,
    roundScores: [...s.roundScores],
    bestFt: s.bestFt,
    reticleX: s.reticleX,
    reticleH: s.reticleH,
    phase: s.phase,
    served: s.served,
    last: s.last ? { ...s.last } : null,
  };
}

/**
 * The inverse, written so that it CANNOT fall behind `derbySnapshot`: it copies
 * whatever keys the snapshot has rather than naming them again. Combined with
 * the guard test (snapshot keys ≡ own data props), a field added to the class
 * and forgotten in the snapshot fails the guard instead of half-restoring here.
 */
export function derbyRestore(s: DerbyCore, snap: DerbySnapshot): void {
  Object.assign(s, snap, {
    roundScores: [...snap.roundScores],
    last: snap.last ? { ...snap.last } : null,
  });
}
