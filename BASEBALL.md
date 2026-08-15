# Baseball — design & physics guide

## Premise

Baseball is an in-app game in the Relay Games hub at `/games`, sitting alongside
Golf. The feel target is **Baseball Clash**: short, snackable sessions — a Home
Run Derby and a 3-inning Duel — driven by one tap for timing and one drag for
placement, wrapped in card-collection progression. The home park is a **Toronto
homage**: a retractable-roof downtown stadium, royal blue / red / white, a tower
on the skyline. Everything is original: no MLB or club marks, no team nicknames,
no real park or player names, no borrowed logos, and **no image assets at all** —
every texture is generated procedurally at runtime. `ip.test.ts` is the
mechanical guard on that, not a promise.

Under the arcade surface the ball flight is real. Feet, seconds, slugs, real
gravity, a real Magnus force with the gyro component projected out — because
pitch break *is* the gameplay, and a pitch that breaks the published number is
what makes reading one feel like a skill instead of a coin flip.

## Physics model

### Units: feet, seconds, slugs — and REAL gravity

Every reference number the game is calibrated against is published in
ft / in / mph / rpm: 60.5 ft mound to plate, a 17 in plate, 94 mph at release
and ~86 at the plate, 2400 rpm, induced break quoted in inches, fence distances
in feet. Working natively in ft/s drops those numbers straight into the code and
straight into the tests with no conversion step to get wrong. Conversions live
at the input edge only, in `units.ts`.

> ⚠ `g = 32.174 ft/s²`, and it is never touched. `lib/golf/rangeSim.ts` uses an
> arcade `GRAVITY = 16` in an abstract yard-space and models spin as a bounded
> constant acceleration. **Copy neither.** Induced vertical break is *defined*
> as the difference between the real trajectory and a gravity-only trajectory
> from the same release, so a fudged `g` does not merely rescale the drop — it
> corrupts the definition of break, and with it `C_L`'s calibration, the pitch
> table, the plate crossing and the batted-ball carry.

### Frame

Right-handed, **Z up**: `+x` mound → plate, `+y` toward third base (a RHP's arm
side is `−y`), `+z` up. Gravity is `(0, 0, −g)`. Declared once in
`airPhysics.ts`; `zone.ts` and the GL scene consume the same convention.

### Constants and where each one comes from

Every number is **published data**, **derived**, **calibrated by a failing
test**, or an **explicitly-labelled feel knob**. There is no fifth category.

| Quantity | ft-s-slug value | Kind | Where from |
| --- | --- | --- | --- |
| `g` | 32.174 ft/s² | fixed | standard gravity |
| ball weight | 5.125 oz | fixed | MLB Rule 3.01 band midpoint (5–5.25) |
| ball mass `m` | 0.0099556 slug | **derived** | `W/g = (5.125/16)/32.174` |
| circumference | 9.125 in | fixed | Rule 3.01 band midpoint (9–9.25) |
| radius `r` | 0.1210237 ft | **derived** | `C/2π` |
| area `A` | 0.0460144 ft² | **derived** | `π r²` |
| `p₀`, `R_dry` | 2116.22 lbf/ft², 1716.49 | fixed | US Standard Atmosphere |
| `R_vapor` | 2759.8 | **derived** | `R_dry / 0.62197` (molar-mass ratio) |
| `ρ` | 0.0023770 @ ISA SL | **derived** | barometric + ideal gas + humidity split |
| `K = ρA/2m` | 0.0054932 ft⁻¹ @ ISA SL | **derived** | see below — never hand-set |
| `C_D` | 0.300 | **calibrated** | 94.0 mph release → 86.3 at the plate |
| `C_L(S)` | piecewise, cap 0.35 | **calibrated** | stage 2: all 8 pitch-table rows at once |
| `FIXED_MS` | 1000/120 | fixed | the one substep, shared by every consumer |

**Air density.** `airDensity(elevFt, tempF, rh)` = standard-atmosphere
barometric pressure `p(h) = p₀(1 − 6.87535e-6·h)^5.2559`, then the ideal gas law
at the *local* temperature with a partial-pressure split for vapour:
`ρ = (p − p_v)/(R_dry·T) + p_v/(R_v·T)`. Water vapour is lighter than air, so
humid air is thinner and the ball carries.

Note the textbook figure **0.002378 slug/ft³ is quoted at ISA sea level: 59 °F,
dry.** A game-day 70 °F / 50 % RH sea level is **0.0023169** — 2.5 % thinner,
because it is 11 °F warmer *and* carries vapour. The tests assert the physics,
not the round number. A mile-high park is 17.5 % thinner still, which is the
largest single park effect in the sport.

**The one derived aero scale.** Both aero forces have the form
`F = ½ρ·C·A·|v|·v`. Dividing by `m` puts the same group in front of both:

```
a = F/m = (ρA / 2m) · C · |v| · v      ⇒      K ≡ ρA / (2m)   [ft⁻¹]
```

`K` is the *only* channel through which altitude and weather reach the ball.
Hand-setting it silently makes Denver behave like sea level, so it is exported
as `aeroScale(rho)` and never as a literal.

### The equation

```
a = (0, 0, −g)  −  K·C_D·|v|·v  +  K·C_L·|v|·(ω̂_eff × v)
```

with `S = r·|ω_eff| / |v|` feeding `C_L(S)`.

