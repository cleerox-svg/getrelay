# Golf — in-app game (Mini-Golf + Driving Range)

An in-app 3D golf game in the Relay **Games** hub (`/games`), built with
Three.js and a hand-rolled physics sim. This doc is the source of truth for what
exists today and the plan to reach PGA-app-level controls and visuals. Read it
first when picking up golf work.

> Reference the user wants to match: **PGA TOUR Golf Shootout** (a Unity game) —
> its aiming (shot line + landing reticle + power arc + wind-adjusted landing)
> and its textured, lit 3D look.

---

## What exists today

Three modes behind the "Golf" chiclet in the Games hub:

- **Mini-Golf (putting)** — top-down/angled 3D hole; drag-to-putt; sink the cup;
  par/stroke scoring. Now a REAL mini-put engine: `puttSim.ts` runs
  slope-coupled Coulomb physics on a per-hole slope FIELD (`puttField.ts` —
  tilt planes, ramps, undulation) reusing `greenPhysics.ts`'s functions at
  mini-scale, so putts BREAK, ramps check/feed the ball, and banked rails
  (`Wall.bank`) run the ball along the rail. Holes are pure DATA validated
  against the physics invariants (`puttCourses/`, default `garden.ts` = 8 slope
  holes). `PuttGL.tsx` renders the green as a DISPLACED BufferGeometry sampled
  from `puttHeightAt` (see-what-you-play: the ball rides the surface, ramps rise,
  banked rails read as leaned amber rails), model-driven camera frame, shared
  scenery kit. HUD (`GolfGame.tsx`) drives off the course's actual hole count.
  Phase-2 STUBS present but not wired: moving obstacles + hazards physics + a
  course picker.
