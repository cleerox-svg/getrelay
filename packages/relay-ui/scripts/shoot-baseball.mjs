// Headless screenshot harness for the baseball stadium scene — the VISUAL GATE.
//
// It boots a Vite dev server for @relay/ui, drives the pre-installed Chromium
// with software GL (SwiftShader), loads baseballpreview.html for each scene,
// waits for a real render (window.__baseballReady, set by
// src/baseballpreview.tsx once three frames have drawn) and writes PNGs to
// packages/relay-ui/.baseball-shots/ (git-ignored). This is what the
// baseball-visual-qa agent runs; humans run it via `pnpm shoot:baseball`.
//
// ⚠ IT CAPTURES console.error AS WELL AS pageerror, AND THIS IS NOT OPTIONAL.
// three logs shader compile/link failures to console.error and then SILENTLY
// SKIPS the mesh. Without the console hook a broken material renders as a
// plausible-looking stadium minus one object, and every check a human is not
// personally squinting at passes.
//
// ⚠ IT ASSERTS NUMBERS, IT DOES NOT MERELY PRINT THEM, AND THAT DISTINCTION IS
// THE WHOLE POINT OF THE FILE. An adversarial review drew the outfield wall 5 ft
// wrong on purpose; this harness printed `worst |Δ| — distance 5.002 ft` and then
// exited 0. A gate that observes the failure and returns success is not a gate.
// Four families of number are checked, and every one of them can fail the run:
//   • draw calls and triangles per scene — the charter's rule 7 demands a numeric
//     GPU budget, so there are ceilings below and they are enforced;
//   • the fence distance and height at 0°/±22°/±45° MEASURED OUT OF THE BUILT
//     GEOMETRY, beside what parks.ts says. A read-back of the builder's own
//     input would prove nothing; this reads the BufferGeometry vertices, so a
//     wall drawn from the five knots instead of the pchip shows up as a delta —
//     and now as a non-zero exit code.
//   • THE TRACER AGAINST THE SIM. See the block above `TRACER_TOL_FT`. This is
//     the check the visual gate was created for and it was blind to it until the
//     ball existed: the sim reports N inches of break, and the DRAWN curve must
//     bend the same way and the same amount.
//   • the batted tracer's own apex and carry, against `BattedFlight`'s.
//
// ⚠ SwiftShader validates composition, geometry and materials but NOT real-GPU
// behaviour. "Renders fine in SwiftShader" is not evidence of on-device safety —
// see the shadow-map note in stadium/quality.ts.
//
// Usage:
//   node scripts/shoot-baseball.mjs                 # all scenes
//   node scripts/shoot-baseball.mjs batter wide     # one or more scene ids

import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgDir, '.baseball-shots');

// The scene matrix. Four camera MODES over one scene, the second park, and five
// flight scenes.
//
// `park-alpine` is the proof that a park is data: a different fence row must
// produce a visibly different wall (347/390/415/375/350 against Harbourfront's
// symmetric 328/375/400, a 16 ft wall in left-centre against a uniform 10, and
// NO ROOF at all against a 282 ft ring).
//
// ⚠ EVERY SCENE CARRIES `t=` OR `bt=`, AND THAT IS A DETERMINISM REQUIREMENT,
// NOT A FRAMING CHOICE. With neither, `StadiumGL` plays the flight back off
// `performance.now()` at `PITCH_TEMPO` and the ball lands wherever the frame
// budget put it — two runs would then differ by a few pixels of ball and the
// byte-identical check would be meaningless. `t` is TRUE PHYSICAL seconds since
// release; `bt` is seconds since CONTACT, and implies a swing.
const SCENES = {
  batter: { query: 'scene=batter&t=0.30', label: 'batter' },
  pitcher: { query: 'scene=pitcher&t=0.30', label: 'pitcher' },
  wide: { query: 'scene=wide&t=0.30', label: 'wide' },
  flight: { query: 'scene=flight&t=0.30', label: 'flight' },
  'park-alpine': { query: 'scene=wide&park=alpine&t=0.30', label: 'park-alpine-wide' },
  // The three break shots. Same camera, same target, same frozen fraction of the
  // flight — so the ONLY thing that differs between the three PNGs is the pitch
  // row, and a human comparing them is comparing break and nothing else.
  'pitch-4seam': { query: 'scene=batter&pitch=ff&t=0.30', label: 'pitch-4seam' },
  'pitch-curve': { query: 'scene=batter&pitch=cu&t=0.35', label: 'pitch-curve' },
  'pitch-sweeper': { query: 'scene=batter&pitch=st&t=0.35', label: 'pitch-sweeper' },
  // The ball just off the bat, from the box, and the same ball near its apex
  // from the upper deck.
  contact: { query: 'scene=batter&pitch=ff&bt=0.12', label: 'contact' },
  homerun: { query: 'scene=flight&pitch=ff&bt=2.6', label: 'homerun' },
  // The DERBY's aim aid: the rule-zone frame and the reticle, drawn as geometry
  // at the plate rather than as a DOM overlay. Placed low and to the pull side
  // (u = −0.55, v = −0.45) rather than dead centre, because a centred reticle
  // sits on the zone frame's own centre and a mis-sized one would look correct.
  // Same camera and same frozen instant as `pitch-4seam`, so the pair differ by
  // the aid and nothing else.
  aim: { query: 'scene=batter&pitch=ff&t=0.30&aim=-0.55,-0.45', label: 'aim' },
};

// Portrait, a phone screen. Same shape as the golf harness so the two sets of
// shots are comparable side by side.
const VIEWPORT = { width: 900, height: 1600 };
const READY_TIMEOUT_MS = 20000;

