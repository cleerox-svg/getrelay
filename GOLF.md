# Golf — in-app game (Mini-Golf + Driving Range)

An in-app 3D golf game in the Relay **Games** hub (`/discover`), built with
Three.js and a hand-rolled physics sim. This doc is the source of truth for what
exists today and the plan to reach PGA-app-level controls and visuals. Read it
first when picking up golf work.

> Reference the user wants to match: **PGA TOUR Golf Shootout** (a Unity game) —
> its aiming (shot line + landing reticle + power arc + wind-adjusted landing)
> and its textured, lit 3D look.

---

## What exists today

Two modes behind the "Golf" chiclet in the Games hub:

- **Mini-Golf (putting)** — top-down/angled 3D hole; drag-to-putt; 6 holes;
  sink the cup; par/stroke scoring. Cohesive 3D (Three.js).
- **Driving Range** — down-range 3D; **Practice** (open, unlimited) and
  **Target Challenge** (8 balls, proximity scoring). Full-screen immersive.

Both are real 3D (Three.js), lazy-loaded so `three` never bloats the main
bundle, with all GPU resources disposed (`forceContextLoss()`) on unmount.

### Shooting / controls (range) — current
- **Pull-back = power + aim (slingshot).** One drag sets both: power tracks the
  pull MAGNITUDE (vertical **power meter**), and the pull's ANGLE steers the
  shot — it flings OPPOSITE the pull, so dragging the finger RIGHT aims LEFT and
  vice-versa, clamped to ±40° with a small deadzone. The on-turf aim arrow and
  the predicted arc follow it live. (The old dedicated ±40° AIM slider is gone.)
- **Spin** via a contact-point **spin puck** (back/top + draw/fade) → bounded
  flight curve; backspin checks/zips back on the bounce.
- **Accuracy** via a **tap-timing bar** (Golf-Clash style): release arms the
  shot, a marker sweeps, tap to fire; off-center adds hook/slice.
- **Live aim prediction** (Roadmap step 1, done): while setting up a shot the
  turf shows a **wind-adjusted predicted arc** to a **landing reticle**, a
  **pre-wind reticle** (the gap between the two reads the wind push), a
  **roll-out marker**, and a **tap-timing dispersion cone** (worst hook ↔ worst
  slice). It's `rangeSim.predict()` — the CURRENT club/power/aim/spin/wind run
  through the SAME launch+flight+roll pipeline as the live shot via a
  snapshot/restore (no commit, no state mutation), so it's true to the yard.
  The harness asserts `predict()` matches `simulateShot()` per club.
- **Club ladder** (full power, neutral spin, harness-measured): Driver 291
  carry / 377 total → SW 109/128. Forgiving/linear power map
  (`s = baseSpeed·√(FLOOR + (1−FLOOR)·power)`). CARRY is loft+baseSpeed; TOTAL is
  carry + a run-out the bounce/roll core derives from the LANDING LIE.
- **Landing lies (surface materials).** The bounce+roll core is one shared model
  MODULATED per surface by a `TERRAIN` table in `rangeSim.ts` (restitution,
  forward bounce-keep, roll multiplier, run-out, backspin bite, settle
  threshold). A **fairway** is firm and lively — a few diminishing FORWARD hops
  then a long run-out (driver releases ~86yd); a **green** is receptive and
  CHECKS (short release); **fringe/rough/bunker/tee** are defined too so a future
  course maps each lie straight onto these numbers without touching the
  integrator. Today's range only classifies fairway (grass) + green (island);
  extend `surfaceAt()` + `ShotResult` + `terrainFor()` to add the rest.

### Range layouts — current
A data-driven **Range layout** picker (persisted, default `fairway`):
- `lane` — grass causeway through the water, both modes; every club lands+rolls.
- `practiceLane` — lane in Practice; Challenge is full water + islands (aim).
- `fairway` — grass fairway with a crossing water hazard (247–285 yд) holding
  island targets; driver carries it to the far fairway; short irons land near.

> **Known issue (user feedback):** the water + floating-island range reads as
> "odd" / un-golf-like, and the controls still don't feel like the PGA app. The
> plan below addresses both. Treat the range layout as a stepping stone toward
> the hole/course format.

### Physics, testing, telemetry
- **Physics** is a small, deterministic ballistics sim — **keep it, don't
  replace it.** World space: `d` downrange, `x` lateral, `h` height; gravity +
  drag + wind + bounce/roll; spin as bounded accelerations.
