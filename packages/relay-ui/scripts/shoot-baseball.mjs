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
//     bend the same way and the same amount. It reads the FULL built path
//     (`tracerFull`), which is what keeps it measuring the whole curve now that
//     the trail is revealed progressively — see `checkPitchTracer`.
//   • the batted tracer's own apex and carry, against `BattedFlight`'s.
//   • THE REVEAL — how much of that path is on screen yet. New, and it is an
//     INFORMATION-LEAK check, not a cosmetic one: the whole arc including the
//     landing point used to be drawn from the instant the pitch was served. See
//     `checkReveal`.
//   • THE FRAMING — is the ball actually in the picture. `checkBall` asserts
//     `Object3D.visible`, which is explicitly NOT the same thing; `checkFraming`
//     projects the drawn ball through the drawing camera and asks.
//   • THE NIGHT BOWL, IN PIXELS. Everything above reads the scene graph, and
//     the night crowd's defect is invisible to every one of them — correct
//     geometry, correct draw calls, an identical day/night pair, and a frame
//     that photographs as television static. `checkNightBowl` decodes the two
//     PNGs this run just wrote and measures the deck's own luminance spread
//     against the day frame's. See its header: the crowd has beaten this suite
//     three times and twice a human had to be the instrument.
//   • THE NIGHT MASSES, IN THE SAME PIXELS. Same function, second half. Three
//     surfaces have now shipped the SAME inversion — a roof deck at 86 % of its
//     own daytime luminance, a concourse at 81 %, a skyline at 65 % — because
//     one `DirectionalLight` has a direction and no position, so a rig aimed at
//     the field lights everything that is not the field too. Each was found by
//     a human looking at a PNG. See `NIGHT_MASS_PATCHES`.
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
import { mkdirSync, readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import path from 'node:path';

const pkgDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(pkgDir, '.baseball-shots');

// The scene matrix. Four camera MODES over one scene, two shots of the second
// park, and five flight scenes.
//
// `park-alpine` is the proof that a park is data: a different fence row must
// produce a visibly different wall (347/390/415/375/350 against the home park's
// published 328/368/381/400/372/359/328 profile, a 16 ft wall in left-centre
// against a column that runs 8 ft at dead centre to 14 ft 4 in on the left
// line, NO ROOF at all against a 282 ft ring, and — since M3 — NO SKYLINE
// against a city, because `surroundings` is a park field like `roof` is).
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
  // ⚠ THE SECOND SCALE SHOT, AND IT IS HERE BECAUSE THE FIRST ONE DIED. M1 had
  // two: `pitcher` and `batter`, the 6 ft marker legible in both. M2c re-framed
  // `batter` to hold the strike zone, which put the marker at 121 % of frame
  // width — outside — so `stadium/scale.ts` is now readable in ONE shot, and one
  // photographic check of a whole game's scale is not a check. This restores the
  // pair along a different axis: the same camera at the OTHER park, for one line
  // and no new geometry.
  //
  // ⚠ AND IT IS THE ROOF AND THE FOUL DISTANCE, NOT THE WALL. An earlier version
  // of this note claimed the shot exercises "Alpine's 347/390/415 wall"; it
  // cannot. `CAMERAS.pitcher` stands on the mound at [0, 6, −55] looking IN at
  // [0, 2.6, 0], so the outfield fence is 290–360 ft BEHIND the camera and is
  // never in frame. What DOES differ inside this box is `roof` (Harbourfront's
  // 282 ft retractable vs Alpine's none) and `foulTerritoryFt` (28 vs 22), which
  // moves the backstop and the foot of the stand behind the plate. Measured
  // against `pitcher.png`: 9.63 % of pixels differ, all of it the roof/sky rows
  // plus two thin bands; ~90 % of the frame is identical. That is the honest
  // claim — a park-scoped STRUCTURE check against a fixed 6 ft reference — and it
  // is still worth a shot. A wall check is `StadiumApi.measureFence`'s job, and
  // `wide` / `park-alpine-wide` are the pair that photograph one.
  'park-alpine-pitcher': {
    query: 'scene=pitcher&park=alpine&t=0.30',
    label: 'park-alpine-pitcher',
  },
  // The three break shots. Same camera, same target, same frozen fraction of the
  // flight — so the ONLY thing that differs between the three PNGs is the pitch
  // row, and a human comparing them is comparing break and nothing else.
  'pitch-4seam': { query: 'scene=batter&pitch=ff&t=0.30', label: 'pitch-4seam' },
  'pitch-curve': { query: 'scene=batter&pitch=cu&t=0.35', label: 'pitch-curve' },
  'pitch-sweeper': { query: 'scene=batter&pitch=st&t=0.35', label: 'pitch-sweeper' },
  // ⚠ THE BALL JUST OFF THE BAT — AND IT WAS NOT IN THE PICTURE. At the shipped
  // `bt = 0.12` the drawn ball projects to (0.016, −0.123) through the `batter`
  // camera, i.e. **197 px above the top crop** and hard against the left edge:
  // a scene whose entire caption is "the ball just off the bat", gating nothing.
  // It was invisible to every other check in this file because `checkBall`
  // asserts `Object3D.visible`, which its own note is at pains to say is NOT
  // "in this picture".
  //
  // RE-TIMED, not re-framed, because the framing is load-bearing elsewhere:
  // `CAMERAS.batter` is the camera `boardPaint.ts` derives the whole board
  // legibility floor from, and `pitch-4seam` / `aim` / `board` are all composed
  // against it. Measured, same camera, same swing (105 mph / 26.5° / −12°):
  //
  //     bt      ball on screen        margin to the nearest crop
  //     0.02    (0.370, 0.423)        the bat is still in it — no separation
  //     0.06    (0.187, 0.140)        168 px top, 126 px left   ← shipped
  //     0.08    (0.120, 0.036)         58 px top — one bad frame from gone
  //     0.12    (0.016, −0.123)       197 px OFF the top        ← was shipped
  //
  // 0.06 s is ~9 ft off the bat at 105 mph, which is the separation the caption
  // claims, with a whole ball-flight's worth of margin before the crop.
  // `expectBallInFrame` + `ballMarginPx` is what stops it drifting back out.
  contact: {
    query: 'scene=batter&pitch=ff&bt=0.06',
    label: 'contact',
    expectBallInFrame: true,
    ballMarginPx: 40,
  },
  // …and the same ball near its apex from the upper deck.
  homerun: { query: 'scene=flight&pitch=ff&bt=2.6', label: 'homerun' },
  // The DERBY's aim aid: the rule-zone frame and the reticle, drawn as geometry
  // at the plate rather than as a DOM overlay. Placed low and to the pull side
  // (u = −0.55, v = −0.45) rather than dead centre, because a centred reticle
  // sits on the zone frame's own centre and a mis-sized one would look correct.
  // Same camera and same frozen instant as `pitch-4seam`, so the pair differ by
  // the aid and nothing else.
  aim: { query: 'scene=batter&pitch=ff&t=0.30&aim=-0.55,-0.45', label: 'aim' },
  // ⚠ THE THREE FOLLOW SCENES, AND THEY EXIST BECAUSE A HUMAN PLAYED THE BUILD
  // AND SAID "it's odd that I can't see the ball if it's hit to left or right
  // field". The `flight` camera's horizontal FOV at this viewport is ±16.3°
  // about a FIXED axis, so a ball to either corner simply left the picture.
  // At 105 mph / 26.5° / bt = 2.6 s, the ball is drawn at (∓164.65, 93.30,
  // −196.22) scene ft; projected through the PRE-FOLLOW `flight` camera
  // (pos [−12, 120, 90], look [34, 60, −380], fov 55, near 4, aspect 900/1600):
  //
  //     spray   ball on screen (0…1, y down)   what a fixed axis gives
  //     −40°    (−0.632, 0.473)                569 px off the LEFT edge
  //     +40°    (+1.334, 0.463)                300 px past the RIGHT edge
  //
  // ⚠ THOSE TWO ROWS MOVED WHEN THE CAMERA DID, and the pair below is what they
  // were measured at BEFORE (pos [−40, 120, 90], look [−40, 60, −380]):
  // −40° → (−0.241, 0.467), 217 px off the left; +40° → (+1.716, 0.467), 645 px
  // past the right. The camera has since been re-centred and its static aim
  // yawed toward the landmark (`camera.ts`, `flight`), which moves BOTH numbers
  // — the oppo corner is no longer ~3× worse than the pull one, it is now the
  // BETTER of the two, and the yaw shifts the whole pair left. The defect these
  // scenes exist for is unchanged in kind and worse in one direction: a fixed
  // axis loses both corners either way, which is why `expectBallInFrame` is
  // asserted rather than eyeballed.
  //
  // ⚠ THE PAIR THIS COMMENT USED TO QUOTE — (−0.083, 0.470) and (1.098, 0.470) —
  // DID NOT REPRODUCE, and it understated the defect in two independent ways.
  // Both are worth recording, because the reasoning is the reusable part and the
  // arithmetic is not:
  //
  //   (i) IT WAS SYMMETRIC ABOUT u ≈ 0.5075, WHICH ONLY A CAMERA AT x = 0 CAN
  //       PRODUCE. `CAMERAS.flight` stood at x = −40, so it was nearer the pull
  //       corner and further from the oppo one, and the true pair was symmetric
  //       about u = 0.738. That asymmetry IS the explanation for the thing the
  //       old figures made look like a coincidence: the oppo corner was ~3× worse
  //       than the pull corner (645 px against 217 px). A symmetric pair
  //       from an asymmetric rig is the tell, and it is cheaper to spot than to
  //       re-measure. (From x = 0 the same two balls give −0.479 / +1.479.)
  //  (ii) ITS SPAN WAS 1.181 FRAME WIDTHS AGAINST A TRUE 1.957 — 40 % short —
  //       so it understated BOTH corners regardless of where it was centred. The
  //       span is a property of the FOV and the ball positions alone (it is
  //       identical from x = 0 and from x = −40), which is what makes it a
  //       second, independent error rather than a consequence of (i).
  //
  // ⚠ AND HOW TO KEEP A FIGURE LIKE THIS HONEST: validate the method against
  // this harness's OWN PRINTED CONTROL before trusting it on a counterfactual.
  // The `flight` scene has no swing, so its camera never follows and it still
  // prints the fixed-axis projection every run — `ball on screen (0.521, 1.329)`
  // for the pitch at t = 0.30 s, from the re-centred stand. The recomputation
  // above reproduces the printed control to four decimals with the same code
  // path that produced the two rows. (At the old stand the same control read
  // (1.074, 1.333) and was reproduced as (1.0738, 1.3333); the METHOD is the
  // reusable part, and validating it against a number this run prints is what
  // keeps a counterfactual honest.)
  //
  // `expectBallInFrame` turns all of this from a picture a human has to squint
  // at into a number the run exits non-zero on. Both corners, because a follow
  // that re-aims the wrong way fixes one and doubles the other.
  'follow-pull': {
    query: 'scene=flight&pitch=ff&hit=1&spray=-40&bt=2.6',
    label: 'follow-pull',
    expectBallInFrame: true,
  },
  'follow-oppo': {
    query: 'scene=flight&pitch=ff&hit=1&spray=40&bt=2.6',
    label: 'follow-oppo',
    expectBallInFrame: true,
  },
  // The transition CAUGHT MID-MOVE — mount on the batter camera, ease to the
  // deck, and freeze 400 ms in. This is the only shot that can see the ease at
  // all: every other scene mounts in its final mode and snaps. 400 ms of a
  // 800 ms quintic is smootherstep(0.5) = 0.5, i.e. the exact half-way pose,
  // which is also the frame in which a linear blend and a quintic one AGREE —
  // so this shot proves the transition exists and `camera.test.ts` proves its
  // shape. The ball is 0.40 s off the bat and must be in frame throughout.
  'follow-ease': {
    query: 'scene=flight&pitch=ff&hit=1&bt=0.40&from=batter&ease=400',
    label: 'follow-ease',
    expectBallInFrame: true,
  },
  // ⚠ THE BOARD ARRAY, FROM THE ONLY CAMERA THAT READS IT. `boardPaint.ts`
  // derives the whole legibility floor from `CAMERAS.batter`, and at that
  // camera's real 20° lens a 100 ft board 430 ft out spans 1009 px of a 900 px
  // frame — i.e. it is now the DOMINANT object in the batter's view and there
  // was no shot of it. Same camera and same frozen instant as `pitch-4seam`, so
  // the pair differ by the board's content and nothing else.
  //
  // `board=batter` is the derby's own resting card, built by the HUD's own
  // `derbyBoardArray` rather than authored in the preview — a photograph of a
  // picture the game cannot produce would be worth nothing.
  board: { query: 'scene=batter&pitch=ff&t=0.30&board=batter', label: 'board' },
  // The array's four panels against the frame, from far enough back to see the
  // whole assembly — the shot that says whether the GAPS read, which is the
  // entire content of "it is an array, not one rectangle".
  'board-wide': { query: 'scene=flight&pitch=ff&t=0.30&board=batter', label: 'board-wide' },
  // The eruption, frozen at 0.5 s — inside `BOARD_ANIM_END_S` (2.6 s) and past
  // the first strobe, so the board, both columns, the strip and the ribbon are
  // all in their celebration state at once.
  'board-homerun': {
    query: 'scene=batter&pitch=ff&t=0.30&board=homerun&bts=0.5',
    label: 'board-homerun',
  },
  // ⚠ THE DAY / NIGHT PAIR, ON ONE CAMERA. There has never been a night scene at
  // all, so nothing has ever tested one. These two differ by `?daylight=` and by
  // nothing else, which is what lets `checkDayNightPairs` below assert the
  // charter's hard rule mechanically: a cosmetic toggle must not move a single
  // draw call, triangle, geometry, fence measurement or tracer vertex.
  'daynight-day': {
    query: 'scene=wide&pitch=ff&t=0.30&board=batter&daylight=day',
    label: 'daynight-day',
    pairWith: 'daynight-night',
  },
  'daynight-night': {
    query: 'scene=wide&pitch=ff&t=0.30&board=batter&daylight=night',
    label: 'daynight-night',
  },
  // The batter's own frame at night: floodlit turf, a dark dome, and the board
  // and ribbons as the brightest things in the picture.
  night: {
    query: 'scene=batter&pitch=ff&t=0.30&board=batter&daylight=night',
    label: 'night',
  },
  // ⚠ THE MONEY MOMENT. Board erupting, ribbons sweeping the ring, tower
  // flashing — all three from one `(BoardArray, tS)`, all three quantised, and
  // the ball near its apex so the tower is in frame beside it. `bts=0.6` is a
  // strobe-ON frame (`STROBE_S` = 0.2 s, so 0.6 s is the start of the fourth
  // half-period), which is the frame worth photographing.
  'night-homerun': {
    query: 'scene=flight&pitch=ff&hit=1&bt=2.6&board=homerun&bts=0.6&daylight=night',
    label: 'night-homerun',
    expectBallInFrame: true,
  },
};