// Bearings the fence table is printed at: dead centre, the two power alleys and
// both foul lines. −45/0/+45 are sampled knots in both parks; ±22 is a knot in
// Harbourfront and an OFF-KNOT pchip evaluation in Alpine (whose knots are
// ±20), which is exactly the case a knots-only renderer would get wrong.
const FENCE_BEARINGS = [-45, -22, 0, 22, 45];

/**
 * How far the DRAWN wall may sit from `parks.ts`, ft — distance and height.
 *
 * This is a SAMPLING-RESIDUAL tolerance, not a taste one, and it is derived
 * rather than picked. The wall is a chord polyline through `fenceAt` evaluated
 * every `quality.fenceStepDeg`, and `sample()` reads it back by interpolating
 * linearly between two adjacent posts, so the only legitimate error is the
 * chord's sagitta against the pchip across one step. Measured:
 *
 *     tier      step     worst |Δ| dist   worst |Δ| height
 *     high      0.5°     0.000 ft         0.000 ft
 *     medium    1.5°     0.006 ft         0.005 ft      ← the harness default
 *     low       3.0°     0.027 ft         0.021 ft
 *
 * (Measured by forcing `?quality=` over both parks — the `wide` scene, whose
 * geometry is the same wall every mode draws.) Chord error goes as step², which
 * the medium → low row confirms: 4× the error for 2× the step, on both columns.
 * 0.05 ft is therefore ~8× the default tier's residual and 1.9× the coarsest tier
 * the game can ever run at, and it is 100× SMALLER than the 4.97 ft
 * knots-vs-pchip gap this whole read-back exists to catch — a wall drawn from the
 * five knots, or a builder that quietly rounds, cannot hide under it. It is also
 * far below anything a player could see: 0.05 ft is 0.6 in on a 10 ft wall.
 */
const FENCE_TOL_FT = 0.05;

/**
 * ⚠ THE TRACER GATE, AND ITS TWO DERIVED TOLERANCES.
 *
 * `baseball-visual-qa`'s highest-value check is: read the sim's reported break,
 * then confirm the DRAWN tracer bends the same way and by the same amount. A
 * tracer drawn from a separate visual spline that disagrees with the sim is the
 * exact bug class the gate exists for, and it went unchecked through M1 because
 * there was no ball to draw.
 *
 * Three independent comparisons, because they fail on different mistakes:
 *
 *   (1) POSITION, DRAWN → SIM — for every DRAWN vertex, the sim's own track is
 *       interpolated to that vertex's distance-from-the-plate and the two are
 *       differenced. Catches an offset, a scale error, a mirrored axis, a wrong
 *       frame conversion.
 *   (1r) POSITION, SIM → DRAWN — the REVERSE direction, and it is not optional.
 *       (1) alone is a ONE-DIRECTIONAL Hausdorff distance: it asks only "is
 *       every drawn vertex on the sim path", never "is every sim sample near
 *       the drawn line". A tracer that keeps a handful of the sim's own
 *       vertices and drops the rest passes (1) EXACTLY — every vertex it kept
 *       is on the path — while drawing a chord straight through the break.
 *       Measured, on a deliberately adversarial tracer that kept the samples at
 *       d ≥ 49 ft plus the plate point (ff: 51 verts → 6):
 *
 *           check                       worst |Δx|   deflection drawn vs sim
 *           (1) drawn → sim             0.00e+0      identical to 6 decimals
 *           (1r) sim → drawn            2.45e-1 ft   —
 *
 *       i.e. the forward direction reported EXACTLY ZERO error on a tracer
 *       hiding 1.58 in of horizontal and 2.94 in of vertical break (14.23 in on
 *       `cu`), and the reverse direction catches it at 122× tolerance on `ff`,
 *       593× on `cu`. The reverse direction is also what actually catches a
 *       TRUNCATED buffer, which the header above claimed for (1) and which (1)
 *       does not catch: dropping the tail leaves every surviving vertex correct.
 *   (2) DEFLECTION — the departure of the path from the straight line tangent to
 *       it at `segmentFt`, evaluated at the plate, computed by the SAME function
 *       on the drawn polyline and on the sim's dense track. Catches the case
 *       position cannot: a curve that agrees at its ends and bends differently
 *       in between. A constant offset cancels out of a deflection, which is
 *       precisely why (1) is not redundant.
 *
 *       ⚠ AND DEFLECTION CANNOT SUBSTITUTE FOR (1r). It reads only the pair of
 *       vertices straddling `segFt` and the final vertex, so a chord that keeps
 *       dense samples astride 50 ft (exact tangent) and the true plate point
 *       (exact endpoint) reproduces it to 1e-5 in while drawing nothing in
 *       between. That is measured above, not argued.
 *
 * ⚠ THE HARNESS CONVERTS FRAMES ITSELF, from `zone.ts`'s REPORT definition and
 * `stadium/geom.ts`'s scene frame, and deliberately does NOT call the
 * renderer's converter. A gate that reuses the code under test is a tautology.
 *
 * TRACER_TOL_FT = 0.002. Derived. The tracer's vertices live in a Float32
 * `BufferAttribute` (that is what the GPU draws, so that is what is read back),
 * whose quantum at the largest scene coordinate a fly ball reaches — ~500 ft —
 * is 500·2⁻²⁴ = 3.0e-5 ft, and 3.8e-6 ft over the 60 ft of a pitch. The
 * interpolation in (1) lands on a track node whenever the tracer is a subsample
 * of the track, and on the exact chord otherwise, so it contributes nothing.
 * 0.002 ft is ~65× that residual and 40× BELOW one inch — the scale at which a
 * break error is a physics claim. Nothing about the tolerance is physical.
 *
 * DEFLECT_TOL_IN = 0.05. Derived from the same float32 residual through the
 * metric's own lever arm: the tangent is estimated over one substep (~1.1 ft at
 * 94 mph) and extrapolated 50 ft, so a 3.8e-6 ft vertex error is amplified
 * ~46× to 1.7e-4 ft = 0.002 in. 0.05 in is ~25× that and ~300× below the
 * ~15 in of break it is measuring. It is dominated by tracer SAMPLING — a
 * tracer decimated to every 10th substep would move it by the chord error of
 * the tangent estimate, which is the intended sensitivity.
 */
