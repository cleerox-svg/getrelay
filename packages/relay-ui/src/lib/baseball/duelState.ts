// The Duel — the READOUTS: what a pitch produced, what a HUD polls, and the
// snapshot/restore pair.
//
// The same seam `derbyState.ts` was taken along, for the same reason: `duelSim`
// is the LOOP and this is everything the loop is READ through. Nothing here
// decides anything; every function is a pure projection of the sim's own fields.
//
// ⚠ THE CORE IS STRUCTURAL, NOT `DuelSim`. `DuelCore` names exactly the mutable
// fields the three functions touch, so this module does not import the class and
// there is no cycle — and a field added to the class but not to `DuelCore`
// cannot be silently half-snapshotted, because the guard test compares the
// snapshot's keys against `Object.keys(sim)`.

import type { BattedFlight } from './battedBallSim';
import type {
  Bases,
  DuelPhase,
  Half,
  PitchOutcome,
  ResolvedDuelConfig,
  Team,
  Winner,
} from './duelRules';
import type { PaOutcome } from './duelInnings';
import { battingTeam } from './duelInnings';
import type { PlayResult } from './fielding';
import type { FenceOutcome } from './parks';
import type { PitchId } from './pitches';
import type { PitchResult } from './pitchSim';

/** What the pitcher asked for and what he got — the command readout. */
export interface ServedPitch {
  id: PitchId;
  /** The INTENDED plate location, ft (REPORT). */
  intentX: number;
  intentH: number;
  /** Where the pitch was actually aimed after the command miss, ft. */
  targetX: number;
  targetH: number;
  /** The signed accuracy-bar stop, [−1, 1]. 0 = perfectly released. */
  stopError: number;
  result: PitchResult;
}

/** Everything one pitch produced. `last` in `getState()`; the HUD's whole row. */
export interface PitchRecord {
  outcome: PitchOutcome;
  pitchId: PitchId;
  /** The count BEFORE this pitch, so a HUD can caption the row it is drawing. */
  balls: number;
  strikes: number;
  /**
   * …and the count this pitch produced. ⚠ NOT "the count the next pitch is
   * thrown in", which is what this line used to say and is false on exactly the
   * pitches that matter: a walk, a strikeout and a ball in play all END the
   * plate appearance, so the next pitch is thrown 0-0. It is the count AT the
   * end of THIS pitch — 4-2 on a walk, 1-3 on a strikeout — which is what a HUD
   * captioning the pitch it is drawing needs.
   */
  ballsAfter: number;
  strikesAfter: number;
  plateX: number;
  plateH: number;
  plateSpeedMph: number;
  /** The umpire's call on the CALLED zone — true even if the batter swung. */
  strike: boolean;
  swung: boolean;
  /** + = LATE, s, true physical time against the plate crossing. 0 on a take. */
  timingErrorS: number;
  undercutIn: number;
  /** + = the pitch was further from the batter than the reticle, in. */
  lateralIn: number;
  /** Where on the bat it landed, m from the knob. null unless contact was made. */
  contactZM: number | null;
  evMph: number;
  laDeg: number;
  sprayDeg: number;
  distFt: number;
  hangS: number;
  apexFt: number;
  barrel: boolean;
  /** `resolveFence`'s raw five-way answer, kept so nothing is lost in mapping. */
  fence: FenceOutcome | null;
  fenceDistFt: number;
  /** `fielding.ts`'s answer, null unless a ball was put in play. */
  play: PlayResult | null;
  /** The nearest fielder's position label, '' when nobody was asked. */
  fielder: string;
  /**
   * The WHOLE batted flight, sampled — null unless contact was made.
   *
   * ⚠ THIS IS THE OBJECT THE RENDERER DRAWS, for the reason `derbyState.ts`
   * gives at length: reconstructing a flight from EV/LA/spray loses the spin the
   * oblique-impulse solve produced, i.e. draws a curve the sim did not compute.
   * What `swing()` RETURNS carries the live object; what the two readouts hand
   * back is a copy, all the way down — see `copyRecord`.
   */
  flight: BattedFlight | null;
  /** Set iff this pitch ENDED the plate appearance. */
  pa: PaResult | null;
}

