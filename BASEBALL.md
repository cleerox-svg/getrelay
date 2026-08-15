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

**WORLD** (the frame the integrator runs in) is right-handed, **Z up**: `+x`
mound → plate, `+y` toward **first** base / the catcher's right (a RHP's arm
side is `−y`), `+z` up. Gravity is `(0, 0, −g)`. Declared once in
`airPhysics.ts`; `zone.ts` and the GL scene consume the same convention.

> ⚠ Stage 1 shipped this line saying "`+y` toward third base", which cannot be
> true of a right-handed frame with `+x` mound → plate and `+z` up
> (`ŷ = ẑ × x̂` is the first-base side), and which contradicted its own
> parenthetical. Stage 2 corrected the label, not the code: no constant, test
> result or trajectory moved. It matters because `zone.ts` maps `y` onto the
> Statcast lateral axis, and a mirrored label mirrors every published horizontal
> break.

**REPORT** (`zone.ts`) is the frame every published table and the HUD use:
`d` = distance from the plate, + toward centre field (0 at the plate's rear
point, 54.0 at release, 60.5 at the rubber — a pitch travels in `−d`); `x` =
lateral, + to the umpire's right = the first-base side, which is Statcast's
lateral axis sign for sign; `h` = height. `d = 54 − x_world`, `x = y_world`,
`h = z_world`. It is a labelled tuple, not a basis — `(d, x, h)` in that order
is left-handed, so cross products stay in WORLD.

Two published signs pin the lateral axis and are asserted: a RHP's average
release is at `x = −1.9 ft` (arm side = third-base side), and his four-seamer's
horizontal break is toward `−x`. Both negative, as raw Statcast has them.

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
| `C_D` | 0.300 | **calibrated** | 94.0 mph release → 86.3 mph \|v\| at the plate, spinless, 55 ft, **ISA air** — see below |
| `C_L(S)` | `1.5S` (S≤0.1), `0.09+0.6S` | **published data** | Alan Nathan's published baseball-aerodynamics lift fit (exact reference unverified — confirm before publication) |
| `C_L_MAX` | 0.35 | **feel knob** | safety clamp, NOT part of the fit; bites at S = 0.4333, never in the pitch table |
| `FIXED_MS` | 1000/120 | fixed | the one substep, shared by every consumer (`tuning.ts`) |
| `BREAK_SEGMENT_FT` | 50 | **calibrated** | the ONE number stage 2 fitted — see the segment sweep below |
| `PITCH_TEMPO` | 0.55 | **feel knob** | playback only; the sim cannot import it, and a test reads the source to prove it |
| release `d`, `h`, side | 54.0, 5.8, 1.9 ft | fixed | league-average Statcast release (6.5 ft extension) |
| zone | 17 in × 1.60–3.40 ft | fixed | rule book + league-average per-batter zone |
| called zone | 19.90 in × 2.042 ft | **derived** | rule zone + one BALL RADIUS a side (any part of the ball over any part of the plate) |

**Air density.** `airDensity(elevFt, tempF, rh)` = standard-atmosphere
barometric pressure `p(h) = p₀(1 − 6.87535e-6·h)^5.2559`, then the ideal gas law
at the *local* temperature with a partial-pressure split for vapour:
`ρ = (p − p_v)/(R_dry·T) + p_v/(R_v·T)`. Water vapour is lighter than air, so
humid air is thinner and the ball carries.

Note the textbook figure **0.002378 slug/ft³ is quoted at ISA sea level: 59 °F,
dry.** A game-day 70 °F / 50 % RH sea level is **0.0023168** — 2.6 % thinner,
because it is 11 °F warmer *and* carries vapour. The tests assert the physics,
not the round number. A mile-high park is 17.5 % thinner still, which is the
largest single park effect in the sport.

**`C_L` is published, not calibrated.** The piecewise form `C_L = 1.5·S` for
`S ≤ 0.1` and `C_L = 0.09 + 0.6·S` above it is the standard lift fit from the
baseball aerodynamics literature — Alan Nathan's published fit. *(Exact
journal/volume/page unverified; confirm before publication. A general
attribution is honest, an invented citation is not.)* It was previously labelled
"calibrated", which was wrong twice over: nothing in this repo calibrates it, and
the label invites stage 2 to nudge the slope until one pitch looks right. The
honest way to change it is a better *published* fit.
`airPhysics.test.ts` anchors both branches at fixed `S`, so an edit to either
slope fails immediately — changing 0.6 → 0.9 previously passed the whole suite.