- **Headless test harness** (vitest): `pnpm --filter @relay/ui test` drives the
  REAL sim via `simulateShot({clubId,power,aimDeg,spinBack,spinSide,accuracy,
  layout,isChallenge})` and prints per-club/per-layout tables with
  regression-failing assertions. **Use this to tune — don't guess.**
- **In-app telemetry**: a last-shot debug panel + "Copy telemetry" button
  (last 30 shots as JSON) so real device numbers can be compared to the harness.

### Leaderboard / scoring
- Shared, contact-scoped `game_scores` table; discriminators `golf` (putting)
  and `golfrange` (range challenge). Worker: `packages/relay-worker/src/games.ts`
  (`GAME_IDS`, `POST /game/score`, `GET /game/leaderboard`). Clamps: ≤8 rounds,
  ≤2000 pts each. No migration needed to add a game id.

### Key files
| Area | Path |
|---|---|
| Range physics/sim (headless) | `packages/relay-ui/src/lib/golf/rangeSim.ts` |
| Sim tests / harness | `packages/relay-ui/src/lib/golf/rangeSim.test.ts` |
| Range 3D scene (Three.js) | `packages/relay-ui/src/components/golf/RangeGL.tsx` |
| Range HUD + controls + telemetry + layout picker | `packages/relay-ui/src/components/golf/RangeGame.tsx` |
| Layouts, pins, `surfaceAt` | `packages/relay-ui/src/lib/golf/rangeTargets.ts` |
| Club ladder | `packages/relay-ui/src/lib/golf/clubs.ts` |
| Putting sim / scene / round | `src/lib/golf/puttSim.ts`, `components/golf/PuttGL.tsx`, `GolfGame.tsx` |
| Ball material (dimple normal map) | `packages/relay-ui/src/lib/golf/ballTexture.ts` |
| Hub wiring | `packages/relay-ui/src/routes/Fog.tsx`, `components/golf/GolfMenu.tsx` |
| Worker leaderboard | `packages/relay-worker/src/games.ts` |

### Commands
- `pnpm --filter @relay/ui test` — the golf sim harness (dynamics tables).
- `pnpm typecheck` · `pnpm --filter @relay/ui build` (three stays a lazy chunk).
- `pnpm --filter @relay/worker test` — worker suite (unaffected by golf UI).

---

## Assessment — closing the gap to the PGA app

**Bottom line: not an engine problem.** Keep our physics (small, correct,
tested). Do **not** build a rendering engine — Three.js already is one and can
reach the target look. The two real gaps are a proper **aim/trajectory control**
(buildable on the sim we already have) and **art + shading** (textures,
lighting, shadows, trees, sky). PGA Shootout is Unity, but a Unity rewrite is
the wrong fit for a messenger mini-game.

### 1. Shooting controls — replicate PGA (highest impact, no new tech)
Touch **on the ball** → pull back to load a **power arc** hugging the ball →
show a shot line to an adjustable **landing reticle**, plus a **second,
wind-adjusted** path to the real landing point → release on the tap-timing beat.
A **dispersion cone** shows the risk.

Why it's safe: the predicted arc is just `rangeSim` stepped forward with the
current club/power/aim/spin/wind (no commit), drawn as a line + reticle. The
harness verifies the prediction matches the real shot to the yard. Effort: days,
not weeks.

### 2. Graphics — the look gap is assets + shading, not the renderer
Ranked by fit for an in-messenger PWA/Capacitor game:

| Path | Fidelity | Effort | Fit | Verdict |
|---|---|---|---|---|
| **Push our Three.js** — PBR turf/sand, sun + soft shadows, ambient/hemisphere light, sky + haze, billboard tree sprites w/ shadows, light bloom/tone-mapping | ~80% | Medium | Excellent (stays in the lazy chunk) | **Do this first** |
| Babylon.js or React-Three-Fiber + drei — batteries-included PBR/shadows/post | ~85% | Medium-High | OK (new dep / partial rewrite) | Only if #1 stalls |
| Unity / Godot → WebGL — what PGA uses | ~100% | Very high | Poor (multi-MB, heavy load, separate embedded app) | Not for a mini-game |
| Write our own renderer | Unbounded | Enormous | No | Don't |

