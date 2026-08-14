// Terrain-aware full-shot simulation for the 9-hole course — headless, pure
// physics, no canvas. It reuses the SAME tuned ballistics and per-lie bounce/
// roll materials as the driving range (constants + TERRAIN imported from
// rangeSim), so a course shot feels identical to a range shot — but the ground
// is the hole's HEIGHTFIELD (lib/golf/terrain.ts): flight lands at heightAt(),
// the grounded roll follows slopeAccel() (downhill runs, uphill checks, sidehill
// pushes), and the lie under the ball (surfaceAt → TERRAIN material) shapes the
// bounce and run. One source of truth (the CourseHole) drives both this and the
// coming terrain mesh, so the look and the play can't disagree.
//
// World space matches the range/terrain: d downrange yd, x lateral yd (+right),
// h ABSOLUTE elevation yd (the range treats ground as h=0; here the ground is
// heightAt(d,x)). The course renderer will drive this on the same fixed step.

import { CLUBS, clubById, DEFAULT_CLUB_ID } from './clubs';
import type { Club } from './clubs';
import { FIXED_MS, MIN_PULL, powerCurve } from './tuning';
import {
  ACCURACY_AIM,
  ACCURACY_CURVE,
  ACCURACY_POWER_FLOOR,
  ACCURACY_SPIN_MAX,
  AIM_DEADZONE_FRAC,
  AIR_DRAG,
  BITE_K,
  CHECK_BACK_FRAC,
  CHECK_BACK_KICK,
  CHECK_TOP_FRAC,
  GRAVITY,
  MAX_AIM_RAD,
  ROLL_FRICTION,
  SPIN_BITE,
  SPIN_LIFT_ACC,
  SPIN_ROLL,
  SPIN_SIDE_ACC,
  TERRAIN,
  type Terrain,
} from './rangeSim';
import { courseTrees, gradientAt, heightAt, slopeAccel, surfaceAt } from './terrain';
import type { CourseHole, CourseTree, Surface } from './terrain';
import {
  BALL_R,
  CUP_R,
  POLE_R,
  POLE_RESTITUTION,
  cupCaptured,
  greenRollDecel,
  launchSpeedForRoll,
  poleDeflect,
  poleSweep,
} from './greenPhysics';

// Below this ground speed a rolling ball on ~flat ground is snapped to rest. On
// a slope the per-substep slopeAccel keeps feeding it, so it only rests where
// the ground is shallow enough that friction wins.
const ROLL_REST = 2.0;
// On the GREEN a putt must roll its last inch, so it rests at a much finer speed
// than a settling fairway shot (a coarse 2.0 threshold would strand a dying putt
// a couple of yards short of the cup).
const GREEN_REST = 0.3;
// Height (yd, above the local ground) of the flagstick — how high a flighted
// ball can still catch the pole. A real pin is ~2.1 m ≈ 2.3 yd. Only used to
// gate the AIRBORNE pin strike so a shot flying well over the pin (an approach
// at apex, a bomb crossing the green) can't carom off a pole it never reaches;
// a grounded roll into the pin is always within this and needs no gate.
const PIN_HEIGHT = 2.3;
// Off-green grass friction (Coulomb, KINETIC) — the piece that slows a moving
// ball. Below LOW_ROLL_SPEED a constant decel of frictionFor(lie) yd/s² opposes
// motion, so a rolling ball bleeds to a stop at the KINETIC angle-of-repose
// contour (where slopeAccel == this decel and net force is zero). fairway/rough/
// sand bite harder so approach shots settle in a second or two. The green/fringe
// do NOT use this — they run the calibrated Stimpmeter model below.
const LOW_ROLL_SPEED = 8;
function frictionFor(surf: Surface): number {
  switch (surf) {
    case 'rough':
      return 6.5; // thick grass grabs
    case 'bunker':
      return 9; // sand kills it
    case 'cartpath':
      return 1.2; // firm — runs a bit
    default:
      return 4.5; // fairway / tee
  }
}
// STATIC friction is higher than kinetic (a stopped ball resists starting to
// move more than a moving one resists continuing). This ratio is the physical
// basis for the rest rule below: a ball rolls to a stop at the KINETIC repose
// contour (slopeAccel == frictionFor), and STATIC friction — frictionFor ·
// STATIC_HOLD_FACTOR — then HOLDS it there instead of letting the slope re-
// accelerate the stationary ball down the hill forever (the "rolls slowly
// forever on a legit hill" bug). ~1.3 is a typical grass static/kinetic ratio.
const STATIC_HOLD_FACTOR = 1.3;
// The maximum downhill slope-acceleration (yd/s²) a surface's STATIC friction
// can hold a stationary ball against — the single "can it rest here?" test used
// by the ONE rest rule in substep(). On the green/fringe this is the calibrated
// Stimpmeter decel μ·g (static == kinetic there BY the green design guard: a
// green's tilt is authored ≲ μ so a resting putt holds — see A_GREEN below), so
// the putt-rest and the fairway/rough-rest are the same rule with one hold term.
function staticHoldFor(surf: Surface): number {
  if (surf === 'green' || surf === 'fringe') return greenDecel(surf);
  return frictionFor(surf) * STATIC_HOLD_FACTOR;
}

// --- Green speed (Stimpmeter) → putting physics ----------------------------
// The green/fringe roll on a CALIBRATED Coulomb friction from the shared
// greenPhysics module (μ ≈ 0.611/stimp; a = g·μ), so a putt's flat roll-out is
// exactly v²/(2a). A_GREEN is the deceleration on the putting surface; the
// fringe/collar grabs ~2× harder. Because this decel is CONSTANT while the
// ball's speed shrinks, the slope-break (slopeAccel) bends a putt MORE the
// slower it rolls — the "a slow ball breaks more" behaviour emerges, unscripted.
//
// DESIGN GUARD when authoring greens: A_GREEN is also the max slope a resting
// putt can HOLD (see the rest-hold gate in substep). slopeAccel = GRAVITY·grad,
// so a ball can only settle where grad ≲ μ = 0.611/stimp — at stimp 10 that's a
// ~6.1% slope. A green whose tiltPct (plus undulation) exceeds ~0.061 would let
// NO putt come to rest anywhere on it (it trickles forever); keep a hole's
// green slope under that, or raise the stimp/μ in lockstep.
const A_GREEN = greenRollDecel(GRAVITY);
const A_FRINGE = A_GREEN * 2;
function greenDecel(surf: Surface): number {
  return surf === 'fringe' ? A_FRINGE : A_GREEN;
}
// The course allows genuine FINESSE: a much lower effective power floor than the
// range (0.35), so a soft pitch can fly a few yards instead of a forced ~40. Full
// power (sPow=1) is unchanged, so the club ladder off the tee is untouched.
const COURSE_POWER_FLOOR = 0.06;

// Wedge-class finesse curve. Off-green pitch/chip shots with a lofted wedge need
// FINE low-end control (a controllable 3–20 yd pitch, not a 35 yd jump from a
// small drag). For wedges (loft ≥ WEDGE_LOFT: PW + SW) the power→speed map is
// QUADRATIC with a lower effective floor, so resolution is packed into the low
// end and a soft pitch is playable — mirroring the putter's quadratic feel.
// Crucially the map is A + (1−A)·pᵏ, which is 1 at power=1 for ANY A/k, so
// FULL-power carry is UNCHANGED for every club and the club ladder off the tee is
// identical. Longer clubs keep the forgiving linear map (COURSE_POWER_FLOOR).
const WEDGE_LOFT = 37;
const WEDGE_SPOW_FLOOR = 0.02;
const WEDGE_POWER_EXP = 2;
function swingSPow(club: Club, power: number): number {
  const p = Math.max(0, Math.min(1, power));
  if (club.loft >= WEDGE_LOFT) {
    return WEDGE_SPOW_FLOOR + (1 - WEDGE_SPOW_FLOOR) * Math.pow(p, WEDGE_POWER_EXP);
  }
  return COURSE_POWER_FLOOR + (1 - COURSE_POWER_FLOOR) * p;
}