**`C_D` = 0.300, and the conditions are part of the number.** ISA air (59 °F,
dry, `K = 0.00549317 ft⁻¹`), 55 ft of flight, spinless, and the 86.3 mph target
is the **vector magnitude** `|v|` — which is what a radar plate speed reports.
The gravity-free closed form `v_x = v₀·exp(−K·C_D·x)` inverts to `C_D = 0.2829`
(0.2902 in game-day air) — accurate, but a statement about `v_x`, not `|v|`.
The model lands `|v| = 86.29`, `v_x = 85.84`. Two documented biases of ~±0.2 mph
each remain and partly cancel: the game plays in thinner 70 °F/50 % RH air
(86.49 mph with the same `C_D`), and 55 ft measures to the plate's rear point
while plate speed is read ~1.4 ft nearer the front. "Inside the convention slop
of the published number" is the honest claim; "dead on it" is not.

### Induced break — the reporting convention

> ⚠ **Pinned here so stage 2 cannot recalibrate a published coefficient to fix a
> reporting mismatch.** This is a *convention*, not a physical result.

| | |
| --- | --- |
| reference trajectory | same release state, **same drag**, spin set to **zero** |
| start point | the release point, released **horizontally** from z = 6 ft |
| end point | the plate crossing |
| flight length | **55 ft** (60.5 mound-to-plate less ~5.5 ft extension) |
| **air** | **ISA sea level — 59 °F, dry, ρ = 0.002377, K = 0.00549317 ft⁻¹** |
| reported quantity | `Δz = z_spun − z_spinless` at the end point, in inches |

**The air row is load-bearing, not bookkeeping.** The same four-seamer measures
22.59 in in ISA air, **22.01 in** at the game-day 70 °F / 50 % RH, and **18.11 in**
a mile high — a 4.5 in spread on the exact number this section exists to stop
stage 2 misreading as a calibration error. Quote the air with the break or the
number means nothing. (Release angle is a minor term by comparison: −1.5° / −3.0°
downhill give 22.66 / 22.78 in.)

Keeping drag in the reference is what makes the number *the Magnus term alone*:
drag and gravity are identical between the two trajectories, so the difference
is exactly the lift force's contribution. The alternative — a vacuum
gravity-only reference — folds in drag's vertical component and reads ~4 % higher
(23.56 in vs 22.59 in for the reference four-seamer). Both columns are printed by
`airPhysics.test.ts`; the **spinless-with-drag** column is the convention.

**Expected relationship to quoted Statcast IVB.** A fully-efficient 2400 rpm /
94 mph four-seamer measures **22.59 in** on this convention, against the ~15–18 in
usually quoted as IVB. That gap is the *measured segment*, not the physics: the
Magnus acceleration is 0.72 g, inside the published 0.5–0.9 g range, and
deflection grows as the square of the measured length. Measured over the last
45 ft the same pitch gives 15.23 in, over the last 40 ft 12.07 in — the printed
table walks it. So a pitch-table break target published on someone else's
convention must be **converted** before it is asserted against; `C_L` does not
move to close a convention gap. (Which segment the public figures use is a
reporting detail we have not verified — flagged, not guessed.)

**The segment is `BREAK_SEGMENT_FT = 50` — and it does not reconcile the
arsenal.** Stage 2 tested stage 1's "it is only a convention" conclusion
properly, sweeping the segment 30 → 54 ft against **sixteen** published targets
(eight pitches × IVB and HB). The sweep table is printed by `pitchSim.test.ts`.
The result:

- **No single segment fits all eight.** The length each pitch needs *on its own*
  spans 34.0 ft (cutter) to 51.1 ft (sinker). The RMS optimum over all sixteen
  is 44 ft at a 3.40 in RMS residual, which fits nothing well.
- **The segment mathematically cannot fit them**, and this is asserted as a
  test, not argued in prose. Over a common segment
  `Δ ≈ ½·a·t² = ½·(K·C_L·|v|²)·(L/|v|)² = ½·K·C_L·L²`, so `|v|` cancels: the
  **ratio** of any two pitches' break is just the ratio of their `C_L`, at every
  L. Measured true to 3 %, and identically at L = 40 and L = 50. The segment
  sets the *scale* of all eight together and can never change their relative
  pattern.