**Real bottleneck: art content.** Agents can write the shaders, procedural
textures, lighting rig, and asset integration — but the last mile of the PGA
look is real art (turf/sand albedo+normal maps, tree sprites, a skybox). Either
license/curate CC0 or asset-store packs (agents integrate; adds bundle weight,
mitigated by lazy-load + compression), or a designer produces bespoke art.

### 3. Direct answers
- **Own physics?** Already have it — keep it (deterministic, unit-tested).
- **Own visual engine?** No — Three.js is our engine and can reach the look.
- **Need agents?** Yes for the engineering (fleet + harness). Agents can't
  manufacture licensed art — that's the one non-agent input.
- **Range odd?** Agreed — retire the water-island idiom; aim the work at the
  hole/course format (the destination).

---

## Roadmap (recommended order)

Gameplay clean first, then the look, then the course — each step reuses the last.

1. **Nail the aim/shot control** — touch-the-ball → power arc → aim line +
   landing reticle → wind-adjusted second path → tap-timing release. Prediction
   from the sim; verified by the harness. Biggest felt improvement.
   **→ Done:** `rangeSim.predict()` + the on-turf arc/reticles/dispersion cone
   in `RangeGL` (see "Live aim prediction" above). Next felt improvements here
   would be a draggable landing reticle (adjust aim by dragging the target) and
   folding the power arc onto the ball itself; both build on `predict()`.
2. **Level up visuals in Three.js** — PBR turf/sand, real sun + soft shadows +
   ambient light, sky + distance haze, lit tree sprites, glossier ball, light
   bloom/tone-mapping. The ~80% path, no new dep. Retire the odd range look here.
   **→ Done (first pass):** ACES filmic tone mapping + exposure; a stronger warm
   key sun with a soft-shadow map (ball/tree/flag contact shadows now read) over
   a sky/ground hemisphere fill; deeper, crisper sky with defined puffy
   cumulus; warmer, denser distance haze (fog); richer, glossier striped turf
   with a subtler mow delta and stronger blade normals; the odd flat tee-mat
   disc removed (tee peg + soft ball shadow ground the ball). All in `RangeGL`,
   verified by headless Chromium screenshots of every layout. No new dep; `three`
   stays a lazy chunk. **Not yet:** post-process bloom (needs EffectComposer —
   deferred for GPU cost on low-end mobile), billboard tree sprites, real sand/
   bunkers. Tune light intensity/exposure against device screenshots next.
   **Gotcha (learned the hard way):** a 2048² shadow map once crashed the
   WebView GPU process on real Android (black screen, needs an app restart)
   though it rendered fine in desktop/software GL, so it was reverted to 1024².
   It has since been **re-enabled to 2048² by request** — this MUST be
   re-verified on a low-end Android device before the release AAB ships; if it
   regresses, 1536² is the first dial to turn down. Test GPU-cost changes on a
   low-end device, not just the headless screenshot harness.
