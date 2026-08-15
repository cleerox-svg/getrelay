// Every tunable number in the baseball game, in one place, with its CATEGORY
// stated. Pure data: no imports, no three, no Math.random, no clock — so this
// file can be read by the sim, the HUD and the GL scene without dragging
// anything behind it, and so `airPhysics.ts` can import the substep from here
// without a cycle.
//
// ⚠ THE PHYSICS RULE. A number in this game is exactly one of:
//
//   • PUBLISHED DATA — a rule-book or measured figure from outside this repo
//     (60.5 ft, 5.125 oz, 93.9 mph). Changing it means the source changed.
//   • DERIVED — computed from other numbers (ρ, K = ρA/2m, the ball's mass).
//     NEVER hand-set: a hand-set derived value silently disconnects its inputs.
//   • CALIBRATED — chosen so a FAILING TEST passes against published data
//     (C_D, and the break measurement segment below). The test is the
//     definition; the constant is the answer.
//   • FEEL KNOB — has no physical referent at all and is labelled as such
//     (PITCH_TEMPO). A feel knob may be turned freely; nothing else may.
//
// There is no fifth category. In particular there is no "fudge factor", no
// "per-pitch correction" and no "close enough multiplier". If the eight-row
// pitch table cannot be reached, the finding gets reported, not absorbed into a
// new constant.

// ---------------------------------------------------------------------------
// The substep — FIXED
// ---------------------------------------------------------------------------
//
// ⚠ FIXED_MS is THE shared substep of the whole game: the live rAF loop, the
// headless predict() used by the AI, the vitest harness and the screenshot
// driver all advance by exactly this. That identity is what makes an on-screen
// trajectory trustworthy evidence about the physics — the pitch you watch is
// the pitch the test measured, step for step.
//
// It lives HERE rather than in airPhysics.ts (where stage 1 left it) so that
// the render layer can import the substep without importing the integrator.
// airPhysics.ts re-exports it, so every stage-1 consumer is unaffected.

/** The one substep, in milliseconds. 120 Hz. FIXED. */
export const FIXED_MS = 1000 / 120;

/** The one substep, in seconds. DERIVED from FIXED_MS. */
export const FIXED_DT = FIXED_MS / 1000;

// ---------------------------------------------------------------------------
// Playback — FEEL KNOB, and quarantined from the physics
// ---------------------------------------------------------------------------

/**
 * Slow-motion playback rate for a pitch, ∈ (0, 1]. FEEL KNOB — pure
 * presentation, no physical referent whatsoever. 0.55 means a pitch that really
 * takes 0.40 s takes 0.73 s of wall time on screen, which is what makes a
 * one-tap timing game playable at all.
 *
 * ⚠ IT MUST NEVER TOUCH dt, AND NOTHING IN THE SIM MAY READ IT. Gravity is
 * linear in dt while both aero terms go as v², so scaling dt re-weights them
 * against each other and silently rewrites every break number in the table —
 * a bug that would look like "the curveball feels a bit flat" and never like a
 * broken integrator.
 *
 * The architecture that enforces this: `pitchSim` precomputes the ENTIRE
 * trajectory at true physical time into a sampled PitchTrack, and the render
 * layer plays that array back at PITCH_TEMPO. Contact resolves against the true
 * physical state, at true physical time, at any tempo. `pitchSim.ts` does not
 * import this constant, and its test asserts the trajectory is identical
 * whatever the tempo is set to, because the tempo cannot reach it.
 */
export const PITCH_TEMPO = 0.55;

// ---------------------------------------------------------------------------
// Air the game is played in — PUBLISHED DATA (a default; parks override)
// ---------------------------------------------------------------------------
//
// Air reaches the ball through exactly one channel, K = ρA/2m (airPhysics.ts),
// so these three numbers ARE the park effect. Stage 3's parks.ts supplies its
// own elevation per park; these are the neutral defaults used by the pitch sim
// and by anything that has not been told where it is.

/** Default park elevation, ft. PUBLISHED DATA (sea level). */
export const GAME_ELEV_FT = 0;

/** Default game-time temperature, °F. PUBLISHED DATA (a mild evening). */
export const GAME_TEMP_F = 70;

/** Default relative humidity, 0..1. PUBLISHED DATA (a mild evening). */
export const GAME_RH = 0.5;