- **Course · Hole 1 (beta)** — a full terrain-aware hole (tee → fairway → green
  → cup) on `courseSim.ts` + `CourseGL.tsx`; slingshot aim/power, tap-timing,
  camera-follow, a predicted aim arc, and a real Coulomb-friction putting green
  that reliably HOLES an on-line putt (elliptic cup capture, no pin collision).
  The green is clean (no on-turf slope overlay); the aim line + cup reticle pulse
  gold/green when the current putt will drop. Persisted best-shot records. The
  hole is fully DATA-driven (`CourseHole`) so holes 2–9 are pure data — see the
  "HOW TO AUTHOR A HOLE" contract header in `terrain.ts`. See roadmap step 3.
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
- **Best-shot records (course).** A per-user `golf_records` table (migration
  `0007_golf_records.sql`, in both `schema.sql` and the numbered file) backs
  `GET`/`POST /game/golf-records` — upsert-on-improve (MAX longest drive, MAX
  longest holed putt, MIN closest-to-pin). `CourseSim` computes the per-hole
  metrics via a single `recordShot()` off `stop()` (shared by live fire,
  `simulateShot`, `simulatePutt`): longest drive = the first full swing's total
  (an OB/water opener doesn't lock it — the replay does); closest-to-pin = min
  rest `distToPin` among non-holing, non-water/OB, NON-PUTT shots; longest putt =
  a putt that holes out. `CourseGame.tsx` shows this hole's numbers plus
  persisted bests with a "New best!" badge; the `api.ts` client
  (`getGolfRecords`/`postGolfRecords`) is seeded on mount and refreshed from the
  POST read-after-write (survives offline/401).

### Key files
| Area | Path |
|---|---|
| Shared scene kit (turf/sky/fog) | `packages/relay-ui/src/lib/golf/scenery.ts` |
| Instanced scatter primitive (shared kit; batcher + impostor quads) | `packages/relay-ui/src/lib/scene3d/instancing.ts` |
| The tree grove — shared by Course + Range, 3 draw calls; per-hole blossom rides the same batch | `packages/relay-ui/src/components/golf/scene/foliage.ts` |
| Shared WATER (level geometry, Gerstner waves, Fresnel + sky/planar reflection, foam, splash, wet bank, reeds, quality tiers) | `packages/relay-ui/src/lib/golf/water.ts` |
| Headless screenshot harness | `packages/relay-ui/scripts/shoot-golf.mjs` + `golfpreview.html` + `src/golfpreview.tsx` |
| Quality tier POLICY (shared kit) + GPU instrumentation | `packages/relay-ui/src/lib/scene3d/quality.ts`, `stats.ts` |
| Procedural sky IBL (shared kit): equirect painter + PMREM | `packages/relay-ui/src/lib/scene3d/env.ts` |
| Golf's sky palette + `scene.environment` wiring + the hemi cut | `packages/relay-ui/src/components/golf/scene/env.ts` |
| Bunker sand: albedo + normal + roughness off one height field | `packages/relay-ui/src/components/golf/scene/sand.ts` |
| Golf's per-scene budget table + `?quality=`/`?shadow=` | `packages/relay-ui/src/components/golf/scene/quality.ts` |
| Committed GPU ceilings + the shared harness reporter | `packages/relay-ui/scripts/budgets.golf.json`, `scripts/lib/shoot-report.mjs` |
| Range physics/sim (headless) | `packages/relay-ui/src/lib/golf/rangeSim.ts` |
| Sim tests / harness | `packages/relay-ui/src/lib/golf/rangeSim.test.ts` |
| Range 3D scene (Three.js) | `packages/relay-ui/src/components/golf/RangeGL.tsx` |
| Range HUD + controls + telemetry + layout picker | `packages/relay-ui/src/components/golf/RangeGame.tsx` |
| Layouts, pins, `surfaceAt` | `packages/relay-ui/src/lib/golf/rangeTargets.ts` |
| Club ladder | `packages/relay-ui/src/lib/golf/clubs.ts` |
| Course terrain data + "HOW TO AUTHOR A HOLE" contract (`heightAt`/`gradientAt`/`surfaceAt`; `TEE_R`/`corridorHalfAt`/`greenPadRadius`; organic edges `edgeNoise`/`edgeRadius`/`featureSeed` + `EDGE_WOBBLE`/`maxGreenPadRadius`; render-only `corridorEdgeDist` first-cut helper; optional render-only `bloom` flowering canopy) | `packages/relay-ui/src/lib/golf/terrain.ts`, `courseData.ts` |
| Course sim (terrain-aware; `snapshot`/`restore`/`predict`; putt power/speed; records) | `packages/relay-ui/src/lib/golf/courseSim.ts` |
| Green + putting physics (Stimp → μ, roll-out, elliptic cup capture, BALL_R/CUP_R scale) | `packages/relay-ui/src/lib/golf/greenPhysics.ts` |
| Course 3D scene (Three.js) — baked surface map, aim-holing pulse; `buildOrganicDisc`/`buildOrganicAnnulus` draw the green cap, fringe collar, bunkers and terrain-following water from the model's `edgeRadius`+`featureSeed`; long-grass rough, a crisp `corridorEdgeDist` first-cut band (uniform mown collar framed by dark mow lines), textured tee (`makeTeeTurf`); all textures seeded (`mulberry32`) | `packages/relay-ui/src/components/golf/CourseGL.tsx` |
| Course HUD + records recap | `packages/relay-ui/src/components/golf/CourseGame.tsx` |
| Putting sim / scene / round | `src/lib/golf/puttSim.ts`, `components/golf/PuttGL.tsx`, `GolfGame.tsx` |
| Ball material (dimple normal map) | `packages/relay-ui/src/lib/golf/ballTexture.ts` |
| Hub wiring | `packages/relay-ui/src/routes/Games.tsx`, `components/golf/GolfMenu.tsx` |
| Worker leaderboard + best-shot records | `packages/relay-worker/src/games.ts` (migration `0007_golf_records.sql`) |
| Best-shot records API client | `packages/relay-ui/src/lib/api.ts` (`getGolfRecords`/`postGolfRecords`) |

### Commands
- `pnpm --filter @relay/ui test` — the golf sim harness (dynamics tables).
- `pnpm --filter @relay/ui shoot:golf` — headless screenshots of every scene AND
  the numeric GPU gate (draw calls / triangles vs `scripts/budgets.golf.json`;
  non-zero exit on a regression).
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
   stays a lazy chunk. **Not yet:** post-process bloom (rejected outright in
   `/GRAPHICS.md` §3 — an `EffectComposer` render target is 46 MB at phone size),
   billboard tree sprites. **→ Also done (second pass):** scene-wide IBL and real
   sand — see "Scene-wide IBL, and real sand" below.
   Tune light intensity/exposure against device screenshots next.
   **Gotcha (learned the hard way):** a 2048² shadow map once crashed the
   WebView GPU process on real Android (black screen, needs an app restart)
   though it rendered fine in desktop/software GL, so it was reverted to 1024².
   It was then **re-enabled to 2048² by request**, with a standing requirement to
   re-verify on a low-end Android that never happened. **→ Now resolved by a
   tier:** Course and Range run the 1536² this doc itself nominated as the first
   dial to turn down, Putt keeps its 1024², and `?shadow=2048` reproduces the
   crashing configuration on a handset without a rebuild. See "Quality tiers, GPU
   numbers and the shadow map" below. Test GPU-cost changes on a low-end device,
   not just the headless screenshot harness.
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
   max), a putt-read break arrow on the green (fall line from `slopeUnder()` —
   later REMOVED in the green overhaul below; the HUD break text stays),
   and **textures**: a mow-stripe turf map on the ground, sand-grain caps on the
   bunkers, and a drifting ripple normal on the water. The strike/accuracy bar
   was kept (the user likes it); verified headless
   (aiming shows the arc + dispersion + power meter).
   **→ Also done — arc fix + shared-physics refactor:** the predicted aim arc was
   invisible on the SECOND+ aim — the aim-aid BufferGeometry's cached
   `boundingSphere` went stale and three.js frustum-culled the arc BEFORE drawing
   (that's why the earlier dots-vs-lines, depthTest and renderOrder patches all
   failed — they act AFTER culling). Fix: `frustumCulled = false` on all six
   aim-aid objects in `CourseGL` (parity with `RangeGL`, which already did this —
   why the Range never hit the bug), and `ARC_MAX` raised 700→2048 (long shots
   were being truncated). Refactor: `CourseSim.predict()` no longer hand-copies 13
   fields — it uses a `snapshot()`/`restore()` pair over a full `CourseSnapshot`
   plain-data struct and dry-runs the REAL swing/substep pipeline, so prediction
   and the live shot are one integrator over one state. A guard test dumps ALL own
   data props independently of `snapshot()` and asserts byte-identical state after
   `predict()`, so it fails loudly if a new field is forgotten.
   **⚠ RULE:** any new MUTABLE `CourseSim` field MUST be added to `CourseSnapshot`
   + `snapshot()` + `restore()`, or the guard test fails.
   **→ Also done — green + putting engine (v1):** new shared pure-math module
   `lib/golf/greenPhysics.ts` (no `three`, no sim state): Stimpmeter green speed →
   friction (μ = 0.611/stimp, `GREEN_STIMP=10`), roll-out `d=v²/(2a)`, and
   speed-dependent cup capture. `courseSim` green/fringe roll uses this Coulomb
   model (constant decel → a putt BREAKS more as it slows, emergent); off-green
   surfaces keep the tuned run-out so the club ladder is unchanged.
   **⚠ GREEN DESIGN GUARD:** a resting putt can only hold where slope ≲ μ (~6.1%
   at stimp 10) — keep future green tilt under that, or raise stimp/μ in lockstep.
   **→ Also done — ONE static-friction rest rule (fixes "ball rolls slowly forever
   on a hill"):** a slow ball on a slope used to sit on the KINETIC angle-of-repose
   contour (where `slopeAccel == frictionFor(surf)`) and creep downhill forever,
   re-accelerated each grounded substep, because the rest gate compared the slope
   against the KINETIC hold (so a slope a hair steeper never let it settle — only
   the 100000-step safety guard, ~833 s, ever stopped it). `courseSim.substep` now
   rests on EVERY grounded surface (green/fringe/fairway/rough/bunker/tee/cartpath)
   by ONE rule: `speed ≤ restSpeed(surf) AND |slopeAccel| ≤ staticHold(surf)`. The
   hold is STATIC friction — `frictionFor(surf)·STATIC_HOLD_FACTOR` (1.3) off the
   green — so a ball rolls to the kinetic-repose contour and STATIC friction then
   HOLDS it (rest is set, play advances); only a genuinely steep slope (slopeAccel
   above the static hold) keeps rolling. On the green/fringe the static hold IS the
   Stimpmeter μ·g (`greenDecel`, static == kinetic BY the green design guard above),
   so the putt-rest and the fairway/rough-rest are now the SAME rule — break/holing
   unchanged. All module consts (no new mutable `CourseSim` field → snapshot guard
   untouched); tuned/proved against the vitest harness (`courseSim.test.ts`).
   **→ Also done — course/green OVERHAUL (3 phases; the earlier bold slope-read
   overlay was REMOVED):**
   • **Phase 1 — scalable surface model (`terrain.ts`).** A hole is now fully
     data-driven via `CourseHole` with a documented "HOW TO AUTHOR A HOLE"
     contract header IN `terrain.ts` (centerline, `fairwayHalf` + optional
     `fairwayTaper`, `roughHalf`/OB, `green{r,raise,tiltPct,tiltDir,undulation}`,
     `fringeW` collar, `hazards[]`, `cartPath`, `terrain`, `wind`). `surfaceAt()`
     precedence is strict — green > fringe > bunker/water > cartpath > tee >
     fairway > rough > ob — so a hazard never touches the putting surface;
     `heightAt()` makes the green plateau span green+fringe (flush collar). New
     exports `TEE_R`, `corridorHalfAt`, `greenPadRadius`. Invariants (pin inside
     green; hazards outside `greenPadRadius`; green slope ≲ μ) are stated in the
     header — treat THAT as the source of truth for authoring holes 2–9 / new
     courses as pure data.
   • **Phase 2 — putting physics + scale (`courseSim.ts`, `greenPhysics.ts`).**
     Ball/cup scale is one source of truth: `BALL_R=0.2`, `CUP_R=0.5` (ratio 0.4,
     a real ball/cup). Cup capture uses an ELLIPTIC effective-radius falloff
     (`r_eff = cupR·√(1−(speed/limit)²)`) so an on-line putt at holing pace
     reliably DROPS — the old "bounces off the pin" was actually capture failing
     (there is NO pin collision). A putt-specific power model `puttSpeedForPower`
     maps drag QUADRATICALLY (`speed = MIN + (MAX−MIN)·power²`) with a low
     `PUTT_MIN_SPEED` so short putts are controllable (a dead tap rolls ~1.5 ft).
     `predict()` reports `result==='holed'` for an on-line putt.
   • **Phase 3 — rendering (`CourseGL.tsx`).** A baked top-down albedo surface map
     (`makeSurfaceMap` via `surfaceAt`) drives distinct materials: bold-contrast
     fairway mow stripes, darker/coarser rough at the edges, a cart path; a
     distinct terrain-following FRINGE collar annulus (`green.r`→`greenPadRadius`)
     so the green never abuts sand/water; a textured (seeded, deterministic grain)
     green cap; and the ball SEATED at `b.h+BALL_R` with a contact-shadow disc (no
     float). The on-green fall-line arrows + contour grid + slope heat tint were
     REMOVED (clean green; the HUD "downhill · breaks left" text stays). New aim
     cue: the predicted aim line + cup reticle PULSE gold/green when
     `predict(0).result==='holed'` (replacing the arrows). The scene frame is
     DERIVED from the hole (centerline + roughHalf + tee/pin extent) so ANY hole
     renders fully — part of the scalability story.
   **→ Also done — natural terrain (organic outlines + first cut + long-grass
   rough + tee texture; 2 phases):**
   • **Phase 1 — organic feature outlines (model, `terrain.ts`).** Bunkers,
     ponds, the green and its fringe collar no longer have circular outlines: a
     shared deterministic edge-noise `edgeNoise(seed, angle)` +
     `edgeRadius(seed, angle, baseR)` (default ±`EDGE_WOBBLE`=15%) perturbs each
     feature's radius by a smooth, seeded, 2π-periodic wobble, with a per-feature
     `featureSeed(d, x)` (green + fringe SHARE the green's seed so the collar
     nests). `surfaceAt()` and `heightAt()` both call it, so the classified/played
     AND the baked-rendered outlines are organic for ANY hole — the green interior
     (tilt/undulation → break) is unchanged; only the EDGES wobble. The authoring
     invariants gained a matching `(1+EDGE_WOBBLE)` margin: the pin sits inside the
     MIN (wobbled-in) green radius, and a hazard clears the green's MAX wobbled
     fringe pad (`maxGreenPadRadius`; new export). The `terrain.ts` contract header
     is the source of truth and now documents organic edges.
   • **Phase 2 — rendering (`CourseGL.tsx`).** `buildOrganicDisc`/
     `buildOrganicAnnulus` draw the green cap, fringe collar, bunkers and water
     from the SAME `edgeRadius`+`featureSeed`+angle convention as the model, so
     drawn == played == baked (see-what-you-play), all model-driven (scales to any
     hole). Water is now a terrain-FOLLOWING organic disc (`heightAt` per vertex)
     that covers its full footprint — fixing a dark-crescent/faceted-seam bug where
     a flat water plane let the higher downrange basin rim poke through. Rough is
     retextured to read as long grass (stretched/warped streak noise); a smooth
     "first cut" is a crisp, narrow fairway↔rough band (a uniform mown collar
     framed by dark mow lines at each seam) via the read-only `corridorEdgeDist`
     helper (render-only — physics classification is UNCHANGED);
     the tee box is textured (`makeTeeTurf`). All scene textures are seeded
     (`mulberry32`, no `Math.random`) for deterministic screenshots.
   • **Terminology:** the fairway↔rough intermediate is the "first cut"; the
     "fringe" is the collar around the green.
   **→ Also done — best-shot records:** `golf_records` D1 table (migration
   `0007`) + `GET`/`POST /game/golf-records` in `games.ts`, tracked by
   `CourseSim.recordShot()` and shown in the `CourseGame` recap. See "Best-shot
   records (course)" above.
   **→ Also done — regression harness:** a permanent `secondAim` scene in
   `scripts/shoot-golf.mjs` drives TWO real rendered aims with a fire between them
   — the only sequence that reproduces the frustum-cull class (the old single-aim
   harness couldn't). Run: `pnpm --filter @relay/ui shoot:golf secondAim`.
   80 UI golf tests pass across 5 files (range 15, courseData 14, courseSim 31,
   terrain 13, greenPhysics 7); worker `games.test.ts` grew golf-records coverage.
   **Next:** author the remaining holes 2–9 as pure data per the `terrain.ts`
   contract header, and consolidate Mini-Golf (`puttSim`/`PuttGL`) onto a real
   heightfield so it can share `greenPhysics` (today it stays a separate flat
   engine) — pending on-device feel feedback.

**Working principle going forward:** tune against the **harness** and **device
telemetry**, not guesses — that's why both exist.

---

## Rendering, the shared scene kit, and visual QA

The Course and Range 3D scenes drifted — the Range grew rich lit turf, a cloud
sky and a two-species tree grove while the Course stayed on flat paint. The
shared ingredients now live in **`lib/golf/scenery.ts`** (turf colour + normal,
sky dome, fog) and BOTH `CourseGL` and `RangeGL` import them, so a
look change happens once. The **tree grove** is shared the same way but lives in
**`components/golf/scene/foliage.ts`** — it moved there when it was instanced,
because an `InstancedMesh` needs its count up front and so cannot be a pair of
`add…()` calls that each drop a `Group` into the scene. Same rule applies: change
the trees THERE, not per-scene. The Course terrain is multi-surface (per-vertex
`SURFACE_RGB`), so it uses `makeTurfColor('neutral')` — a near-white luminance
detail that MULTIPLIES the vertex colour (keeping each lie's hue while adding
mown texture); the Range bakes `'green'`. `three` stays lazy: `scenery.ts` is
only imported by the already `lazy()`-loaded `*GL.tsx`.

**Shared water (`lib/golf/water.ts`).** Water is single-sourced across all
three scenes — Course, Range and Putt attach ONE material to their own geometry
and never make look/behaviour decisions of their own. It replaced a
`MeshStandardMaterial` with a mottled colour map that read as "a blue lid",
for four compounding reasons worth remembering:

1. **The Course surface followed the dished terrain**, so it was a *bowl*.
   Water is the one surface in the world that is exactly level, and a curved one
   reads as tinted ground instantly.
2. **Nothing reflected.** No env map, and `scene.environment` is deliberately
   unset — yet at golf camera angles real water is mostly mirror.
3. **One opacity and one colour edge to edge** — no Fresnel, no depth.
4. **The ripple repeats were baked into the shared texture**, so the Range's
   150 yd plane and the Course's ~26 yd pond got the same anisotropic tile,
   which combed the wave trains into horizontal stripes.

What it does now:

- **Level surfaces with per-vertex depth.** Geometry carries an `aDepth`
  attribute (yards of water above the bed); the shader discards where it is ≤ 0,
  so the visible waterline is where the level plane meets the rising bank — a
  terrain-derived shoreline that cannot disagree with the outline `surfaceAt`
  classifies. The old painted shoreline annulus is gone.
- **`heightAt` grades a WATER PAD** (`terrain.ts`) exactly like the green pad:
  hills AND the tee→green grade are erased inside a water hazard's outline and
  ramped back over a skirt, so the basin rim is one height all the way round.
  Without it a level plane is impossible — measured rim spread on this course's
  ponds was 1.3–2.7 yd against a 2.2 yd basin. `waterLevelAt(hole, hz)` is the
  single source for the waterline. **Bunkers are excluded** — sand genuinely
  follows the ground it sits in.
- **Gerstner waves** in the vertex shader with analytic normals, so crests
  actually travel. Steepness is DERIVED from amplitude (`k·a`) — passing both
  separately once left the surface geometrically calm but *shaded* as heavy
  chop, which mottled the pond like static.
- **Fresnel + reflection**: the sky gradient always (the same
  `makeSkyGradientTexture` that feeds the ball's PMREM, so the pond and the sky
  dome can't drift), and on the `high` tier a true planar reflection.
- **Wind-driven**: wave direction, amplitude, wavelength and whitecaps come from
  the hole wind, via the same `windMph`/`windBearing` the HUD's WindChip reads.
- **`makeWaterFX`**: the droplet crown + expanding ripple rings, seeded so
  screenshots are stable. This existed only in the Range; the Course played a
  splash SOUND and drew nothing, and Putt had neither.

**Shoreline (`makeWetBankMaterial` / `makeReeds`).** Two features that live on
the water's EDGE rather than its surface, and between them do as much for the
illusion as the shader does:

- **Wet bank** — a dark, low-roughness overlay revealed by per-vertex alpha
  (`attachBankWetness`), straddling the waterline. It is what makes the water
  look like it TOUCHES the land instead of sitting on top of it. Height above
  the waterline alone is NOT enough to place it: the water pad grades the
  surround level, so ground stays within inches of the waterline for yards
  outward and a purely height-driven band floods the whole shoulder. Multiply
  the shared height profile (`bankWetnessFromHeight`) by a horizontal falloff
  from the shore — smoothstepped, or the band's outer edge reads as a drawn
  outline.
- **Reeds** — clumped tufts of cattails at the margin. A pond's outline is the
  most artificial thing left in frame once the surface reads right; reeds break
  that curve and, being tall, give the water something to be *behind*. Blades
  and cattail heads bake into ONE merged geometry per belt (one draw call, both
  coloured per vertex) and sway in the vertex shader — injected into a standard
  material via `onBeforeCompile`, so they keep the scene's lighting, shadows and
  fog — off the SAME wind that drives the waves. Placement clumps deliberately:
  an evenly-spaced ring reads as landscaping and walls the pond off from the
  player. The Course finds its shoreline by BISECTING the terrain (the basin
  dishes, so height rises monotonically outward) rather than assuming a radius,
  so any basin profile works; Putt uses the rectangular variants
  (`makeWetBankRect` / `reedRectAnchors`). The Range lake's only shoreline is
  the distant fence line, so it takes neither.

**Quality tiers.** `pickWaterQuality(renderer)` returns `high | medium | low`,
overridable with **`?water=high|medium|low`** on the preview page so the extra
pass can be checked on a real handset without a rebuild. Only `high` adds the
Tier 3 planar reflection — a SECOND full scene render per frame — so it is
gated behind GPU/CPU headroom. Everything below it costs no more than an
ordinary material and still gets level water, Fresnel, moving crests and foam.

**Gotchas that cost real time here:**
- Clipping the reflection at the waterline via `renderer.clippingPlanes` flips
  the renderer's plane COUNT every frame, and three rebuilds *every* material's
  program when that count changes — a full shader recompile per frame. Use an
  **oblique near plane** on the reflection camera instead (it is inside the
  projection matrix, and free).
- Render the reflection pass with **tone mapping OFF into a LINEAR target**, or
  it is tone-mapped once into the target and again by the water shader and comes
  out visibly grey.
- A **flat-bedded** pond (the Range lake, a Putt board) floats inches above its
  bed, so an unclamped wave trough drops *through* it and the ground punches up
  in a marbled pattern. Pass `clearance` — the shader clamps the trough.
- A hazard basin is a **raised cosine**, so its shoulders are nearly flat at the
  rim: dropping the waterline even a quarter-yard pulls the shore a long way
  inward and leaves a crater. `WATER_LIP` is 0.05 for a reason.
- Three's `<fog_vertex>` chunk reads a varying named **`mvPosition`** — name the
  view-space position that or the shader silently fails to compile, three logs to
  `console.error` (NOT `pageerror`) and skips the mesh, so the scene renders
  minus the water and looks plausibly fine. `shoot-golf.mjs` now captures
  console errors for exactly this reason.

**Quality tiers, GPU numbers and the shadow map.** Golf had no quality tiering,
no frame-time probe and no GPU instrumentation at all: `shoot-baseball.mjs`
printed draw calls / triangles / programs / geometries / textures per scene while
`shoot-golf.mjs` printed nothing numeric — and golf is the bigger, shipped scene.
Everything on the fidelity roadmap adds GPU cost, so the measurement had to come
first. Three pieces, all in `/GRAPHICS.md` §4's terms:

- **The policy is shared, the numbers are not.** `lib/scene3d/quality.ts`
  (`pickSceneQuality`) implements **default DOWN, promote only on measured
  evidence**; golf's own table lives in `components/golf/scene/quality.ts`. The
  only automatic decisions step DOWN — a WebGL1 context, `maxTextureSize < 4096`,
  a fragment precision below `highp`. `high` is unreachable without an explicit
  `?quality=high`; it exists to be forced on a handset, not handed out.
  ⚠ Do **not** copy `water.ts`'s `pickWaterQuality`, which promotes on
  `cores > 4 && maxTextureSize >= 8192` — a typical mid-range Android satisfies
  that, so the tier meant to be gated behind headroom is what most phones get.
- **⚠ A tier may never RAISE a scene's cost, so the sizes are PER SCENE.** The
  obvious version of this change was "default 1536² everywhere". That reads as a
  step down because two of the three scenes were at 2048² — but `PuttGL` was
  already at **1024²**, and a flat default would have made a currently-safe scene
  2.25× more expensive in shadow-map memory. **Course and Range: 2048² → 1536².
  Putt: stays 1024². `low` drops the shadow pass entirely.** `high` does not
  raise the map in any scene. `quality.test.ts` asserts no tier of any scene
  exceeds what that scene ships, and that every dial is monotonic across tiers.
- **The knobs, for the on-device bisect that is still owed:**
  **`?quality=low|medium|high`** and **`?shadow=1024|1536|2048`** (an allowlist —
  a fat-fingered value falls back to the tier). `?shadow=` is deliberately
  allowed to go UP: reproducing the exact configuration that crashed is half of
  bisecting it. Both are read by the scenes themselves, so the app and the
  preview take the identical code path, and `shoot-golf.mjs --query=shadow=2048`
  shoots the whole matrix at a forced knob.
- **Numbers, printed and enforced.** Each scene calls an `onStats` prop every
  ~30 frames with `renderer.info` plus the resolved tier and its reason;
  `golfpreview.tsx` publishes it as `window.__golfStats` (readable straight off a
  handset's console). `shoot-golf.mjs` prints a GPU line per scene and checks it
  against the committed **`scripts/budgets.golf.json`**, exiting non-zero on a
  regression; the reporter itself is game-neutral (`scripts/lib/shoot-report.mjs`)
  so baseball can adopt it. Regenerate a baseline explicitly with
  `--update-budgets` — never automatically, or the gate rewrites its own
  thresholds when they fail. Baselines from the committed run: **Course scenes
  24–50 draw calls / 59k–119k triangles, Range 89–110 / 15k–23k, Mini-Golf
  27–38 / 11k (94k on `putt-water`)**.
  ⚠ **1,034 draw calls on the tee view of Hole 1 WAS the standout finding** — an
  order of magnitude above the whole baseball stadium. It is now **41**: the cause
  was un-instanced foliage, see "Instanced foliage" below. The ceilings were
  re-baselined DOWN in the same change. Tightening a ceiling after a measured win
  is correct, and is the opposite of the rule against regenerating one because it
  failed.
- ⚠ **Worked example of the blind spot: scene IBL cost ZERO draw calls.** Turning
  on `scene.environment` measured identical draw calls and identical triangles on
  all six compared scenes — only `textures` moved, +2. That number is true and it
  is misleading. Setting `scene.environment` adds a **cubeUV sample to every lit
  fragment** at medium/high, which is pure fill rate and is invisible to
  `renderer.info`. On a full-screen turf scene that is most of the frame, and it
  is precisely the cost the original ball-only `envMap` decision was written to
  avoid ("so turf/trees/water pay no per-frame env cost"). SwiftShader is software
  GL and cannot speak to it. **Get a frame-time reading on a low-end Android
  before trusting `medium` here** — same handset that lost its GPU process to the
  2048² shadow map. `?quality=low` is the mitigation and is untouched by the IBL
  change, which is the right shape if it turns out to be needed.
- **What these numbers cannot see.** They count what the CPU SUBMITTED. Fill
  rate, VRAM and shadow-map size — the class of cost that actually killed the
  WebView GPU process — are invisible to them, and to SwiftShader. A green budget
  is not evidence of on-device safety.
- **The frame-time probe exists but does not feed the tier.** `stats.ts`
  `makeFrameProbe` reports a median (never a mean — a phone's outliers are free)
  and it rides along in the stats payload. It is deliberately NOT wired into
  promotion: the median arrives after the scene is built, so promoting on it
  would mean persisting a verdict across sessions, and persisted cross-run state
  would make the screenshot harness's tier depend on a previous run. The bar a
  future promotion must clear is written down in `quality.ts`'s header (≤20 ms
  median over ≥300 settled frames at `medium`, twice, same device+scene). The
  probe's value is also kept OUT of the harness printout, because it is
  wall-clock and would make an unchanged run print differently twice.

**The 1536² tier was visually verified, and it is free.** `golf-visual-qa` shot
the six shadow-carrying scenes at 1536² and again at `--query=shadow=2048`, after
first establishing a noise floor by shooting 1536² twice (`meanAbs 0.000`,
`max 0` on five of six). Verdict: **no visible loss.** Worst scene is
`course-approach` at `meanAbs 0.087` / 32 of 920 tiles; the frames are
indistinguishable at 1:1 and need 3–4× zoom before the 1536² penumbra shows a
fraction more dither.

The reason is structural and worth keeping: the Course shadow camera is
**640 × 680 world units**, i.e. 0.42 units/texel at 1536² against 0.31 at 2048².
`BALL_R` is **0.2** — the ball's shadow is **sub-texel at both sizes**. Ball
seating never came from the shadow map; `CourseGL` draws an explicit soft contact
disc for exactly that. So 2048² was paying 2.25× the memory for detail the shadow
frustum cannot resolve.

⚠ Two caveats. This is SwiftShader: it removes the *visual* objection to 1536²,
it says nothing about whether 1536² still trips the WebView GPU process, so the
on-device smoke test stays open. And `?shadow=` is applied **globally to every
scene**, so Putt is NOT a control in a forced run — it gets pushed 1024² → 2048²
too and will legitimately differ.

**Defects the visual gate found (open — none are regressions, all pre-date the
tier work).** Recorded here because a subagent's report is not a tracker. Owner
for all four: `golf`.

**Defects 1 and 2 below are FIXED** (see "Instanced foliage" for the numbers);
3, 4 and 5 are still open. The text is kept because the *diagnosis* of #2 turned
out to be wrong in an instructive way.

1. ~~**`course-celebrate`'s camera is degenerate.**~~ **FIXED.** The frame is a straight-down
   extreme close-up of the cup — no sky, no horizon, no stripes, no trees — and
   the ball reads as a flat hexagon because you are looking at the sphere's pole
   cap, where the dimple normal map collapses into facets. It is useless as a QA
   frame, and provably so: it was the ONE scene byte-identical between 1536² and
   2048², because nothing in it casts a resolvable shadow. **The cause is not the
   `back = max(6, min(11, R*0.5+5))` distance** (a plausible-looking suspect that
   turns out to be irrelevant) — it is `CourseGL.tsx:2609`
   `tmpDir.subVectors(pinV, tmpB).setY(0).normalize()`. With the ball in the cup
   `pinV - tmpB` is the zero vector, three's `normalize()` returns `(0,0,0)`, and
   `desiredPos = ball + 0*back` collapses the camera onto the ball before lifting
   it 3.5 units and looking down. The two in-flight branches just above (~2588,
   ~2600) both guard this with `if (tmpDir.lengthSq() < 1e-4)`; **this branch is
   simply missing the guard.** One-line fix: fall back to the last aim direction.
   → **Done**, falling back to `aimDir()` — the aimed line, which is where the
   player was looking when the putt dropped. The frame is now sky + horizon +
   rough band + green + cup + flagstick + confetti, i.e. a useful QA frame. It is
   also the one scene whose before/after diff is ~100% of pixels, by design.
2. **`putt-water` drew 187,010 triangles**, 17× every other putt scene, on the
   board that should be the cheapest thing golf ships. `PuttGL.tsx:555` calls
   `makeWaterPlane(rw, rh, PUTT_WATER_DEPTH, 0.12, 1.4)`; at 0.12 board-units per
   segment a mini-golf pond saturates `makeWaterPlane`'s 160-segment clamp on
   BOTH axes — 160×160 quads = 51,200 triangles for one rectangle, again per
   shadow and reflection pass. It buys nothing: the gate reports a flat blue
   rectangle with no geometric wave relief (amplitude 0.09 units under a
   near-overhead camera), and the 1.4-unit shoreline fade does not read either.
   `ydPerSegment ≈ 0.6` should cut ~40k triangles per pass invisibly. The budget
   entry carries a `_bug` note so the ceiling is not mistaken for approval.
   → **Half done, and THE DIAGNOSIS ABOVE WAS WRONG in an instructive way.**
   `ydPerSegment` 0.12 → 0.6 is in, and it saved exactly the predicted 41,900 —
   but that left **145,110**, so the water plane was never the bulk. Ablating the
   scene in the harness (rendering it with the bank off, the reeds off, and both
   off) found the real cost: **`water.ts` `makeWetBankRect` was 115,600 of the
   187,010.** It computed `seg = Math.round(Math.max(w, d) / 0.35)` and passed
   that to BOTH axes of the `PlaneGeometry`, so the 30×56 tide pool got the LONG
   side's 170 segments across its 32-unit SHORT side — 0.19 units per segment on
   an axis the function itself asks for 0.35 on. 170×170 quads = 57,800 triangles,
   submitted twice. Fixed per-axis (`segW`/`segD`; same intended density, now
   actually applied), saving another 51,000 → **94,110**.
   **What remains (~64,600) is a SHAPE problem, not a density one** and is
   deliberately NOT fixed here: the wet bank is a full plane that tessellates a
   30×56 *interior* at uniform alpha in order to draw a 1.1-unit band around its
   *border*. It wants to be a ring. That changes shared water geometry and needs
   its own visual gate. The `_bug` note was therefore **rewritten, not removed** —
   94k is still 9× every other putt scene.
   *Lesson worth keeping: the harness can ablate. Rendering a scene with one
   object removed costs one 30-second run and beats arithmetic about which mesh is
   expensive.*
3. **The tee peg pokes through the top of the ball** (`course-hole1`, visible at
   10×). `LIFT = 0.05` + `pegH = 0.42` puts the peg top at ground + 0.47, while
   `BALL_R = 0.2` puts the ball crown at ground + 0.40 — a 0.07-unit overshoot.
4. **The flagstick casts no readable shadow on the green — at 2048² either.** The
   sun at `(-160, 260, 120)` is high and behind-left, so the pole's shadow is
   short and self-occluded from the green camera. If a crisp flagstick contact
   shadow is wanted, the lever is the sun angle or a contact disc at the pole
   base; it was never shadow-map resolution.
5. **No harness frame shows a Course bunker properly.** Counting warm-beige
   pixels across all 25 scenes: `putt-sand` has 10,962, `putt-bank-rail` 6,847
   and `course-aim-iron` 3,929 — every other scene has effectively none. So the
   one thing golf's own visual gate cannot review is sand, which is why the sand
   work below had to be judged from a 2× crop of a single frame. A dedicated
   greenside-bunker view is cheap and belongs in `SCENES`.
6. ~~**The Augusta flowering holes render no blossom at all.**~~ **FIXED — see
   "Blossom" below.** Counting pink pixels
   across `augusta-2-pink-dogwood`, `augusta-13-azalea` and `augusta-16-redbud`:
   **zero, in every one** — and identically zero before and after the instancing
   change, so this is content that was never built, not something that broke.
   Three holes are named for flowers the renderer does not draw, and the grove on
   all three is plain green. This is the clearest single example of the thesis in
   `/GRAPHICS.md`: the gap is **content**, not the renderer. A per-species blossom
   tint on the existing instanced canopy is now nearly free — `foliage.ts` already
   carries per-instance colour, so the whole cost is choosing which trees bloom.
   → **Done.** The three scenes now measure **13,926 / 14,642 / 31,308** pink
   pixels (0.97% / 1.02% / 2.17% of frame) at **exactly the same draw calls**.
7. **The hole-out frame does not actually show the ball.** Now that
   `course-celebrate`'s camera is fixed (defect 1), the frame is legible — sky,
   horizon, rough, green, cup, flagstick, confetti — but the fallback direction
   puts the **flagstick directly between the camera and the ball**, leaving two
   ~2 px wedges visible at 10×. Defensible, since a holed ball is at the bottom of
   the cup, but the one frame whose job is to evidence "ball in cup" does not.
   Nudging the fallback azimuth off the pin axis would fix it.
8. **Confetti reads as stuck pixels.** Sparse, low-alpha, axis-aligned, unrotated
   flat squares that blend into the green. Pre-existing and untouched by any of
   this work — but **nobody had ever seen it**, because until defect 1 was fixed
   the celebration camera pointed straight down at the ball's pole cap.

**Instanced foliage — the single largest GPU win measured on this codebase.**
The tee view's 1,034 draw calls were **559 individual meshes of tree**. There was
no `InstancedMesh` anywhere in the golf render path; `scenery.ts` `createTreeKit`
built a `Group` per tree — one trunk plus five-to-seven leaf blobs for a
broadleaf, one trunk plus four-to-five cone tiers for a pine — and Hole 1 plants
92 trees. With every caster submitted a second time for the shadow map that is
1,118 submissions, which is the measured number minus frustum culling. It was not
a batching failure; it was un-instanced foliage doing exactly what it was written
to do.

- **`lib/scene3d/instancing.ts` (shared kit).** Collect a transform and an
  optional per-instance tint per prop, commit **one `InstancedMesh` per distinct
  geometry**. Two-phase because an `InstancedMesh` needs its count up front. Also
  ships `makeImpostorQuads` (N crossed quads, one indexed geometry, atlas-cell
  UVs) for a future far band. No RNG in the module by design — placement jitter is
  the caller's, and must stay seeded. Game-neutral: a stadium crowd is the same
  primitive, and baseball can take it as-is.
- **`components/golf/scene/foliage.ts` (golf's consumer).** `buildGrove(scene,
  track, placements)` — it takes the whole list rather than handing back an
  `add…()` pair, because a builder you have to remember to `commit()` is one
  somebody will forget, leaving a treeless course that typechecks. Both `CourseGL`
  and `RangeGL` call it, so the grove is still ONE implementation and cannot
  drift; `scenery.ts` keeps a pointer where `createTreeKit` used to be.
- **Three batches, not four.** Trunk / leaf blob / pine tier. The two species'
  trunks are the same tapered cylinder at different sizes (0.45→0.85 over 5.5 vs
  0.32→0.6 over 5.0, taper ratios 0.5294 and 0.5333), so ONE unit cylinder scaled
  per instance serves both, reproducing the pine's top radius to within 0.0024 yd.
  Three's instancing path divides the normal by each column's squared length
  before applying the instance matrix, so a non-uniformly scaled cone still shades
  with the correct slope.
- **The 5 leaf materials became one white material + `instanceColor`.** Three
  multiplies `instanceColor` into `diffuseColor`, so the material MUST be white or
  the palette comes out as a tint of one colour. Same five hexes, one program.
- **The art is provably unchanged.** The per-tree RNG **draw order** is
  byte-identical to `createTreeKit`'s, so a seed produces the tree it always
  produced. A throwaway parity harness rebuilt the old builder and compared all
  559 world matrices and leaf colours: **558 identical, 1 differing by 0.001 yd**
  (float32 `instanceMatrix` vs float64 `matrixWorld`). Canopy density, silhouette
  variety and shadow contribution are indistinguishable at 2× zoom. Variety was
  never in the meshes or the materials — it is in the seeded jitter, and an
  instance matrix expresses all of it.
- **The trade, stated: triangles go UP.** An `InstancedMesh` is frustum-culled
  all-or-nothing, so the whole grove is submitted in every view including the
  trees behind the camera. That is +1.6k to +9.9k triangles per course scene and
  +4.7k on the range. Right way round on mobile — submission is the cost, the
  shadow pass was drawing most of them anyway, and a grove is ~10k triangles
  against a terrain mesh's 50k+.
- **Measured, worst-first.** course **1034 → 41**, augusta2 964 → 33, secondAim
  895 → 49, aim 790 → 50, augusta13 685 → 24, played 653 → 48, approach 593 → 32,
  celebrate 583 → 30, green 581 → 28, augusta16 424 → 39, listowel3 419 → 37,
  augusta12 365 → 39, augusta16pond 320 → 34, range-water 290 → 110, range
  269 → 89. **The worst scene in the whole game is now 110.** `budgets.golf.json`
  was re-baselined DOWN in the same change.
- **Determinism held.** Two consecutive post-change runs differ on exactly the
  five documented water scenes (`course-played-aim`, `putt-water`, `augusta-12`,
  `listowel-heritage-3`, `augusta-16-redbud`) at ≤0.011% and max Δ 42. No new
  scene entered that set; `course-hole1`, `course-celebrate` and both range scenes
  are byte-identical run to run.
- **Entry chunk: +0.03 kB** (844.54 → 844.57 kB, gzip 240.40 → 240.42). `three`
  stays its own 537.75 kB chunk and `foliage` came out as its own 3.13 kB lazy
  chunk — it is imported only by the `lazy()`-loaded `*GL.tsx`, so it never
  reaches the app entry.

**Blossom — the flowering holes, at zero draw calls.** Augusta names 13 of its
18 holes after a flowering plant and every one of them rendered a plain green
tree line (defect 6). Fixed as **content**, which is the whole point: the
renderer needed one colour path it already had.

- **Bloom is authored in HOLE DATA, never derived from the name.** `CourseHole`
  gains an optional `bloom { color, fraction }` (documented under "THE CANOPY"
  in `terrain.ts`'s authoring contract); `courses/augusta.ts` carries a `BLOOM`
  table with the colour each namesake plant actually flowers. Parsing "Pink
  Dogwood" into a colour at render time would couple the renderer to copy text.
  The five holes named for non-flowering plants (1 Tea Olive, 6 Juniper,
  7 Pampas, 14 Chinese Fir, 18 Holly) have no bloom and render unchanged.
- **It rides the EXISTING instanced leaf batch.** A blooming broadleaf's crown
  blobs are re-tinted toward the blossom colour and three small flower clusters
  are appended — all the same unit icosahedron and the same white material, so
  they are extra `instanceColor` entries in the batch that was already there.
  **Draw calls are IDENTICAL on every scene**; the cost is +1.3k to +2.2k
  triangles on a flowering hole. A mesh per blooming tree would have undone the
  25× win, which is why the design started from that constraint.
- **It is a RENDER TINT and provably nothing else.** `courseTrees()` sets
  `CourseTree.bloom` and touches no other field, so a flowering hole's tree list
  is byte-identical to the same hole with the field stripped — same trunks, same
  collision radii, same ground. And the tint is drawn from a SEPARATE generator
  seeded off the tree's own seed rather than from the per-tree render RNG, so a
  blooming tree keeps the exact silhouette, crown count and jitter it had plain.
  Both properties are unit-tested (`terrain.test.ts`, `foliage.test.ts`,
  `courses.test.ts`), which matters more than usual here: a bloom field that
  moved a ball would break see-what-you-play silently.
- **Seeded selection, and per hole.** Which broadleaves flower is
  `bloomRoll(tree.seed, hole.terrain.seed)` — mulberry32, never `Math.random`.
  The hole seed is in the mix because tree seeds are a function of `d` alone, so
  without it every flowering hole would bloom at the same downrange stations.
  `fraction` is 0.45–0.65, never 1: pines never flower and a share of the
  broadleaves stays green, so the grove reads as accent trees in a canopy rather
  than a repainted hedge.
- **Measured:** pink pixels 0 → **13,926** (hole 2), 0 → **14,642** (13),
  0 → **31,308** (16). Draw calls 33 / 24 / 39 — unchanged. Triangles
  +2,160 / +1,920 / +1,320.

**Scene-wide IBL, and real sand.** Two changes that deliberately move pixels.

- **`scene.environment` is on at `medium`/`high`.** This REVERSES a considered
  decision. `scenery.ts` `makeSkyEnvMap` attached its PMREM to the ball's
  `envMap` alone, on the recorded grounds that "turf/trees/water pay no
  per-frame env cost", and visual QA at the time found scene-wide IBL bought
  nothing. That finding was true of *that texture* and not of IBL:
  **`PMREMGenerator` sizes its cube as `image.width / 4`**, so an 8×128 gradient
  is a **2×2 cube** — a flat wash with no direction in it at all. Three's own
  documented minimum equirect is 64×32.
  `lib/scene3d/env.ts` paints a real one — a sun disc at a true 0.53° angular
  size (energy-conserved when it falls below a texel), a circumsolar halo, a
  three-stop sky and a turf-green ground bounce — in **half-float**, because an
  8-bit canvas clamps at 1.0 and would cap the sun at sky brightness.
  `components/golf/scene/env.ts` holds golf's palette (every colour lifted from
  the sky dome, so dome / water reflection / env can't drift).
- **⚠ THE TRAP, and it is the whole change.** IBL added on top of the existing
  hemisphere fill double-counts the ambient and flattens everything to grey —
  which looks exactly like "the IBL didn't work" and sends you tuning the wrong
  knob. The fill comes down IN THE SAME CALL: `hemiFill()` is now the only way a
  golf scene sets its hemisphere intensity and it reads the same `quality.ibl`
  flag. Numbers, derived rather than guessed: the painted sky's cosine-weighted
  irradiance on an up-facing normal is `(0.44, 1.09, 2.18)` at intensity 1 and
  the hemisphere light it replaces gave `(0.64, 0.86, 1.05)`, so
  `ENV_INTENSITY = 0.5` with `HEMI_IBL_FACTOR = 0.28` holds total ambient
  luminance within ~10% while moving the colour. Measured on the shots: mean
  signed delta per channel is **R −1.0, G +0.9, B +10.8** — less red, much more
  blue, luminance ~flat. Warm key, cool sky-lit shade.
- **`low` keeps the old behaviour exactly** — ball-only `envMap`, full
  hemisphere fill, `scene.environment` untouched, and the 21 KB 2×2 PMREM rather
  than 1.5 MiB. The original reasoning still governs the hardware it was written
  for. `quality.test.ts` asserts it.
- **Memory.** 512×256 equirect → a 128 cube → `3 × max(128,112) × 4 × 128`
  half-float RGBA, no mips (cubeUV packs every roughness level into the one
  target) = **1,572,864 B / 1.5 MiB** per scene. `skyEnvBytes()` computes it
  without a GPU and a unit test pins it. Three calls 1024×512 "ideal" (a 256
  cube, 6 MiB); that is 4.5 MiB more for a gradient, on the fleet that lost a
  WebView GPU process to a 16 MB shadow map.
- **Cost, measured.** Draw calls and triangles are **unchanged on all 25 scenes**
  — an env map is a sample, not a submission. Textures +2 on the scenes with
  sand in frame (the new normal + roughness maps); the env texture replaces the
  old one 1:1. What `renderer.info` cannot see is the per-fragment cubeUV sample
  every lit material now pays, and that is exactly the cost the original
  ball-only decision was protecting. It is tier-gated for that reason and the
  on-device check is still owed.
- **Real sand (`components/golf/scene/sand.ts`).** Bunkers were albedo-only at a
  flat `roughness: 1` — a surface with no normal and no roughness variance
  cannot respond to a moving light, so sand rendered as flat beige whatever the
  sun did. Now albedo, normal and roughness all come off ONE tileable seeded
  value-noise height field plus cosine rake ridges, so the grain you see, the
  bumps the sun rakes and the packed/loose sheen agree. Roughness tracks height
  *inversely* — a rake compresses what it pushes down, so furrow floors are
  glossier than the crust that stands proud. The Course and Putt each painted
  their own near-identical grain (256² and 128², 0.137 vs 0.134 dots/px); that
  is now one generator with a `repeat`/`base`/`rake` per scene. Seeded
  `mulberry32`, no `Math.random`, no `onBeforeCompile`.

**Shared putting physics.** `lib/golf/greenPhysics.ts` is the pure-math
counterpart for greens (Stimp → μ, roll-out, cup capture; no `three`, no sim
state), used by `courseSim`'s green/fringe roll. **Consolidation status:**
Mini-Golf now REUSES `greenPhysics`'s functions (roll-out decel + elliptic cup
capture) at mini-scale through a slope FIELD (`puttField.ts`), so its putts break
on a real heightfield instead of the old flat arcade engine. It keeps its own
mini-scale CONSTANTS (`tuning.ts` `PUTT_*` — a ~8× scale difference from the
yard-space Course values) by design; only the shared FUNCTIONS port.

**Seeing the game (committed harness).** `pnpm --filter @relay/ui shoot:golf`
renders each scene headlessly (Vite + pre-installed Chromium with
`--use-angle=swiftshader --enable-unsafe-swiftshader`) and writes PNGs to
`.golf-shots/` (git-ignored). It mounts one scene standalone via
`golfpreview.html?scene=course|range` (no app shell/auth). This replaces the old
throwaway preview and is what the **`golf-visual-qa`** agent runs.

**The harness is DETERMINISTIC — keep it that way.** Two runs with no code change
used to differ on **23 of 25** scenes (`course-celebrate` on 89% of its pixels),
which made the visual gate worthless: it could not tell a real regression from
the machine having run a bit faster. The cause was never RNG — the texture and
particle generators were already seeded (`mulberry32`). It was **animation
sampled at wall-clock time**. Two things fixed it, and both are load-bearing:

- **`lib/scene3d/clock.ts` — a freezable virtual clock** (game-neutral; baseball
  will want it too). All three render loops take `now` from `tickSceneClock(rafNow)`
  instead of the rAF timestamp, and anything else needing a timestamp
  (`RangeGL`'s `divotStart`, `water.ts`'s splash `ringStart`) uses `sceneNow()`.
  **Untouched it is a pass-through**: `tickSceneClock` returns the rAF timestamp
  verbatim, so the shipped app is bit-for-bit unaffected. `golfpreview.tsx` is the
  ONLY caller of `engageVirtualClock()`; it freezes the clock at the instant it
  raises `window.__golfReady`, after which `dt === 0`, no substep runs, and every
  later frame is identical. Loops must therefore tolerate `dt === 0` — never
  divide by it.
- **Readiness counted in FRAMES, never milliseconds.** SwiftShader renders these
  scenes at **~3 fps**, so the beacon's old "45 frames" condition took ~15 s and
  its 4 s wall-clock safety net beat it to the flag on *every single scene* — the
  frame path had never once run, and each shot froze wherever the machine happened
  to be. The virtual step is **100 ms**, matching the dt clamp all three loops
  already apply and the real SwiftShader frame time; at 100 ms the course camera
  easing (`1 − 0.001^dt`) converges 50% per frame, where a 16.7 ms step converges
  11% and would screenshot the `?at=` views mid-camera-flight.

- **The beacon's 30 s "NOT deterministic" fallback now cancels itself.** It used
  to be cleared only by the effect cleanup, i.e. on unmount, so any page that
  outlived 30 s — `secondAim` drives two real aims, a fire and a roll-out at
  SwiftShader's ~3 fps — logged the alarm long after a perfectly deterministic
  ready. A false alarm on the one scene that exists to catch a regression is
  worse than no alarm; it trains the reader to skip the line.

Where a sequence genuinely needs motion, `shoot-golf.mjs` asks for it in VIRTUAL
milliseconds (`advanceScene(page, ms)` → `window.__sceneClock.advance`), never
`waitForTimeout`, then renders a few frozen frames before capturing (Chromium can
hand back the frame *before* the last one rendered).

**Known residual: 5 water scenes still differ by 10–200 pixels (≤0.015%).**
`augusta-12`, `augusta-16-redbud`, `course-played-aim`, `listowel-heritage-3`,
`putt-water` — plus, in one run pair out of three, `augusta-16-pond` at 5 px
(maxΔ 1), so membership flickers at the very low end. Per-pixel magnitude reaches
**maxΔ ≈ 44** on `listowel-heritage-3` and ~20–26 on the augusta holes, which is
higher than the "4–10" first recorded here: that early figure came from a smaller
sample, not from a since-introduced regression. Measured directly — two
consecutive runs at the current 1536² and two more at `?shadow=2048` (the old
configuration) produce the same scene set and the same magnitudes, so the shadow
tier does not touch it. This is **not** the clock and is not fixable from scene
state:
virtual time at freeze is exactly `2300 ms` on 6/6 consecutive loads, a water-free
hole is 6/6 byte-identical, and a water hole is 6/6 different while being stable
*within* a page load. The differing pixels are a 1-px line on the water's
silhouette — the `if (vDepth <= 0.0) discard;` shoreline in `water.ts`, where
`alpha *= smoothstep(0.0, 0.09, vDepth)` leaves near-zero-alpha fragments whose
8-bit rounding flips. It is SwiftShader per-GL-context behaviour (implicit-LOD
sampling next to discarded fragments); `?water=low` and disabling Chromium's
program cache both reduce but do not remove it. Treat a diff of this size on a
water scene as noise; **anything larger, or on a non-water scene, is a real
regression.**

**Visual change workflow.** Any change to a golf scene, its materials, lighting
or geometry: `golf` implements → `code-reviewer` (diff) → `qa-verify`
(typecheck/tests/build) → **`golf-visual-qa`** (before/after screenshots, Course
vs Range parity) → human review. Typecheck and unit tests never catch a broken
or regressed render — capture a **before** (baseline) and **after**; a
"visual" change that produces no visible delta is itself a finding.

**Gotcha (learned the hard way):** the Course terrain is a custom displaced
BufferGeometry — its triangles must be wound so the top surface FRONT-faces up.
A downward winding gets back-face culled, so the whole textured ground vanishes
and only the flat fill plane shows in the foreground (the long-standing "flat
grass" look). Keep the fill plane a few yards BELOW the terrain minimum so it
backs only the far-horizon void and never occludes the playable ground. The
2048² shadow map is still an on-device GPU risk (see step 2) — swiftshader
screenshots won't catch it.

---

## Continuing in a new session
Steps 1 (aim/shot control) and 2 (visual first pass) are **done**, and **step 3
(hole engine)** has a PLAYABLE Hole 1 — terrain-aware sim, predicted aim arc
(frustum-cull bug fixed), a real Coulomb putting green (elliptic cup capture that
reliably holes an on-line putt), a clean textured green with an aim-holing pulse
cue, a data-driven scalable surface model, and persisted best-shot records. See
the roadmap markers above. Next up:

1. **Author holes 2–9 as pure data** per the "HOW TO AUTHOR A HOLE" contract
   header in `terrain.ts` (`terrain.ts`/`courseData.ts`) — the engine, shaders,
   HUD and scene frame are all hole-agnostic and derive from the `CourseHole`, so
   this is data only, no per-hole code (and every new hole gets organic feature
   outlines for free). Respect the header invariants: pin inside the MIN wobbled
   green, hazards outside `maxGreenPadRadius` (the wobble-safe clearance), and each
   green's tilt ≲ μ (~6.1% at stimp 10) or a resting putt won't hold (green design
   guard, step 3).
2. **Consolidate Mini-Golf onto a real heightfield** so `puttSim`/`PuttGL` can
   share `greenPhysics` instead of its own flat engine.
3. **On-device GPU check** (swiftshader/headless won't catch it). The shadow map
   is no longer a bare number to argue about — it is a tier, it defaults DOWN
   (Course/Range 1536², Putt 1024²), and every knob is a URL parameter, so the
   check is now a ten-minute job on a handset instead of a rebuild cycle:
   - **`?shadow=2048`** reproduces the configuration that killed the WebView GPU
     process; **`?shadow=1536`** is the shipping default; **`?shadow=1024`** is
     the known-survivable fallback. Bisect in that order.
   - **`?quality=low`** drops the shadow pass entirely — if that is the only tier
     that survives, the finding is much bigger than a map size.
   - **`?water=medium`** drops the Tier 3 planar reflection pass (a second full
     scene render), **`?water=low`** also drops the detail normals.
     `pickWaterQuality` still promotes on a capability sniff
     (`cores > 4 && maxTextureSize >= 8192`) — a **known defect**, and the thing
     most in need of confirming on a real handset.
   - Read `window.__golfStats` in the device console for the live draw
     call / triangle / tier numbers, including a median frame time.
   The remaining open item is the measurement itself, on hardware. Until someone
   holds a low-end Android, nothing here is evidence.

**Regressions:** if you ever touch `CourseSim` state, remember any new mutable
field MUST join `CourseSnapshot`/`snapshot()`/`restore()` (guard test enforces
it), and re-run `pnpm --filter @relay/ui shoot:golf secondAim` — the two-aim
sequence is the only thing that catches the aim-arc frustum-cull class.

Tip for visual work: a throwaway `golfpreview.html` + `src/golfpreview.tsx` that
mounts only `<RangeGL>` (no app shell/auth) lets you screenshot the range with
the pre-installed headless Chromium (`--use-angle=swiftshader
--enable-unsafe-swiftshader`) for real before/after feedback. Recreate it when
iterating on the scene; it's not committed.

The user is gathering more reference screenshots of the PGA app's shooting and
will share them. Full visual write-up of the assessment was also produced as an
artifact during the session it was written.