- **So the residual is in the arsenal's spin data or in unmodelled physics.**
  Published break ÷ C_L, normalised to the four-seamer: ff 1.00, si 1.04,
  ch 1.03 — then st 0.84, fs 0.74, cu 0.67, sl 0.61, **fc 0.47**. A cutter at
  2400 rpm / 75 % efficiency carries *more* effective spin than a four-seamer at
  2300 / 93 %, at a lower speed and so a longer flight, yet its published break
  is 44 % of the four-seamer's. No `C_L`, no segment and no air can produce
  that. Either its spin efficiency is really ~0.24, or seam-shifted wake — which
  this spin-only model does not have — is cancelling much of its Magnus break.
  The residual signs match the documented SSW directions: the sinker and changeup
  run *more* arm-side than their axis predicts, the cutter breaks *less*.
- Adopted 50 ft, not the RMS-optimal 44 ft, because 50 is nominated from
  **outside** this data (the tracking system fits every pitch's trajectory
  parameters at a plane 50 ft from the plate — that the public movement columns
  use that segment is an inference we have **not** verified) and confirmed from
  inside it: the three rows whose own tilt and break columns agree with each
  other independently require 49.8 / 51.1 / 50.8 ft. 44 ft is fitted to rows
  shown to be self-contradictory and makes the best-measured pitch in baseball
  worse (four-seam IVB residual +0.3 in at 50 ft, −3.3 in at 44 ft).

`C_D` and `C_L` were **not** touched, and no per-pitch correction was added. The
five resisting rows are pinned to the **model's own** numbers as golden values,
with their published values and residuals recorded beside them.

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
95 mph pitch covers 1.16 ft per substep against a 1.9 ft strike zone (measured:
the interpolated crossing state matches a 512× finer integration to 1.2e-3 in).
`crossingFraction` is **half-open, `t ∈ (0, 1]`** — the start of a substep is
excluded so a ball launched from exactly `z = 0` does not register ground contact
on its first step, and the end is included so a crossing landing on a substep
boundary is reported exactly once. No `Math.random`, no wall clock in any sim
file — seeded `mulberry32` only, and `determinism.test.ts` reads the sources and
fails on `Math.random`, `Date.now`, `performance.` or `new Date`.

`PITCH_TEMPO` (slow motion) **must never scale `dt`**. Gravity is linear in `dt`
while the aero terms go as `v²`, so a time-scaled `dt` re-weights them against
each other and silently rewrites every break number. Playback speed belongs to
the render layer; contact resolves at the true physical state.

## Key files

| File | Role |
| --- | --- |
| `packages/relay-ui/src/lib/baseball/units.ts` | ft/s/slug conversions, real `g`, the units rationale |
| `packages/relay-ui/src/lib/baseball/airPhysics.ts` | **THE** aero core: ball spec, `airDensity`, `aeroScale` (K), `C_D`/`C_L`, `aeroAccel`, RK4 `stepBall`, analytic event interpolation. Called by both the pitch and the batted ball — never copied |
| `packages/relay-ui/src/lib/baseball/airPhysics.test.ts` | The dynamics bench: prints the ρ→K, C_L(S), gyro-superposition, Magnus-sign, drag, break-convention, RK4-convergence and plate-crossing tables; asserts the derivations, the gyro projection, the Magnus sign and magnitude, and the drag calibration |
| `packages/relay-ui/src/lib/baseball/tuning.ts` | Every tunable number with its CATEGORY stated — fixed / derived / calibrated / feel knob. Owns `FIXED_MS`, `PITCH_TEMPO`, the break convention, the air defaults and the mirrored worker score clamps. Imports nothing |
| `packages/relay-ui/src/lib/baseball/zone.ts` | The shared geometry: release point, plate, rule vs called zone, `isStrike`, the reticle mapping, WORLD ↔ REPORT, `armSideX` — the one place the arm-side mirror is written |
| `packages/relay-ui/src/lib/baseball/pitches.ts` | The eight-row arsenal as DATA + `tiltAngleRad` / `spinVector` (tilt clock → real spin axis, gyro fraction included) + `validatePitches()`. The IVB/HB columns are TEST TARGETS and are never read by the sim |
| `packages/relay-ui/src/lib/baseball/pitchSim.ts` | Release-aim solve, the flight on stage 1's RK4, the sampled `PitchTrack` at TRUE physical time, the analytic plate crossing, and `measureBreak` on the pinned convention. Does not import `PITCH_TEMPO`, and a test reads the file to keep it that way |
| `packages/relay-ui/src/lib/baseball/pitchSim.test.ts` | The pitching bench: prints the segment sweep, the ratio-structure table, the per-pitch dynamics table, the pure-gyro and track tables; asserts the plate-speed loss, the aim solve, the ordering, determinism and the golden break values |
| `packages/relay-ui/src/lib/baseball/determinism.test.ts` | Source-reading guard: no `Math.random`, `Date.now`, `performance.` or `new Date` in any baseball source |
| `packages/relay-ui/src/lib/baseball/ip.test.ts` | Source-reading guard: no club nickname, real park name or `mlbstatic` host in the shipped game |