// ---------------------------------------------------------------------------
// DRAG — one coefficient, two regimes, and an honest account of each number
// ---------------------------------------------------------------------------
//
// `airPhysics.dragCoef(speedFps, S)` reads these. They live HERE rather than
// beside the integrator because the physics rule demands a CATEGORY per number
// and this is the file that keeps them, and because `airPhysics.ts` is near its
// 500-line cap. `airPhysics.ts` re-exports `C_D_BASE` so stage-1 consumers are
// unchanged.
//
// ⚠ WHY THERE ARE TWO REGIMES AT ALL. Stage 3 ran the published max-carry ladder
// as an INDEPENDENT test of a `C_D` fitted entirely in the pitch regime, and it
// missed by +58.3 ft mean, uniformly positive. Stage 3 also showed no single
// CONSTANT `C_D` repairs it (0.385 fits the level, flattens the slope the wrong
// way and puts the four-seamer at the plate at 84.1 mph against a published 86.3
// — see `C_D_BASE`). Both of those results stand. What stage 3 stopped one step
// short of is the resolution: a REYNOLDS-dependent `C_D`, which a real baseball
// has and which `dragCoef(speedFps, S)`'s signature has anticipated since stage
// 1. A pitch never drops below ~72 mph and a fly ball decays to ~45, so the two
// regimes sample different parts of the curve — which is exactly why one
// constant could not serve both.
//
// ⚠ AND SPIN-DEPENDENT `C_D` IS RULED OUT AS A STANDALONE, by arithmetic. Holding
// C_D(S = 0.211) = 0.300 for the pitch while the fly ball needs C_D(S ≈ 0.30) ≈
// 0.385 implies dC_D/dS ≈ 0.95 and C_D(0) ≈ 0.10 — an absurd spinless drag. The
// `S` parameter stays in the signature (a real ball does gain a little drag with
// spin) but nothing reads it, and it must not be made to carry this.

/**
 * Kinematic viscosity of air, ft²/s. PUBLISHED DATA (~1.57e-4 at 70 °F, sea
 * level). Used ONLY to turn a speed into a Reynolds number.
 *
 * ⚠ HELD FIXED, AND THAT IS A MODELLING CHOICE WITH A MEASURED PRICE. ν = μ/ρ,
 * so a mile-high park's ν is 21.6 % higher (ρ is 17.8 % lower, μ depends only on
 * temperature) and the SAME speed there sits at a 17.8 % LOWER Reynolds number —
 * deeper into the crisis, i.e. MORE drag. Holding ν fixed puts the crisis at the
 * same SPEED in every park. Measured cost at 105 mph: the model's mile-high
 * carry is 465.9 ft (+34.7 ft over sea level); with a park-local Re it would be
 * 438.1 ft (+6.9 ft). The published altitude effect is ~25–30 ft on a 400 ft
 * fly, which favours the fixed-ν answer — but that agreement is a check, not a
 * derivation, and the honest reading is that it bounds how much the crisis
 * PLACEMENT matters at altitude. Fixing it properly means giving `dragCoef` the
 * park's ρ, which changes its signature and every caller; flagged, not fudged.
 *
 * ⚠ STAGE 4 MEASURED THE LIKE-FOR-LIKE COMPARISON AND IT IS BETTER THAN THIS
 * NOTE SAID. The +34.7 ft above is the 105 mph MAX-CARRY rung, which is a 432 ft
 * fly at sea level — but the published ~25–30 ft is quoted ON A 400 FT FLY, and
 * the altitude gain is superlinear in flight length (8.03 % of a 432 ft fly,
 * 7.61 % of a 400 ft one). Hold the swing fixed at a 400 ft sea-level carry and
 * change only the air: the model gives **+29.1 ft** at 5200 ft and +29.5 at
 * 5280, or +30.0 / +30.4 with each air at its own optimum launch angle. That is
 * INSIDE the published band, at its top edge — not outside it. `parks.test.ts`
 * prints the ladder and asserts the band. The value of ν did NOT move; only the
 * yardstick was corrected.
 */
export const AIR_KINEMATIC_VISC_FT2_S = 1.57e-4;