const TRACER_TOL_FT = 0.002;
const DEFLECT_TOL_IN = 0.05;

/**
 * The batted tracer's own carry and apex against `BattedFlight`'s reported
 * numbers, ft. Looser than TRACER_TOL_FT and for a stated reason: apex is a
 * MAXIMUM over the drawn samples, and the sim's `apexFt` is the same maximum
 * over the same samples, so they agree exactly — but `carryFt` is measured to
 * the interpolated ground crossing while the drawn polyline's last vertex is
 * that same interpolated point, so the only error is float32 at ~450 ft
 * (2.7e-5 ft). 0.01 ft is 370× that and is 0.12 in on a 430 ft fly.
 */
const BATTED_TOL_FT = 0.01;

/**
 * The GPU ceiling, per scene. Charter rule 7: "GPU budget with a number", and a
 * number nobody enforces is a comment.
 *
 * M1's worst scene was `wide` at 18 draws / 1,845 triangles. M2b adds at most
 * four: the ball, its contact shadow, the pitch tracer and the batted tracer
 * (three geometries draw nothing when their draw range is 0, which three skips
 * before it counts a call). The two ceilings are deliberately NOT set the same
 * multiple of that, because the two costs do not grow the same way:
 *
 *   • DRAW CALLS are the dominant mobile cost and the one thing the charter
 *     legislates directly — the crowd is ONE `InstancedMesh`, repeated geometry
 *     is instanced or merged. Draw calls should therefore grow by ones as M2 art
 *     lands (crowd, lights, scoreboard, skyline, bat), not by multiples.
 *     40 is 1.8× today's worst, and sits UNDER 3 × 22 = 66, so the "somebody
 *     gave every seating section its own material" regression trips it. That is
 *     the failure this number exists for.
 *   • TRIANGLES are cheap per instance and expensive per bad decision. An
 *     instanced crowd legitimately adds six figures of triangles inside ONE draw
 *     call, so a 3× ceiling here would fire on correct M2 art and get raised,
 *     which is how a budget becomes a formality. 120,000 is a real static-scene
 *     budget for a mid-range mobile GPU and still catches what actually goes
 *     wrong — an un-instanced crowd or a 64-segment sphere per seat lands in the
 *     millions, not the tens of thousands.
 *
 * ⚠ If one of these has to move, it moves with a comment saying what was
 * measured, exactly like the line caps in `budget.test.ts`. "The scene got
 * bigger" is not a measurement.
 */
const MAX_DRAW_CALLS = 40;
const MAX_TRIANGLES = 120000;

/**
 * The ball's radius, ft. DERIVED HERE from the published 9.125 in circumference
 * — `r = C/2π` — and deliberately NOT imported from `airPhysics.ts`, for the
 * same reason the frame conversions above are written out: a gate that reuses
 * the value under test cannot fail on it.
 */
const BALL_RADIUS_FT = 9.125 / (2 * Math.PI) / 12;

const requested = process.argv.slice(2);
const ids = requested.length ? requested : Object.keys(SCENES);
for (const id of ids) {
  if (!SCENES[id]) {
    console.error(`Unknown scene "${id}". Known: ${Object.keys(SCENES).join(', ')}`);
    process.exit(2);
  }
}

async function loadPlaywright() {
  let gRoot;
  try {
    gRoot = execSync('npm root -g', { encoding: 'utf8' }).trim();
  } catch {
    throw new Error('Could not run `npm root -g` to locate the global Playwright install.');
  }
  for (const entry of ['playwright/index.mjs', 'playwright-core/index.mjs']) {
    try {
      return await import(path.join(gRoot, entry));
    } catch {
      /* try next */
    }
  }
  throw new Error(
    `Playwright not found in the global npm root (${gRoot}). This harness needs a ` +
      `global Playwright + a Chromium under PLAYWRIGHT_BROWSERS_PATH.`,
  );
}

const f2 = (v) => (v === null || v === undefined ? '   —  ' : v.toFixed(2).padStart(7));
const f3 = (v) => (v === null || v === undefined ? '    —  ' : v.toFixed(3).padStart(8));

// ---------------------------------------------------------------------------
// The tracer gate's arithmetic. Pure, so it can be reasoned about on its own.
// ---------------------------------------------------------------------------

/**
 * Scene ft → the REPORT frame the pitch sim publishes in.
 *
 * `stadium/geom.ts`: scene x is lateral (+ = first-base side), scene y is up,
 * scene −z is toward centre field. `zone.ts`: REPORT d is + toward centre field
 * from the plate, x is + to the umpire's right = the first-base side, h is
 * height. So d = −z, x = x, h = y. Written out here, from those two documents,
 * rather than imported — see the note above TRACER_TOL_FT.
 */
const reportFromSceneFlat = (flat) => {
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push({ d: -flat[i + 2], x: flat[i], h: flat[i + 1] });
  }
  return out;
};

/** The sim's REPORT-frame parallel arrays as the same list of points. */
const reportFromTrack = (track) =>
  track.d.map((d, i) => ({ d, x: track.x[i], h: track.h[i] }));

