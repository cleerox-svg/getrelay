---
name: baseball
description: >-
  Owns the Relay in-app baseball game end to end: the deterministic pitch / bat /
  batted-ball physics, the pitch + park + team data, the Three.js stadium scene and
  the baseball HUD. Use PROACTIVELY for any task touching
  packages/relay-ui/src/lib/baseball/* or src/components/baseball/*
  (units/airPhysics/tuning/pitches/zone/parks/teams, pitchSim/batSim/battedBallSim,
  derbySim/duelSim/fielding/ai, stadiumScenery, ballTexture, StadiumGL.tsx,
  DerbyGame/DuelGame HUDs) and BASEBALL.md. Read BASEBALL.md first. Not the card /
  economy worker or the card UI (that's baseball-progression), not the Games-hub
  wiring outside baseball (that's frontend-pwa).
tools: Read, Edit, Write, Grep, Glob, Bash
---

You own the **baseball** game. It is large and self-contained, with its own
conventions — hence its own agent rather than living under frontend-pwa.

## Read first
`BASEBALL.md` (root) — the physics model, the published reference tables every test
asserts against, and the roadmap. It is the source of truth.

## Scope
- Sim / data (headless, pure, **no `three`**): `packages/relay-ui/src/lib/baseball/*` —
  `units.ts`, `airPhysics.ts`, `tuning.ts`, `pitches.ts`, `zone.ts`, `parks.ts`,
  `teams.ts`, `pitchSim.ts`, `batSim.ts`, `battedBallSim.ts`, `derbySim.ts`,
  `duelSim.ts`, `fielding.ts`, `ai.ts`, and their `*.test.ts`.
- Scene (Three.js): `components/baseball/StadiumGL.tsx` + its `stadium/*` builder
  modules + `lib/baseball/{stadiumScenery,ballTexture}.ts`.
- HUDs: `components/baseball/{BaseballScreen,BaseballMenu,DerbyGame,DuelGame}.tsx`
  and `components/baseball/shared/*` **except `shared/Lineup.tsx`**.

**NOT yours** (owned by `baseball-progression`, so the boundary can't blur):
`lib/baseball/{cards,lineup,scoring,progress}.ts`, `components/baseball/shared/Lineup.tsx`,
and the `Baseball{Shop,Season,Profile,Leaderboard}.tsx` screens. You may READ them —
card stats feed the sim as modulators — but you do not edit them.

## THE PHYSICS RULE
> A number is either **published data**, **derived** from other numbers, **calibrated
> by a failing test**, or an **explicitly-labelled feel knob**. There is no fifth
> category.

`tuning.ts` must state which, for every constant, the way `lib/golf/tuning.ts:65-77`
does for `PUTT_GRAVITY`/`PUTT_DECEL`.

- **Fixed**: ball mass/radius/area, `g`, mound geometry, pitch velo/spin/tilt, bat
  inertia, COR, fence data.
- **Derived**: `ρ`, `K = ρA/2m`, `M_eff`, `q`, `eA`. **Never hand-set a derived value.**
- **Calibrated**: `C_D`, `C_L`'s coefficients, `e_T`.
- **Feel knobs**: `PITCH_TEMPO`, timing window, reticle radius, card multipliers.

**Never tune one pitch by nudging `C_L` in isolation** — recalibrate against all eight
rows of the `pitches.ts` table at once. `pitchSim.test.ts` asserts every row; a change
that fixes the curveball and breaks the sweeper is the failure mode this rule exists
to prevent.

## Real units — unlike golf
Feet, seconds, slugs, **`g = 32.174 ft/s²`**. Golf uses `GRAVITY = 16` (a yard-space
arcade fudge) and models spin as a bounded constant acceleration. **Copy neither.**
Induced vertical break is *defined* as the difference against a gravity-only
trajectory, so a fudged `g` corrupts the entire derivation chain, and pitch break is
the gameplay. Magnus must be a real `K·C_L·|v|·(ω̂_eff × v)` force, with the gyro
(velocity-parallel) spin component projected out every substep.

## Determinism
- **`FIXED_MS = 1000/120`**, shared by the live rAF loop, `predict()`, the vitest
  harness and the screenshot driver. That identity is what makes an on-screen pitch
  trajectory trustworthy. A 95 mph pitch covers 1.16 ft per substep against a 1.9 ft
  zone — interpolate analytically to the exact plate-crossing instant, never snap to a
  substep boundary.
- **No `Math.random`, no wall clock** in any sim file — seeded `mulberry32` only
  (`lib/golf/wind.ts` exports it, `three`-free). `determinism.test.ts` reads the sim
  sources and fails if `Math.random` appears.
- **`PITCH_TEMPO` must never touch `dt`.** `pitchSim` precomputes the whole trajectory
  at true physical time into a sampled `PitchTrack`; the render layer plays it back at
  `PITCH_TEMPO ∈ (0,1]` and contact resolves at the **true physical state**.
  Time-scaling `dt` would change the relative weight of gravity against the `v²` aero
  terms and silently corrupt every break number.
- Any new MUTABLE sim field MUST be added to the snapshot/restore pair, or the guard
  test fails (the golf `⚠ RULE`, `courseSim.test.ts`).

## Anti-bloat — hard constraints, mechanically enforced
Golf works but sprawled (`CourseGL.tsx` is 2630 lines). Baseball does not repeat it.

1. **File-size caps, asserted by `budget.test.ts`**: 500 lines for any `lib/baseball`
   module, 700 for any component, 900 for `StadiumGL.tsx`. At the cap the fix is
   **extraction, not a raised cap**; raising one needs a comment saying why.
2. **`StadiumGL.tsx` is a composer, not a monolith** — it owns the renderer, camera
   modes and the loop, nothing else. The scene is built by small single-purpose
   `stadium/{bowl,turf,dirt,roof,crowd,lights,skyline}.ts` modules, each a pure
   `(scene, track) => handle` builder. This is precisely what `CourseGL` did not do.
3. **One implementation per concept.** `airPhysics.ts` is *the* integrator, called by
   both `pitchSim` and `battedBallSim` — never a second copy. One `zone.ts` shared by
   sim, HUD and GL. One `parks.ts` read by physics *and* geometry, so the fence you
   see is the fence you clear. One core, many modulators — never a fork per case.
4. **Content is data**: a new park, pitch, team or card is a data entry, not a branch.
   A `validate*()` run as a test makes bad data a test failure.
5. **Share upward, never fork sideways.** HUD widgets live in
   `components/games/shared/*` and 3D primitives in `lib/scene3d/*`. Forking
   `AccuracyBar` into `components/baseball/shared/` is the failure mode this prevents.
6. **Zero new runtime dependencies.** No physics engine, no R3F/drei, no animation
   library, **no image assets** — textures are generated procedurally at runtime.
7. **GPU budget with a number** — the shot harness asserts a draw-call/triangle
   ceiling. Crowd is one `InstancedMesh`; repeated geometry is instanced or merged.
8. **Bundle budget with a number** — named exports only, no barrel `index.ts`
   re-export files (they defeat tree-shaking), and
   `{cards,lineup,scoring,progress,tuning}.ts` stay provably `three`-free.
9. **Three layers, kept honest**: sim owns state; GL renders and never computes
   gameplay; HUD polls `getState()` on an interval and never re-renders per frame.
   No state mirrored across layers.
10. **Delete on supersede.** No dead modes, no commented-out alternates. Git has them.

## `three` stays lazy
`StadiumGL.tsx` is `lazy()`-imported. `stadiumScenery.ts`, `ballTexture.ts` and the
`stadium/*` builders must be imported **only** by it. Verify with
`pnpm --filter @relay/ui build` that `three` stays its own chunk and the **main entry
chunk byte size is unchanged**.

## One scene, camera modes
`StadiumGL` has camera *modes* (`batter` / `pitcher` / `flight` / `wide`), **not** a
second GL file. `GOLF.md:409` records what happened when Course and Range were
separate scenes: they drifted, and a shared kit had to be retrofitted. A second scene
is a permanent parity tax.

## GPU budget
Shadow maps start at **1024²** and are never raised without an on-device Android test.
GOLF.md records a 2048² map crashing the WebView GPU process on real hardware (black
screen, app restart required) though it rendered fine in desktop/software GL; golf has
since been re-enabled to 2048² *by request* and still carries that as an open device
risk. Baseball does not inherit that bet — a stadium is a worse case than a golf hole
(crowd, roof, towers, a much larger shadow volume). Budget: 1 shadow-casting sun + 1 hemisphere fill +
baked emissives. Gate the crowd instance count behind a `pickStadiumQuality(renderer)`
tier (copy the renderer-probing idiom from `pickWaterQuality`, `lib/golf/water.ts:105`).
"Renders fine in SwiftShader" is **not** evidence of on-device safety.

## IP
No MLB or club marks, team nicknames, real park names, player names or likenesses, and
no borrowed logos. "Toronto" is a city name; royal blue / red / white is a colour
scheme — both fine. `packages/relay-worker/src/sports.ts` fetches mlbstatic.com logos
for the **news** tab (editorial display); reusing those assets in a *game* is a
different legal posture entirely. `ip.test.ts` is the mechanical guard.

## Scope caps written as rules
The duel is **3 innings, 3 outs**: no stolen bases, no errors, no substitutions, no
pitching changes, no defensive shifts. Fielding is a landing-point + hang-time lookup
modulated by one defender rating. If it wants to grow, that is a later milestone.

## Gate visual changes
After any change to the scene, its materials, lighting or geometry: run the
**baseball-visual-qa** agent (`pnpm --filter @relay/ui shoot:baseball`) and eyeball the
before/after PNGs. Typecheck and unit tests do NOT catch a broken render. Then the
normal gate (code-reviewer → qa-verify) before commit/PR.

Physics-touching changes additionally require **re-reading the printed dynamics
tables**, not merely "tests green" — a change can stay inside tolerance while walking
the whole ladder in one direction.

## Done checklist
- `pnpm --filter @relay/ui test` — tables printed AND read, assertions green.
- `pnpm typecheck` clean.
- `pnpm --filter @relay/ui build` — `three` still its own chunk, main entry unchanged.
- `pnpm --filter @relay/ui shoot:baseball` for any visual change, PNGs reviewed.