/**
 * Subcritical drag coefficient — below the crisis. PUBLISHED DATA: ~0.50 is the
 * standard low-speed drag coefficient quoted for a baseball throughout the
 * aerodynamics literature (and is the classic subcritical sphere value).
 * *(Exact reference unverified — confirm before publication, the same standard
 * `C_L`'s fit is held to. A general attribution is honest; an invented citation
 * is not.)*
 *
 * ⚠ IT WAS NOT FITTED TO THE CARRY LADDER, and that is worth stating because the
 * temptation was right there. Sweeping it against the six published rungs with
 * `C_D_BASE` and the band pinned gives an RMS optimum near 0.5375 (RMS 5.6 ft)
 * against 0.50's RMS 9.5 ft. We kept the published 0.50; the ladder is then an
 * INDEPENDENT check that it passes — mean residual +7.7 ft against a ±15 ft
 * corroboration bar — rather than a fit it was built to satisfy.
 *
 * (This note used to read 0.545 / RMS 5.7 / RMS 9.1 / mean +7.2. Those were
 * measured against the CUBIC smoothstep and never re-run when the shape became a
 * quintic — see `RE_CRISIS_LO`'s note, which had gone stale the same way. The
 * cubic still gives mean +7.17 / RMS 9.06 today, so nothing drifted: the prose
 * was simply describing a curve the game no longer integrates. Every number in
 * this block is the shipped quintic's.)
 */
export const C_D_SUBCRIT = 0.5;

/**
 * Supercritical drag coefficient — above the crisis. CALIBRATED, and UNMOVED by
 * this stage: it is stage 1's number, pinned by a 94.0 mph release crossing the
 * plate at 86.3 mph. See the long note on `airPhysics.dragCoef` for the
 * conditions, which are part of the number. The whole point of the crisis curve
 * is that it reproduces this: the four-seamer measures 86.287 mph against
 * 86.288 with the old constant, a 0.001 mph move. (Measured at `FIXED_DT` and
 * again at 64× refinement — 86.2874 both times, so this is the physics and not
 * the substep. It read 86.283 here until stage 4's audit: that was the cubic
 * smoothstep's figure, left behind when the shape became a quintic.)
 */
export const C_D_BASE = 0.3;

/**
 * The Reynolds band the drag crisis is smoothed across. CALIBRATED, WITH A
 * PUBLISHED PRIOR — and the two halves of that label are worth separating.
 *
 *   NOMINATED FROM OUTSIDE. A *seamed* ball's drag crisis sits far below a
 *   smooth sphere's ~3.5e5, in the region 1e5–2e5, because the seams trip the
 *   boundary layer early. (Exact reference unverified — flagged.) That range is
 *   where these two numbers come from; they were not free to be anything.
 *
 *   PINNED INSIDE IT BY THE LADDER. Within that range the placement is
 *   load-bearing and the carry ladder is what fixes it: 1.0e5–1.9e5 gives a mean
 *   residual of +15.5 ft, 1.1e5–2.0e5 gives +7.7 ft, 1.2e5–2.1e5 gives −0.1 ft
 *   but starts to cost the pitch regime (four-seam plate speed 86.244 mph, and
 *   falling). 1.1e5–2.0e5 is the band that lands the ladder well inside the
 *   corroboration bar while leaving stage 1 untouched. So: calibrated.
 *   (Re-measured in stage 4's audit. The +15.0 / +7.2 / −0.6 / 86.17 this note
 *   carried are the CUBIC smoothstep's numbers for the same three bands —
 *   re-measured, the cubic still gives exactly those — so the ladder did not
 *   drift; the prose was never re-run after the shape changed below.)
 *
 * ⚠ AND THE SHAPE IS AN ASSUMPTION, NOT A FIT. The quintic `smootherstep`
 * between the two endpoints is an INTERPOLATION, not a measurement: we have no
 * C_D(Re) dataset in this repo, and pretending a smootherstep is one would be
 * the fifth category by a prettier route. Measured cost of the choice — a LINEAR
 * ramp over the same band gives a mean carry residual of +6.2 ft (against +7.7)
 * and a four-seam plate speed of 86.244 mph (against 86.287) — so the shape is
 * worth ~1.5 ft of carry and ~0.04 mph of plate speed.
 *
 * ⚠ QUINTIC RATHER THAN THE USUAL CUBIC, FOR A MEASURED REASON. The cubic
 * smoothstep u²(3 − 2u) is only C¹: its second derivative jumps at both ends of
 * the band, and a 94 mph pitch decays right through the upper end. That kink
 * costs RK4 its convergence order — measured, on `airPhysics.test.ts`'s own
 * refinement bench, a halving ratio of 8.07 where 4th order demands ~16. The
 * quintic is C² and restores it (15.4–16.7 across the same rungs, matching the
 * constant-C_D baseline). A C^∞ exp-bump blend does marginally better still
 * (16.0–16.2) for two `exp` calls per RK4 stage and is not worth it. So the
 * shape is an assumption, but WHICH smooth shape was decided by the integrator,
 * not by taste.
 *
 * ⚠ THOSE RATIOS ARE THE PITCH BENCH'S, AND ONLY THE PITCH BENCH'S. A review
 * asked whether "15.4–16.7" is a property of the game or of that one flight, and
 * it is the latter. Re-measured on a BATTED ball (100 mph, 27°, 4 s, successive
 * halvings of `FIXED_DT`) the picture is:
 *
 *   • at 1200 rpm or 0 rpm the ratios are 24.5 / 20.2 before the flight hits a
 *     ~1e-12 ft roundoff floor — comfortably ≥ 16, i.e. the crisis shape is not
 *     the limiting kink out there either;
 *   • at the reference 2200 rpm they collapse to 2.0 / 3.1 / 7.4 with 150× the
 *     absolute error (3.4e-7 ft at 120 Hz). That is NOT the smoothstep: it is
 *     `C_L_MAX`, a hard `Math.min` clamp that binds for ~17 % of that flight and
 *     is only C⁰. On a fly ball the lift clamp, not `dragCoef`, is what sets the
 *     observed order.
 *
 * Both findings are recorded rather than acted on: 3.4e-7 ft of integration
 * error on a 400 ft flight is eleven orders below anything gameplay can see, and
 * softening `C_L_MAX` would move carry, which is a calibration question and not
 * a numerics one. The quintic argument stands on the pitch bench, where it was
 * made and where the pitch table is asserted.
 */