/** Linear interpolation of a d-ordered (descending) path at a given `d`. */
function atDistance(path, d) {
  if (path.length === 0) return null;
  if (d >= path[0].d) return path[0];
  const last = path[path.length - 1];
  if (d <= last.d) return last;
  let hi = 1;
  while (hi < path.length - 1 && path[hi].d > d) hi++;
  const a = path[hi - 1];
  const b = path[hi];
  const f = a.d === b.d ? 0 : (a.d - d) / (a.d - b.d);
  return { d, x: a.x + (b.x - a.x) * f, h: a.h + (b.h - a.h) * f };
}

/**
 * The deflection functional: how far the path has departed, at the plate, from
 * the straight line tangent to it at `segFt` out.
 *
 * This is the geometry of "break" applied to a polyline. It is NOT identical to
 * `measureBreak`'s number — that one differences against a spinless trajectory
 * that carries the same drag, whose lateral path is straight in TIME rather than
 * in distance — so the two are printed side by side and only the SIGN is
 * asserted between them. What IS asserted numerically is drawn-vs-sim of this
 * same functional, which is a statement about the renderer and not about physics.
 */
function deflectionIn(path, segFt) {
  let i = 0;
  while (i + 1 < path.length && path[i + 1].d >= segFt) i++;
  const a = path[i];
  const b = path[i + 1];
  if (!a || !b || a.d < segFt) return null;
  const f = a.d === b.d ? 0 : (a.d - segFt) / (a.d - b.d);
  const p0x = a.x + (b.x - a.x) * f;
  const p0h = a.h + (b.h - a.h) * f;
  const sx = (b.x - a.x) / (b.d - a.d);
  const sh = (b.h - a.h) / (b.d - a.d);
  const end = path[path.length - 1];
  const dd = end.d - segFt;
  return { xIn: (end.x - (p0x + sx * dd)) * 12, hIn: (end.h - (p0h + sh * dd)) * 12 };
}

/** WORLD (batted) ft → scene, and back. `geom.ts`: scene = (world.y, z, x). */
const worldFromSceneFlat = (flat) => {
  const out = [];
  for (let i = 0; i + 2 < flat.length; i += 3) {
    out.push({ x: flat[i + 2], y: flat[i], z: flat[i + 1] });
  }
  return out;
};

const worldFromTrack = (track) => track.t.map((_, i) => ({ x: track.x[i], y: track.y[i], z: track.z[i] }));

/** Ground-plane radius from the contact point — monotone along a fly ball. */
const radiusOf = (p) => Math.hypot(p.x, p.y);

function atRadius(path, r) {
  if (path.length === 0) return null;
  if (r <= radiusOf(path[0])) return path[0];
  const last = path[path.length - 1];
  if (r >= radiusOf(last)) return last;
  let hi = 1;
  while (hi < path.length - 1 && radiusOf(path[hi]) < r) hi++;
  const a = path[hi - 1];
  const b = path[hi];
  const ra = radiusOf(a);
  const rb = radiusOf(b);
  const f = ra === rb ? 0 : (r - ra) / (rb - ra);
  return { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, z: a.z + (b.z - a.z) * f };
}

/**
 * Print the scene's numbers AND JUDGE THEM. Returns the list of violations —
 * an empty array means the scene passed.
 *
 * ⚠ IT RETURNS RATHER THAN PRINTS ITS VERDICT so the caller cannot forget to
 * count it. The version of this function that only printed is the reason a
 * deliberately 5 ft-wrong wall shipped a green run.
 */
function checkReport(report) {
  if (!report || report.err) {
    // ⚠ THIS IS A FAILURE, NOT A WARNING. It is the one branch in the file that
    // reports a problem, and it used to return success. `window.__baseball` is
    // completed from StadiumGL's `onReady`, so its absence after the ready
    // beacon means the scene handle is broken — every number below is then
    // unmeasured, which is strictly worse than measured-and-wrong.
    console.error(`  ✗ no scene handle: ${report?.err ?? 'window.__baseball missing'}`);
    return ['no scene handle'];
  }
  const violations = [];
  const s = report.stats;
  console.log(
    `  GPU   draws ${String(s.drawCalls).padStart(3)}  tris ${String(s.triangles).padStart(6)}` +
      `  progs ${s.programs}  geos ${s.geometries}  texs ${s.textures}` +
      `  tier ${s.tier} (${s.shadowMapSize}²) — ${s.qualityReason}`,
  );
  console.log(
    `  SHADOW  volume ±${s.shadowHalfFt.toFixed(0)} ft over ${s.shadowMapSize}² =` +
      ` ${s.shadowTexelFt.toFixed(3)} ft/texel  (ball radius 0.121 ft —` +
      ` ${(s.shadowTexelFt / 0.1210237).toFixed(1)}× the whole ball)`,
  );
  if (s.drawCalls > MAX_DRAW_CALLS) {
    violations.push(`draw calls ${s.drawCalls} > ceiling ${MAX_DRAW_CALLS}`);
  }
  if (s.triangles > MAX_TRIANGLES) {
    violations.push(`triangles ${s.triangles} > ceiling ${MAX_TRIANGLES}`);
  }
  console.log(
    `  FENCE park=${report.parkId}  roofPeak ${report.roofPeakFt} ft  foul ${report.foulTerritoryFt} ft`,
  );
  console.log('    bearing   geometry_ft   parks.ts_ft      Δft   geom_h    park_h     Δh');
  let worstD = 0;
  let worstH = 0;
  for (const row of report.fence) {
    const dd = row.geo && row.park ? row.geo.distFt - row.park.distFt : null;
    const dh = row.geo && row.park ? row.geo.heightFt - row.park.heightFt : null;
    if (dd !== null) worstD = Math.max(worstD, Math.abs(dd));
    if (dh !== null) worstH = Math.max(worstH, Math.abs(dh));
    // A bearing the geometry cannot answer is a HOLE IN THE WALL, and it must not
    // pass as "no delta measured". −45/0/+45 are sampled knots in both parks.
    if (!row.geo || !row.park) violations.push(`fence unmeasurable at ${row.deg}°`);
    console.log(
      `      ${String(row.deg).padStart(4)}°  ${f2(row.geo?.distFt)}      ${f2(row.park?.distFt)}` +
        `  ${f2(dd)}  ${f2(row.geo?.heightFt)}  ${f2(row.park?.heightFt)}  ${f2(dh)}`,
    );
  }
  console.log(
    `    worst |Δ| — distance ${worstD.toFixed(3)} ft, height ${worstH.toFixed(3)} ft` +
      `  (tol ${FENCE_TOL_FT} ft)`,
  );
  if (worstD > FENCE_TOL_FT) {
    violations.push(`fence distance off by ${worstD.toFixed(3)} ft > tol ${FENCE_TOL_FT} ft`);
  }
  if (worstH > FENCE_TOL_FT) {
    violations.push(`fence height off by ${worstH.toFixed(3)} ft > tol ${FENCE_TOL_FT} ft`);
  }

  violations.push(...checkPitchTracer(report));
  violations.push(...checkBattedTracer(report));
  violations.push(...checkBall(report));
  violations.push(...checkContactSeam(report));
  return violations;
}