// Portrait, a phone screen. Same shape as the golf harness so the two sets of
// shots are comparable side by side.
const VIEWPORT = { width: 900, height: 1600 };
// ⚠ RAISED FROM 20 s FOR `?ease=`. A transition shot spends an EXACT slice of
// virtual time — 400 ms at a 50 ms virtual step is 8 extra rendered frames, and
// SwiftShader renders this scene at roughly 3 fps, so ~3 s more before the
// beacon. The number is headroom over a measured cost, not a guess at one.
const READY_TIMEOUT_MS = 30000;

// Bearings the fence table is printed at: dead centre, the two power alleys and
// both foul lines. −45/0/+45 are sampled knots in both parks; ±22 is a knot in
// Harbourfront and an OFF-KNOT pchip evaluation in Alpine (whose knots are
// ±20), which is exactly the case a knots-only renderer would get wrong.
const FENCE_BEARINGS = [-45, -22, 0, 22, 45];

/**
 * Bearings the ROOF profile is walked at — its own list, and it is finer than
 * the fence's on purpose.
 *
 * The open roof is a STACK OF PARKED PANELS over centre field (`stadium/roof.ts`),
 * so the thing to measure is a PROFILE — thick behind centre, thinning outward,
 * gone well before the foul lines — and five bearings cannot see a profile.
 * ±3/±7/±9/±10 each land inside a DIFFERENT number of panels, which is what
 * makes the STEP measurable at all; ±12 straddles the outermost panel's edge,
 * so "it ends" is a measurement rather than an inference from two points either
 * side of a 90° gap; ±14 is the LANDMARK's own bearing, which must be open sky
 * or its observation pod goes behind the overhang.
 */
const ROOF_BEARINGS = [-45, -22, -14, -12, -10, -9, -7, -3, 0, 3, 7, 9, 10, 12, 14, 22, 45];

/**
 * The band the stack must have at dead centre, ft — "deeper than the closed
 * roof was there", as a number.
 *
 * ⚠ IT IS THE OLD RING'S OWN DEPTH, NOT A TASTE. The superseded symmetric ring
 * ran `ROOF_BAND_FT = 120` at every bearing; the whole point of the collapse is
 * that four panels are piled where one used to lie, so behind centre field the
 * mass must be materially deeper than that. 200 ft is 1.7× the ring, and the
 * stack's own table lands at 250 — so this is a floor with 50 ft of headroom,
 * which is what stops it becoming a golden value that has to be edited every
 * time a panel row moves by a foot.
 */
const ROOF_STACK_MIN_DEPTH_FT = 200;

/**
 * The fewest panels the stack must have at dead centre.
 *
 * "Several arcs nested, with visible steps where panels stack" is the owner's
 * description, and 3 is the smallest number of arcs that can show a step and
 * still read as a stack rather than as a lip. `stadium/roof.ts` ships 4.
 */
const ROOF_MIN_LAYERS = 3;

/**
 * How far two readings of the stack's DEPTH may differ before it is a defect, ft.
 *
 * ⚠ IT IS NOT `ROOF_TOL_FT`, AND THE FIRST DRAFT USED THAT AND WAS WRONG. Two
 * things make a constant-depth panel read as a varying one, and neither is slop:
 *
 *   • CHORD SAGITTA. Both edges of a panel are polylines through
 *     `quality.bowlStepDeg` = 3°, and sagitta goes as the radius —
 *     530·(1 − cos 1.5°) = 0.18 ft on the outer edge against 0.09 ft on the
 *     inner. Measured worst step within one panel: 0.33 ft.
 *   • THE PARK IS NOT SYMMETRIC. The stack hangs on the top of the bowl and the
 *     bowl follows the wall, and Harbourfront's published profile runs
 *     328/368/381/400/372/359/328 — 375.4 ft at −22° against 365.9 at +22°.
 *     The panel table is mirrored; the building it is bolted to is not.
 *     Measured worst |Δdepth| across ±b where the layer counts agree: 0.159 ft.
 *
 * 0.5 ft is 1.5× the larger of those and 80× under the 40 ft step between one
 * panel and the next, which is the signal these two legs measure. `ROOF_TOL_FT`
 * still governs the HEIGHT, where neither effect exists — a deck is a polyline
 * through a constant `y`, so there is no sagitta in it at all.
 */
const ROOF_PROFILE_TOL_FT = 0.5;

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