export const RE_CRISIS_LO = 1.1e5;
export const RE_CRISIS_HI = 2.0e5;

// ---------------------------------------------------------------------------
// The induced-break reporting convention
// ---------------------------------------------------------------------------
//
// See BASEBALL.md § "Induced break — the reporting convention". Break is
// DEFINED as the displacement between the real trajectory and a reference
// trajectory that shares its position, velocity, drag and gravity but has ZERO
// spin. Because drag and gravity are identical between the two, the difference
// is exactly the Magnus term's contribution — nothing else.
//
// Two things about that definition are conventions rather than physics, and
// both change the answer by a lot, so both are pinned here:
//
//   1. THE AIR. The same four-seamer measures 22.59 in in ISA air, 22.01 in at
//      70 °F/50 % RH and 18.11 in a mile up. Quote the air or the number is
//      meaningless. Published break tables are league-wide, so the reference
//      air is ISA sea level — NOT the game-day air above.
//   2. THE SEGMENT. Deflection grows as the square of the measured length, so
//      "how much did it break" has no answer until you say "over what". This is
//      the one free parameter stage 2 had, and it was fitted — see below.

/** Break-reference temperature, °F. PUBLISHED DATA (ISA sea level). */
export const BREAK_REF_TEMP_F = 59;

/** Break-reference humidity, 0..1. PUBLISHED DATA (ISA is dry). */
export const BREAK_REF_RH = 0;

/** Break-reference elevation, ft. PUBLISHED DATA (ISA sea level). */
export const BREAK_REF_ELEV_FT = 0;