// CONSERVATIVE full-power total distance (yд) per club — the MAX total measured
// across every authored hole (harness, simulateShot at power=1 from each tee;
// terrain roll adds a lot on downhill holes, so a club's total ranges ~130 yд).
// recommendedClub() uses the MAX so the club it picks can never overshoot on ANY
// hole: the actual full total ≤ this max ≤ the target, so full power lands at or
// short of the pin instead of flying the green. Re-measure if the ballistics or
// hole terrain change (the harness prints per-club min/max totals).
const CLUB_FULL_TOTAL: Record<string, number> = {
  driver: 420,
  '3wood': 357,
  hybrid: 317,
  '5iron': 278,
  '7iron': 240,
  '9iron': 201,
  pw: 166,
  sw: 131,
};
// Putt power model (its own map, DISTINCT from the full-swing power floor). On
// the green a stroke ROLLS along the ground (no loft, no floor); drag power maps
// to an initial ground speed calibrated via the Stimpmeter roll-out so:
//   • MIN (a dead-soft tap) trickles ~0.5 yd (1.5 ft) — a genuine delicate tap,
//     so a 3-ft putt is controllable instead of being blasted past;
//   • FULL power rolls ~22 yd on the flat (comfortably crosses a green / lags a
//     long one).
// The map is QUADRATIC in the drag (speed = MIN + (MAX−MIN)·power²), which packs
// FINE resolution into the low end: a short putt lives in the lower half of the
// drag range with plenty of travel to feather, rather than in an unusable sliver
// just above the floor (the old linear map + a ~1.4-yd floor overshot every
// short putt). PUTT_MIN_SPEED now sits comfortably BELOW CUP_CAPTURE_SPEED, so a
// dead-soft tap started right at the lip still drops.
const PUTT_MAX_SPEED = launchSpeedForRoll(22, A_GREEN);
const PUTT_MIN_SPEED = launchSpeedForRoll(0.5, A_GREEN);
// Convert a drag power (0..1) to a putt launch speed with the low-end-dense
// quadratic curve above. Shared by the live fire path and predict().
function puttSpeedForPower(power: number): number {
  const p = Math.max(0, Math.min(1, power));
  return PUTT_MIN_SPEED + p * p * (PUTT_MAX_SPEED - PUTT_MIN_SPEED);
}

// --- Tree collision (trunk ricochet + canopy brush) ------------------------
// Trees are deterministic DATA (terrain.courseTrees) shared with the renderer, so
// the trunk the player sees is the trunk the ball hits. A trunk is a vertical
// cylinder the ball CAROMS off (reflect the inbound normal component, restitution
// < 1 → a central hit comes back, a glancing hit deflects); the canopy is a soft
// sphere that lightly DAMPS an airborne ball passing through it — leaves brushing
// it, not a hard stop.
//
// Restitution of a trunk carom (reflected normal component kept fraction). Lower
// than a fibreglass pin — a tree trunk deadens the knock — but lively enough to
// clearly kick the ball away.
const TRUNK_RESTITUTION = 0.55;
// Extra pace shed by the whole velocity on a trunk knock (a little speed killed
// regardless of angle), applied on top of the normal-component restitution.
const TRUNK_SPEED_KEEP = 0.85;
// Fraction of speed KEPT per second an airborne ball spends inside a canopy — the
// leaf BRUSH, "just a little" (the user's words). Close to 1 so a typical
// fly-through (~0.1–0.15 s in the leaves) sheds only a couple of percent; a slow
// lob dwelling ~0.4 s near the top still loses only ~4%. dt-scaled so it's a
// gentle brush, not a catch, and identical live + headless.
const CANOPY_KEEP_PER_SEC = 0.9;

// Where a shot ended up. The solid lies double as the resting-lie readout; the
// terminal ones end the shot.
export type CourseResult = Surface | 'holed';

// Map a course lie onto its bounce/roll material. water/ob never reach here (the
// settle path ends the shot on them first); every solid lie has a TERRAIN entry.
function terrainFor(surf: Surface): Terrain {
  switch (surf) {
    case 'green':
      return 'green';
    case 'fringe':
      return 'fringe';
    case 'rough':
      return 'rough';
    case 'bunker':
      return 'bunker';
    case 'cartpath':
      return 'cartpath';
    case 'tee':
      return 'tee';
    default:
      return 'fairway';
  }
}

export interface CourseBall {
  d: number;
  x: number;
  h: number;
  vd: number;
  vx: number;
  vh: number;
  inFlight: boolean;
  grounded: boolean;
  resting: boolean;
}

export interface CourseTrailPt {
  d: number;
  x: number;
  h: number;
}

export interface CourseShot {
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  restD: number;
  restX: number;
  distToPin: number;
  result: CourseResult;
}

export interface CourseShotOptions {
  clubId?: string;
  power?: number; // 0..1
  aimDeg?: number; // + = right, absolute bearing off the tee→pin... here off +d
  spinBack?: number; // -1..1
  spinSide?: number; // -1..1
  // Start the shot from an arbitrary lie (approach/putt) instead of the tee.
  from?: { d: number; x: number };
  windAlong?: number;
  windCross?: number;
}

// Non-committing prediction returned by predict(): the sampled flight+roll
// `path` (world space), the first-ground-contact `landing` (carry point, null
// only for a shot that never touches down), and the resting point.
export interface CoursePrediction {
  path: CourseTrailPt[];
  landing: { d: number; x: number; h: number } | null;
  // Index into `path` of the sample at/just after the first ground contact
  // (i.e. the carry endpoint that `landing` marks). null when `landing` is null
  // (a putt/roll that never goes airborne). HUD-only: lets a full-swing aim
  // preview draw the arc up to the FIRST bounce and drop the post-bounce roll
  // guess; `path`/`landing`/`rest`/`result` semantics are unchanged.
  landingIndex: number | null;
  rest: { d: number; x: number; h: number };
  result: CourseResult;
}

// Options for predict() — unified with rangeSim's shape so both scenes call it
// the same way. Uses the sim's CURRENT club/power/steer/spin/wind unless
// overridden. `accuracy` bakes in a tap-timing miss (0 = the pure centre line);
// `includeWind: false` zeroes wind for the "intended" pre-wind line (the gap to
// the wind-adjusted landing shows the wind push); `stride` sub-samples the path.
// A bare number is accepted too (legacy `predict(0)`/`predict(-1)`/`predict(1)`
// callers) and treated as `{ accuracy }`.
export interface CoursePredictOptions {
  accuracy?: number;
  includeWind?: boolean;
  stride?: number;
}

// Live readouts the HUD polls each frame.
export interface CourseState {
  clubId: string;
  clubName: string;
  par: number;
  strokes: number;
  power: number;
  aiming: boolean;
  armed: boolean;
  inFlight: boolean;
  resting: boolean;
  holed: boolean;
  aimDeg: number;
  distToPin: number;
  lie: Surface;
  lastResult: CourseResult;
  spinBack: number;
  spinSide: number;
  penaltyPending: boolean;
  // Round wind (yd/s² accelerations) so the HUD's WindChip reads from the sim,
  // exactly like the Range. Set once per round via setWind(); airborne-only.
  windAlong: number;
  windCross: number;
  // Last-shot ballistics for the telemetry panel (mirrors RangeState): carry /
  // total played distance, apex height, and launch ball speed.
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  // On the green → the next stroke is a putt (ground roll), so the HUD can label
  // the club "Putter" and read the power meter as putt strength.
  putting: boolean;
  // The hole's number (for attributing a record to a hole) and the per-hole best
  // shots so far, rounded to whole yards (null until produced). The recap reads
  // these at hole-out to show the drive / closest-approach / holed-putt lengths
  // and to POST them to /game/golf-records.
  holeId: number;
  driveYards: number | null;
  closestToPinYards: number | null;
  longestPuttYards: number | null;
}

const TRAIL_MAX = 64;