3. **Hole engine → 9-hole par-5 course** — a hole = tee → fairway → green → cup
   with per-hole terrain, par, distance-to-pin, wind. Same sim, same aim UI,
   same shaders. Then it's mostly hole data + terrain art to build the nine.
   (User's stated goal: a 9-hole course of par 5s, after gameplay is clean.)
   **Decision (user):** slopes are **physics-coupled EVERYWHERE** — putts break,
   the ball rolls downhill / checks uphill, sidehill lies push — not visual-only.
   **→ Started:** `lib/golf/terrain.ts` — a hole is DATA (`CourseHole`): a
   fairway CENTERLINE + half-width (doglegs are bent points), a raised, planar-
   TILTED green, circular bunker/water features that DISH the heightfield, a cart
   path ribbon, rough/OB falloff, and a tee→green grade + rolling value-noise
   hills. `heightAt()`/`gradientAt()` give elevation + slope and `surfaceAt()`
   the lie — ONE source of truth for both the (coming) terrain mesh and the ball
   physics. `slopeAccel()` is the downhill roll term (a ≈ −g·gradient) the course
   sim will add each grounded substep; greens are graded flat under the pad so
   their own tilt (not the surrounding mounds) breaks a putt. Showcase `HOLE_1`
   (dogleg-right par 5) + a headless harness (`terrain.test.ts`) proving break,
   downhill-vs-uphill run and a flat-hole regression.
   **→ Also done:** `lib/golf/courseSim.ts` — a terrain-aware full-shot sim that
   REUSES the range's tuned ballistics + `TERRAIN` lie materials (constants
   exported from `rangeSim`), but the ground is the hole's heightfield: flight
   lands at `heightAt`, the grounded roll adds `slopeAccel` each substep, the lie
   under the ball drives bounce/roll, and a cup captures a slow putt. Added a
   `cartpath` lie material (firm/lively). `courseSim.test.ts` proves it on
   `HOLE_1`: tee shots land on terrain with real lies, a putt BREAKS (vs a flat-
   green control) and can be HOLED, a wedge finds the pond, a pull goes OB, and a
   downhill putt outruns the same uphill one. 28/28 golf tests pass (range still
   15, untouched).
   **→ Also done (v1):** `components/golf/CourseGL.tsx` renders a hole in 3D from
   the SAME data — a displaced ground mesh sampled from `heightAt`, vertex-
   COLOURED per lie from `surfaceAt` (so the fairway/green/rough/bunker/water/
   cart-path you see are the surfaces the ball plays), a big fill plane to the
   horizon, translucent water discs, a flagstick, the ball on the tee, faceted
   framing trees, and the range's tuned lighting rig (ACES + warm sun + 2048²
   soft shadows + sky/haze). A golfer's-eye tee camera. Verified with a headless
   swiftshader screenshot of `HOLE_1` (reads as a tree-lined fairway to a distant
   flag).
   **→ Also done — PLAYABLE v1:** `CourseGL` now drives a live `CourseSim` on the
   fixed-step loop with the range's slingshot input (drag to aim — steering off
   the bearing-to-pin so "straight" points at the flag on a dogleg — pull for
   power, release to arm), a tap-timing accuracy bar, camera-follow, a ball
   tracer and an aim line. `CourseSim` gained the interactive surface
   (onPointerDown/Move/arm/fireArmed, club cycle, spin, getState, strokes,
   water/OB replay-with-penalty, cup hole-out). `components/golf/CourseGame.tsx`
   is the HUD wrapper (club selector, distance-to-pin/strokes/lie, accuracy bar,
   hole-out banner) — lazy-loaded so `three` stays a chunk. Wired into the Games
   hub: **Golf → "Course · Hole 1 (beta)"** plays the hole full-bleed. Verified
   headless (a scripted driver flies with camera-follow; the HUD renders).
   **→ Also done — range parity + polish (user feedback "the aim arc, the
   power… so much is missing"):** `CourseSim.predict()` (non-committing
   trajectory on the terrain, snapshot/restore, harness-asserted to match the
   committed shot to the yard) drives a **predicted aim arc** in `CourseGL` — a
   bright centre trajectory to a **landing reticle** + a **roll-out marker**, and
   two faded **dispersion** edges (worst hook ↔ slice), refreshed on drag/arm.
   Added a **vertical power meter** to the HUD (fills as you pull, reddens near
   max), a **putt-read break arrow** on the green (fall line from `slopeUnder()`),
   and **textures**: a mow-stripe turf map on the ground, sand-grain caps on the
   bunkers, and a drifting ripple normal on the water. The strike/accuracy bar
   was kept (the user likes it). 29/29 golf tests pass; verified headless
   (aiming shows the arc + dispersion + power meter). **Next:** build out the
   nine holes as data (+ optional: dial mow-stripe strength, tighten the tee
   camera framing) — pending on-device feel feedback.

**Working principle going forward:** tune against the **harness** and **device
telemetry**, not guesses — that's why both exist.

---

## Continuing in a new session
Steps 1 (aim/shot control) and 2 (visual first pass) are **done** — see the
roadmap markers above. Next up is **step 3 (hole engine → 9-hole par-5
course)**, unless the user wants to keep polishing the look (device-tuned
exposure/lighting, bloom, tree sprites, bunkers) first.

Tip for visual work: a throwaway `golfpreview.html` + `src/golfpreview.tsx` that
mounts only `<RangeGL>` (no app shell/auth) lets you screenshot the range with
the pre-installed headless Chromium (`--use-angle=swiftshader
--enable-unsafe-swiftshader`) for real before/after feedback. Recreate it when
iterating on the scene; it's not committed.

The user is gathering more reference screenshots of the PGA app's shooting and
will share them. Full visual write-up of the assessment was also produced as an
artifact during the session it was written.