/**
 * Length of the segment, in feet BEFORE the plate, over which induced break is
 * measured. CALIBRATED — but read the whole note, because the honest answer is
 * more interesting than the number.
 *
 * WHAT STAGE 2 SET OUT TO TEST. Stage 1 measured its fully-efficient reference
 * four-seamer at 22.59 in over the whole flight against a published ~16 in, and
 * concluded the gap was a measured-segment convention rather than a coefficient
 * error. Stage 2 tested that: one free parameter (this one) against sixteen
 * published constraints (eight pitches × IVB and HB), swept 30→54 ft, residual
 * table printed by `pitchSim.test.ts`.
 *
 * ⚠ IT FAILED, AND THAT IS THE FINDING. No single segment reconciles all eight.
 * The length each pitch needs to hit its own published break spans 34.0 ft
 * (cutter) to 51.1 ft (sinker). The RMS optimum over all sixteen is 44 ft, at
 * an RMS residual of 3.40 in, which fits nothing well.
 *
 * WHY THE SEGMENT CANNOT BE THE ANSWER, in one line: over a common segment,
 * deflection ≈ ½·K·C_L·|v|²·(L/|v|)² = ½·K·C_L·L², so |v| cancels and the RATIO
 * of any two pitches' break is just the ratio of their C_L. Keeping the drag
 * makes that cancellation EXACT rather than leading-order: with |v| = v₀·e^(−k·x)
 * and k = K·C_D, integrating a_M = K·C_L·|v|² twice in time (dt = dx/|v|) gives
 *     Δ = K·C_L·[ (e^(k·L) − 1)/k² − L/k ]     → ½·K·C_L·L² as k → 0,
 * in which v₀ does not appear AT ALL — because |v| enters once through a_M ∝ |v|²
 * and twice through dt. The model obeys it to 4.3 % at L = 40 and 2.9 % at
 * L = 50 — and that residual is L-DEPENDENT (7.1 % at L = 20, 2.4 % at L = 54),
 * because the prediction evaluates C_L at the release spin parameter while the
 * real S climbs as |v| decays, so a short segment measures only the last and
 * slowest feet, where the true C_L has drifted furthest. What does NOT move with
 * L is the ratio itself (≤ 0.011 between L = 40 and L = 50). The
 * segment sets the SCALE of all eight together and nothing else. The published
 * table's break ratios disagree with the C_L ratios implied by its own
 * spin/efficiency columns by up to 2.1× (the cutter), so no choice of scale can
 * fit them.
 *
 * AND THE ERROR IS NOT IN C_L'S SHAPE EITHER — which matters, because the
 * identity above says break ratios ARE C_L ratios, so C_L(S)'s functional form
 * is precisely the lever that could change the pattern, and its citation is
 * flagged unverified. The argument that closes it needs no C_L at all, only
 * that C_L is monotone in S (asserted in airPhysics.test.ts): the published
 * table contains a spin/break INVERSION. The cutter has the higher spin
 * parameter (S = 0.175 vs the changeup's 0.152) and HALF the published break
 * ratio (0.444 vs 0.899). Under any monotone C_L a higher S must break at least
 * as much over a common segment, so no fit — published, refitted or invented —
 * reproduces that pair. (The curveball vs the four-seamer is a second, milder
 * instance: S 0.251 vs 0.197, break 0.768 vs 1.000.) The error is in the
 * arsenal's spin data or in unmodelled physics (seam-shifted wake), NOT in a
 * coefficient and NOT here. `pitchSim.test.ts` asserts the inversion.
 *
 * WHY 50 AND NOT THE RMS-OPTIMAL 44 — two reasons, and only two.
 *   1. It is nominated from OUTSIDE this data: the tracking system fits every
 *      pitch's trajectory parameters at a reference plane 50 ft from the plate,
 *      so a movement figure derived from that fit is naturally a 50 ft figure.
 *      ⚠ UNVERIFIED — that the public movement columns use that segment is an
 *      inference, flagged, not asserted.
 *   2. The single best-measured row in baseball independently requires it: the
 *      four-seamer, whose tilt and break columns agree to 1.1°, needs 49.8 ft on
 *      its own.
 * The sinker (51.1 ft) and changeup (50.8 ft) land there too, but they are NOT a
 * third and fourth independent confirmation and must not be sold as one: the
 * bisection matches break MAGNITUDE, so "requires ~50 ft" and "published ÷ C_L
 * ≈ 1" are the same statement, and the latter is defined relative to the
 * four-seamer. One constraint plus two consistency checks. (The changeup in
 * particular is the second-WORST row in the table by tilt/break agreement, 22.5°
 * out, so it is not evidence of anything except its own magnitude.)
 * 44 ft is then rejected on its own terms: it is a least-squares compromise
 * fitted to rows the inversion above proves mutually inconsistent, and it makes
 * the best-measured pitch in baseball WORSE (four-seam IVB residual +0.3 in at
 * 50 ft, −3.3 in at 44 ft).
 *
 * ⚠ OPEN QUESTION, HELD TO THE SAME STANDARD AS THE LENGTH: WHERE THE SEGMENT
 * ENDS. It ends at d = 0, the plate's REAR point, because that is the physics
 * frame's origin — but the front edge is 1.42 ft nearer, and C_D's calibration
 * note already flags the identical ambiguity as one of its two biases. A segment
 * running from the same 50 ft plane to the FRONT edge measures 15.39 in on the
 * reference four-seamer against 16.31 in, i.e. 5.6 % / 0.92 in less. (Sliding a
 * full 50 ft segment earlier so it ENDS at the front edge costs only 0.13 %, so
 * this is a question about the segment's LENGTH, not its placement.) Unresolved
 * and unverifiable from here, so it is flagged rather than split the difference.
 *
 * ⚠ THIS IS THE ONLY NUMBER STAGE 2 FITTED, AND IT IS GLOBAL. C_D and C_L did
 * not move; they are published/calibrated and locked by stage 1's
 * mutation-verified tests. A pitch that misses does NOT get its own segment
 * length — a per-pitch measurement convention is a fudge factor wearing a lab
 * coat, and `pitchSim.test.ts` asserts the ratio structure above specifically so
 * that adding one is a test failure.
 */
