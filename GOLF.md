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
| Shared scene kit (turf/sky/trees/fog) | `packages/relay-ui/src/lib/golf/scenery.ts` |
| Shared WATER (level geometry, Gerstner waves, Fresnel + sky/planar reflection, foam, splash, wet bank, reeds, quality tiers) | `packages/relay-ui/src/lib/golf/water.ts` |
| Headless screenshot harness | `packages/relay-ui/scripts/shoot-golf.mjs` + `golfpreview.html` + `src/golfpreview.tsx` |
| Range physics/sim (headless) | `packages/relay-ui/src/lib/golf/rangeSim.ts` |
| Sim tests / harness | `packages/relay-ui/src/lib/golf/rangeSim.test.ts` |
| Range 3D scene (Three.js) | `packages/relay-ui/src/components/golf/RangeGL.tsx` |
| Range HUD + controls + telemetry + layout picker | `packages/relay-ui/src/components/golf/RangeGame.tsx` |
| Layouts, pins, `surfaceAt` | `packages/relay-ui/src/lib/golf/rangeTargets.ts` |
| Club ladder | `packages/relay-ui/src/lib/golf/clubs.ts` |
| Course terrain data + "HOW TO AUTHOR A HOLE" contract (`heightAt`/`gradientAt`/`surfaceAt`; `TEE_R`/`corridorHalfAt`/`greenPadRadius`; organic edges `edgeNoise`/`edgeRadius`/`featureSeed` + `EDGE_WOBBLE`/`maxGreenPadRadius`; render-only `corridorEdgeDist` first-cut helper) | `packages/relay-ui/src/lib/golf/terrain.ts`, `courseData.ts` |
| Course sim (terrain-aware; `snapshot`/`restore`/`predict`; putt power/speed; records) | `packages/relay-ui/src/lib/golf/courseSim.ts` |
| Green + putting physics (Stimp → μ, roll-out, elliptic cup capture, BALL_R/CUP_R scale) | `packages/relay-ui/src/lib/golf/greenPhysics.ts` |
| Course 3D scene (Three.js) — baked surface map, aim-holing pulse; `buildOrganicDisc`/`buildOrganicAnnulus` draw the green cap, fringe collar, bunkers and terrain-following water from the model's `edgeRadius`+`featureSeed`; long-grass rough, a crisp `corridorEdgeDist` first-cut band (uniform mown collar framed by dark mow lines), textured tee (`makeTeeTurf`); all textures seeded (`mulberry32`) | `packages/relay-ui/src/components/golf/CourseGL.tsx` |
| Course HUD + records recap | `packages/relay-ui/src/components/golf/CourseGame.tsx` |
| Putting sim / scene / round | `src/lib/golf/puttSim.ts`, `components/golf/PuttGL.tsx`, `GolfGame.tsx` |
| Ball material (dimple normal map) | `packages/relay-ui/src/lib/golf/ballTexture.ts` |
| Hub wiring | `packages/relay-ui/src/routes/Fog.tsx`, `components/golf/GolfMenu.tsx` |
| Worker leaderboard + best-shot records | `packages/relay-worker/src/games.ts` (migration `0007_golf_records.sql`) |
| Best-shot records API client | `packages/relay-ui/src/lib/api.ts` (`getGolfRecords`/`postGolfRecords`) |

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
sky dome, fog, tree kit) and BOTH `CourseGL` and `RangeGL` import them, so a
look change happens once. The Course terrain is multi-surface (per-vertex
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
3. **On-device GPU check** (swiftshader/headless won't catch it): the 2048²
   shadow map — plus the shared water surface — needs verifying on a low-end
   Android device before the release AAB ships; 1536² is the first dial to turn
   down. Water now has its own dial: load the preview with **`?water=medium`**
   (drops the Tier 3 planar reflection pass, keeping everything else) or
   **`?water=low`** (also drops the detail normals). `pickWaterQuality` only
   offers `high` where the GPU reports headroom, but that heuristic is exactly
   what wants confirming on a real handset. (The transparent slope-read overlay that was an earlier
   GPU concern is gone — the green is clean now.)

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