/** See `checkRoof`. Derived from float32 at 282 ft, exactly as FENCE_TOL_FT is. */
const ROOF_TOL_FT = 0.05;

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
 * M1's worst scene was `wide` at 18 draws / 1,845 triangles; M2b took it to 22
 * / 2,249 with the ball, its contact shadow and the two tracers; M3's art pass
 * takes it to 26 / 15,060 — a banded bowl, a roof truss, a mown field and a
 * whole city for FOUR extra draw calls, which is the merge discipline working
 * (authored naively they would have been ~40 more). NEITHER CEILING MOVED. The
 * two are deliberately NOT set to the same multiple of the worst scene, because
 * the two costs do not grow the same way:
 *
 *   • DRAW CALLS are the dominant mobile cost and the one thing the charter
 *     legislates directly — the crowd is ONE `InstancedMesh`, repeated geometry
 *     is instanced or merged. Draw calls should therefore grow by ones as M2 art
 *     lands (crowd, lights, scoreboard, skyline, bat), not by multiples.
 *     40 is 1.5× today's worst, and sits UNDER 3 × 26 = 78, so the "somebody
 *     gave every seating section its own material" regression trips it — and at
 *     M3 that regression was one design decision away: the bowl is nine bands
 *     and the city is seventeen solids, all of which merge to three calls.
 *   • TRIANGLES are cheap per instance and expensive per bad decision. An
 *     instanced crowd legitimately adds six figures of triangles inside ONE draw
 *     call, so a 3× ceiling here would fire on correct M2 art and get raised,
 *     which is how a budget becomes a formality. M3's mown-turf grid alone is
 *     8,640 of them and it is one call. 120,000 is a real static-scene
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

/**
 * THE FORWARD FRAME MAPS — the sim's own samples as the flat SCENE-space floats
 * a tracer's `BufferAttribute` would hold if it were built from them, ROUNDED TO
 * FLOAT32.
 *
 * ⚠ THE `Math.fround` IS WHAT MAKES AN EXACT COMPARISON LEGITIMATE. A
 * `BufferAttribute` stores float32 (that is what the GPU draws), so reading one
 * back yields the float64 nearest a float32. `Math.fround` is the same rounding,
 * so `drawn[i] === fround(sim[i])` is an EQUALITY, not a tolerance — and a
 * tolerance is exactly what a "the buffer is the sim's samples and nothing else"
 * claim must not have.
 *
 * Written out here from `zone.ts`'s REPORT definition, `battedBallSim`'s WORLD
 * definition and `stadium/geom.ts`'s scene frame — the same discipline as
 * `reportFromSceneFlat`, and for the same reason: a gate that imports the
 * renderer's own converter cannot fail on it.
 */
const sceneFlatFromPitchTrack = (tr) => {
  const out = [];
  for (let i = 0; i < tr.d.length; i++) {
    // REPORT (d, x, h) → scene (x, h, −d).
    out.push(Math.fround(tr.x[i]), Math.fround(tr.h[i]), Math.fround(-tr.d[i]));
  }
  return out;
};

const sceneFlatFromBattedTrack = (tr) => {
  const out = [];
  for (let i = 0; i < tr.x.length; i++) {
    // WORLD (x, y, z) → scene (y, z, x).
    out.push(Math.fround(tr.y[i]), Math.fround(tr.z[i]), Math.fround(tr.x[i]));
  }
  return out;
};

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
      `  tier ${s.tier} (${s.shadowMapSize}²) — ${s.qualityReason}` +
      `  light ${s.daylight}`,
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

  violations.push(...checkBoard(report));
  violations.push(...checkRoof(report));
  violations.push(...checkPitchTracer(report));
  violations.push(...checkBattedTracer(report));
  violations.push(...checkBall(report));
  violations.push(...checkContactSeam(report));
  violations.push(...checkReveal(report));
  violations.push(...checkFraming(report));
  return violations;
}

/**
 * THE BOARD ARRAY, MEASURED OUT OF THE BUILT GEOMETRY.
 *
 * ⚠ FOUR PANELS, ONE DRAW CALL, AND THE GAPS ARE THE POINT. The array's whole
 * design claim is that it reads as an ARRAY rather than as one rectangle, and
 * that rests on two things a screenshot alone cannot adjudicate: the four quads
 * are separated by real gaps in the park, and their UV rects tile the atlas
 * without overlapping. Both are arithmetic on the rects the geometry was
 * actually built from, so both are asserted here.
 *
 * ⚠ AND THE REPAINT BUDGET, WHICH IS THE ONE PERFORMANCE DECISION THE BOARD
 * MAKES. A 1024 × 512 RGBA atlas is 2.0 MB per upload. In a FROZEN scene the
 * board's state and `tS` are both constant, so the count must stop — this
 * harness renders many frames after the beacon and a board that repainted every
 * frame would be uploading 2 MB × 60/s for a picture that never changes. The
 * count is read beside `texture.version`, which three increments inside its own
 * `needsUpdate` setter: the module's own counter alone is self-referential (its
 * source says so), so the PAIR is the measurement.
 */
const BOARD_MAX_UPLOADS = 3;

/**
 * Which parks MUST carry a board. `board.ts` builds nothing unless
 * `park.surroundings === 'city'` — the same "content is data, not a branch"
 * rule `roofPeakFt` gets — so this is the park-side predicate, read out of
 * `parks.ts` exactly as `checkRoof` reads `roofPeakFt`.
 *
 * MUTATIONS WATCHED TO FAIL (each reverted, counts as observed, exit 1):
 *   1. `CENTREFIELD_BOARD.sillFt` 26 → 400, so the bowl's own deck top
 *      falls under the sill and `board.ts` returns `scoreboard: null` —
 *      the EXACT failure this rewrite exists for                      → 1 fail
 *      (`batter`: "park harbourfront has surroundings='city' and must
 *      carry a centre-field board, and NONE was built". The superseded
 *      branch printed `none (park has no centre-field structure)` and
 *      exited 0 on the identical scene.)
 *   2. `shouldHaveBoard` inverted, to reach the MIRROR leg — which is
 *      unreachable while `board.ts` owns the same predicate, and is a
 *      guard on a future edit rather than on today's tree             → 2 fail
 *      (`batter` on the mirror, `park-alpine` on the must-have leg)
 */
const shouldHaveBoard = (report) => report.surroundings === 'city';

function checkBoard(report) {
  const b = report.board;
  if (!b) {
    // ⚠ THIS BRANCH USED TO PRINT AN UNKNOWN AS A FACT AND RETURN SUCCESS. It
    // said `none (park has no centre-field structure)` on the strength of the
    // REPORT having no board field, which is not the same statement at all —
    // and the gap between them is a real, reachable defect: `board.ts` returns
    // `{ scoreboard: null, panels: [] }` whenever `surroundings` is not `city`
    // OR the bowl's `deckTopFt` falls under `CENTREFIELD_BOARD.sillFt` (26 ft).
    // Trip either and the array, the ribbon map and the tower's feed ALL
    // vanish at once, while this gate printed a reassuring sentence and exited
    // 0. `checkRoof` three functions down was rewritten to close exactly this
    // shape, and the fence walk calls its own version `fence unmeasurable at
    // N°` and counts it a violation.
    const must = shouldHaveBoard(report);
    console.log(
      `  BOARD  none — park=${report.parkId} surroundings=${report.surroundings}` +
        `${must ? '  ✗ and a city park MUST carry one' : ' (no centre-field structure)'}`,
    );
    return must
      ? [
          `park ${report.parkId} has surroundings='city' and must carry a centre-field ` +
            `board, and NONE was built — check park.surroundings and stands.deckTopFt ` +
            `against CENTREFIELD_BOARD.sillFt`,
        ]
      : [];
  }
  const violations = [];
  // …and the mirror, which is the leg `checkRoof` calls "a roofless park drew
  // roof geometry": a park with no city around it must not be paying for a
  // board either, and its absence is what proves the `scoreboard: null` branch
  // is reached rather than merely written.
  if (!shouldHaveBoard(report)) {
    violations.push(
      `park ${report.parkId} has surroundings='${report.surroundings}' and built a ` +
        `centre-field board anyway — that branch is data, not decoration`,
    );
  }
  const wFt = b.geometry.widthFt;
  console.log(
    `  BOARD  ${wFt}×${b.geometry.heightFt} ft at ${b.geometry.faceDistFt} ft` +
      `   ribbon ${b.geometry.ribbonHeightFt.toFixed(2)} ft band on a ` +
      `${(2 * Math.PI * b.geometry.ribbonRadiusFt).toFixed(0)} ft ring` +
      `   tS ${b.tS.toFixed(3)} s`,
  );
  console.log(
    `         uploads atlas ${b.uploads} (texture.version ${b.textureVersion})` +
      `  ribbon ${b.ribbonUploads}   frame ${b.current?.frame ?? '—'}` +
      `  offsetU ${(b.current?.offsetU ?? 0).toFixed(4)}`,
  );
  for (const p of b.panels) {
    console.log(
      `         ${p.id.padEnd(8)} x ${f2(p.x0)} → ${f2(p.x1)}   y ${f2(p.y0)} → ${f2(p.y1)}` +
        `   uv ${p.uv.u0.toFixed(3)}–${p.uv.u1.toFixed(3)} × ${p.uv.v0.toFixed(3)}–${p.uv.v1.toFixed(3)}`,
    );
  }
  if (b.panels.length !== 4) {
    violations.push(`the board built ${b.panels.length} panels, not 4`);
  }
  // (1) EVERY PANEL IS INSIDE THE DECLARED FACE. A quad hanging off the board is
  // a quad hanging in front of the recess's back wall.
  for (const p of b.panels) {
    if (p.x0 < -wFt / 2 - 1e-6 || p.x1 > wFt / 2 + 1e-6) {
      violations.push(`panel ${p.id} runs x ${p.x0} → ${p.x1}, outside the ${wFt} ft face`);
    }
  }
  // (2) NO TWO PANELS OVERLAP, AND EVERY NEIGHBOURING PAIR HAS A REAL GAP.
  // Both in the PARK, in feet, because that is what a player sees.
  let minGap = Infinity;
  for (let i = 0; i < b.panels.length; i++) {
    for (let j = i + 1; j < b.panels.length; j++) {
      const a = b.panels[i];
      const c = b.panels[j];
      const gapX = Math.max(a.x0 - c.x1, c.x0 - a.x1);
      const gapY = Math.max(a.y0 - c.y1, c.y0 - a.y1);
      const gap = Math.max(gapX, gapY);
      minGap = Math.min(minGap, gap);
      if (gap <= 0) violations.push(`panels ${a.id} and ${c.id} OVERLAP by ${(-gap).toFixed(2)} ft`);
    }
  }
  console.log(
    `         smallest gap between two panels ${minGap.toFixed(2)} ft` +
      `  — the mullion the atlas leaves texels for`,
  );
  // (3) THE FROZEN SCENE STOPPED REPAINTING. See BOARD_MAX_UPLOADS.
  if (b.uploads > BOARD_MAX_UPLOADS) {
    violations.push(
      `the board repainted ${b.uploads} times in a frozen scene (budget ${BOARD_MAX_UPLOADS}) — ` +
        `each one is 2.0 MB of texel traffic for a picture that cannot have changed`,
    );
  }
  // (4) THE MODULE'S COUNTER AND THREE'S AGREE, OFF BY THE CONSTRUCTOR.
  //
  // ⚠ THE `+ 1` IS MEASURED, NOT FUDGED. `Texture.needsUpdate`'s setter does
  // `version++`, and `CanvasTexture`'s CONSTRUCTOR sets `needsUpdate = true` —
  // so a texture that has never been repainted is already at version 1. The
  // first draft of this check asserted equality and fired on every scene at
  // 2 vs 3, which is the check working: it found a wrong assumption about
  // three's internals on its first run rather than a wrong board.
  //
  // This is what kills a mutation that deletes `needsUpdate = true` and leaves
  // the module's own counter perfectly correct — the board's own source names
  // that hole and says the counter alone cannot close it.
  if (b.textureVersion !== b.uploads + 1) {
    violations.push(
      `the board counted ${b.uploads} uploads but three's texture.version is ` +
        `${b.textureVersion} (expected ${b.uploads + 1}) — one of them is not measuring an upload`,
    );
  }
  if (b.uploads < 1) violations.push('the board never painted at all — the atlas is transparent');
  return violations;
}