/** Linear interpolation of a t-ordered sample list. Clamped, like `sampleTrack`. */
function atTime(times, comps, t) {
  const n = times.length;
  if (n === 0) return null;
  const at = (i) => comps.map((c) => c[i]);
  if (t <= times[0]) return at(0);
  if (t >= times[n - 1]) return at(n - 1);
  let i = 1;
  while (i < n - 1 && times[i] < t) i++;
  const t0 = times[i - 1];
  const t1 = times[i];
  const f = t1 > t0 ? (t - t0) / (t1 - t0) : 0;
  const a = at(i - 1);
  const b = at(i);
  return a.map((v, k) => v + (b[k] - v) * f);
}

/**
 * THE BALL ITSELF — position, visibility and scale.
 *
 * ⚠ THIS CHECK EXISTS BECAUSE `ballScene()` USED TO BE A TAUTOLOGY. It returned
 * the closure variable the setter had just computed, not `ball.position`, so
 * deleting `ball.position.set(...)` altogether left it returning the right
 * answer — the exact opposite of what `tracer.ts` deliberately does. It now
 * reads back out of the Object3D, and this is the check that makes that worth
 * anything: the harness re-derives the expected point from the sim's own track
 * by its own linear interpolation (which is what `sampleTrack` does — see
 * `pitchSim.ts`) and its own frame conversion.
 *
 * ⚠ AND `visible` IS ASSERTED, because a scene that never turns the ball on
 * reports a perfectly correct position and photographs an empty sky.
 *
 * ⚠ AND `scale`, because it was unmeasured and it is a DESIGN CLAIM:
 * `MIN_BALL_PX`'s note argues at length that there is no constant inflation
 * factor and that in `batter` / `pitcher` — where the true-size ball is already
 * 13 px and 7 px, and where the magenta scale reference exists to police it —
 * the drawn ball is the REAL SIZE. Unmeasured, a flat 3× would pass every other
 * number in this run. In those two modes the scale must therefore be EXACTLY
 * `BALL_RADIUS_FT`; elsewhere the screen-space floor may legitimately engage, so
 * only the floor's direction is asserted.
 */
function checkBall(report) {
  const violations = [];
  const t = report.ballTimeS;
  if (t === null || t === undefined) {
    // Every scene in SCENES carries `t=` or `bt=`; see the determinism note.
    console.error('    ✗ scene has no frozen ball time — the shot is not deterministic');
    return ['ball time not frozen'];
  }
  const b = report.batted;
  const expected =
    b && t >= report.contactTS
      ? (() => {
          const w = atTime(b.track.t, [b.track.x, b.track.y, b.track.z], t - report.contactTS);
          return w && [w[1], w[2], w[0]]; // world (x,y,z) → scene (y, z, x)
        })()
      : (() => {
          const r = atTime(report.pitch.track.t, [report.pitch.track.d, report.pitch.track.x, report.pitch.track.h], t);
          return r && [r[1], r[2], -r[0]]; // report (d,x,h) → scene (x, h, −d)
        })();
  const got = report.ballScene;
  if (!expected) return ['ball reference unmeasurable'];
  if (!got) {
    console.error('    ✗ the ball is not drawn at all');
    return ['ball not drawn'];
  }
  const worst = Math.max(...got.map((v, i) => Math.abs(v - expected[i])));
  console.log(
    `  BALL  t ${t.toFixed(3)} s  drawn (${got.map((v) => v.toFixed(4)).join(', ')})` +
      `  expected (${expected.map((v) => v.toFixed(4)).join(', ')})  worst |Δ| ${worst.toExponential(2)} ft` +
      `  (tol ${TRACER_TOL_FT} ft)`,
  );
  console.log(
    `        visible ${report.ballVisible}  scale ${report.ballScale.toFixed(6)} ft` +
      ` (true radius ${BALL_RADIUS_FT.toFixed(6)} ft, ×${(report.ballScale / BALL_RADIUS_FT).toFixed(2)})`,
  );
  if (worst > TRACER_TOL_FT) {
    violations.push(`the DRAWN ball is ${worst.toFixed(4)} ft off the sim's own sample`);
  }
  if (!report.ballVisible) violations.push('the ball is positioned but not visible');
  if (report.mode === 'batter' || report.mode === 'pitcher') {
    if (report.ballScale !== BALL_RADIUS_FT) {
      violations.push(
        `${report.mode} draws the ball at ${report.ballScale.toFixed(6)} ft, not the true ` +
          `${BALL_RADIUS_FT.toFixed(6)} ft — MIN_BALL_PX must not engage here`,
      );
    }
  } else if (report.ballScale < BALL_RADIUS_FT) {
    violations.push(`the ball is drawn SMALLER than life (${report.ballScale.toFixed(6)} ft)`);
  }
  for (const which of ['pitch', 'batted']) {
    const drawnLen = (which === 'pitch' ? report.pitchTracer : report.battedTracer).length;
    if (drawnLen > 0 && !report.tracerVisible[which]) {
      violations.push(`the ${which} tracer has ${drawnLen / 3} vertices and is not visible`);
    }
  }
  return violations;
}