## Roadmap

- **Stage 1 — aero core.** → **Done:** `units.ts` (ft/s/slug, real `g = 32.174`,
  written against golf's arcade `GRAVITY = 16`); `airPhysics.ts` (MLB ball spec
  derived to mass/radius/area, `airDensity` with barometric + humidity, the
  derived `K = ρA/2m`, `liftCoef`/`dragCoef`, `aeroAccel` with per-call gyro
  projection, RK4 `stepBall` at `FIXED_MS = 1000/120`, `crossingFraction` /
  `lerpBallState` for exact event resolution); `airPhysics.test.ts` — 15 tests,
  printed tables, `C_D` calibrated to **0.300** giving 94.0 mph → **86.29 mph**
  at 55 ft against the published 86.3. Plus `determinism.test.ts` and
  `ip.test.ts`, the two source-reading guards.
  **Every assertion in stage 1 has been watched fail.** The original gyro test
  fed ω exactly parallel to `v`, where `ω̂ × v` vanishes with or without the
  projection — deleting the projection outright kept all ten tests green. Four
  more mutations passed too: flipping the Magnus cross product (a four-seamer
  *sinks* 22.8 in), changing the `C_L` slope 0.6 → 0.9 (a 30 % break error),
  computing `S` from the unprojected `|ω|` (2.15× the break on a gyro slider),
  and `C_D = 0.25` (87.59 mph, inside the old 86–88 band). All five are now
  killed, verified by re-running each mutation.
- **Stage 2 — pitching.** → **Done:** `tuning.ts` (every constant labelled, plus
  the worker's score clamps mirrored with a warning), `zone.ts` (release point,
  rule vs called zone, reticle mapping, WORLD ↔ REPORT, `armSideX`),
  `pitches.ts` (the eight-row arsenal, the tilt clock → spin axis with the gyro
  fraction carried, `validatePitches`), `pitchSim.ts` (aim solve to < 1e-6 ft,
  the `PitchTrack` at true physical time, the analytic plate crossing,
  `measureBreak`). 24 new tests over three files; `FIXED_MS`/`FIXED_DT` moved to
  `tuning.ts` and re-exported by `airPhysics.ts`.
  **`C_L` was NOT recalibrated** — see the segment sweep above. The one fitted
  number is `BREAK_SEGMENT_FT`, and the honest result is that no segment
  reconciles the eight; the finding is reported rather than absorbed into a
  per-pitch factor. Measured: plate speed 91.6–92.5 % of release across the
  arsenal, flight 0.410–0.485 s, four-seam break +0.3 in IVB / −0.4 in HB
  against published with nothing tuned to it.
  **Seven mutations were watched to fail** and reverted: mirrored tilt clock (5
  tests), dropped `activeSpin` factor (5), slider tilt shifted to a sweeper's
  (1 — only the golden pin catches it, which is what golden pins are for),
  dropped gyro component (3), plate crossing snapped to a substep instead of
  interpolated (4), stage 1's gyro projection defeated (7, two of them stage 1's
  own), and `BREAK_SEGMENT_FT` moved to the RMS optimum (4).
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
  makes every pitch the same pitch.