/**
 * THE ROOF PROFILE, MEASURED OUT OF THE GEOMETRY RATHER THAN PRINTED FROM
 * `parks.ts`.
 *
 * ⚠ THE ORIGINAL CHECK CLOSED A HOLE THE GATE NAMED IN ITS OWN OUTPUT.
 * `roofPeak 282 ft` was read from the park DATA and printed beside numbers that
 * had been measured off the vertex buffer, which reads as a measurement and is
 * not one — the same tautology `checkBall`'s note describes for `ballScene()`.
 * And it matters more than a cosmetic dimension: `resolveFence` rules a ball
 * that reaches `roofPeakFt` `'roof'` and never a home run, so the ceiling is a
 * GAMEPLAY boundary. A roof drawn at 240 ft over a 282 ft rule would have
 * printed a clean run. That leg is unchanged and is assertion (5) below.
 *
 * ⚠⚠ AND IT WAS RE-AUTHORED, BECAUSE IT ASSERTED THE DEFECT. The check demanded
 * *a measurable roof at every one of the five fence bearings* — which is exactly
 * the symmetric ring that turned out to be the wrong model. The open roof is a
 * stack of panels parked over centre field; the foul lines have NO roof, by
 * design, and the old check would have failed a correct collapse while passing
 * the incorrect ring it was written against. "Roof is measurable here" was never
 * the property worth asserting: it is a constant, and a constant tells a gate
 * nothing, which is the same reason `fence.sample` asserts a VARYING wall.
 *
 * So it asserts the PROFILE the scene intends, and every leg fails on a
 * different way of getting the collapse wrong:
 *
 *   (1) DEAD CENTRE IS THE MASS — covered, by at least `ROOF_MIN_LAYERS`
 *       panels, and by the MOST panels of any bearing measured. Kills a stack
 *       parked over the wrong side of the park, and a one-panel "collapse" that
 *       is really just a narrower ring.
 *   (2) IT IS DEEP THERE — band ≥ `ROOF_STACK_MIN_DEPTH_FT`, i.e. materially
 *       deeper than the 120 ft ring it replaced. Kills a stack that nests its
 *       panels into the same footprint instead of piling them.
 *   (3) BOTH FOUL LINES ARE OPEN SKY — `null`, not "thin". This is the leg the
 *       owner's note is about: `follow-pull` and `follow-oppo` had roof where
 *       the reference has city.
 *   (4) IT IS MONOTONE AND SYMMETRIC — layers and depth never increase as
 *       |bearing| grows, and ±b agree. Kills a stack with a hole in it, a
 *       panel table sorted the wrong way, and a mirrored bearing sign.
 *   (5) THE TOP OF THE STACK IS THE PARK'S CEILING — `peakFt` within
 *       `ROOF_TOL_FT` of `roofPeakFt` wherever there is any roof at all.
 *
 * `ROOF_TOL_FT` is the same class of number as `FENCE_TOL_FT` and is derived the
 * same way: a deck is a chord polyline through a CONSTANT height, so unlike the
 * wall there is no sagitta at all in `y` — the only error is float32 at ~282 ft,
 * i.e. 282·2⁻²³ = 3.4e-5 ft. 0.05 ft is ~1,500× that and 0.6 in on a 282 ft
 * ceiling, and it is 200× smaller than the smallest error anybody would author
 * by hand. The DEPTH comparisons in (4) do NOT use it — see
 * `ROOF_PROFILE_TOL_FT`, which is a different residual for two stated reasons.
 */
function checkRoof(report) {
  const rows = report.roof ?? [];
  const at = (deg) => rows.find((r) => r.deg === deg)?.geo ?? null;
  const measured = rows.filter((r) => r.geo);
  if (report.roofPeakFt > 0 && measured.length === 0) {
    console.error('    ✗ the park has a roof and none of it could be measured');
    return ['roof unmeasurable in a park that has one'];
  }
  if (report.roofPeakFt <= 0) {
    console.log('  ROOF   none (park has no roof) — nothing to measure');
    return measured.length
      ? [`a roofless park drew roof geometry at ${measured.length} bearing(s)`]
      : [];
  }

  const violations = [];
  const depth = (g) => g.outerFt - g.innerFt;
  console.log(`  ROOF   parked stack — parks.ts ceiling ${report.roofPeakFt} ft`);
  console.log('    bearing   layers   band_in→out_ft    depth   peak_ft     Δpeak');
  let worstPeak = 0;
  for (const r of rows) {
    if (!r.geo) {
      console.log(`      ${String(r.deg).padStart(4)}°        0   — open sky —`);
      continue;
    }
    const dPeak = r.geo.peakFt - report.roofPeakFt;
    worstPeak = Math.max(worstPeak, Math.abs(dPeak));
    console.log(
      `      ${String(r.deg).padStart(4)}°   ${String(r.geo.layers).padStart(6)}` +
        `   ${r.geo.innerFt.toFixed(1).padStart(6)}→${r.geo.outerFt.toFixed(1).padStart(6)}` +
        `  ${depth(r.geo).toFixed(1).padStart(7)}  ${r.geo.peakFt.toFixed(2).padStart(8)}` +
        `  ${dPeak.toFixed(3).padStart(8)}`,
    );
  }

  // (1) DEAD CENTRE IS THE MASS.
  const centre = at(0);
  if (!centre) {
    violations.push('no roof at all behind dead centre field — the stack is parked somewhere else');
  } else {
    if (centre.layers < ROOF_MIN_LAYERS) {
      violations.push(
        `the stack is ${centre.layers} panel(s) deep at 0° (want ≥ ${ROOF_MIN_LAYERS}) — ` +
          `that is a narrower ring, not a collapse`,
      );
    }
    const deepest = Math.max(...measured.map((r) => r.geo.layers));
    if (centre.layers < deepest) {
      violations.push(
        `the stack is deepest at some bearing other than 0° (${deepest} layers vs ` +
          `${centre.layers} at dead centre)`,
      );
    }
    // (2) IT IS DEEP THERE.
    if (depth(centre) < ROOF_STACK_MIN_DEPTH_FT) {
      violations.push(
        `the stack is only ${depth(centre).toFixed(1)} ft deep at 0° (want ≥ ` +
          `${ROOF_STACK_MIN_DEPTH_FT}) — the parked panels are not piled, they are laid out`,
      );
    }
  }

  // (3) BOTH FOUL LINES ARE OPEN SKY.
  for (const deg of [-45, 45]) {
    if (at(deg)) {
      violations.push(
        `there is roof at the ${deg}° foul line — the corner cameras must look at sky and ` +
          `skyline there, which is the whole point of the collapse`,
      );
    }
  }

  // (4) MONOTONE OUTWARD, AND SYMMETRIC ABOUT DEAD CENTRE.
  const degs = rows.map((r) => r.deg).filter((d) => d >= 0).sort((a, b) => a - b);
  for (let i = 1; i < degs.length; i++) {
    for (const sign of [1, -1]) {
      const a = at(sign * degs[i - 1]);
      const b = at(sign * degs[i]);
      const la = a?.layers ?? 0;
      const lb = b?.layers ?? 0;
      if (lb > la) {
        violations.push(
          `the stack GAINS a layer going outward, ${sign * degs[i - 1]}° → ${sign * degs[i]}° ` +
            `(${la} → ${lb}) — a parked stack thins outward`,
        );
      }
      const da = a ? depth(a) : 0;
      const db = b ? depth(b) : 0;
      if (db > da + ROOF_PROFILE_TOL_FT) {
        violations.push(
          `the stack gets DEEPER going outward, ${sign * degs[i - 1]}° → ${sign * degs[i]}° ` +
            `(${da.toFixed(1)} → ${db.toFixed(1)} ft)`,
        );
      }
    }
  }
  for (const deg of degs) {
    if (deg === 0) continue;
    const l = at(-deg);
    const r = at(deg);
    if (!!l !== !!r) {
      violations.push(`the stack covers ${l ? -deg : deg}° and not ${l ? deg : -deg}°`);
      continue;
    }
    if (!l || !r) continue;
    if (l.layers !== r.layers) {
      violations.push(`±${deg}° carry ${l.layers} and ${r.layers} layers — the stack is not symmetric`);
    }
    if (Math.abs(depth(l) - depth(r)) > ROOF_PROFILE_TOL_FT) {
      violations.push(
        `±${deg}° are ${depth(l).toFixed(2)} and ${depth(r).toFixed(2)} ft deep — ` +
          `the stack is not symmetric about dead centre`,
      );
    }
  }

  // (5) THE TOP OF THE STACK IS THE PARK'S CEILING.
  console.log(
    `    worst |Δpeak| ${worstPeak.toFixed(3)} ft (tol ${ROOF_TOL_FT} ft)` +
      `   covered at ${measured.length}/${rows.length} bearings` +
      `   deepest ${centre ? depth(centre).toFixed(1) : '—'} ft over ${centre?.layers ?? 0} panels`,
  );
  if (worstPeak > ROOF_TOL_FT) {
    violations.push(`roof height off by ${worstPeak.toFixed(3)} ft > tol ${ROOF_TOL_FT} ft`);
  }
  return violations;
}