/**
 * THE CONTACT SEAM — the one thing neither tracer check can see.
 *
 * Each tracer is checked against its own sim track, so each can be internally
 * perfect while the two do not meet: the pitch ends at the plate-crossing height
 * and the batted ball starts wherever its launch put it. That gap was MEASURED
 * at 0.5000 ft — the preview launched from `CONTACT_HEIGHT_FT` (3.0) while the
 * pitch arrived at `ZONE_CENTER.h` (2.50) — and it is invisible to every other
 * number in this file. `derbySim.resolveSwing` already contacts at `pr.plate.h`,
 * so the sim was never wrong; only the preview was.
 */
function checkContactSeam(report) {
  const p = report.pitchTracer;
  const b = report.battedTracer;
  if (p.length < 3 || b.length < 3) return [];
  const gap = Math.max(
    Math.abs(p[p.length - 3] - b[0]),
    Math.abs(p[p.length - 2] - b[1]),
    Math.abs(p[p.length - 1] - b[2]),
  );
  console.log(
    `  SEAM  last pitch vertex → first batted vertex: worst |Δ| ${gap.toExponential(2)} ft` +
      `  (tol ${TRACER_TOL_FT} ft)`,
  );
  return gap > TRACER_TOL_FT
    ? [`the batted ball starts ${gap.toFixed(4)} ft from where the pitch ended`]
    : [];
}

function checkPitchTracer(report) {
  const violations = [];
  const p = report.pitch;
  const drawn = reportFromSceneFlat(report.pitchTracer);
  console.log(
    `  PITCH ${p.id}  plate ${p.plate.speedMph.toFixed(1)} mph at` +
      ` x ${p.plate.x.toFixed(2)} h ${p.plate.h.toFixed(2)} ft` +
      ` (${p.plate.strike ? 'strike' : 'ball'})  flight ${p.flightTimeS.toFixed(3)} s` +
      `  ball drawn at ${report.ballScene ? report.ballScene.map((v) => v.toFixed(2)).join(', ') : '—'}`,
  );
  if (drawn.length < 2) {
    console.error('    ✗ pitch tracer drew fewer than 2 vertices');
    return ['pitch tracer empty'];
  }
  const sim = reportFromTrack(p.track);

  // (1) POSITION — every drawn vertex against the sim's own path at the same d.
  let worstX = 0;
  let worstH = 0;
  for (const v of drawn) {
    const ref = atDistance(sim, v.d);
    if (!ref) continue;
    worstX = Math.max(worstX, Math.abs(v.x - ref.x));
    worstH = Math.max(worstH, Math.abs(v.h - ref.h));
  }
  // (1r) THE REVERSE DIRECTION — every SIM sample against the drawn POLYLINE,
  // interpolated. Six lines, and without them the whole gate is defeated by a
  // chord. See the note above TRACER_TOL_FT.
  let backX = 0;
  let backH = 0;
  for (const s of sim) {
    const ref = atDistance(drawn, s.d);
    if (!ref) continue;
    backX = Math.max(backX, Math.abs(s.x - ref.x));
    backH = Math.max(backH, Math.abs(s.h - ref.h));
  }
  console.log(
    `    tracer ${String(drawn.length).padStart(4)} verts vs sim ${String(sim.length).padStart(4)}` +
      ` samples — worst |Δx| ${worstX.toExponential(2)} ft, |Δh| ${worstH.toExponential(2)} ft` +
      `  (tol ${TRACER_TOL_FT} ft)`,
  );
  console.log(
    `    REVERSE (every sim sample to the drawn line) — worst |Δx| ${backX.toExponential(2)} ft,` +
      ` |Δh| ${backH.toExponential(2)} ft  (tol ${TRACER_TOL_FT} ft)`,
  );
  if (worstX > TRACER_TOL_FT) {
    violations.push(`drawn pitch tracer off laterally by ${worstX.toFixed(4)} ft`);
  }
  if (worstH > TRACER_TOL_FT) {
    violations.push(`drawn pitch tracer off vertically by ${worstH.toFixed(4)} ft`);
  }
  if (backX > TRACER_TOL_FT) {
    violations.push(`pitch tracer SKIPS the sim laterally by ${backX.toFixed(4)} ft (chord?)`);
  }
  if (backH > TRACER_TOL_FT) {
    violations.push(`pitch tracer SKIPS the sim vertically by ${backH.toFixed(4)} ft (chord?)`);
  }

  // (2) DEFLECTION — the same functional on the drawn polyline and on the sim's.
  const dDrawn = deflectionIn(drawn, p.segmentFt);
  const dSim = deflectionIn(sim, p.segmentFt);
  if (!dDrawn || !dSim) {
    console.error(`    ✗ deflection unmeasurable over ${p.segmentFt} ft`);
    return [...violations, 'deflection unmeasurable'];
  }
  console.log(
    `    deflection over ${p.segmentFt} ft   horiz ${f3(dDrawn.xIn)} in drawn` +
      ` vs ${f3(dSim.xIn)} in sim      Δ ${(dDrawn.xIn - dSim.xIn).toExponential(2)} in`,
  );
  console.log(
    `                             vert  ${f3(dDrawn.hIn)} in drawn` +
      ` vs ${f3(dSim.hIn)} in sim      Δ ${(dDrawn.hIn - dSim.hIn).toExponential(2)} in`,
  );
  console.log(
    `    measureBreak  game air  IVB ${f3(p.breakGameIn.ivbIn)} in  HB ${f3(p.breakGameIn.hbIn)} in` +
      `   |  published (ISA) air  IVB ${f3(p.breakRefIn.ivbIn)} in  HB ${f3(p.breakRefIn.hbIn)} in`,
  );
  const dx = Math.abs(dDrawn.xIn - dSim.xIn);
  const dh = Math.abs(dDrawn.hIn - dSim.hIn);
  if (dx > DEFLECT_TOL_IN) {
    violations.push(`drawn horizontal deflection ${dx.toFixed(4)} in from the sim's`);
  }
  if (dh > DEFLECT_TOL_IN) {
    violations.push(`drawn vertical deflection ${dh.toFixed(4)} in from the sim's`);
  }
  // The SIGN check against the physics. A mirrored lateral axis — the exact bug
  // BASEBALL.md's frame note records having shipped once as a mislabel — leaves
  // every magnitude above intact and flips this. Convention-free.
  //
  // ⚠ IT NEEDS AN EPSILON, AND `Math.sign` IS WHY. `Math.sign(0) === 0`, so a row
  // whose horizontal break is exactly zero — a true 12:00/6:00 spin axis — makes
  // `0 !== ±1` fire UNCONDITIONALLY, reporting a mirrored axis on the one pitch
  // that has no axis to mirror. No published row reaches it today (the nearest is
  // a synthetic 6:00 curve at +0.847 in) but the margin is under an inch, and a
  // gate that fails on correct data is worth exactly as little as one that passes
  // on wrong data. Below DEFLECT_TOL_IN the drawn deflection's own sign is not
  // resolvable anyway — that is the tolerance this file already derived for it —
  // so that is the threshold, and skipping is stated rather than silent.
  if (Math.abs(p.breakGameIn.hbIn) < DEFLECT_TOL_IN || Math.abs(dDrawn.xIn) < DEFLECT_TOL_IN) {
    console.log(
      `    sign check SKIPPED — |HB| ${Math.abs(p.breakGameIn.hbIn).toFixed(4)} in or |drawn|` +
        ` ${Math.abs(dDrawn.xIn).toFixed(4)} in is under DEFLECT_TOL_IN ${DEFLECT_TOL_IN}`,
    );
  } else if (Math.sign(dDrawn.xIn) !== Math.sign(p.breakGameIn.hbIn)) {
    violations.push(
      `drawn horizontal bend (${dDrawn.xIn.toFixed(2)} in) opposes measureBreak's HB ` +
        `(${p.breakGameIn.hbIn.toFixed(2)} in) — mirrored lateral axis?`,
    );
  }
  return violations;
}