// A complete capture of every MUTABLE field of a CourseSim — the one source of
// truth for predict()'s snapshot/restore (see CourseSim.snapshot). Kept as a
// plain data struct with no reference to any render object, so it clones cheaply
// and a dry-run prediction can never touch the scene. If you add mutable state
// to CourseSim, add it here too; the round-trip test enforces completeness.
interface CourseSnapshot {
  ball: CourseBall;
  trail: CourseTrailPt[];
  clubId: string;
  spinBack: number;
  spinSide: number;
  launchSpinSide: number;
  windAlong: number;
  windCross: number;
  carry: number;
  total: number;
  apex: number;
  ballSpeed: number;
  firstLanding: boolean;
  rollDecay: number;
  result: CourseResult;
  originD: number;
  originX: number;
  aiming: boolean;
  power: number;
  aimRad: number;
  armed: boolean;
  strokes: number;
  holed: boolean;
  dragStart: { x: number; y: number };
  maxPull: number;
  shotOriginD: number;
  shotOriginX: number;
  penaltyPending: boolean;
  stepGuard: number;
  driveYards: number | null;
  closestToPinYards: number | null;
  longestPuttYards: number | null;
  driveRecorded: boolean;
  shotIsDrive: boolean;
  shotIsPutt: boolean;
  puttStartDist: number;
}

export class CourseSim {
  readonly hole: CourseHole;
  readonly ball: CourseBall;
  readonly trail: CourseTrailPt[] = [];
  // The tree grove — DETERMINISTIC DATA derived from the static hole (same list
  // the renderer draws), so the trunk you see is the trunk you hit. Immutable
  // after construction, so it needs no CourseSnapshot entry: predict() reads but
  // never mutates it, leaving the snapshot round-trip guard byte-identical.
  private readonly trees: CourseTree[];

  private clubId: string;
  private spinBack = 0;
  private spinSide = 0;
  private launchSpinSide = 0;
  private windAlong: number;
  private windCross: number;

  private teeGround: number;
  private originD: number;
  private originX: number;

  private carry = 0;
  private total = 0;
  private apex = 0;
  private ballSpeed = 0;
  private firstLanding = true;
  private rollDecay = ROLL_FRICTION;
  private result: CourseResult = 'tee';

  // --- Interactive play (drag-to-aim slingshot, reused from the range) ------
  // aimRad STEERS off the bearing-to-pin (so "straight" points at the flag even
  // on a dogleg); the pull magnitude sets power. arm() locks them and raises the
  // accuracy bar; fireArmed() launches. The ball plays shot-by-shot from wherever
  // it lies until it's holed.
  private readonly par: number;
  aiming = false;
  power = 0;
  aimRad = 0;
  armed = false;
  strokes = 0;
  holed = false;
  private dragStart = { x: 0, y: 0 };
  private maxPull = 220;
  private shotOriginD = 0;
  private shotOriginX = 0;
  private penaltyPending = false;
  private stepGuard = 0;

  // --- Per-hole best-shot records (surfaced in the recap, posted to
  // /game/golf-records). Accumulated as shots come to REST via stop(), so both
  // the live fire path and the simulateShot/simulatePutt harness feed them. All
  // in yards; null until the hole produces one.
  //   driveYards       — total played distance of the TEE shot / first full
  //                       swing (one per hole; a first swing that finds water/OB
  //                       doesn't count, so its replay becomes the drive).
  //   closestToPinYards — the nearest ANY non-holing shot RESTED to the pin
  //                       (the "closest approach"; excludes holed/water/OB).
  //   longestPuttYards  — the length (origin→cup) of the longest PUTT that
  //                       HOLED OUT (a stroke played from the green that drops);
  //                       null if the hole wasn't finished with a putt.
  driveYards: number | null = null;
  closestToPinYards: number | null = null;
  longestPuttYards: number | null = null;
  private driveRecorded = false; // the drive distance is locked in for the hole
  private shotIsDrive = false; // the in-flight shot is the (unrecorded) drive
  private shotIsPutt = false; // the in-flight shot is a putt (ground roll)
  private puttStartDist = 0; // length of the in-flight putt (origin→pin)

  constructor(hole: CourseHole, clubId = DEFAULT_CLUB_ID) {
    this.hole = hole;
    this.par = hole.par;
    this.trees = courseTrees(hole);
    this.clubId = clubId;
    this.windAlong = hole.wind.along;
    this.windCross = hole.wind.cross;
    this.teeGround = heightAt(hole, hole.tee.d, hole.tee.x);
    this.originD = hole.tee.d;
    this.originX = hole.tee.x;
    this.ball = {
      d: hole.tee.d,
      x: hole.tee.x,
      h: this.teeGround,
      vd: 0,
      vx: 0,
      vh: 0,
      inFlight: false,
      grounded: false,
      resting: true,
    };
    // Auto-club the opening tee shot for the hole length (long par 5 → driver).
    this.clubId = this.recommendedClub();
  }

  private club(): Club {
    return clubById(this.clubId);
  }

  private ground(d: number, x: number): number {
    return heightAt(this.hole, d, x);
  }
  private lieAt(d: number, x: number): Surface {
    return surfaceAt(this.hole, d, x);
  }

  // Launch from a lie with a locked club/power and an ABSOLUTE direction (dirRad,
  // angle off the +d axis) plus a precomputed net side-spin. Off an arbitrary
  // origin at the ground's elevation there. Mirrors rangeSim.swing.
  private swing(power: number, dirRad: number, launchSpinSide: number): void {
    const club = this.club();
    const b = this.ball;
    const sPow = swingSPow(club, power);
    const s = club.baseSpeed * Math.sqrt(sPow);
    const loft = (club.loft * Math.PI) / 180;
    this.launchSpinSide = launchSpinSide;
    const sH = s * Math.cos(loft);
    b.h = this.ground(b.d, b.x);
    b.vh = s * Math.sin(loft);
    b.vd = sH * Math.cos(dirRad);
    b.vx = sH * Math.sin(dirRad);
    b.inFlight = true;
    b.grounded = false;
    b.resting = false;
    this.ballSpeed = s;
    this.carry = 0;
    this.total = 0;
    this.apex = 0;
    this.firstLanding = true;
    this.result = 'tee';
    this.trail.length = 0;
    this.stepGuard = 0;
    // The first full swing of the hole is the drive candidate (recorded at rest,
    // unless it finds water/OB — then its replay is the drive).
    this.shotIsDrive = !this.driveRecorded;
    this.shotIsPutt = false;
  }

  // Roll a PUTT from the current lie: no launch angle, no power floor — the drag
  // power maps to an initial GROUND speed and the ball rolls (and breaks on the
  // green's tilt via the grounded substep). Reuses the same roll integrator as a
  // settled shot, so a well-judged putt trickles into the cup.
  private puttLaunch(power: number, dirRad: number): void {
    const b = this.ball;
    const speed = puttSpeedForPower(power);
    b.h = this.ground(b.d, b.x);
    b.vh = 0;
    b.vd = speed * Math.cos(dirRad);
    b.vx = speed * Math.sin(dirRad);
    b.inFlight = true;
    b.grounded = true;
    b.resting = false;
    this.launchSpinSide = 0;
    this.ballSpeed = speed;
    this.carry = 0;
    this.total = 0;
    this.apex = 0;
    this.firstLanding = false;
    this.result = 'green';
    this.trail.length = 0;
    this.stepGuard = 0;
    // Smooth green roll — the green lie's own run, no club bite.
    const mat = TERRAIN.green;
    this.rollDecay = Math.max(0.6, Math.min(0.99, 1 - (1 - 0.985) / mat.runMul));
    // A putt can hole → remember its length (origin→cup) for the longest-putt
    // record; it is NOT a drive.
    this.shotIsDrive = false;
    this.shotIsPutt = true;
    const p = this.hole.pin;
    this.puttStartDist = Math.hypot(b.d - p.d, b.x - p.x);
  }

  private pushTrail(): void {
    const b = this.ball;
    this.trail.push({ d: b.d, x: b.x, h: b.h });
    if (this.trail.length > TRAIL_MAX) this.trail.shift();
  }