/**
 * THE INFORMATION-LEAK CHECK — new, and the reason the two tracer seams are now
 * two functions instead of one.
 *
 * The owner played the shipped build and reported "the arc is there steady when
 * I expected it would be created as the ball is flying not ahead of it". It was:
 * the whole flight, INCLUDING THE LANDING POINT, was drawn the instant the pitch
 * was served. That is not a look problem, it is an information leak — a home run
 * is readable before it happens, and an incoming pitch's break is readable
 * before the player has to commit — and the pitch half is the worse of the two.
 *
 * Three assertions, each killing a different way of getting this wrong:
 *
 *   (a) THE COUNT, re-derived here. The harness counts the sim's own samples at
 *       or before the frozen instant and requires the draw range to equal it
 *       EXACTLY. That kills a full reveal (the old behaviour), an off-by-one
 *       lead, a reveal stuck at zero, and a reveal keyed off the wrong clock.
 *       It is arithmetic on `report.pitch.track.t`, not a read of anything the
 *       renderer computed, so it cannot become a tautology.
 *   (b) THE BUFFER, AGAINST THE SIM, BIT FOR BIT — in two halves, both of which
 *       read data the renderer did not produce.
 *
 *       ⚠ **AND ITS FIRST VERSION WAS A TAUTOLOGY THAT COULD NOT FAIL.** It
 *       compared `tracer()` against `tracerFull()` — "every drawn float must be
 *       the corresponding float of the FULL buffer" — and `stadium/tracer.ts`
 *       subarrays THE SAME BACKING `Float32Array` for both readers
 *       (`positions.subarray(0, drawRange.count * 3)` and
 *       `positions.subarray(0, written * 3)`), so the comparison was
 *       `positions[i] !== positions[i]`. Its own note claimed "an implementation
 *       that rewrote the vertex data per frame to end at the ball would pass (a)
 *       and (c) and fail here"; it would NOT, because such an implementation
 *       rewrites `positions` IN PLACE and both readers return the rewritten
 *       prefix identically. A dead assertion inside a file whose charter is "IT
 *       ASSERTS NUMBERS, IT DOES NOT MERELY PRINT THEM" is worse than no
 *       assertion, because it is read as cover.
 *
 *       (b1) THE DRAWN PREFIX IS THE SIM'S LEADING SAMPLES, INDEX FOR INDEX.
 *            `drawn[i] === fround(simScene[i])` for every drawn float. (a) has
 *            already fixed HOW MANY vertices are drawn; this fixes WHICH POINTS
 *            they are, so the two together say "the first n samples of the sim,
 *            in order". It is strictly stronger than either Hausdorff direction
 *            in `checkPitchTracer`: a polyline re-parameterised by arc length
 *            has its vertices ON the same curve (chord sagitta over one substep
 *            of a pitch is ~5e-4 ft, comfortably under `TRACER_TOL_FT`) and
 *            passes both, while failing this.
 *       (b2) THE BUILT BUFFER IS THE WHOLE FLIGHT. `tracerFull()` must be
 *            exactly as long as the sim's track and equal it float for float.
 *            This is the leg that kills the rewrite: an implementation that
 *            re-authors the buffer each frame to end at the ball has
 *            `written === drawn`, so the buffer STOPS AT THE BALL and the
 *            hidden tail — which is the whole descending limb on `homerun`, and
 *            precisely what the 0.002 ft drawn-vs-sim comparison exists to
 *            measure — is simply not there.
 *
 *       Note that (b1) ∧ (b2) ⇒ `drawn[i] === all[i]`, i.e. the original prefix
 *       claim is recovered — but as a CONSEQUENCE of two measurements against
 *       the sim rather than as an identity between two views of one array.
 *
 *       ⚠ (b2) is not the only thing that can see a truncated buffer:
 *       `checkPitchTracer`'s REVERSE Hausdorff also fires, because
 *       `atDistance` clamps and every missing sim sample then differences
 *       against the drawn path's last vertex. That is the check the property
 *       was actually resting on while (b) was dead. (b2) is kept beside it
 *       because it is exact, carries no tolerance, and names the failure
 *       ("the geometry is being rewritten") instead of guessing at it ("chord?").
 *
 *       ⚠ TWO MUTATIONS WERE WATCHED, AND THE OLD (b) WAS WATCHED TO SAY
 *       NOTHING ON BOTH. Both were written into `stadium/flight.ts` as real
 *       behaviour and run through this harness:
 *
 *       M1 — "rewrite the vertices every frame so the trail ends EXACTLY at the
 *       ball": `applyReveal` calls `set()` with the revealed prefix, last vertex
 *       replaced by the interpolated ball position, instead of `reveal()`.
 *       This is the implementation the old comment named.
 *
 *           check                                   scenes failed / 15
 *           OLD (b)  drawn-vs-all prefix                    0     ← silent
 *           (a)      the reveal count                       0     ← passes
 *           (c)      the tip vs the ball             skipped, always
 *           (b1)     drawn ≡ sim, index for index          12
 *           (b2)     built ≡ sim, index for index          12
 *           (b2)     built length = the sim's track        15
 *
 *       (a) passes because the count is still right; (c) is skipped on every
 *       scene, because it only runs while `drawnN < allN` and this mutation
 *       makes them equal by construction. (b1)/(b2) miss the three scenes whose
 *       frozen instant lands exactly on a substep, where the re-authored tip
 *       coincides with the sample it replaced — the LENGTH leg catches those.
 *
 *       M2 — "resample the built polyline uniformly by ARC LENGTH", same vertex
 *       count, built once, revealed normally. Geometrically the same curve; only
 *       the index-to-time correspondence is destroyed. This is the mutation that
 *       justifies (b1) EXISTING beside the Hausdorff pair, because they cannot
 *       see it at all:
 *
 *           check                        `batter`        vs tolerance
 *           forward Hausdorff (1)        1.06e-7 ft      19,000× under
 *           reverse Hausdorff (1r)       2.18e-4 ft           9× under
 *           deflection, horizontal       4.99e-2 in      UNDER 5.00e-2 — passed
 *           deflection, vertical         7.95e-2 in      fired, by 1.6×
 *           OLD (b)                      no difference   silent
 *           (b1)/(b2)                    differ @float 3 fired
 *
 *       i.e. the geometric checks are blind or on a knife edge — the horizontal
 *       deflection came in at 99.8 % of its own tolerance and PASSED — while the
 *       index comparison fires on the fourth float of the buffer.
 *   (c) THE TIP, geometrically. The last drawn vertex must lie BEHIND the drawn
 *       ball along the path, by no more than the one sim substep the reveal
 *       granularity allows. "Behind" is a dot product against the next (hidden)
 *       vertex, so it needs no frame convention and no tolerance to have a sign;
 *       "no more than" is bounded by the distance to that same next vertex,
 *       which is DERIVED from the track rather than chosen. A tracer written in
 *       reverse order passes (a) and (b) and dies here.
 */