- **⚠ Test the projection by SUPERPOSITION, never by a parallel spin.** `ω̂ × v`
  vanishes for parallel vectors *whether or not the projection exists*, so a
  "pure gyro spin is inert" test passes an implementation with the projection
  deleted — which is exactly what stage 1 shipped at first, and why "exactly
  0.00e+0 across 9 cases" was an artifact of degenerate inputs rather than
  evidence. The test with teeth is `aeroAccel(v, ω) === aeroAccel(v, ω + c·v̂)`
  for an **oblique** `ω` and several `c`: adding pure gyro spin to an existing
  oblique spin must move the acceleration by nothing (measured ≤ 5e-15 ft/s²;
  the unprojected implementation moves it by up to 16 ft/s²). The general rule:
  **an invariant test must use inputs where a wrong implementation gives a
  different answer**, and you must watch it fail before you trust it.
- **The frame is load-bearing for the Magnus SIGN.** Backspin about `−y` on a
  `+x` ball gives `(−ŷ) × x̂ = +ẑ` — UP. Swapping the cross-product operands
  makes every fastball sink and passes any suite that only checks magnitudes, so
  the sign is asserted directly: `a.z = −8.956` against gravity-alone `−32.174`,
  i.e. 23.22 ft/s² of lift, with topspin the exact mirror and `+z` sidespin
  pushing toward third base.
- **Gravity is real: 32.174 ft/s².** Golf's `GRAVITY = 16` is a yard-space arcade
  fudge and is not transferable. Break is *defined* against a gravity-only
  trajectory, so g is load-bearing for the definition itself, not just the drop.
- **`K` is derived, never edited.** If a trajectory looks wrong the honest dials
  are `C_D` / `C_L` (calibrated against published data) or a labelled feel knob.
  Editing `K` disconnects altitude and weather from the ball.
- **0.002378 is the *59 °F dry* density.** Do not assert it for 70 °F/50 % RH;
  the right answer there is 0.0023168, and the 2.6 % gap is real carry.
- **`C_L` is published data — it is not a dial.** Never tune one pitch by nudging
  it. If the eight-row pitch table cannot be reached, the error is in the table's
  spin/tilt data, in the break-reporting convention above, or in `C_D` — a change
  that fixes the curveball and breaks the sweeper is the failure mode that rule
  exists to prevent.
- **Break numbers only mean something with a convention attached.** 22.59 in and
  15.23 in are the *same pitch* measured over 55 ft and 45 ft. Convert published
  targets into our convention; never move a coefficient to close the gap.
- **The measured segment sets SCALE, never SHAPE.** `|v|` cancels out of
  `Δ ≈ ½·K·C_L·L²`, so every pitch's break moves together when `L` moves and the
  ratios between pitches do not move at all. If one pitch is out relative to the
  others, `BREAK_SEGMENT_FT` is not the lever — its spin/efficiency data is, or
  the missing physics is. `pitchSim.test.ts` asserts the ratio law so that a
  per-pitch fudge factor is a test failure.
- **The tilt clock is FIXED IN SPACE and points the way the ball BREAKS.** 12:00
  is straight up, 3:00 is the third-base side (a RHP's arm side, a LHP's glove
  side) — which is why a RHP's fastball is quoted near 1:00 and a LHP's near
  11:00. It is not the raw spin axis: a pure-backspin fastball's axis is
  horizontal yet its tilt is 12:00, so `spinVector` rotates tilt 90° into an
  axis, once.
- **Spin is an AXIAL vector, so a LHP is not "a RHP with `y` negated".**
  Reflecting the lateral axis leaves the component *along* it alone (the
  backspin that makes IVB) and flips the two perpendicular to it — including the
  gyro sense, because a mirrored right-handed screw is a left-handed one. The
  gyro sign is invisible in the break (it is projected out) and wrong the moment
  a spin axis is drawn or a bat imparts torque.
- **A pure gyro pitch breaks 1.4 in, not 0.** The axis is fixed in space while
  gravity rotates the velocity ~6° through the flight, so an axis parallel at
  release is not parallel at the plate and a real sliver of transverse spin
  appears — 0.14 in over the last 10 ft, 1.44 in over 50 ft. That is physics, not
  a leak in the projection; the leak would show up in the 10 ft figure and in
  stage 1's superposition test.
- **The called zone is the rule zone plus one ball RADIUS a side (19.90 in),
  not a diameter (22.81 in).** A strike is any part of the ball over any part of
  the plate and we integrate the ball's *centre*, so the centre may sit one
  radius outside an edge. The 1.91 ft figure that circulates is the diameter
  version and would widen each side of the plate by an extra 1.45 in.