  private origin2D(d: number, x: number): number {
    return Math.hypot(d - this.originD, x - this.originX);
  }

  private stop(result: CourseResult): void {
    const b = this.ball;
    b.inFlight = false;
    b.grounded = false;
    b.resting = true;
    b.vd = b.vx = b.vh = 0;
    b.h = this.ground(b.d, b.x);
    this.total = this.origin2D(b.d, b.x);
    this.result = result;
    if (result === 'holed') this.holed = true;
    this.recordShot(result);
    // Water / OB → the next address replays from the previous spot for a penalty.
    if (result === 'water' || result === 'ob') this.penaltyPending = true;
    // Auto-club the next shot for the new lie/distance (the player can still
    // cycle). A driver-for-a-bunker-chip default is exactly what this avoids.
    else this.clubId = this.recommendedClub();
  }

  // Fold a shot that has just come to REST into the per-hole best records. Called
  // from stop() so every terminating path (live fire, simulateShot, simulatePutt,
  // the safety guard) feeds the same accounting.
  private recordShot(result: CourseResult): void {
    const b = this.ball;
    const p = this.hole.pin;
    // Closest-to-pin: the nearest an APPROACH (a full swing) finishes to the cup.
    // Exclude the holed shot (ball in the cup), hazard stops (water/OB are
    // replayed), AND putts — a stroke played from the green (shotIsPutt) rests
    // inches from the cup on nearly every completed hole, which would collapse
    // this to ~0 and make the stat meaningless. So only non-putt rests count.
    if (result !== 'holed' && result !== 'water' && result !== 'ob' && !this.shotIsPutt) {
      const dtp = Math.hypot(b.d - p.d, b.x - p.x);
      if (this.closestToPinYards == null || dtp < this.closestToPinYards) {
        this.closestToPinYards = dtp;
      }
    }
    // Drive: the first full swing's total distance, locked in once it finishes on
    // a playable lie. A first swing into water/OB doesn't count — shotIsDrive
    // clears but driveRecorded stays false, so the replay swing becomes the drive.
    if (this.shotIsDrive) {
      this.shotIsDrive = false;
      if (result !== 'water' && result !== 'ob') {
        this.driveYards = this.total;
        this.driveRecorded = true;
      }
    }
    // Longest putt: a putt (green stroke) that HOLES OUT; keep the longest.
    if (result === 'holed' && this.shotIsPutt) {
      if (this.longestPuttYards == null || this.puttStartDist > this.longestPuttYards) {
        this.longestPuttYards = this.puttStartDist;
      }
    }
  }

  // --- Interactive control surface (CourseGL drives this; CourseGame reads it) --

  // The sensible club for the CURRENT lie + distance-to-pin: the LONGEST club
  // whose full-power total does NOT overshoot the pin — so full power lands AT or
  // just SHORT of the target and the auto-club never flies the green (the old
  // rule picked the shortest club that "reaches", so a full-power 3-wood bombed a
  // short par 4's green). The player still dials power/cycles up for more. A wedge
  // out of sand regardless; green → putter (putt mode handles the stroke). Used
  // to auto-set the club each new shot.
  recommendedClub(): string {
    const b = this.ball;
    const p = this.hole.pin;
    const R = Math.hypot(b.d - p.d, b.x - p.x);
    const lie = this.lieAt(b.d, b.x);
    if (lie === 'green') return 'pw'; // cosmetic; putt mode ignores the club
    if (lie === 'bunker') return R > 110 ? 'pw' : 'sw'; // loft to escape sand
    // CLUBS is ordered longest → shortest, so the first whose full-power total
    // fits (≤ R) is the longest club that won't overshoot. If even the shortest
    // (sand wedge) would overshoot (a very short pitch), fall back to it and let
    // the wedge finesse curve dial the distance down.
    for (const c of CLUBS) {
      if ((CLUB_FULL_TOTAL[c.id] ?? Infinity) <= R) return c.id;
    }
    return CLUBS[CLUBS.length - 1]!.id; // shortest (sand wedge)
  }

  selectClub(id: string): void {
    if (this.ball.inFlight) return;
    if (CLUBS.some((c) => c.id === id)) this.clubId = id;
  }
  cycleClub(dir: 1 | -1): void {
    if (this.ball.inFlight) return;
    const i = CLUBS.findIndex((c) => c.id === this.clubId);
    this.clubId = CLUBS[(i + dir + CLUBS.length) % CLUBS.length]!.id;
  }
  setSpin(back: number, side: number): void {
    this.spinBack = Math.max(-1, Math.min(1, back));
    this.spinSide = Math.max(-1, Math.min(1, side));
  }
  // Set the round's wind (yd/s² accelerations: `along` head/tail on +d, `cross`
  // L/R on +x). Mutates the EXISTING windAlong/windCross fields (already in the
  // CourseSnapshot) — no new mutable state, so the snapshot round-trip guard is
  // untouched. Wind is applied airborne-only in substep() (a grounded/settled
  // ball is never shoved), matching the deliberate course rule.
  setWind(along: number, cross: number): void {
    this.windAlong = along;
    this.windCross = cross;
  }
  setMaxPull(px: number): void {
    this.maxPull = Math.max(40, px);
  }

  // Bearing (rad off +d) from the ball to the pin. KEPT for readouts / any
  // pin-relative math, but it is NO LONGER the aim base — see driveHeading().
  private bearingToPin(): number {
    const b = this.ball;
    const p = this.hole.pin;
    // TRUE signed bearing — no clamp on the forward component — so a ball BEHIND
    // the pin (the whole back half of the green) can still aim back at the cup
    // (bearing points backward, |angle| > 90°). Clamping the denominator used to
    // snap it sideways/away, making the hole unputtable from long.
    return Math.atan2(p.x - b.x, p.d - b.d);
  }

  // Direction (rad off +d) of the FIRST FAIRWAY LEG from the tee (centerline[0] →
  // centerline[1], the drive line). On a straight hole / par-3 the centerline is
  // collinear tee→pin, so this equals bearingToPin() from the tee. Guards a
  // degenerate/empty centerline (falls back to the tee then the pin) so it can
  // never atan2(0,0) — mirrors the CourseGL tee-box twin.
  private driveHeading(): number {
    const cl = this.hole.centerline;
    const a = cl[0] ?? this.hole.tee;
    const b = cl[1] ?? this.hole.pin;
    return Math.atan2(b.x - a.x, b.d - a.d);
  }

  // The BASE aim heading (rad off +d) the slingshot steer is added to:
  //   • THE TEED DRIVE (strokes === 0) → the DRIVE LINE (first fairway leg).
  //     "Straight" points down the fairway you're standing on, NOT around the
  //     corner at the pin, so on a dogleg the address view + tee box sit square to
  //     the drive line and steering shapes the drive off it.
  //   • EVERY OTHER STROKE (approach, chip, and PUTTS on the green) → bearing-to-
  //     pin, exactly as before — aim points at the pin/cup. Putting is UNCHANGED.
  // The predicate is `strokes === 0`, which is EXACTLY what CourseGL gates the tee
  // box + peg on, so the sim aim base and the rendered box can never split-brain
  // (the earlier lieAt('tee') gate depended on surfaceAt precedence — a cartpath
  // or hazard within TEE_R would misclassify the opening drive). On a straight
  // hole / par-3 both bases are equal (collinear centerline), so those holes are
  // byte-identical everywhere.
  private baseHeading(): number {
    return this.strokes === 0 ? this.driveHeading() : this.bearingToPin();
  }

  // Public: the INTENDED shot heading (rad off +d) = base heading + the current
  // slingshot steer (aimRad), i.e. the pre-wind, pre-accuracy line the aim arrow
  // points down. The scene reads this to yaw the address camera + tee box down the
  // aimed line; aimRad = 0 returns the base (the drive line on the tee, the pin
  // elsewhere). Read-only — no state change.
  aimHeading(): number {
    return this.baseHeading() + this.aimRad;
  }

  // Is the ball on the green? Then a stroke is a PUTT (ground roll), not a swing.
  private putting(): boolean {
    return this.lieAt(this.ball.d, this.ball.x) === 'green';
  }