function checkReveal(report) {
  const violations = [];
  const t = report.ballTimeS;
  if (t === null || t === undefined) return [];
  const struck = !!report.batted && t >= report.contactTS;
  const rows = [
    {
      which: 'pitch',
      drawn: report.pitchTracer,
      all: report.pitchTracerAll,
      // The sim's own samples in the tracer's own frame — the reference (b1)
      // and (b2) are measured against. Not read from the renderer.
      sim: sceneFlatFromPitchTrack(report.pitch.track),
      // Once the ball is struck the pitch is HISTORY and stays fully drawn —
      // that trail is what makes the contact seam legible.
      want: struck ? report.pitch.track.t.length : countAtOrBefore(report.pitch.track.t, t),
      live: !struck,
    },
    {
      which: 'batted',
      drawn: report.battedTracer,
      all: report.battedTracerAll,
      sim: report.batted ? sceneFlatFromBattedTrack(report.batted.track) : [],
      want: report.batted ? countAtOrBefore(report.batted.track.t, t - report.contactTS) : 0,
      live: struck,
    },
  ];
  for (const r of rows) {
    if (r.all.length === 0) continue;
    const drawnN = r.drawn.length / 3;
    const allN = r.all.length / 3;
    console.log(
      `  REVEAL ${r.which.padEnd(6)} drawn ${String(drawnN).padStart(4)} of ${String(allN).padStart(
        4,
      )} verts   expected ${String(r.want).padStart(4)}${r.live ? '   ← the live track' : ''}`,
    );
    if (drawnN !== r.want) {
      violations.push(
        `the ${r.which} tracer draws ${drawnN} vertices at t = ${t.toFixed(3)} s, but only ` +
          `${r.want} of the sim's samples have happened — ` +
          (drawnN > r.want ? 'the arc is drawn AHEAD of the ball' : 'the trail lags the ball'),
      );
    }
    // (b1) the drawn vertices ARE the sim's leading samples, index for index.
    // (b2) the built buffer IS the whole sim track, index for index.
    //
    // ⚠ BOTH SIDES OF EACH COMPARISON MUST NOT BE THE SAME ARRAY. The version
    // this replaces compared `r.drawn[i]` against `r.all[i]`, which `tracer.ts`
    // serves from one backing `Float32Array` — see the (b) note above.
    const firstDiffAgainst = (buf, n) => {
      for (let i = 0; i < n; i++) if (buf[i] !== r.sim[i]) return i;
      return -1;
    };
    const drawnDiff = firstDiffAgainst(r.drawn, r.drawn.length);
    const builtDiff = firstDiffAgainst(r.all, Math.min(r.all.length, r.sim.length));
    const builtVerdict =
      r.all.length !== r.sim.length ? 'TRUNCATED' : builtDiff < 0 ? 'yes' : `NO @${builtDiff}`;
    console.log(
      `         built ${String(allN).padStart(4)} of the sim's ${String(
        r.sim.length / 3,
      ).padStart(4)} samples` +
        `   drawn≡sim ${drawnDiff < 0 ? 'yes' : `NO @${drawnDiff}`}` +
        `   built≡sim ${builtVerdict}`,
    );
    if (drawnDiff >= 0) {
      violations.push(
        `the ${r.which} tracer's drawn vertices are not the sim's leading samples ` +
          `(float ${drawnDiff}: drew ${r.drawn[drawnDiff]}, sim says ${r.sim[drawnDiff]}) — ` +
          `the geometry is being re-authored, not revealed`,
      );
    }
    if (builtDiff >= 0) {
      violations.push(
        `the ${r.which} tracer's BUILT path is not the sim's track ` +
          `(float ${builtDiff}: built ${r.all[builtDiff]}, sim says ${r.sim[builtDiff]})`,
      );
    }
    if (r.all.length !== r.sim.length) {
      violations.push(
        `the ${r.which} tracer's BUILT path holds ${allN} vertices, not the sim's ` +
          `${r.sim.length / 3} — the buffer stops at the ball, so the hidden tail the ` +
          `0.002 ft drawn-vs-sim comparison measures is not in it`,
      );
    }
    // (c) the tip, against the drawn ball.
    if (!r.live || drawnN < 1 || drawnN >= allN || !report.ballScene) continue;
    const tip = [r.all[(drawnN - 1) * 3], r.all[(drawnN - 1) * 3 + 1], r.all[(drawnN - 1) * 3 + 2]];
    const next = [r.all[drawnN * 3], r.all[drawnN * 3 + 1], r.all[drawnN * 3 + 2]];
    const toBall = report.ballScene.map((v, i) => v - tip[i]);
    const toNext = next.map((v, i) => v - tip[i]);
    const lag = Math.hypot(...toBall);
    const step = Math.hypot(...toNext);
    // ⚠ NORMALISED, AND THE EPSILON IS THE FLOAT32 ONE. When the frozen instant
    // lands exactly on a substep the ball sits ON the tip vertex, `toBall` is a
    // Float64-minus-Float32 difference (2.7e-5 ft at 450 ft) and its SIGN is
    // noise. Dividing by the step turns the dot product into a length along the
    // path, which `TRACER_TOL_FT` is already the derived tolerance for.
    const along =
      (toBall[0] * toNext[0] + toBall[1] * toNext[1] + toBall[2] * toNext[2]) / (step || 1);
    console.log(
      `         tip → ball ${lag.toFixed(4)} ft, forward ${
        along > -TRACER_TOL_FT ? 'yes' : 'NO'
      }  (bound: one substep = ${step.toFixed(4)} ft + tol ${TRACER_TOL_FT})`,
    );
    if (along < -TRACER_TOL_FT) {
      violations.push(
        `the ${r.which} trail's tip is AHEAD of the ball — the outcome is on screen before it happens`,
      );
    }
    if (lag > step + TRACER_TOL_FT) {
      violations.push(
        `the ${r.which} trail's tip is ${lag.toFixed(4)} ft behind the ball, over the ` +
          `${step.toFixed(4)} ft one-substep bound — the trail is detached`,
      );
    }
  }
  return violations;
}

/** How many of `times` are at or before `t`. The reveal count, re-derived. */
function countAtOrBefore(times, t) {
  let n = 0;
  for (const v of times) if (v <= t) n++;
  return n;
}

/**
 * THE FRAMING CHECK — new, and it is the owner's second defect written as a
 * number.
 *
 * `ballScreen()` is the DRAWN ball projected by the DRAWING camera into 0…1
 * viewport coordinates. "In frame" is therefore `0 ≤ u,v ≤ 1` and nothing else,
 * and it is the one thing `checkBall` explicitly could NOT say: its own note
 * warns that `Object3D.visible` is not "in this picture", and cites `flight.png`
 * passing with no ball anywhere in the shot.
 *
 * It is asserted only for the scenes that claim it (`expectBallInFrame`), and
 * PRINTED for every scene — because a mode whose ball is legitimately off-frame
 * (`flight` at t = 0.30 s, the pitch still below the bottom crop) is a fact
 * about the framing, not a regression, and a gate that fails on correct data is
 * worth as little as one that passes on wrong data.
 *
 * MUTATION WATCHED TO FAIL (reverted, counts as observed, exit 1):
 *   1. `contact` back to `bt = 0.12`, the shipped timing               → 1 fail
 *      ("the ball is OFF FRAME at (0.016, −0.123) (needs 40 px of
 *      clearance from every edge)"). Before this scene declared
 *      `expectBallInFrame` nothing in the run could see it: `checkBall`
 *      passed on the same frame, because `Object3D.visible` was true.
 */