function checkBattedTracer(report) {
  if (!report.batted) return [];
  const violations = [];
  const b = report.batted;
  const drawn = worldFromSceneFlat(report.battedTracer);
  console.log(
    `  BATTED  EV ${b.evMph.toFixed(1)} mph  LA ${b.laDeg.toFixed(1)}°  spray ${b.sprayDeg.toFixed(1)}°` +
      `  carry ${b.carryFt.toFixed(1)} ft  apex ${b.apexFt.toFixed(1)} ft  hang ${b.hangS.toFixed(2)} s`,
  );
  if (drawn.length < 2) {
    console.error('    ✗ batted tracer drew fewer than 2 vertices');
    return ['batted tracer empty'];
  }
  const sim = worldFromTrack(b.track);
  let worst = 0;
  for (const v of drawn) {
    const ref = atRadius(sim, radiusOf(v));
    if (!ref) continue;
    worst = Math.max(worst, Math.abs(v.x - ref.x), Math.abs(v.y - ref.y), Math.abs(v.z - ref.z));
  }
  // The REVERSE direction, for exactly the reason the pitch tracer needs it: a
  // chord through the apex passes the forward check with zero error.
  let back = 0;
  for (const s of sim) {
    const ref = atRadius(drawn, radiusOf(s));
    if (!ref) continue;
    back = Math.max(back, Math.abs(s.x - ref.x), Math.abs(s.y - ref.y), Math.abs(s.z - ref.z));
  }
  const drawnApex = drawn.reduce((m, v) => Math.max(m, v.z), 0);
  const end = drawn[drawn.length - 1];
  const drawnCarry = Math.hypot(end.x, end.y);
  console.log(
    `    tracer ${String(drawn.length).padStart(4)} verts vs sim ${String(sim.length).padStart(4)}` +
      ` samples — worst |Δ| ${worst.toExponential(2)} ft  (tol ${TRACER_TOL_FT} ft)` +
      `   REVERSE ${back.toExponential(2)} ft`,
  );
  console.log(
    `    drawn carry ${drawnCarry.toFixed(2)} ft vs sim ${b.carryFt.toFixed(2)} ft` +
      `   |   drawn apex ${drawnApex.toFixed(2)} ft vs sim ${b.apexFt.toFixed(2)} ft` +
      `  (tol ${BATTED_TOL_FT} ft)`,
  );
  if (worst > TRACER_TOL_FT) {
    violations.push(`drawn batted tracer off by ${worst.toFixed(4)} ft`);
  }
  if (back > TRACER_TOL_FT) {
    violations.push(`batted tracer SKIPS the sim by ${back.toFixed(4)} ft (chord?)`);
  }
  if (Math.abs(drawnCarry - b.carryFt) > BATTED_TOL_FT) {
    violations.push(`drawn carry off by ${Math.abs(drawnCarry - b.carryFt).toFixed(4)} ft`);
  }
  if (Math.abs(drawnApex - b.apexFt) > BATTED_TOL_FT) {
    violations.push(`drawn apex off by ${Math.abs(drawnApex - b.apexFt).toFixed(4)} ft`);
  }
  return violations;
}