/** What a completed plate appearance did to the game. */
export interface PaResult {
  outcome: PaOutcome;
  /** Runs it drove in. */
  runs: number;
  battingTeam: Team;
  inning: number;
  half: Half;
  basesBefore: Bases;
  basesAfter: Bases;
  outsAfter: number;
  awayScore: number;
  homeScore: number;
  /** Did this plate appearance end the GAME? Walk-off, or the last out. */
  gameOver: boolean;
}

/** What a HUD polls at ~120 ms. Built fresh; nothing here is shared state. */
export interface DuelState {
  phase: DuelPhase;
  inning: number;
  innings: number;
  half: Half;
  outs: number;
  balls: number;
  strikes: number;
  bases: Bases;
  awayScore: number;
  homeScore: number;
  lineAway: number[];
  lineHome: number[];
  /** Who is batting, and whether that is the human. The HUD switches on this. */
  batting: Team;
  humanBats: Team;
  humanIsBatting: boolean;
  reticle: { x: number; h: number };
  pitchId: PitchId | null;
  flightTimeS: number;
  plate: { x: number; h: number; speedMph: number; strike: boolean } | null;
  last: PitchRecord | null;
  lastPa: PaResult | null;
  pitchCount: number;
  paCount: number;
  /** Null until the game ends. */
  winner: Winner | null;
}

export interface DuelSnapshot {
  cfg: ResolvedDuelConfig;
  conditionsSeed: number;
  rngState: number;
  inning: number;
  half: Half;
  outs: number;
  balls: number;
  strikes: number;
  bases: Bases;
  awayScore: number;
  homeScore: number;
  lineAway: number[];
  lineHome: number[];
  phase: DuelPhase;
  served: ServedPitch | null;
  last: PitchRecord | null;
  lastPa: PaResult | null;
  reticleX: number;
  reticleH: number;
  pitchCount: number;
  paCount: number;
  winner: Winner | null;
}

/** The mutable session `DuelSim` owns — named structurally, see the header. */
export type DuelCore = DuelSnapshot;

/**
 * A `PitchRecord` nothing outside the sim can mutate back into it.
 *
 * ⚠ THE SPREAD ALONE IS NOT ENOUGH, and `derbyState.ts` records the mutation
 * that proved it: `{ ...r }` is SHALLOW, so `flight` — and its four sample
 * arrays — stay ALIASED across the live sim, `getState()` and `snapshot()`. Four
 * array copies of a ~700-sample track at an 8 Hz poll is tens of microseconds a
 * second, well below the price of an invariant with one exception in it.
 */
function copyRecord(r: PitchRecord | null): PitchRecord | null {
  if (!r) return null;
  const f = r.flight;
  return {
    ...r,
    pa: r.pa ? { ...r.pa } : null,
    flight: f
      ? {
          ...f,
          landing: { ...f.landing },
          track: { t: [...f.track.t], x: [...f.track.x], y: [...f.track.y], z: [...f.track.z] },
        }
      : null,
  };
}

/**
 * A `ServedPitch` nothing outside the sim can mutate back into it.
 *
 * ⚠ THIS CLOSES AN EXCEPTION RATHER THAN DOCUMENTING ONE. `served` used to go
 * into the snapshot BY REFERENCE, on the argument that the sim never mutates it
 * in place — which is true, and which is not the property the ⚠ RULE below
 * claims. The rule is that nothing the readouts hand back aliases sim state, and
 * a caller who wrote to `snap.served.result.track.h[i]` would have been editing
 * the live pitch AND every future restore of it. "Never mutated in place" is a
 * statement about this file's discipline; the invariant is a statement about
 * everybody else's, and `derbyState.copySwing` records what it cost to learn
 * that distinction on `flight`.
 *
 * It is cheap: a `PitchTrack` is ~50 samples, and a snapshot is taken at
 * preview/restore boundaries, not per frame. `getState()` never exposed `served`
 * at all — it projects scalars off it — so only the snapshot needed this.
 *
 * ⚠ `derbyState.ts` still carries the reference version of this shape. Left
 * alone deliberately: it is the derby's slice and its goldens are the gate on
 * touching it, but it is the same latent hole and it should follow.
 */