function checkFraming(report) {
  const p = report.ballScreen;
  const cam = report.cameraAim;
  console.log(
    `  FRAME  mode ${String(cam?.mode).padEnd(7)} ease ${(cam?.progress ?? 0).toFixed(3)}` +
      `  aim (${(cam?.target ?? []).map((v) => v.toFixed(1)).join(', ')})` +
      `   ball on screen ${p ? `(${p[0].toFixed(3)}, ${p[1].toFixed(3)})` : '— (off frustum)'}` +
      `${report.expectBallInFrame ? `  must be in frame${report.ballMarginPx ? ` ≥${report.ballMarginPx} px clear` : ''}` : ''}` +
      `   clock ${report.clockNow ?? '—'} ms`,
  );
  if (!report.expectBallInFrame) return [];
  if (!p) return ['the ball is outside the camera frustum in a scene that must contain it'];
  // ⚠ `ballMarginPx` IS NOT DECORATION. `0 ≤ u,v ≤ 1` is the right bound for the
  // three `follow-*` scenes, whose claim is only that the camera TRACKS — a ball
  // one pixel inside the crop is a tracking camera. It is the wrong bound for
  // `contact`, whose claim is that a human can SEE the ball leaving the bat: a
  // ball at v = 0.004 satisfies "in frame" and photographs as a smear on the
  // edge. Scenes that are a PICTURE of the ball ask for real clearance, in
  // pixels of the actual crop, so the number means the same thing on both axes.
  const m = report.ballMarginPx ?? 0;
  const mu = m / VIEWPORT.width;
  const mv = m / VIEWPORT.height;
  const inFrame = p[0] >= mu && p[0] <= 1 - mu && p[1] >= mv && p[1] <= 1 - mv;
  return inFrame
    ? []
    : [
        `the ball is OFF FRAME at (${p[0].toFixed(3)}, ${p[1].toFixed(3)})` +
          `${m ? ` (needs ${m} px of clearance from every edge)` : ''} — the camera is not ` +
          `following it, which is the defect this scene exists to catch`,
      ];
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
 * reports a perfectly correct position and photographs an empty sky. But it is
 * `Object3D.visible`, NOT "in this picture", and the two come apart: `flight.png`
 * at t = 0.30 s passes this check with no ball anywhere in the frame — that
 * camera is 120 ft up at z = +90 looking out, and the pitch is still below its
 * bottom crop. Read it as "the scene did not switch the ball off", never as a
 * photographic guarantee; in-frame is what the PNG diff is for.
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
  // The BUILT paths, not the revealed ones: the seam is a property of the
  // geometry, and reading the reveal would make this check silently skip on
  // every shot frozen before contact.
  const p = report.pitchTracerAll;
  const b = report.battedTracerAll;
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
  // ⚠ THE FULL BUILT PATH, NOT THE REVEALED PREFIX, AND THE DISTINCTION IS THE
  // WHOLE RE-BASING THIS CHECK NEEDED. The trail is now revealed progressively,
  // so `tracer()` returns only the part of the flight that has happened. Point
  // this comparison at that and it quietly stops asking anything about the part
  // of the curve the ball has not reached — which on a shot frozen at t = 0.30 s
  // is 40 % of a pitch, and on `homerun` is the entire descending limb, i.e.
  // exactly the geometry a "prettier curve" bug would live in. `readAll()`
  // exists so this check keeps measuring what it always measured; `checkReveal`
  // is where the reveal itself is asserted.
  const drawn = reportFromSceneFlat(report.pitchTracerAll);
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
  // The full built path — see the note in `checkPitchTracer`.
  const drawn = worldFromSceneFlat(report.battedTracerAll);
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

/* ------------------------------------------------------- the night bowl */

/**
 * ⚠⚠ THE ONE CHECK IN THIS FILE THAT READS THE ACTUAL PIXELS, AND IT EXISTS
 * BECAUSE THE CROWD HAS NOW BEATEN THIS SUITE THREE TIMES.
 *
 * Every other number here comes out of the scene graph, and the night crowd's
 * defect is invisible to all of them: the geometry is right, the draw calls are
 * right, the day/night pair is identical in every counted quantity, and the
 * frame still photographs as television static. Twice it was "fixed" by moving
 * `daylight.crowdBase` and twice a human had to look at a PNG to find out it
 * had not been. So the third fix ships with the measurement attached.
 *
 * WHAT IS MEASURED, and why it is a RATIO rather than a level. Absolute
 * luminance is a legitimate authoring choice and moves whenever the lighting
 * does; what makes a deck read as *noise* is the SPREAD between its bright
 * points and the deck under them, with nothing alive in between. So each patch
 * is measured in BOTH rows of the same pair and the night figure is judged
 * against its own day figure — the day crowd is the one a human signed off.
 *
 *   patch              day p50/p99  ratio     night, as shipped before / after
 *   far upper deck      22.1/36.5     1.7      9.8/150.4 = 15.4  →  27.0/76.2 = 2.8
 *   near bowl           18.4/73.2     4.0      4.1/112.3 = 27.5  →  15.7/67.5 = 4.3
 *
 * Night SHOULD run hotter than day — the points stand for self-luminous phone
 * screens, where by day both the points and the deck under them take the same
 * sun — so parity is the wrong bar. `CROWD_MAX_NIGHT_RATIO` is 3× the day
 * figure: it passes the shipped 1.6× and 1.1×, and fails the 9.1× and 6.9× that
 * two rounds of gate output described in prose and no test could see.
 *
 * ⚠ AND THE SECOND LEG IS THE PEAK, MEASURED AGAINST THE FIELD. A crowd point
 * is not a light — the crowd map MULTIPLIES a Lambert seat colour — so a texel
 * that renders brighter than the floodlit turf is a white patch out-shining the
 * thing the floodlights are pointed at. The turf patch is read from the same
 * PNG, so this leg follows the lighting instead of pinning a constant to it.
 *
 * ⚠ GUARD THE GUARD. These are hand-placed rectangles on a 900 × 1600 `wide`
 * frame, so the failure mode is a rect that has slid off the deck and is
 * quietly measuring turf or sky. Every patch therefore declares the band its
 * DAY p50 must land in, and a patch outside it is a violation in its own right
 * — the check reports that it can no longer see what it is named after rather
 * than passing on whatever it hit.
 *
 * MUTATIONS WATCHED TO FAIL (each reverted, counts as observed, exit 1):
 *   1. `night.crowdBase` back to 0.16 — the state two rounds shipped  → 2 fail
 *      (BOTH patches, on the SPREAD leg: 4.4× and 4.0× the day ratio)
 *   2. `night.crowdPointGain` back to 1 — no ceiling on a point       → 3 fail
 *      (both patches on the PEAK leg at 151.4 and 113.5 against a
 *      floodlit 83.2, and the far patch on the spread leg too)
 *   3. the far patch's rect moved onto the turf                       → 1 fail
 *      (the guard-the-guard leg: day p50 95.0 outside its 16–30 band,
 *      and the two real legs are SKIPPED rather than passed on it)
 */
const CROWD_PATCHES = [
  // Upper deck, ~400 ft out, between two fascia LED lines. No ribbon text.
  { id: 'far upper deck', rect: [220, 515, 140, 45], dayP50: [16, 30] },
  // The lower bowl behind the plate, the nearest seating this camera reaches.
  //
  // ⚠ 220×80 → 210×60, AND THE TRIM IS A FINDING, NOT A TIDY-UP. The bottom
  // right 122 texels of the old rect were not crowd at all — they were the
  // CONCOURSE outside the bowl, showing through at (656–659, 1155+) at the old
  // night apron's exact (67,70,76). That is 0.7 % of the rect and it was the
  // whole of its p99: darkening the concourse moved this patch's night peak
  // from 67.5 to 58.9 with nothing about the crowd having changed. A "crowd
  // point" that is actually a car park is the same class of defect `dayP50`
  // exists to catch, one order of magnitude smaller — the band could not see
  // it because the day p50 barely moves (18.4 → 19.3, both inside 12–26). The
  // trimmed rect is 0 apron texels; measured, night p99/p50 is 3.5 against a
  // day 3.8.
  { id: 'near bowl', rect: [440, 1090, 210, 60], dayP50: [12, 26] },
];
/** The floodlit field, in the same frame — the reference the peak is judged on. */
const TURF_PATCH = { id: 'turf', rect: [400, 700, 120, 60], dayP50: [85, 120] };

/**
 * ⚠⚠ THE OTHER HALF OF THE NIGHT FRAME: EVERY LARGE SURFACE THE LIGHT RIG DOES
 * NOT REACH, AND THE RULE IS ONE LINE — IT MUST BE MATERIALLY DARKER THAN IT IS
 * BY DAY.
 *
 * A `DirectionalLight` has a direction and no position, so a rig that is
 * conceptually "inside the bowl pointing down at the field" is, to everything
 * else in the scene, a light of infinite reach. Three surfaces have now shipped
 * the same inversion — the parked roof deck at 86 % of its own daytime
 * luminance, the concourse at 81 %, and the skyline at 65 % with the tower's
 * concrete shaft rendering at 96.1 against a floodlit turf at 83.2. Every one
 * of them passed the whole suite: the geometry is right, the draw calls are
 * right, the day/night pair is byte-identical, and a human had to look at a PNG.
 *
 * So it is measured here, in pixels, on the same `daynight` pair the crowd is.
 * The ratio is against each patch's OWN day figure rather than an absolute
 * level, so it survives an art pass that repaints the surface, and each rect
 * carries a `dayP50` band on the same guard-the-guard principle as
 * `CROWD_PATCHES`: a rect that has drifted off the thing it is named after
 * SKIPS rather than passes.
 *
 * MUTATIONS WATCHED TO FAIL (each reverted, counts as observed, exit 1):
 *   1. `night.apronHex` back to 0x63625d — the shipped concourse   → 1 fail
 *      (69.8 against a day 86.4, 81 %)
 *   2. `night.cityWallGain` back to 1 and the night ramp back to
 *      the day concrete — the shipped skyline                      → 1 fail
 *      (85.8 against a day 132.4, 65 %)
 *   3. the concourse rect moved onto the bowl                      → 1 fail
 *      (guard-the-guard: day p50 29.1, outside its 78–95 band, and
 *      the real leg is SKIPPED rather than passed on it — it would
 *      have read 113 % and failed for the wrong reason)
 */
const NIGHT_MASS_PATCHES = [
  // The ground disc outside the bowl, bottom of frame. `field.ts` does not
  // grain the apron, so this rect is 100 % one colour and the p50 IS the
  // surface.
  { id: 'concourse', rect: [80, 1400, 200, 120], dayP50: [78, 95] },
  // The tallest high-rise, top of frame. 57 % of the rect is facade; the rest
  // is its window grid, which is why the p50 and not the mean is read.
  { id: 'skyline body', rect: [330, 60, 40, 130], dayP50: [125, 140] },
];
/** How much of its own DAY luminance a surface outside the rig may keep. */
const NIGHT_MASS_MAX_OF_DAY = 0.5;
const CROWD_MAX_NIGHT_RATIO = 3;
/** How far over the turf's own p50 a crowd point may reach. */
const CROWD_MAX_PEAK_OVER_TURF = 1.2;

/**
 * Minimal 8-bit non-interlaced PNG reader — IHDR, IDAT, un-filter. Forty lines
 * and no dependency, which is the whole reason it is here: rule 6 of the
 * charter is zero new runtime dependencies, and a screenshot harness that needs
 * an image library to read its own output would be the first crack in it.
 */
function readPng(file) {
  const buf = readFileSync(file);
  let off = 8;
  let w = 0;
  let h = 0;
  let ch = 0;
  const idat = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      w = data.readUInt32BE(0);
      h = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('not 8-bit non-interlaced');
      ch = data[9] === 6 ? 4 : data[9] === 2 ? 3 : 0;
      if (!ch) throw new Error(`colour type ${data[9]}`);
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    off += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const stride = w * ch;
  const out = Buffer.alloc(h * stride);
  let p = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[p++];
    const cur = out.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? out.subarray((y - 1) * stride, y * stride) : null;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? cur[x - ch] : 0;
      const b = prev ? prev[x] : 0;
      const c = prev && x >= ch ? prev[x - ch] : 0;
      let v = raw[p + x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const q = a + b - c;
        const pa = Math.abs(q - a);
        const pb = Math.abs(q - b);
        const pc = Math.abs(q - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[x] = v & 255;
    }
    p += stride;
  }
  return { width: w, channels: ch, data: out };
}

/** Rec.709 percentiles over a rectangle — the units every soffit and crowd figure is in. */
function patchStats(img, [x0, y0, w, h]) {
  const l = [];
  for (let y = y0; y < y0 + h; y++) {
    for (let x = x0; x < x0 + w; x++) {
      const i = (y * img.width + x) * img.channels;
      l.push(0.2126 * img.data[i] + 0.7152 * img.data[i + 1] + 0.0722 * img.data[i + 2]);
    }
  }
  l.sort((a, b) => a - b);
  const q = (f) => l[Math.min(l.length - 1, Math.floor(f * (l.length - 1)))];
  return { p50: q(0.5), p90: q(0.9), p99: q(0.99), ratio: q(0.99) / Math.max(q(0.5), 0.01) };
}

function checkNightBowl(reports) {
  if (!ids.includes('daynight-day') || !ids.includes('daynight-night')) return [];
  if (!reports.get('daynight-day') || !reports.get('daynight-night')) return [];
  const violations = [];
  let day;
  let night;
  try {
    day = readPng(path.join(outDir, `${SCENES['daynight-day'].label}.png`));
    night = readPng(path.join(outDir, `${SCENES['daynight-night'].label}.png`));
  } catch (e) {
    return [`could not read the day/night PNGs back: ${String(e)}`];
  }
  const turfDay = patchStats(day, TURF_PATCH.rect);
  const turfNight = patchStats(night, TURF_PATCH.rect);
  console.log('\n· NIGHT BOWL  luminance of the crowd deck, read back out of the PNGs');
  console.log('    patch              day p50    p99  ratio  |  night p50    p99  ratio');
  const rows = [...CROWD_PATCHES, TURF_PATCH];
  for (const patch of rows) {
    const d = patch === TURF_PATCH ? turfDay : patchStats(day, patch.rect);
    const n = patch === TURF_PATCH ? turfNight : patchStats(night, patch.rect);
    console.log(
      `    ${patch.id.padEnd(16)} ${d.p50.toFixed(1).padStart(7)} ${d.p99.toFixed(1).padStart(6)}` +
        ` ${d.ratio.toFixed(1).padStart(6)}  | ${n.p50.toFixed(1).padStart(9)}` +
        ` ${n.p99.toFixed(1).padStart(6)} ${n.ratio.toFixed(1).padStart(6)}`,
    );
    // (0) THE RECT STILL SEES WHAT IT IS NAMED AFTER.
    const [lo, hi] = patch.dayP50;
    if (d.p50 < lo || d.p50 > hi) {
      violations.push(
        `the "${patch.id}" patch reads day p50 ${d.p50.toFixed(1)}, outside its declared ` +
          `${lo}–${hi} band — the rectangle is no longer on the surface it names, so every ` +
          `figure beside it is measuring something else`,
      );
      continue;
    }
    if (patch === TURF_PATCH) continue;
    // (1) THE SPREAD. See the header — a ratio, against this patch's own day figure.
    if (n.ratio > CROWD_MAX_NIGHT_RATIO * d.ratio) {
      violations.push(
        `"${patch.id}" runs p99/p50 = ${n.ratio.toFixed(1)} at night against ${d.ratio.toFixed(1)} ` +
          `by day (${(n.ratio / d.ratio).toFixed(1)}×, ceiling ${CROWD_MAX_NIGHT_RATIO}×) — bright ` +
          `points on a dead deck is sensor noise, not a crowd`,
      );
    }
    // (2) THE PEAK, against the floodlit field in the same frame.
    if (n.p99 > CROWD_MAX_PEAK_OVER_TURF * turfNight.p50) {
      violations.push(
        `"${patch.id}" peaks at ${n.p99.toFixed(1)} at night against floodlit turf at ` +
          `${turfNight.p50.toFixed(1)} — the crowd map MULTIPLIES a Lambert seat, so a texel ` +
          `over the field is a white patch out-shining the floodlights`,
      );
    }
  }

  // --- the surfaces OUTSIDE the rig. See `NIGHT_MASS_PATCHES`.
  console.log('\n· NIGHT MASSES  surfaces the rig does not reach, read back out of the PNGs');
  console.log('    patch              day p50   night p50   night/day   ceiling');
  for (const patch of NIGHT_MASS_PATCHES) {
    const d = patchStats(day, patch.rect);
    const n = patchStats(night, patch.rect);
    const frac = n.p50 / Math.max(d.p50, 0.01);
    console.log(
      `    ${patch.id.padEnd(16)} ${d.p50.toFixed(1).padStart(7)} ${n.p50.toFixed(1).padStart(11)}` +
        ` ${(frac * 100).toFixed(0).padStart(10)} % ${(NIGHT_MASS_MAX_OF_DAY * 100).toFixed(0).padStart(9)} %`,
    );
    const [lo, hi] = patch.dayP50;
    if (d.p50 < lo || d.p50 > hi) {
      violations.push(
        `the "${patch.id}" patch reads day p50 ${d.p50.toFixed(1)}, outside its declared ` +
          `${lo}–${hi} band — the rectangle is no longer on the surface it names, so the ` +
          `night figure beside it is measuring something else`,
      );
      continue;
    }
    if (frac > NIGHT_MASS_MAX_OF_DAY) {
      violations.push(
        `"${patch.id}" renders at ${n.p50.toFixed(1)} at night against ${d.p50.toFixed(1)} by day ` +
          `(${(frac * 100).toFixed(0)} %, ceiling ${(NIGHT_MASS_MAX_OF_DAY * 100).toFixed(0)} %) — one ` +
          `DirectionalLight has a direction and no position, so the field rig is lighting a ` +
          `surface it is not standing in. Reflectance is the only channel that can separate them`,
      );
    }
    if (n.p50 < 1) {
      violations.push(
        `"${patch.id}" renders at ${n.p50.toFixed(1)} at night — that is CLIPPED, not dark. ` +
          `The exactly-derived "rig removed" albedo is black for every one of these surfaces; ` +
          `a hole in the frame is the other failure mode, not the fix`,
      );
    }
  }
  return violations;
}

/**
 * ⚠ THE DAY / NIGHT TOGGLE IS COSMETIC, ASSERTED ACROSS TWO SCENES.
 *
 * `stadium/daylight.ts` states the hard rule — a *player-selectable* option that
 * changed how far the ball carried would be a "pick the easy mode" button on a
 * leaderboard game — and `shared/prefs.test.ts` asserts the PHYSICS half by
 * running the published carry ladder with the preference set both ways and
 * requiring the two byte-identical.
 *
 * This is the RENDER half, and it is a different claim: that nothing about the
 * scene except its lighting moved. The two scenes differ by `?daylight=` alone,
 * so every number below is one that a lighting change has no business touching.
 * Draw calls and triangles catch "night quietly added four floodlights"; the
 * geometry count catches "night built a second sky"; the fence and the tracer
 * catch a night mode that re-derived anything it should have read.
 *
 * ⚠ IT IS NOT A PNG DIFF, ON PURPOSE. The two pictures MUST differ — that is the
 * whole feature — so a pixel comparison is exactly the wrong instrument. What
 * has to be identical is everything a pixel comparison cannot see.
 */
function checkDayNightPairs(reports) {
  const violations = [];
  for (const [id, scene] of Object.entries(SCENES)) {
    if (!scene.pairWith) continue;
    const a = reports.get(id);
    const b = reports.get(scene.pairWith);
    if (!a || !b) {
      // Only a complaint when BOTH were asked for — a single-scene run is fine.
      if (ids.includes(id) && ids.includes(scene.pairWith)) {
        violations.push(`${id}/${scene.pairWith}: one of the pair produced no report`);
      }
      continue;
    }
    if (a.stats.daylight === b.stats.daylight) {
      violations.push(
        `${id}/${scene.pairWith}: both report light "${a.stats.daylight}" — the pair is not ` +
          `testing anything, so ?daylight= is not reaching the scene`,
      );
    }
    const rows = [
      ['draw calls', a.stats.drawCalls, b.stats.drawCalls],
      ['triangles', a.stats.triangles, b.stats.triangles],
      ['geometries', a.stats.geometries, b.stats.geometries],
      ['textures', a.stats.textures, b.stats.textures],
      ['shadow map', a.stats.shadowMapSize, b.stats.shadowMapSize],
      ['shadow volume ft', a.stats.shadowHalfFt, b.stats.shadowHalfFt],
      ['fence @0°', a.fence.find((r) => r.deg === 0)?.geo?.distFt, b.fence.find((r) => r.deg === 0)?.geo?.distFt],
      ['tracer verts', a.pitchTracerAll.length, b.pitchTracerAll.length],
      ['board panels', a.board?.panels.length ?? 0, b.board?.panels.length ?? 0],
    ];
    console.log(`\n· DAY/NIGHT  ${id} (${a.stats.daylight}) vs ${scene.pairWith} (${b.stats.daylight})`);
    for (const [name, x, y] of rows) {
      const same = x === y;
      console.log(`    ${String(name).padEnd(17)} ${String(x).padStart(9)} ${same ? '=' : '≠'} ${String(y)}`);
      if (!same) {
        violations.push(
          `${id}/${scene.pairWith}: ${name} differs (${x} vs ${y}) — the daylight toggle is ` +
            `supposed to change LIGHT and nothing else`,
        );
      }
    }
    // The tracer, float for float. A night mode that rebuilt the flight would
    // pass every count above and fail here.
    const n = Math.min(a.pitchTracerAll.length, b.pitchTracerAll.length);
    let diff = -1;
    for (let i = 0; i < n; i++) {
      if (a.pitchTracerAll[i] !== b.pitchTracerAll[i]) {
        diff = i;
        break;
      }
    }
    console.log(`    ${'tracer ≡ tracer'.padEnd(17)} ${diff < 0 ? 'yes' : `NO @float ${diff}`}`);
    if (diff >= 0) {
      violations.push(`${id}/${scene.pairWith}: the drawn flight differs at float ${diff}`);
    }
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
  /** Every scene's report, for the CROSS-SCENE checks below. */
  const reports = new Map();
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

        const report = await page.evaluate(({ fence: bearings, roof: roofBearings }) => {
          const bb = window.__baseball;
          if (!bb || !bb.stadium) return { err: 'window.__baseball incomplete' };
          const { sim, stadium } = bb;
          const st = sim.derby.getState();
          return {
            parkId: sim.parkId,
            surroundings: sim.surroundings,
            roofPeakFt: sim.roofPeakFt,
            foulTerritoryFt: sim.foulTerritoryFt,
            derby: { phase: st.phase, rounds: st.rounds, pitchesPerRound: st.pitchesPerRound },
            stats: stadium.stats(),
            board: stadium.board(),
            fence: bearings.map((deg) => ({
              deg,
              geo: stadium.measureFence(deg),
              park: sim.fenceAt(deg),
            })),
            roof: roofBearings.map((deg) => ({ deg, geo: stadium.measureRoof(deg) })),
            pitch: sim.pitch,
            batted: sim.batted,
            ballTimeS: sim.ballTimeS,
            contactTS: sim.contactTS,
            mode: stadium.mode,
            // AS DRAWN (the reveal) and AS BUILT (the geometry). Two questions,
            // two readers — see `tracer.ts`'s note on `readAll`.
            pitchTracer: stadium.tracer('pitch'),
            battedTracer: stadium.tracer('batted'),
            pitchTracerAll: stadium.tracerFull('pitch'),
            battedTracerAll: stadium.tracerFull('batted'),
            tracerVisible: {
              pitch: stadium.tracerVisible('pitch'),
              batted: stadium.tracerVisible('batted'),
            },
            ballScene: stadium.ballScene(),
            ballScreen: stadium.ballScreen(),
            ballVisible: stadium.ballVisible(),
            ballScale: stadium.ballScale(),
            cameraAim: stadium.cameraAim(),
            clockNow: window.__sceneClockNow ? window.__sceneClockNow() : null,
          };
        }, { fence: FENCE_BEARINGS, roof: ROOF_BEARINGS });

        // The scene's own claim about itself, carried into the checks. Guarded
        // because `report` is `{ err }` when the handle is broken.
        if (report && !report.err) {
          report.expectBallInFrame = !!SCENES[id].expectBallInFrame;
          report.ballMarginPx = SCENES[id].ballMarginPx ?? 0;
          reports.set(id, report);
        }

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

  // The CROSS-SCENE checks. They cannot run inside the per-scene loop because
  // they compare two scenes, and they are counted as failures like everything
  // else — a check whose verdict is only printed is the defect this file's own
  // header is about.
  const pairBad = checkDayNightPairs(reports);
  if (pairBad.length) {
    failed++;
    console.error(`✗ day/night pair FAILED — ${pairBad.join('; ')}`);
  }
  const bowlBad = checkNightBowl(reports);
  if (bowlBad.length) {
    failed++;
    console.error(`✗ night bowl FAILED — ${bowlBad.join('; ')}`);
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