> ⚠ **Gyro projection.** `ω_eff = ω − (ω·v̂)·v̂` — the component of the spin
> vector *perpendicular* to velocity. The velocity-parallel component (gyro
> spin, the rifle-bullet spiral) produces **zero** Magnus force, since `ω̂ × v`
> vanishes when `ω̂ ∥ v`. It must be projected out **every substep**, not once at
> release, because `v` rotates through the flight and an axis that starts
> perpendicular does not stay perpendicular.
>
> This projection *is* the difference between pitch types. A slider and a
> four-seamer can both be thrown at 2400 rpm; the slider's axis points near its
> direction of travel, so most of that spin is inert and only the small
> perpendicular remainder sweeps it. Without the projection every pitch collapses
> toward the same shape and the pitch table is unreachable. `S` is computed from
> `|ω_eff|` too, so gyro spin correctly stops inflating `C_L` as well.

### Determinism

`FIXED_MS = 1000/120` is shared by the live rAF loop, the headless `predict()`,
the vitest harness and the screenshot driver — that identity is what makes an
on-screen trajectory trustworthy evidence about the physics. Events (plate
crossing, fence plane, ground) resolve **analytically** via
`crossingFraction` + `lerpBallState`, never by snapping to a substep boundary: a
95 mph pitch covers 1.16 ft per substep against a 1.9 ft strike zone. No
`Math.random`, no wall clock in any sim file — seeded `mulberry32` only.

`PITCH_TEMPO` (slow motion) **must never scale `dt`**. Gravity is linear in `dt`
while the aero terms go as `v²`, so a time-scaled `dt` re-weights them against
each other and silently rewrites every break number. Playback speed belongs to
the render layer; contact resolves at the true physical state.

## Key files

| File | Role |
| --- | --- |
| `packages/relay-ui/src/lib/baseball/units.ts` | ft/s/slug conversions, real `g`, the units rationale |
| `packages/relay-ui/src/lib/baseball/airPhysics.ts` | **THE** aero core: ball spec, `airDensity`, `aeroScale` (K), `C_D`/`C_L`, `aeroAccel`, RK4 `stepBall`, analytic event interpolation. Called by both the pitch and the batted ball — never copied |
| `packages/relay-ui/src/lib/baseball/airPhysics.test.ts` | The dynamics bench: prints ρ→K and S→C_L tables, asserts the derivations, the gyro projection and the drag calibration |

## Roadmap

- **Stage 1 — aero core.** → **Done:** `units.ts` (ft/s/slug, real `g = 32.174`,
  written against golf's arcade `GRAVITY = 16`); `airPhysics.ts` (MLB ball spec
  derived to mass/radius/area, `airDensity` with barometric + humidity, the
  derived `K = ρA/2m`, `liftCoef`/`dragCoef`, `aeroAccel` with per-call gyro
  projection, RK4 `stepBall` at `FIXED_MS = 1000/120`, `crossingFraction` /
  `lerpBallState` for exact event resolution); `airPhysics.test.ts` — 10 tests,
  printed tables, `C_D` calibrated to **0.300** giving 94.0 mph → **86.29 mph**
  at 55 ft against the published 86.3.
- **Stage 2 — pitching.** `tuning.ts` (every constant labelled fixed / derived /
  calibrated / feel knob), `pitches.ts` (the eight-row published pitch table:
  velo, spin, tilt, and the induced-break targets), `zone.ts`, `pitchSim.ts`
  precomputing a `PitchTrack` at true physical time. `C_L` is recalibrated
  against all eight rows **at once**.
- **Stage 3 — hitting.** `batSim.ts` (bat inertia, COR, derived `M_eff`/`q`/`eA`,
  calibrated `e_T`), `battedBallSim.ts` on the *same* `airPhysics` integrator,
  `parks.ts` (fence data read by physics *and* geometry, so the fence you see is
  the fence you clear), `fielding.ts` as a landing-point + hang-time lookup.
- **Stage 4 — game & scene.** `derbySim.ts`, `duelSim.ts` (3 innings, 3 outs, no
  steals/errors/subs/shifts), `ai.ts`, `StadiumGL.tsx` as a *composer* over
  `stadium/{bowl,turf,dirt,roof,crowd,lights,skyline}.ts`, HUDs, and the budget /
  determinism / IP guard tests.

## Gotchas

- **Project the gyro spin out every substep.** `ω_eff = ω − (ω·v̂)v̂`. Doing it
  once at release is wrong — `v` rotates through the flight. Doing it not at all
  makes every pitch the same pitch. `airPhysics.test.ts` asserts a pure-gyro ball
  feels a Magnus force below `1e-9` ft/s² (it measures exactly 0), and that the
  same spin turned perpendicular exceeds half a g.
- **Gravity is real: 32.174 ft/s².** Golf's `GRAVITY = 16` is a yard-space arcade
  fudge and is not transferable. Break is *defined* against a gravity-only
  trajectory, so g is load-bearing for the definition itself, not just the drop.
- **`K` is derived, never edited.** If a trajectory looks wrong the honest dials
  are `C_D` / `C_L` (calibrated against published data) or a labelled feel knob.
  Editing `K` disconnects altitude and weather from the ball.
- **0.002378 is the *59 °F dry* density.** Do not assert it for 70 °F/50 % RH;
  the right answer there is 0.0023169, and the 2.5 % gap is real carry.
- **Never tune one pitch by nudging `C_L` in isolation** — recalibrate against
  all eight rows of the pitch table at once. A change that fixes the curveball
  and breaks the sweeper is the failure mode that rule exists to prevent.