  // Slingshot steer from a pull-back vector (start − finger, CSS px): the shot
  // flings OPPOSITE the pull. Identical mapping/deadzone to the range.
  private pullAim(rawX: number, rawY: number): number {
    const back = -rawY;
    if (back < this.maxPull * AIM_DEADZONE_FRAC) return 0;
    return Math.max(-MAX_AIM_RAD, Math.min(MAX_AIM_RAD, Math.atan2(rawX, back)));
  }

  onPointerDown(p: { x: number; y: number }): void {
    if (this.ball.inFlight || this.holed) return;
    if (this.penaltyPending) this.applyPenalty();
    this.aiming = true;
    this.armed = false;
    this.dragStart = { x: p.x, y: p.y };
    this.power = 0;
    this.aimRad = 0;
  }
  onPointerMove(p: { x: number; y: number }): void {
    if (!this.aiming) return;
    const rawX = this.dragStart.x - p.x;
    const rawY = this.dragStart.y - p.y;
    // Elastic response: raw pull fraction → power via the ease-out curve, so a
    // downward pull reaches high power in less room and the top is a strain.
    this.power = powerCurve(Math.min(Math.hypot(rawX, rawY), this.maxPull) / this.maxPull);
    this.aimRad = this.pullAim(rawX, rawY);
  }
  // Release: lock power + steer and raise the accuracy bar (no launch yet). A
  // sub-min pull cancels back to address.
  arm(p: { x: number; y: number }): boolean {
    if (!this.aiming) return false;
    this.aiming = false;
    const pullX = this.dragStart.x - p.x;
    const pullY = this.dragStart.y - p.y;
    if (Math.hypot(pullX, pullY) < MIN_PULL) {
      this.armed = false;
      this.power = 0;
      return false;
    }
    this.power = powerCurve(Math.min(Math.hypot(pullX, pullY), this.maxPull) / this.maxPull);
    this.aimRad = this.pullAim(pullX, pullY);
    this.armed = true;
    return true;
  }
  cancelArm(): void {
    this.armed = false;
    this.aiming = false;
    this.power = 0;
  }

  // Fire the armed shot with the tap-timing error e∈[-1..1] (0 = pure). Turns the
  // miss into a straight push + side-spin curve (same model as the range), aims
  // along the BASE heading + steer (drive line on the tee, pin elsewhere — matches
  // aimHeading()/the on-turf arrow/the camera), launches, counts the stroke.
  fireArmed(accuracyError: number): void {
    if (!this.armed) return;
    this.armed = false;
    const e = Math.max(-1, Math.min(1, accuracyError));
    const powerW = ACCURACY_POWER_FLOOR + (1 - ACCURACY_POWER_FLOOR) * this.power;
    const curve = e * ACCURACY_CURVE * powerW;
    const pushAim = e * ACCURACY_AIM * powerW;
    const lss = Math.max(-ACCURACY_SPIN_MAX, Math.min(ACCURACY_SPIN_MAX, this.spinSide + curve));
    const b = this.ball;
    this.originD = this.shotOriginD = b.d;
    this.originX = this.shotOriginX = b.x;
    const dir = this.baseHeading() + this.aimRad + pushAim;
    // On the green the stroke is a PUTT (ground roll); everywhere else a lofted
    // swing. Both aim along baseHeading() + the steer (the drive line on the teed
    // shot, bearing-to-pin otherwise), and both count a stroke.
    if (this.putting()) this.puttLaunch(this.power, dir);
    else this.swing(this.power, dir, lss);
    this.strokes += 1;
    this.power = 0;
  }

  // Replay from the previous shot's origin after water/OB, adding a penalty.
  private applyPenalty(): void {
    const b = this.ball;
    b.d = this.shotOriginD;
    b.x = this.shotOriginX;
    b.h = this.ground(b.d, b.x);
    b.vd = b.vx = b.vh = 0;
    this.strokes += 1;
    this.penaltyPending = false;
    this.result = this.lieAt(b.d, b.x);
    this.clubId = this.recommendedClub(); // re-club for the replay lie/distance
  }

  getState(): CourseState {
    const b = this.ball;
    const pin = this.hole.pin;
    return {
      clubId: this.clubId,
      clubName: this.club().name,
      par: this.par,
      strokes: this.strokes,
      power: this.power,
      aiming: this.aiming,
      armed: this.armed,
      inFlight: b.inFlight,
      resting: b.resting,
      holed: this.holed,
      aimDeg: (this.aimRad * 180) / Math.PI,
      distToPin: Math.round(Math.hypot(b.d - pin.d, b.x - pin.x)),
      lie: this.lieAt(b.d, b.x),
      lastResult: this.result,
      spinBack: this.spinBack,
      spinSide: this.spinSide,
      penaltyPending: this.penaltyPending,
      windAlong: this.windAlong,
      windCross: this.windCross,
      carry: Math.round(this.carry),
      total: Math.round(this.total),
      apex: Math.round(this.apex),
      ballSpeed: Math.round(this.ballSpeed),
      putting: this.putting(),
      holeId: this.hole.id,
      driveYards: this.driveYards == null ? null : Math.round(this.driveYards),
      closestToPinYards:
        this.closestToPinYards == null ? null : Math.round(this.closestToPinYards),
      longestPuttYards:
        this.longestPuttYards == null ? null : Math.round(this.longestPuttYards),
    };
  }

  substep(dt: number): void {
    const b = this.ball;
    if (!b.inFlight) return;

    // Safety: guarantee a shot always terminates (~833s of sim time) even if a
    // future physics change breaks convergence, so the live loop can never
    // strand the player waiting on a ball that won't rest.
    if (++this.stepGuard > 100000) return this.stop(this.lieAt(b.d, b.x));

    // Wind only pushes an AIRBORNE ball; a grounded/near-resting ball isn't
    // shoved around by wind (that used to nudge settled balls on a windy hole).
    if (!b.grounded) {
      b.vd += this.windAlong * dt;
      b.vx += this.windCross * dt;
    }

    if (b.grounded) {
      // Gravity down the fall line (this is the break / downhill run / uphill
      // check). slopeAccel = -g·gradient at the ball.
      const { ad, ax } = slopeAccel(this.hole, b.d, b.x, GRAVITY);
      b.vd += ad * dt;
      b.vx += ax * dt;
      // Friction, sampled at the pre-move lie (the surface being rolled ON this
      // substep). GREEN/FRINGE run the calibrated Stimpmeter Coulomb model — a
      // CONSTANT rolling decel a = g·μ at ALL speeds, so roll-out is exactly
      // v²/(2a) and (decel constant while speed shrinks) the ball breaks more as
      // it dies. Everywhere else keeps the club-tuned exponential run-out plus a
      // low-speed Coulomb bleed to settle it.
      const surf0 = this.lieAt(b.d, b.x);
      const greenRoll = surf0 === 'green' || surf0 === 'fringe';
      if (greenRoll) {
        const a = greenDecel(surf0);
        const sp = Math.hypot(b.vd, b.vx);
        if (sp > 1e-5) {
          const k = Math.max(0, (sp - a * dt) / sp);
          b.vd *= k;
          b.vx *= k;
        }
      } else {
        const decay = Math.pow(this.rollDecay, dt * 60);
        b.vd *= decay;
        b.vx *= decay;
        const fric = frictionFor(surf0);
        const sp0 = Math.hypot(b.vd, b.vx);
        if (sp0 > 1e-5 && sp0 < LOW_ROLL_SPEED) {
          const k = Math.max(0, (sp0 - fric * dt) / sp0);
          b.vd *= k;
          b.vx *= k;
        }
      }
      b.d += b.vd * dt;
      b.x += b.vx * dt;
      // Trunk ricochet (swept) BEFORE the water/ob stop, so a carom off a tree can
      // send a wide ball back toward play instead of dying where it rolled. relH=0
      // grounded, so the ball is always below the trunk top. Reposition + reflect
      // happen inside; re-sample the ground under the (possibly nudged) position.
      this.hitTrunk(b.d - b.vd * dt, b.x - b.vx * dt, 0);
      b.h = this.ground(b.d, b.x);
      this.total = this.origin2D(b.d, b.x);
      const surf = this.lieAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'ob') return this.stop('ob');
      const speed = Math.hypot(b.vd, b.vx);
      if (this.holedOut(speed)) return this.stop('holed');
      // Flagstick strike on the ground roll (swept over this substep's motion so a
      // fast skidder can't tunnel the pin): a slow catch drops (holed), a firm one
      // caroms off the pole and stays out (velocity reflected + nudged clear).
      // holedOut() already dropped the slow cup-captures above, so on the ground
      // this almost always DEFLECTS a hot ball off the pin. prev = pre-move pos.
      if (this.hitPin(b.d - b.vd * dt, b.x - b.vx * dt, speed)) return this.stop('holed');
      // ONE rest rule for EVERY grounded surface (green, fringe, fairway, rough,
      // bunker, tee, cartpath): the ball comes to rest when it is BOTH
      //   (a) slower than the surface's settle threshold, AND
      //   (b) on a slope its STATIC friction can hold —
      // i.e. the downhill slopeAccel can't overcome staticHoldFor(surf). If the
      // slope IS steeper than the static hold the ball keeps rolling/accelerating
      // downhill (a genuinely steep bank), unchanged; it then rolls down until
      // the slope eases to the static-hold contour and settles there — instead of
      // creeping at a hair above the kinetic-repose slope forever (the reported
      // bug). The green rests at a finer speed (a putt must roll its last inch);
      // its static hold IS the Stimpmeter μ·g, so the putt-rest is this same rule.
      const onGreen = surf === 'green' || surf === 'fringe';
      const restSpeed = onGreen ? GREEN_REST : ROLL_REST;
      const staticHold = staticHoldFor(surf);
      if (speed <= restSpeed && Math.hypot(ad, ax) <= staticHold) return this.stop(surf);
      this.pushTrail();
      return;
    }