async function main() {
  mkdirSync(outDir, { recursive: true });

  const { createServer } = await import('vite');
  const { chromium } = await loadPlaywright();

  const server = await createServer({
    root: pkgDir,
    logLevel: 'warn',
    server: { port: 0, host: '127.0.0.1' },
  });
  await server.listen();

  let failed = 0;
  const saved = [];
  let browser;
  try {
    const base = server.resolvedUrls?.local?.[0]?.replace(/\/$/, '');
    if (!base) throw new Error('Vite dev server did not report a local URL.');
    browser = await chromium.launch({
      args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
    });
    for (const id of ids) {
      const { query, label } = SCENES[id];
      const page = await browser.newPage({ viewport: VIEWPORT, deviceScaleFactor: 1 });
      const errors = [];
      page.on('pageerror', (e) => errors.push(`pageerror: ${String(e)}`));
      // See the header: three reports a failed shader to console.error and then
      // draws the scene minus that mesh. This hook is the only thing that sees it.
      page.on('console', (m) => {
        if (m.type() === 'error') errors.push(`console: ${m.text().slice(0, 400)}`);
      });
      const url = `${base}/baseballpreview.html?${query}`;
      try {
        await page.goto(url, { waitUntil: 'load', timeout: 25000 });
        // ⚠ THE `null` IS LOAD-BEARING. Playwright's signature is
        // `waitForFunction(pageFunction, arg, options)`, so passing the options
        // object second hands it to the page as `arg` and silently falls back to
        // Playwright's own 30 s default — `READY_TIMEOUT_MS` was dead code, and
        // the only symptom was a hung run reporting a timeout nobody had written.
        await page.waitForFunction('window.__baseballReady === true', null, {
          timeout: READY_TIMEOUT_MS,
        });
        // Let a couple more frames land after the beacon so the stats read are a
        // steady-state frame rather than the first one.
        await page.waitForTimeout(200);

        const report = await page.evaluate((bearings) => {
          const bb = window.__baseball;
          if (!bb || !bb.stadium) return { err: 'window.__baseball incomplete' };
          const { sim, stadium } = bb;
          const st = sim.derby.getState();
          return {
            parkId: sim.parkId,
            roofPeakFt: sim.roofPeakFt,
            foulTerritoryFt: sim.foulTerritoryFt,
            derby: { phase: st.phase, rounds: st.rounds, pitchesPerRound: st.pitchesPerRound },
            stats: stadium.stats(),
            fence: bearings.map((deg) => ({
              deg,
              geo: stadium.measureFence(deg),
              park: sim.fenceAt(deg),
            })),
            pitch: sim.pitch,
            batted: sim.batted,
            ballTimeS: sim.ballTimeS,
            contactTS: sim.contactTS,
            mode: stadium.mode,
            pitchTracer: stadium.tracer('pitch'),
            battedTracer: stadium.tracer('batted'),
            tracerVisible: {
              pitch: stadium.tracerVisible('pitch'),
              batted: stadium.tracerVisible('batted'),
            },
            ballScene: stadium.ballScene(),
            ballVisible: stadium.ballVisible(),
            ballScale: stadium.ballScale(),
          };
        }, FENCE_BEARINGS);

        const file = path.join(outDir, `${label}.png`);
        await page.screenshot({ path: file });
        // ⚠ THE PNG IS WRITTEN BEFORE THE VERDICT ON PURPOSE — a failing scene's
        // picture is the most useful artefact there is — but the TICK IS PRINTED
        // AFTER. The previous order printed `✓` and counted the scene as captured
        // before the error check ran, so a shader-broken scene reported "5/5
        // captured" beside its own stack trace. The exit code was right and the
        // summary lied, which is the half a human reads.
        console.log(`· ${id.padEnd(14)} → ${path.relative(pkgDir, file)}`);
        const bad = checkReport(report);
        if (errors.length) {
          console.error(`  ✗ PAGE ERRORS (${errors.length}):`);
          for (const e of errors.slice(0, 6)) console.error(`      ${e}`);
          bad.push(`${errors.length} page error(s)`);
        }
        if (bad.length) {
          failed++;
          console.error(`✗ ${id.padEnd(14)} FAILED — ${bad.join('; ')}`);
        } else {
          saved.push(file);
          console.log(`✓ ${id.padEnd(14)} ok`);
        }
      } catch (e) {
        failed++;
        console.error(`✗ ${id}: ${e.message}`);
        if (errors.length) console.error(`  page errors: ${errors.slice(0, 4).join(' | ')}`);
      } finally {
        await page.close();
      }
    }
  } finally {
    if (browser) await browser.close();
    await server.close();
  }

  // `saved` counts scenes that PASSED, not scenes whose PNG got written — the
  // two used to be the same list and the summary was therefore always 5/5.
  console.log(
    `\n${saved.length}/${ids.length} scene(s) passed; PNGs in ${path.relative(process.cwd(), outDir)}`,
  );
  // A page error, a GPU-budget overrun, a wall that does not match parks.ts and
  // a tracer that does not match the sim are all FAILURES here, not footnotes.
  process.exit(failed ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