function copyServed(v: ServedPitch | null): ServedPitch | null {
  if (!v) return null;
  const r = v.result;
  return {
    ...v,
    result: {
      ...r,
      track: { t: [...r.track.t], d: [...r.track.d], x: [...r.track.x], h: [...r.track.h] },
      plate: { ...r.plate, v: { ...r.plate.v } },
      release: { p: { ...r.release.p }, v: { ...r.release.v } },
      omega: { ...r.omega },
    },
  };
}

export function duelState(s: DuelCore): DuelState {
  const pr = s.served?.result ?? null;
  const batting = battingTeam(s.half);
  return {
    phase: s.phase,
    inning: s.inning,
    innings: s.cfg.innings,
    half: s.half,
    outs: s.outs,
    balls: s.balls,
    strikes: s.strikes,
    bases: [s.bases[0], s.bases[1], s.bases[2]],
    awayScore: s.awayScore,
    homeScore: s.homeScore,
    lineAway: [...s.lineAway],
    lineHome: [...s.lineHome],
    batting,
    humanBats: s.cfg.humanBats,
    humanIsBatting: batting === s.cfg.humanBats,
    reticle: { x: s.reticleX, h: s.reticleH },
    pitchId: s.served?.id ?? null,
    flightTimeS: pr?.flightTimeS ?? 0,
    plate: pr
      ? { x: pr.plate.x, h: pr.plate.h, speedMph: pr.plate.speedMph, strike: pr.plate.strike }
      : null,
    // ⚠ A COPY, NOT THE LIVE OBJECT, AND A COPY ALL THE WAY DOWN — the derby's
    // `roundScores` mutation proved this exact shape rots silently.
    last: copyRecord(s.last),
    lastPa: s.lastPa ? { ...s.lastPa } : null,
    pitchCount: s.pitchCount,
    paCount: s.paCount,
    winner: s.winner,
  };
}

/**
 * ⚠ RULE: EVERY own data property of `DuelSim` must appear here, and NOTHING it
 * hands back aliases sim state — no exceptions to remember. The guard test
 * enumerates `Object.keys(sim)` and fails if a field is missing, because a field
 * left out of the pair is a preview that silently leaks into the live session.
 * `bases` and the two line-score arrays are replaced wholesale but are still
 * ARRAYS on a public surface, so they are copied; `last` goes through
 * `copyRecord` and `served` through `copyServed`, both of which copy all the way
 * down to the sample arrays.
 */
export function duelSnapshot(s: DuelCore): DuelSnapshot {
  return {
    cfg: s.cfg,
    conditionsSeed: s.conditionsSeed,
    rngState: s.rngState,
    inning: s.inning,
    half: s.half,
    outs: s.outs,
    balls: s.balls,
    strikes: s.strikes,
    bases: [s.bases[0], s.bases[1], s.bases[2]],
    awayScore: s.awayScore,
    homeScore: s.homeScore,
    lineAway: [...s.lineAway],
    lineHome: [...s.lineHome],
    phase: s.phase,
    served: copyServed(s.served),
    last: copyRecord(s.last),
    lastPa: s.lastPa ? { ...s.lastPa } : null,
    reticleX: s.reticleX,
    reticleH: s.reticleH,
    pitchCount: s.pitchCount,
    paCount: s.paCount,
    winner: s.winner,
  };
}

/**
 * The inverse, written so that it CANNOT fall behind `duelSnapshot`: it copies
 * whatever keys the snapshot has rather than naming them again. Combined with
 * the guard test (snapshot keys ≡ own data props), a field added to the class
 * and forgotten in the snapshot fails the guard instead of half-restoring here.
 */
export function duelRestore(s: DuelCore, snap: DuelSnapshot): void {
  Object.assign(s, snap, {
    served: copyServed(snap.served),
    bases: [snap.bases[0], snap.bases[1], snap.bases[2]] as Bases,
    lineAway: [...snap.lineAway],
    lineHome: [...snap.lineHome],
    last: copyRecord(snap.last),
    lastPa: snap.lastPa ? { ...snap.lastPa } : null,
  });
}