    // Airborne: gravity + spin + drag, integrate.
    b.vh -= GRAVITY * dt;
    b.vh += this.spinBack * SPIN_LIFT_ACC * dt;
    b.vx += this.launchSpinSide * SPIN_SIDE_ACC * dt;
    const drag = Math.pow(AIR_DRAG, dt * 60);
    b.vd *= drag;
    b.vx *= drag;
    b.vh *= drag;
    b.d += b.vd * dt;
    b.x += b.vx * dt;
    b.h += b.vh * dt;
    const above = b.h - this.teeGround;
    if (above > this.apex) this.apex = above;
    this.pushTrail();

    let ground = this.ground(b.d, b.x);
    // Flagstick strike IN FLIGHT: a descending shot that reaches the pin while
    // below the flag top can hole (a soft dart that catches the pin) or carom off
    // the pole. Gated on b.vh < 0 (descending) AND the ball being within the
    // flag's height above ground, so a shot flying well over the pin never
    // touches it. hitPin only reflects the HORIZONTAL velocity and nudges d/x —
    // vh/h carry on through the airborne integrator unchanged.
    if (b.vh < 0 && b.h - ground <= PIN_HEIGHT) {
      const speed = Math.hypot(b.vd, b.vx);
      // Swept over this substep's horizontal motion (prev = pre-integration pos)
      // so a descending liner can't tunnel the pin at speed.
      if (this.hitPin(b.d - b.vd * dt, b.x - b.vx * dt, speed)) return this.stop('holed');
    }
    // Trees IN FLIGHT: a trunk ricochet (below the trunk top) reflects the
    // horizontal velocity; the canopy brush lightly damps a ball flying through
    // the leaves. Trunk first (uses the unmodified pre-brush velocity for the swept
    // prev), then the brush. Both leave vh/h to the airborne integrator (trunk) or
    // scale it a touch (canopy).
    const relH = b.h - ground;
    if (this.hitTrunk(b.d - b.vd * dt, b.x - b.vx * dt, relH)) {
      // Nudged to the trunk edge — re-sample the ground under the new position so
      // the landing test below reads the post-nudge lie (the nudge is sub-yard, so
      // relH for the canopy brush stays accurate enough).
      ground = this.ground(b.d, b.x);
    }
    this.brushCanopy(relH, dt);
    // Land on descent (h dropping to the surface), OR when a still-climbing liner
    // has clearly PENETRATED rising terrain — the latter catches a low shot that
    // would otherwise tunnel through an upslope. The penetration MARGIN keeps a
    // just-launched skim (h ≈ ground) from false-settling at the tee.
    if ((b.h <= ground && b.vh < 0) || b.h < ground - 0.5) {
      b.h = ground;
      const wasFirst = this.firstLanding;
      if (this.firstLanding) {
        this.carry = this.origin2D(b.d, b.x);
        this.firstLanding = false;
      }
      const surf = this.lieAt(b.d, b.x);
      if (surf === 'water') return this.stop('water');
      if (surf === 'ob') return this.stop('ob');
      // First-contact spin check (identical model to the range).
      if (wasFirst) {
        const hs = Math.abs(b.vd);
        const back = Math.max(0, this.spinBack);
        const top = Math.max(0, -this.spinBack);
        b.vd -= back * (CHECK_BACK_FRAC * hs + CHECK_BACK_KICK);
        b.vd += top * CHECK_TOP_FRAC * hs;
      }
      // Bounce or settle, per the LIE material — same core as rangeSim.
      const club = this.club();
      const mat = TERRAIN[terrainFor(surf)];
      const up = -b.vh * mat.restitution;
      if (up < mat.bounceMin) {
        b.grounded = true;
        b.vh = 0;
        const top = Math.max(0, -this.spinBack);
        const rollF = Math.min(0.98, club.rollFactor * mat.rollMul * (1 + top * SPIN_ROLL));
        b.vd *= rollF;
        b.vx *= rollF;
        const biteExtra = Math.max(0, this.spinBack) * SPIN_BITE;
        const base = ROLL_FRICTION - club.backspin * BITE_K * mat.biteMul - biteExtra;
        this.rollDecay = Math.max(0.6, Math.min(0.99, 1 - (1 - base) / mat.runMul));
      } else {
        b.vh = up;
        const keep = Math.min(0.92, mat.bounceKeep + 0.2 * club.rollFactor);
        b.vd *= keep;
        b.vx *= keep;
      }
    }
  }

  // Speed-dependent cup capture (shared greenPhysics.cupCaptured): the ball
  // drops only if slow AND within an effective radius that shrinks with speed —
  // a dead-weight ball holes from within CUP_R, a quick one only near dead-
  // centre, a fast one lips out / rolls over. Replaces the old pure "within
  // radius AND under a fixed speed" test.
  private holedOut(speed: number): boolean {
    const b = this.ball;
    const p = this.hole.pin;
    return cupCaptured(Math.hypot(b.d - p.d, b.x - p.x), speed, CUP_R);
  }

  // Flagstick (pin) collision — SWEPT over the ball's motion this substep. The
  // pin sits at the cup centre with a physical pole radius POLE_R; the ball's
  // centre swept prev→cur has STRUCK the pole when the segment passes within
  // POLE_R + BALL_R of the pin (poleSweep). Sweeping (not a single endpoint test)
  // is what keeps the pin live for a FAST shot — a powered approach / liner that
  // would step clean over the ~0.56-yd zone in one substep and tunnel through.
  // `speed` is the horizontal ground speed; (prevD,prevX) the pre-integration
  // position.
  //   • A slow strike DROPS: the pin is right over the cup, so the shared
  //     cupCaptured() rule (at the closest approach distance) holes it — returns
  //     true so the caller stops the shot 'holed', exactly like the cup path.
  //   • A faster strike DEFLECTS: reverse the inbound normal component of the
  //     horizontal velocity with POLE_RESTITUTION (pace killed, tangential glide
  //     kept) and nudge the ball just OUTSIDE the collision radius along the
  //     contact normal so the next substep starts clear (no re-trigger). Only
  //     caroms when the ball is moving TOWARD the pin (poleSweep.approaching), so
  //     a ball sitting at / leaving the pin isn't shoved by a pole it's departing.
  //     Vertical motion (vh) is left untouched — consistent with both the
  //     grounded (vh already 0) and airborne integrators. Returns false.
  // Stateless: reads only ball + hole.pin and mutates the ball's own fields, so
  // no new CourseSim state is introduced (the snapshot round-trip guard is safe).
  private hitPin(prevD: number, prevX: number, speed: number): boolean {
    const b = this.ball;
    const p = this.hole.pin;
    const R = POLE_R + BALL_R;
    const sw = poleSweep(prevD, prevX, b.d, b.x, p.d, p.x, R);
    if (sw.minDist > R) return false; // the swept path never reached the pole
    // Dead-centre slow strike → the pin funnels it into the cup.
    if (cupCaptured(sw.minDist, speed, CUP_R)) return true;
    // Otherwise carom off the pole — but only on an inbound strike.
    if (!sw.approaching) return false;
    const r = poleDeflect(b.vd, b.vx, sw.n1, sw.n2, POLE_RESTITUTION);
    b.vd = r.v1;
    b.vx = r.v2;
    const clear = R + 1e-3;
    b.d = p.d + sw.n1 * clear;
    b.x = p.x + sw.n2 * clear;
    return false;
  }

  // Trunk ricochet — SWEPT over this substep's horizontal motion (prev→cur) against
  // each tree's vertical trunk cylinder (trunkR), so a fast ball can't tunnel a
  // trunk. When the swept path passes within trunkR + BALL_R of a trunk WHILE the
  // ball is below the trunk top AND moving toward it, the HORIZONTAL velocity is
  // REFLECTED about the trunk-surface normal (trunk centre → contact point) with
  // TRUNK_RESTITUTION (a central hit comes back, a glancing hit deflects) and a
  // little pace is shed (TRUNK_SPEED_KEEP). vh/h are untouched — consistent with
  // the flagstick carom. The ball is nudged just OUTSIDE the collision radius so
  // the next substep starts clear. `relH` is the ball height above the LOCAL
  // ground (0 when grounded); a ball above the trunk top clears it. Stateless
  // beyond the ball's own fields (snapshot guard safe). Reflects the FIRST trunk
  // struck. Returns true on a strike.
  private hitTrunk(prevD: number, prevX: number, relH: number): boolean {
    const b = this.ball;
    for (const t of this.trees) {
      if (relH > t.height) continue; // ball is over the trunk top — no trunk hit
      const R = t.trunkR + BALL_R;
      // Broad phase: skip a trunk whose centre lies outside the swept segment's
      // AABB inflated by R (exact — a hit can't occur outside it). predict() runs
      // this ×3 per aim frame, so pruning the poleSweep cost is worthwhile.
      if (t.d < Math.min(prevD, b.d) - R || t.d > Math.max(prevD, b.d) + R) continue;
      if (t.x < Math.min(prevX, b.x) - R || t.x > Math.max(prevX, b.x) + R) continue;
      const sw = poleSweep(prevD, prevX, b.d, b.x, t.d, t.x, R);
      if (sw.minDist > R || !sw.approaching) continue;
      const r = poleDeflect(b.vd, b.vx, sw.n1, sw.n2, TRUNK_RESTITUTION);
      b.vd = r.v1 * TRUNK_SPEED_KEEP;
      b.vx = r.v2 * TRUNK_SPEED_KEEP;
      const clear = R + 1e-3;
      b.d = t.d + sw.n1 * clear;
      b.x = t.x + sw.n2 * clear;
      return true;
    }
    return false;
  }

  // Canopy brush — an airborne ball whose centre lies inside a tree's canopy
  // sphere (radius canopyR centred canopyH above the base) has its velocity
  // LIGHTLY damped this substep: leaves brushing it, "just a little", never a hard
  // stop. dt-scaled (Math.pow(keep, dt)) so a quick pass loses little and a longer
  // dwell loses a bit more, emergent, and identical live + headless. Only scales
  // the ball's own velocity (snapshot guard safe). `relH` = height above local
  // ground; brushes the FIRST canopy entered.
  private brushCanopy(relH: number, dt: number): void {
    const b = this.ball;
    for (const t of this.trees) {
      const dd = b.d - t.d;
      if (dd > t.canopyR || dd < -t.canopyR) continue; // broad phase (cheap axis reject)
      const dh = relH - t.canopyH;
      if (dh > t.canopyR || dh < -t.canopyR) continue;
      const dx = b.x - t.x;
      if (dd * dd + dx * dx + dh * dh <= t.canopyR * t.canopyR) {
        const k = Math.pow(CANOPY_KEEP_PER_SEC, dt);
        b.vd *= k;
        b.vx *= k;
        b.vh *= k;
        return;
      }
    }
  }

  // Capture / restore the FULL mutable simulation state in ONE place. predict()
  // dry-runs the REAL swing/substep/roll pipeline on live state, then rewinds to
  // byte-identical with restore() — so there is no parallel "prediction physics"
  // to hand-sync, and no per-field snapshot list to silently drift out of date
  // (the old predict() hand-copied only 13 fields, which is exactly the class of
  // bug this closes). snapshot() takes EVERY mutable field; adding new sim state
  // means adding it here, next to the fields. The round-trip test in
  // courseSim.test.ts dumps ALL own data props of the sim INDEPENDENTLY of
  // snapshot() (so it can see fields snapshot() omits) and fails loudly if
  // predict() mutates something snapshot()/restore() forgot. The physics itself
  // is shared BY CONSTRUCTION: predict, fireArmed and simulateShot all call the
  // same swing()/puttLaunch()/substep().
  private snapshot(): CourseSnapshot {
    return {
      ball: { ...this.ball },
      trail: this.trail.slice(),
      clubId: this.clubId,
      spinBack: this.spinBack,
      spinSide: this.spinSide,
      launchSpinSide: this.launchSpinSide,
      windAlong: this.windAlong,
      windCross: this.windCross,
      carry: this.carry,
      total: this.total,
      apex: this.apex,
      ballSpeed: this.ballSpeed,
      firstLanding: this.firstLanding,
      rollDecay: this.rollDecay,
      result: this.result,
      originD: this.originD,
      originX: this.originX,
      aiming: this.aiming,
      power: this.power,
      aimRad: this.aimRad,
      armed: this.armed,
      strokes: this.strokes,
      holed: this.holed,
      dragStart: { ...this.dragStart },
      maxPull: this.maxPull,
      shotOriginD: this.shotOriginD,
      shotOriginX: this.shotOriginX,
      penaltyPending: this.penaltyPending,
      stepGuard: this.stepGuard,
      driveYards: this.driveYards,
      closestToPinYards: this.closestToPinYards,
      longestPuttYards: this.longestPuttYards,
      driveRecorded: this.driveRecorded,
      shotIsDrive: this.shotIsDrive,
      shotIsPutt: this.shotIsPutt,
      puttStartDist: this.puttStartDist,
    };
  }

  private restore(s: CourseSnapshot): void {
    Object.assign(this.ball, s.ball);
    this.trail.length = 0;
    for (const p of s.trail) this.trail.push(p);
    this.clubId = s.clubId;
    this.spinBack = s.spinBack;
    this.spinSide = s.spinSide;
    this.launchSpinSide = s.launchSpinSide;
    this.windAlong = s.windAlong;
    this.windCross = s.windCross;
    this.carry = s.carry;
    this.total = s.total;
    this.apex = s.apex;
    this.ballSpeed = s.ballSpeed;
    this.firstLanding = s.firstLanding;
    this.rollDecay = s.rollDecay;
    this.result = s.result;
    this.originD = s.originD;
    this.originX = s.originX;
    this.aiming = s.aiming;
    this.power = s.power;
    this.aimRad = s.aimRad;
    this.armed = s.armed;
    this.strokes = s.strokes;
    this.holed = s.holed;
    this.dragStart = { ...s.dragStart };
    this.maxPull = s.maxPull;
    this.shotOriginD = s.shotOriginD;
    this.shotOriginX = s.shotOriginX;
    this.penaltyPending = s.penaltyPending;
    this.stepGuard = s.stepGuard;
    this.driveYards = s.driveYards;
    this.closestToPinYards = s.closestToPinYards;
    this.longestPuttYards = s.longestPuttYards;
    this.driveRecorded = s.driveRecorded;
    this.shotIsDrive = s.shotIsDrive;
    this.shotIsPutt = s.shotIsPutt;
    this.puttStartDist = s.puttStartDist;
  }

  // Non-committing trajectory PREDICTION for the aim aid — runs the CURRENT
  // address inputs (club/power/steer/spin) through the SAME launch+flight+roll
  // pipeline the live shot uses and captures the path, WITHOUT disturbing any
  // live state (snapshot() before, restore() after — see above). Because it
  // reuses the real integrator ON THE TERRAIN, the drawn arc, landing reticle
  // and roll-out marker are true to the yard. `accuracy` bakes in a tap-timing
  // miss so the dispersion edges can be drawn. Read-only — the renderer calls it
  // several times per address (centre + both edges). Accepts an options object
  // ({ accuracy, includeWind, stride }) — unified with rangeSim — or a bare
  // number for the legacy `predict(0)` callers, which is read as { accuracy }.
  // With `includeWind: false` the wind is zeroed for the dry-run (the "intended"
  // pre-wind line); snapshot()/restore() put windAlong/windCross back after.
  predict(opts: CoursePredictOptions | number = {}): CoursePrediction {
    const o = typeof opts === 'number' ? { accuracy: opts } : opts;
    const accuracy = o.accuracy ?? 0;
    const fixedS = FIXED_MS / 1000;
    const stride = Math.max(1, Math.floor(o.stride ?? 2));
    const b = this.ball;
    const snap = this.snapshot();
    if (o.includeWind === false) {
      this.windAlong = 0;
      this.windCross = 0;
    }

    const e = Math.max(-1, Math.min(1, accuracy));
    const powerW = ACCURACY_POWER_FLOOR + (1 - ACCURACY_POWER_FLOOR) * this.power;
    const lss = Math.max(
      -ACCURACY_SPIN_MAX,
      Math.min(ACCURACY_SPIN_MAX, this.spinSide + e * ACCURACY_CURVE * powerW),
    );
    this.originD = b.d;
    this.originX = b.x;
    // SAME base as fireArmed (drive line on the tee, pin elsewhere; + steer), so
    // the predicted arc, landing reticle and dispersion centre on the exact line
    // the shot will fly.
    const dir = this.baseHeading() + this.aimRad + e * ACCURACY_AIM * powerW;
    // Predict the SAME stroke the live fire will make — a putt roll on the green,
    // a lofted swing elsewhere — so the on-turf aim line never lies about it.
    if (this.putting()) this.puttLaunch(this.power, dir);
    else this.swing(this.power, dir, lss);

    const path: CourseTrailPt[] = [{ d: b.d, x: b.x, h: b.h }];
    let landing: { d: number; x: number; h: number } | null = null;
    // Index into `path` of the first sample AT/AFTER the first ground contact, so
    // a full-swing aim preview can truncate the drawn arc at the first bounce
    // (drawer takes path.slice(0, landingIndex + 1)). null for a putt/roll that
    // never goes airborne. Additive: path/landing/rest/result are unchanged.
    let landingIndex: number | null = null;
    let i = 0;
    let guard = 0;
    while (b.inFlight && guard < 100000) {
      const wasFirst = this.firstLanding;
      this.substep(fixedS);
      const pushed = i % stride === 0;
      if (pushed) path.push({ d: b.d, x: b.x, h: b.h });
      if (wasFirst && !this.firstLanding && landing == null) {
        landing = { d: b.d, x: b.x, h: b.h };
        // The carry endpoint's slot in `path`: the sample just pushed this
        // substep (the contact point), else the NEXT slot — a later substep push
        // or the final rest push always fills it, so the index is always valid.
        landingIndex = pushed ? path.length - 1 : path.length;
      }
      i++;
      guard++;
    }
    path.push({ d: b.d, x: b.x, h: b.h });
    const out: CoursePrediction = {
      path,
      landing,
      landingIndex,
      rest: { d: b.d, x: b.x, h: b.h },
      result: this.result,
    };

    this.restore(snap);
    return out;
  }

  // Drive a single shot end to end and MEASURE it (tests / tuning / AI). Sets
  // club/spin/aim/power off the given origin, launches, integrates to rest.
  simulateShot(opts: CourseShotOptions = {}): CourseShot {
    const fixedS = FIXED_MS / 1000;
    const b = this.ball;
    if (opts.from) {
      b.d = opts.from.d;
      b.x = opts.from.x;
    } else {
      b.d = this.hole.tee.d;
      b.x = this.hole.tee.x;
    }
    this.originD = b.d;
    this.originX = b.x;
    if (opts.clubId) this.clubId = opts.clubId;
    this.spinBack = Math.max(-1, Math.min(1, opts.spinBack ?? 0));
    this.spinSide = Math.max(-1, Math.min(1, opts.spinSide ?? 0));
    if (opts.windAlong != null) this.windAlong = opts.windAlong;
    if (opts.windCross != null) this.windCross = opts.windCross;
    const aim = ((opts.aimDeg ?? 0) * Math.PI) / 180;
    this.swing(opts.power ?? 1, aim, this.spinSide);
    let guard = 0;
    while (this.ball.inFlight && guard < 100000) {
      this.substep(fixedS);
      guard++;
    }
    const p = this.hole.pin;
    return {
      carry: Math.round(this.carry),
      total: Math.round(this.total),
      apex: Math.round(this.apex),
      ballSpeed: Math.round(this.ballSpeed),
      restD: b.d,
      restX: b.x,
      distToPin: Math.round(Math.hypot(b.d - p.d, b.x - p.x)),
      result: this.result,
    };
  }

  // A putt/roll from a lie with an initial ground speed + bearing (no launch
  // angle). Used to prove greens break and for the putting phase on the course.
  simulatePutt(from: { d: number; x: number }, speed: number, bearingDeg: number): CourseShot {
    const fixedS = FIXED_MS / 1000;
    const b = this.ball;
    b.d = from.d;
    b.x = from.x;
    b.h = this.ground(b.d, b.x);
    this.originD = b.d;
    this.originX = b.x;
    const a = (bearingDeg * Math.PI) / 180;
    b.vd = speed * Math.cos(a);
    b.vx = speed * Math.sin(a);
    b.vh = 0;
    b.inFlight = true;
    b.grounded = true;
    b.resting = false;
    this.carry = 0;
    this.apex = 0;
    this.firstLanding = false;
    // Mark it a putt so a holed roll feeds the longest-putt record (mirrors
    // puttLaunch on the live fire path).
    this.shotIsDrive = false;
    this.shotIsPutt = true;
    this.puttStartDist = Math.hypot(b.d - this.hole.pin.d, b.x - this.hole.pin.x);
    // Putting surface friction: use the lie's own material run, no club bite.
    const mat = TERRAIN[terrainFor(this.lieAt(b.d, b.x))];
    this.rollDecay = Math.max(0.6, Math.min(0.99, 1 - (1 - 0.985) / mat.runMul));
    let guard = 0;
    while (this.ball.inFlight && guard < 100000) {
      this.substep(fixedS);
      guard++;
    }
    const p = this.hole.pin;
    return {
      carry: 0,
      total: Math.round(this.origin2D(b.d, b.x)),
      apex: 0,
      ballSpeed: Math.round(speed),
      restD: b.d,
      restX: b.x,
      distToPin: Math.round(Math.hypot(b.d - p.d, b.x - p.x)),
      result: this.result,
    };
  }

  // Slope of the ground under a point, for a putt-read aid later (the UI can draw
  // the break arrow from this). Thin wrapper so the UI needn't import terrain.
  slopeUnder(d: number, x: number): { gd: number; gx: number } {
    return gradientAt(this.hole, d, x);
  }
}