export const BREAK_SEGMENT_FT = 50;

// ---------------------------------------------------------------------------
// The barrel — PUBLISHED DATA (a classification, not a physical constant)
// ---------------------------------------------------------------------------
//
// A "barrel" is the published batted-ball quality class: the exit-velocity /
// launch-angle combination that historically produces at least a .500 average
// and a 1.500 slugging percentage. It lives here rather than in `batSim.ts`
// because it is a SCORING rule read by the HUD, the derby payout and the duel —
// none of which should have to import a collision solver to colour a hit.
//
// The rule: 98 mph is the floor, and at exactly 98 the window is 26–30°. Every
// mph above 98 opens the window by ~1° on each side, until it saturates.
//
// ⚠ ONE HONEST CONVENTION GAP. The published rule is usually quoted with the
// endpoint "at 116 mph, any ball between 8 and 50 degrees is a barrel". The
// symmetric 1°/mph rule reaches 8° on the low side exactly (26 − 18 = 8) but
// only 48° on the high side, so the real upper edge widens slightly faster
// (~1.11°/mph). We implement the symmetric rule the definition states rather
// than a two-rate fit to one endpoint, and the difference only ever shows up
// above 114 mph at launch angles above 48° — a ball that is a lazy fly either
// way. Flagged, not split.

/** Minimum exit velocity for a barrel, mph. PUBLISHED DATA. */
export const BARREL_MIN_EV_MPH = 98;

/** Launch-angle window at exactly `BARREL_MIN_EV_MPH`, deg. PUBLISHED DATA. */
export const BARREL_LA_LO_DEG = 26;
export const BARREL_LA_HI_DEG = 30;

/** Window widening per mph of exit velocity above the floor, deg. PUBLISHED. */
export const BARREL_WIDEN_DEG_PER_MPH = 1;

/** Saturation clamps on the window, deg. PUBLISHED DATA (the 116 mph row). */
export const BARREL_LA_FLOOR_DEG = 8;
export const BARREL_LA_CEIL_DEG = 50;

/**
 * Is this batted ball a barrel? PUBLISHED classification — no free parameters,
 * nothing here is tuned, and it must never become one: a barrel is a fixed
 * external yardstick the game is scored against, so widening it to make the
 * derby feel generous would silently redefine the measurement.
 */
export function isBarrel(evMph: number, laDeg: number): boolean {
  if (evMph < BARREL_MIN_EV_MPH) return false;
  const widen = (evMph - BARREL_MIN_EV_MPH) * BARREL_WIDEN_DEG_PER_MPH;
  const lo = Math.max(BARREL_LA_FLOOR_DEG, BARREL_LA_LO_DEG - widen);
  const hi = Math.min(BARREL_LA_CEIL_DEG, BARREL_LA_HI_DEG + widen);
  return laDeg >= lo && laDeg <= hi;
}

// ---------------------------------------------------------------------------
// Score clamps — MIRRORED FROM THE WORKER. Do not diverge.
// ---------------------------------------------------------------------------
//
// ⚠ THE SERVER IS THE AUTHORITY AND IT WILL REJECT, NOT CLAMP. These two
// numbers are copies of MAX_ROUNDS / MAX_POINTS_PER_ROUND in
// `packages/relay-worker/src/games.ts`, where a submitted score above
// MAX_ROUNDS × MAX_POINTS_PER_ROUND is a 400, not a truncation. They are
// duplicated here (rather than imported) because the worker and the UI deploy
// INDEPENDENTLY and cannot share a module — which is exactly why a divergence
// is dangerous: a scoring change that lets a good derby round pay 2500 points
// ships fine, plays fine, and then silently fails to submit for every player
// who has a great game.
//
// If you change a payout, check the product against these first, and change
// the worker in the same PR.

/** Max rounds the worker will accept in one submitted game. MIRRORED. */
export const MAX_ROUNDS = 8;

/** Max points per round the worker will accept. MIRRORED. */
export const MAX_POINTS_PER_ROUND = 2000;

/** The worker's hard score ceiling. DERIVED from the two mirrors above. */
export const MAX_SUBMITTABLE_SCORE = MAX_ROUNDS * MAX_POINTS_PER_ROUND;
