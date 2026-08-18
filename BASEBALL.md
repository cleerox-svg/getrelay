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
| `C_D` supercritical | 0.300 | **calibrated** | 94.0 mph release → 86.3 mph \|v\| at the plate, spinless, 55 ft, **ISA air** — see below. UNMOVED by stage 3b |
| `C_D` subcritical | 0.500 | **published data** | the standard low-speed baseball drag coefficient (exact reference unverified). NOT fitted to the carry ladder — see below |
| crisis band | Re 1.1e5 → 2.0e5 | **calibrated**, published prior | the seamed-ball drag crisis region (1e5–2e5); pinned inside it by the carry ladder |
| crisis shape | quintic smootherstep | **assumption** | an interpolation, NOT a fit to C_D(Re) data. Quintic because the cubic costs RK4 its 4th order (measured 8.07 vs ~16) |
| `ν` | 1.57e-4 ft²/s | **published data** | air at 70 °F SL, held FIXED — flagged; worth ~28 ft of mile-high carry |
| `C_L(S)` | `1.5S` (S≤0.1), `0.09+0.6S` | **published data** | Alan Nathan's published baseball-aerodynamics lift fit (exact reference unverified — confirm before publication) |
| `C_L_MAX` | 0.35 | **feel knob** | safety clamp, NOT part of the fit; bites at S = 0.4333. Never binds in the pitch table; DOES bind in the batted-ball tail — measured, ≤0.65 ft of carry |
| `FIXED_MS` | 1000/120 | fixed | the one substep, shared by every consumer (`tuning.ts`) |
| `BREAK_SEGMENT_FT` | 50 | **calibrated** | the ONE number stage 2 fitted — see the segment sweep below |
| `PITCH_TEMPO` | 0.55 | **feel knob** | playback only; the sim cannot import it, and a test reads the source to prove it |
| release `d`, `h`, side | 54.0, 5.8, 1.9 ft | fixed | league-average Statcast release (6.5 ft extension) |
| zone | 17 in × 1.60–3.40 ft | fixed | rule book + league-average per-batter zone |
| called zone | 19.90 in × 2.042 ft | **derived** | rule zone + one BALL RADIUS a side (any part of the ball over any part of the plate) |
| bat M, z_cm, I_cm | 0.879 kg, 0.560 m, 0.0440 kg·m² | fixed | measured 33 in / 31 oz wood-bat swing weight (SI, as published) |
| bat-ball COR `e` | 0.50 | fixed | BBCOR ceiling / measured wood value at the sweet spot |
| `M_eff`, `q`, `eA` | 0.5816 kg, 0.2498, **0.2002** @ 0.72 m | **derived** | `1/M_eff = 1/M + (z−z_cm)²/I_cm`, `q = m/M_eff`, `eA = (e−q)/(1+q)` |
| `ω_bat`, bat speed | 32 rad/s, 71.5 mph | fixed | swing tracking / 2024 Statcast bat-tracking average |
| swing axis → sweet spot | 3.2771 ft | **derived** | `v = ωR` — the two published swing numbers, cross-checked |
| attack angle | +10° | fixed | MLB average |
| `e_T` | **0** | **derived** | the Coulomb STICK condition: reaching rolling costs `J_t/J_n = 0.084` against μ ≈ 0.4–0.6, so the grip fraction is forced to 1.0 — see below |
| reference undercut | 0.56 in | **calibrated** | the swing parameter that meets BOTH published bands at `e_T = 0` (window 0.552–0.582 in) |
| barrel | 98 mph, 26–30°, ±1°/mph | **published data** | Statcast classification, `tuning.isBarrel` |
| foul lines | ±45° | fixed | rule book (the lines are 90° apart) |
| park fence / roof / elevation | see `parks.ts` | fixed | **design data** for ORIGINAL parks — inputs to the physics exactly as the ball's mass is, and nothing is ever fitted to them |
| closed-roof air | 72 °F, 40 % RH | fixed | climate control — the number that makes a domed park deterministic |
| fielder sprint speed | 27 ft/s | **published data** | league-average sprint speed |
| fielder reaction | 0.5 s | **published data** | the reaction leg of published route work (reference unverified) |
| time to sprint speed | 1.8 s | **published data** | ⇒ `a = v/t = 15 ft/s²`, **derived**. Worth 24.3 ft of reach |
| infield arc radius | 95 ft | **published data** | the skinned-infield grass line, struck from the rubber (reference unverified; the *centre* is the ambiguity — see below) |
| infield dirt edge | `r(β) = d·cos β + √(95² − (d·sin β)²)` | **derived** | plate-centred distance to that arc, `d = RUBBER_D_FT`. 155.5 ft at 0°, 127.6 at the foul line. A FUNCTION: the arc is struck from the rubber and the lookup asks in plate polars |
| `XB_DEPTH_DATUM_FT` | 155.5 ft | **feel knob** | where extra-base depth credit is measured from. Deliberately FLAT, `= r(0)`, and argued on the constant — the throw back goes to a base, which does not move when the grass line curves |
| `GROUND_INTERCEPT_FT`, `XB_*`, `DEFENSE_SPAN` | 26 ft, 68/130 ft, ±15 % | **feel knobs** | the fielding lookup's bands — see the fielding section |

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

**`C_D` is Reynolds-dependent — the drag crisis.** `dragCoef(speedFps, S)` returns
0.500 below Re = 1.1e5 (~49 mph), 0.300 above Re = 2.0e5 (~88 mph), and a quintic
smootherstep between. Four numbers, four categories, all stated in `tuning.ts`:

- **0.300 is stage 1's calibration and it did not move** — see the paragraph
  below, which is unchanged. A 94 mph pitch lives at Re ≥ 1.9e5 and only grazes
  the top of the band, so it crosses the plate at 86.287 mph against 86.288 with
  the old constant. The repair is *free* against stage 1.
- **0.500 is published**, the standard subcritical drag coefficient of a
  baseball (reference unverified, flagged on the same standard as `C_L`'s fit).
  It was **not fitted to the carry ladder**: sweeping it against the six rungs
  gives an RMS optimum near 0.5375 (RMS 5.6 ft against 0.50's 9.5), and we kept
  0.50, so the ladder is an independent check that it passes rather than a fit it
  was built to satisfy.
- **The Re band is calibrated with a published prior.** The seamed-ball crisis
  sits in 1e5–2e5 (a seam trips the boundary layer far below a smooth sphere's
  3.5e5); within that range the placement is load-bearing and the ladder fixes
  it — 1.0e5–1.9e5 gives +15.5 ft mean, 1.1e5–2.0e5 gives +7.7, 1.2e5–2.1e5
  gives −0.1 but starts eroding the pitch regime (plate speed 86.244 and
  falling). ⚠ The +15.0 / −0.6 / 86.17 this line used to quote were the *cubic*
  smoothstep's figures for the same three bands, left behind when the shape
  became a quintic; re-measured in stage 4's audit, the cubic still gives exactly
  those, so nothing drifted — only the prose was describing the wrong curve.
- **The shape is an assumption, not a fit**, and is labelled as such: we have no
  measured `C_D(Re)` dataset here. A linear ramp over the same band is worth
  1.5 ft of carry and 0.04 mph of plate speed. *Which* smooth shape was decided
  by measurement rather than taste: the usual cubic smoothstep is only C¹, its
  second-derivative jump costs RK4 its convergence order on the very pitch flight
  `airPhysics.test.ts` refines (halving ratio 8.07 where 4th order needs ~16),
  and the quintic restores it. ⚠ **Those ratios are that pitch bench's, not a
  global property.** Re-measured on a batted ball (100 mph / 27°, 4 s): at 1200
  or 0 rpm the halving ratios are 24.5 / 20.2 down to a ~1e-12 ft roundoff floor,
  but at the reference 2200 rpm they collapse to 2.0 / 3.1 / 7.4 with 150× the
  absolute error — and that is **`C_L_MAX`**, a C⁰ `Math.min` clamp binding for
  ~17 % of the flight, not `dragCoef`. On a fly ball the lift clamp is the
  limiting kink. Recorded, not acted on: 3.4e-7 ft at 120 Hz is eleven orders
  below anything gameplay can see, and softening the clamp would move carry.
- **ν is held fixed**, so the crisis sits at the same *speed* in every park. A
  park-local Reynolds number (ν is 21.6 % higher a mile up) would cut the
  mile-high bonus at 105 mph from +34.7 ft to +6.9 ft; the published altitude
  effect is ~25–30 ft on a 400 ft fly, which favours the fixed-ν answer. That is
  a check, not a derivation, and the flag stays.

**`C_D` = 0.300, and the conditions are part of the number.** ISA air (59 °F,
dry, `K = 0.00549317 ft⁻¹`), 55 ft of flight, spinless, and the 86.3 mph target
is the **vector magnitude** `|v|` — which is what a radar plate speed reports.
The gravity-free closed form `v_x = v₀·exp(−K·C_D·x)` inverts to `C_D = 0.2829`
(0.2902 in game-day air) — accurate, but a statement about `v_x`, not `|v|`.
The model lands `|v| = 86.29`, `v_x = 85.84`. Two documented biases of ~±0.2 mph
each remain and partly cancel: the game plays in thinner 70 °F/50 % RH air
(86.48 mph with the same `C_D`), and 55 ft measures to the plate's rear point
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
  L. (With exponential drag the cancellation is *exact*, not leading-order —
  `Δ = K·C_L·[(e^{kL} − 1)/k² − L/k]`, in which `v₀` does not appear at all,
  because `|v|` enters once through `a_M ∝ |v|²` and twice through `dt = dx/|v|`.)
  The model tracks the law to **4.3 % at L = 40 and 2.9 % at L = 50**, and that
  residual is *not* independent of L: it falls monotonically from 7.1 % at
  L = 20 to 2.4 % at L = 54, because the prediction evaluates `C_L` at the
  *release* spin parameter while the real `S` climbs as `|v|` decays — so a short
  segment measures only the last and slowest feet, where the true `C_L` has
  drifted furthest from the release value. What *is*
  independent of L is the thing the argument needs: no pitch's break **ratio**
  moves by more than **0.011** between a 40 ft and a 50 ft segment. The segment
  sets the *scale* of all eight together and can never change their relative
  pattern. Both figures are asserted; an earlier draft claimed "~2 %, and
  identically at 40 and 50 ft" on the strength of a loop that only ran those two
  lengths, and adding L = 30 would have failed its own bound.
- **Nor can the *shape* of `C_L` rescue it** — which has to be argued, not
  asserted, precisely because the identity above says break ratios *are* `C_L`
  ratios, and `C_L`'s citation is flagged unverified. (A merely proportional
  `C_L ∝ S` would move the slider's published ÷ C_L from 0.61 to 0.81 and the
  splitter's from 0.74 to 1.05, so the loophole is real.) What closes it uses no
  `C_L` at all, only that `C_L` is **monotone** in `S` — asserted over 501
  samples in `airPhysics.test.ts`, and a physical requirement rather than a
  fitting choice. The published table contains a **spin/break inversion**: the
  cutter has the *higher* spin parameter (S = 0.175 against the changeup's 0.152)
  and **half** the published break ratio (0.444 against 0.899). Over a common
  segment `Δ ∝ C_L`, so a monotone `C_L` makes that pair impossible for *any*
  fit. The curveball against the four-seamer is a second, milder instance
  (S 0.251 vs 0.197, break 0.768 vs 1.000). `pitchSim.test.ts` asserts both.
- **So the residual is in the arsenal's spin data or in unmodelled physics.**
  Published break ÷ C_L, normalised to the four-seamer: ff 1.00, si 1.04,
  ch 1.03 — then st 0.84, fs 0.74, cu 0.67, sl 0.61, **fc 0.47**. A cutter at
  2400 rpm / 75 % efficiency carries *comparable* effective spin to a four-seamer
  at 2300 / 93 % — 1800 rpm against 2139, so slightly **less**, which its spin
  parameter (0.175 vs 0.197) and its `C_L` (0.94× the four-seamer's) both agree
  with — at a lower speed and so a longer flight, yet its published break is 44 %
  of the four-seamer's. A 0.94× coefficient cannot make a 0.44× break: no `C_L`,
  no segment and no air can produce that. Either its spin efficiency is really
  ~0.24 (bisecting the model to its own published magnitude gives 0.2418), or
  seam-shifted wake — which this spin-only model does not have — is cancelling
  much of its Magnus break.
- **A separate, systematic finding worth more than the SSW story it replaced.**
  *All eight* arm-side horizontal residuals are negative: ff −0.37, si −1.94,
  fc −4.52, sl −5.17, st −3.77, cu −0.09, ch −3.91, fs −1.68 in, mean **−2.7 in**.
  A uniform sign across the whole arsenal cannot be evidence about *which*
  pitches seam-shifted wake should affect — the slider, sweeper and splitter
  share it with no SSW story to tell. It points instead at a model-wide or
  tilt-column bias, is unexplained, and is printed under the dynamics table so it
  stays visible. An earlier draft cited these signs as SSW corroboration; that
  claim was non-diagnostic and is withdrawn.
- Adopted 50 ft, not the RMS-optimal 44 ft, for exactly two reasons. **(1)** It is
  nominated from **outside** this data: the tracking system fits every pitch's
  trajectory parameters at a plane 50 ft from the plate — that the public
  movement columns use that segment is an inference we have **not** verified.
  **(2)** The single best-measured row independently requires it: the four-seamer,
  the only row whose tilt and break columns agree to better than 5° (1.1°), needs
  **49.8 ft** on its own. The sinker (51.1) and changeup (50.8) land there too,
  but they are **not** independent confirmations and were previously miscounted
  as such: the bisection matches break *magnitude* only, so "requires ~50 ft" and
  "published ÷ C_L ≈ 1" are the same statement, and that ratio is defined
  relative to the four-seamer. One constraint plus two consistency checks. (The
  changeup is in any case the second-*worst* row in the table by tilt/break
  agreement, 22.5° out, which is what `pitches.test.ts` says about it.) 44 ft is
  then rejected on its own terms: it is fitted to rows the inversion above proves
  mutually inconsistent, and it makes the best-measured pitch in baseball worse
  (four-seam IVB residual +0.3 in at 50 ft, −3.3 in at 44 ft).
- **Open question, held to the same standard as the length: where the segment
  *ends*.** It ends at `d = 0`, the plate's rear point, because that is the
  physics frame's origin — but the front edge is 1.42 ft nearer, and `C_D`'s
  calibration note already flags the identical ambiguity as one of its two
  biases. A segment running from the same 50 ft plane to the *front* edge measures
  15.39 in on the reference four-seamer against 16.31 in: **5.6 % / 0.92 in less**.
  (Sliding a whole 50 ft segment earlier so that it *ends* at the front edge costs
  only 0.13 %, so this is a question about the segment's length, not its
  placement.) Unverifiable from here, so it is flagged, not split.

`C_D` and `C_L` were **not** touched, and no per-pitch correction was added. The
**seven** resisting rows are pinned to the **model's own** numbers as golden
values, with their published values and residuals recorded beside them; the
four-seamer is the one row asserted against published numbers anywhere.

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

### The carry experiment — an independent test of the aero core

> ⚠ **Stage 3's most valuable result, and stage 3b's repair of it.** The
> experiment stands; the negative result did not survive one more step of
> diagnosis.

`C_D` and `C_L` were fixed entirely by the **pitch** regime: 0.4 s of flight,
86–94 ft/s-decaying-little, `S ≈ 0.2` and a constant spin. A fly ball is a
different regime in every one of those variables — 5 s of flight, a continuous
decay from 100 mph to ~50 mph, and therefore an `S` that **climbs** through the
flight as `|v|` falls. The published max-carry ladder is therefore an
**independent** test of the same two coefficients at a regime nothing fitted
them to. It does not corroborate them.

**The air and the spin are part of the number**, exactly as they are for break.
Quoted at **game-day sea level (0 ft, 70 °F, 50 % RH, ρ = 0.0023168)** — the air
the game is played in — with **2200 rpm** of backspin, the midpoint of the band
`e_T` is calibrated against and within 200 rpm of what the reference swing
actually produces. ISA sea level is 2.6 % denser and carries 2.6–5.0 ft shorter;
a mile up carries 29.4 ft further. Carry moves ~4 ft per 100 rpm of backspin, so
a carry figure with neither air nor spin attached means nothing.

| EV mph | published | stage 3 (const `C_D`) | resid | stage 3b (crisis `C_D`) | LA_opt | resid |
| --- | --- | --- | --- | --- | --- | --- |
| 90 | 330 | 395.0 @ 31.00° | +65.0 | **345.7** | 28.50° | **+15.7** |
| 95 | 360 | 424.7 @ 30.00° | +64.7 | **374.9** | 27.50° | **+14.9** |
| 100 | 400 | 453.9 @ 29.25° | +53.9 | **403.6** | 26.50° | **+3.6** |
| 105 | 430 | 482.5 @ 28.50° | +52.5 | **431.7** | 25.75° | **+1.7** |
| 110 | 455 | 510.6 @ 27.75° | +55.6 | **459.2** | 25.25° | **+4.2** |
| 115 | 480 | 538.1 @ 27.25° | +58.1 | **486.1** | 24.25° | **+6.1** |

Stage 3: mean **+58.3 ft**, uniformly positive, against a ±15 ft corroboration
bar. Stage 3b: mean **+7.7 ft**, RMS 9.5, inside it.

**No constant `C_D` repairs it, and stage 3 was right about that.** Refitting a
single `C_D` against the six rows (a one-off diagnostic; it needs a second
integrator, so it is not shipped) lands at **0.385**, RMS residual 13.2 ft, and a
residual **spread of 35 ft**: +21.5 ft at 90 mph falling monotonically to
−13.2 ft at 115. Worse, `C_D = 0.385` puts the reference four-seamer at the plate
at **84.1 mph** against the published 86.3, a 2.2 mph error where stage 1
calibrated to ±0.4.

**What repairs it is a Reynolds-dependent `C_D` — the drag crisis**, described in
the constants section above. It is *free* against stage 1 and 2: a pitch never
drops below ~72 mph, so it barely samples the crisis band, and the four-seamer
still crosses the plate at 86.287 mph. A fly ball decays to ~45 mph and samples
all of it. **That is why one constant could not serve both regimes**, and it is
the step stage 3 stopped one short of.

**Spin-dependent `C_D` is ruled out as a standalone**, by arithmetic rather than
by preference: holding `C_D(S = 0.211) = 0.300` for the pitch while the fly ball
needs `C_D(S ≈ 0.30) ≈ 0.385` implies `dC_D/dS ≈ 0.95` and `C_D(0) ≈ 0.10`, an
absurd spinless drag. The `S` argument stays in the signature and stays unread.

**The launch-angle overshoot was the same defect.** Stage 3 recorded the 31.0°
optimum at 90 mph against a briefed 25–30° as "a brief error"; that was the wrong
adjudication. The one change that fixed the carry moved that rung to **28.5°**
with nothing else touched. ⚠ Honest remainder: the ladder is now **28.50 → 24.25°**,
so the *bottom* undershoots — 24.25° at 115 mph is 0.75° below the briefed 25.
The tests assert 24–29 and say why.

**Still nothing fudged.** `C_L` did not move, `C_D`'s supercritical branch did
not move, and there is no carry factor, no per-regime coefficient and no
launch-angle correction. The model's own ladder stays pinned as goldens with the
published values beside it as residuals — stage 2's precedent for the seven
resisting pitch rows — and a carry fudge smuggled in later is still a test
failure (verified: a 0.87 factor kills 8 tests; reverting `dragCoef` to the
constant kills 11).

⚠ **The residual's dominant input is an assumption.** 2200 rpm of backspin is not
a published column of the carry table, and the mean residual runs −9.3 ft at
1200 rpm to +10.5 ft at 2500. So "+7.7 ft" carries ±10 ft of assumption with it,
and the claim the tests assert is the one that survives every rung: **inside the
±15 ft bar at every backspin from 1200 to 2500 rpm**, which the pre-repair
+58.3 ft was at none of them.

⚠ **The slope argument was overstated and has been weakened.** Stage 3 compared a
two-point *endpoint* slope — published 6.00 ft/mph against the model's 5.72 — as
though that 0.28 were a finding. A least-squares line through the six published
rungs has slope **6.086** with residuals −3.1, −3.5, +6.0, +5.6, +0.2, −5.2 ft:
the table scatters ±6 ft about its own trend, so any slope claim finer than
~0.5 ft/mph is noise. The model's 5.61 agrees to well inside that. What *is* safe
is the SPREAD argument (a 35 ft spread against ±6 ft of scatter), and that is
what the constant-`C_D` refit is rejected on.

What the model gets right, and is asserted: the carry optimum sits at 24–29°
rather than the drag-free 45° (with the spin removed it jumps to 37.25° and loses
49 ft, which is the contrast test), the optimum **falls monotonically** as exit
velocity rises, backspin is worth 24.2 ft between 1000 and 2500 rpm at
100 mph / 27°, a 400 ft fly near its optimum hangs 5.29–5.79 s, and thinner air
carries further through `K` alone.

⚠ **`C_L_MAX` is a feel knob and in this regime it BINDS** — stage 1's "it never
binds anywhere" was true of the pitch table and false here, and the extra
end-of-flight drag sharpened it. A fly ball's `S` climbs as `|v|` decays, so the
ladder runs clamped for up to **33 %** of a flight (90 mph rung). Measured, that
is worth **≤0.65 ft** of carry, because the clamp only ever bites in the slow
tail where the aero forces are small — so the ladder measures `C_L`, not the
knob, and the knob was left at 0.35 rather than raised. Where it *is* material
the assertion says so: the 1000→2500 rpm backspin figure is 24.2 ft clamped
against 27.5 unclamped (14 % of it is the knob, and its 2500 rpm end runs 56 %
clamped), and the undercut sweep's 4000–7000 rpm rows are 97–100 % clamped at
`S` up to 1.3 — which is the clamp doing its labelled job on exactly the absurd
inputs it exists for. `battedBallSim.test.ts` prints the accounting every run.

### The collision — two published targets, met at once

The bat-ball collision is **one** oblique rigid-body impulse solve: normal
restitution with the bat's effective mass, tangential restitution with `e_T` and
angular impulse on a uniform sphere. Exit velocity, launch angle, spray angle,
backspin **and** sidespin all come out of it — there is no launch-angle curve and
no backspin lookup, and a pulled ball hooks foul because the same solve gives it
sidespin, not because anything scripts it.

> ⚠ **RETRACTED, stage 3b: "`e_T` cannot satisfy both published targets".** It
> can. Stage 3 varied `e_T` at a **fixed 0.75 in undercut**, where launch angle
> and backspin do move in opposite directions:

| `e_T` | LA | backspin |
| --- | --- | --- |
| +0.46 | 26.2° | 5866 rpm | ← the LA that `LA = θ_LOC + α` predicts |
| +0.20 | 29.0° | 4430 rpm | ← the textbook rigid-surface value |
| **0.00** | 31.2° | 3325 rpm | ← exact rolling (the patch stops sliding) |
| −0.20 | 33.4° | 2220 rpm | ← what stage 3 shipped |

**But the undercut is not published data — it is a free swing parameter**, so
holding it fixed asks whether one arbitrary swing can hit both targets, not
whether the model can. Over the 2-D `(e_T, undercut)` region the bands overlap
for **`e_T ∈ [−0.16, +0.02]`**: at `e_T = 0` an undercut of 0.5517 in gives
LA 25.0°, backspin 2350 rpm and EV 101.7 mph, both bands at once.

**And `e_T` is not a calibrated dial at all — it is derived.** The solve needs a
tangential impulse of only `J_t/J_n = 0.084` to bring the contact patch to
**rolling** (0.103 at the 0.75 in undercut stage 3 swept at), against μ ≈ 0.4–0.6
for leather on wood: the contact sits ~5–7× inside the **stick** regime, so the
patch must reach rolling and the grip fraction `(1 + e_T)` is forced to exactly
**1.0**. Nothing in a rigid-body impulse solve removes tangential impulse while
friction is in surplus, so stage 3's "still sliding forward at 20 %" had no
mechanism behind it. The physically admissible range is `e_T ∈ [0, +0.2]` — 0 is
Coulomb stick, positive is tangential *compliance*, which is what the textbook
bat-ball `e_T ≈ +0.2` measures. **Admissible ∩ feasible = [0, +0.02]**, and
**`e_T = 0`** is shipped: the principled end of it, with zero free parameters.

**The reference swing's undercut moved with it, to 0.56 in** — a swing parameter,
chosen against the two published targets rather than left at an arbitrary value.
It gives LA **25.26°**, backspin **2391 rpm**, EV **101.60 mph**. ⚠ The
joint-feasible window is **narrow** — 0.552 to 0.582 in, LA 25.0–25.9° — because
it is the corner where the two published bands just overlap. That narrowness is
the honest residue of stage 3's finding, and `batSim.test.ts` prints the region.

⚠ **The "~2.7×" was a mislabel.** 2.643 is the *backspin* ratio between
`e_T = +0.46` and `−0.20`, not a tangential impulse. The impulse gap is the ratio
of grip fractions, and at the fixed 0.75 in undercut the bands' nearest edges are
`e_T = +0.2024` (LA 29.0°) and `e_T = −0.1493` (2500 rpm): **1.413×**. What
survives, stated precisely: *at any fixed undercut* the two bands are disjoint by
1.413× in tangential impulse. The bat's own tangential recoil (4.7 % of full mass,
7.1 % of `M_eff`) does not close that, and does not need to.

`LA ≈ θ_LOC + α_attack` still **under-predicts** this model's launch angle — by
**3.3°** on the reference swing (21.96° predicted, 25.26° produced), because the
rule assumes the tangential velocity is entirely scrubbed off and even at 100 %
grip it is not. Stage 3 measured that gap at ~7° at 80 % grip; it shrinks with the
grip fraction but does not vanish.

> ⚠ **The rigid-body model has no bat vibration**, so it puts the "sweet spot" in
> the wrong place. `M_eff` peaks at the *balance point* (0.560 m) and `e` is
> constant, so `eA` keeps rising toward the handle: 4 in toward the barrel tip
> costs **11.53 mph** (right, and for the right reason — `M_eff` collapses), but
> 4 in toward the handle **gains 2.71 mph**, where a real bat loses because the
> sweet spot sits on the fundamental bending node and `e` collapses away from it.
> Both numbers are pinned as goldens so the gap stays visible. Closing it needs a
> measured `e(z)` profile, which this stage has no data for.
>
> ⚠ **And it has a second, larger consequence: the model has no jamming at all.**
> An inside pitch is a smaller aim radius — contact nearer the hands — so the same
> rising `eA` **rewards** it. Measured on time: sweet spot 101.60 mph, 2 in inside
> 104.26, **peak 104.62 at 3 in inside**, 4 in inside 104.31, and it does not fall
> back below the sweet-spot value until ~6 in inside. An inside pitch makes this
> batter stronger for six inches. Same root cause, same fix (a measured `e(z)`),
> and it is asserted so the retraction below cannot quietly lapse.

**Timing is one rotation model**, `ω_bat = 32 rad/s`, and both of its gameplay
consequences come from the same two lines. The bat is a ray from the swing axis;
the ball travels a line at perpendicular distance `d`; so with the swing displaced
by `Δt`, `θ_c = −ω·Δt·v_p/(ωd + v_p)` and `R_c = d/cos θ_c`.

- **The ball keeps moving**, and that second factor is the whole content of it.
  The naive "spray shift = `ω·Δt`" gives 45.8° of bat rotation at 25 ms; contact
  actually happens **1.46 ft** deeper (`v_p · contactDelayS`) and the bat is only
  **25.5°** from square when it gets there. ⚠ *Not* 3.3 ft — that is `v_p · Δt`,
  precisely the naive quantity this bullet exists to refute, and an earlier draft
  of this line and of `batSim.ts`'s quoted it. The *ball* is nevertheless deflected
  **−43.8°**, past the bat angle, because it keeps some tangential velocity — so a
  ±35°-scale spray falls out, by a different mechanism than the rule of thumb it
  comes from. 43.8° is 1.2° **inside** the foul line: a 25 ms early swing on this
  pitch is barely fair, which is a gameplay fact and is asserted as one, with
  two-sided mirrored bounds rather than the one-sided `≤ −35` that would have
  passed at −80° too.
- **`R_c > d` for a miss in either direction**, so any mistiming drives contact out
  toward the tip where `M_eff` collapses: 25 ms off costs 9.2 mph of exit velocity
  and 20 ms off costs 56.3 ft of carry, early or late, with no second knob.
- ⚠ **It is therefore symmetric**, and does **not** reproduce "late = jammed at the
  handle". In this geometry a late swing meets the ball deeper and further out the
  barrel, not nearer the hands. ⚠ **RETRACTED, stage 3b:** an earlier version of
  this bullet resolved that by saying getting jammed "is a property of an inside
  pitch (a smaller aim radius `d`), which is `aimZM`'s job". It is not — see the
  aim-radius measurement above; the model has **no jamming mechanism anywhere**,
  and this is a second consequence of the missing `e(z)`, not a resolution. The
  symmetry is still asserted so nobody closes it with an asymmetric fudge.

### The park — data, and three mechanics that come out of it

A park is a **data entry and zero code**: `parks.ts` holds the `Park` shape and
the generic fence/roof/air machinery, and `parkValidate.ts` holds a
`validatePark()` that `parks.test.ts` runs against a deliberately-broken park
(16 distinct complaints, asserted individually). Adding a venue is a row in
`PARKS`.

**M1's home park is `SkyDome`**, and its dimensions are **published data**:

| station | distance | wall height |
| --- | --- | --- |
| LF line | 328 ft | 14 ft 4 in |
| LC | 368 ft | 11 ft 2 in |
| LC alley | 381 ft | 12 ft 9 in |
| CF | **400 ft** | **8 ft 0 in** |
| RC alley | 372 ft | 10 ft 9 in |
| RC | 359 ft | 14 ft 4 in |
| RF line | 328 ft | 12 ft 7 in |

plus a 60 ft backstop, 28 ft of foul ground down the lines, 250 ft of elevation
and a retractable roof 282 ft up. A published dimension is a **fact** — the same
category as the ball's mass — and nothing in the physics is ever fitted to one.

> ⚠ **THE NAME IS AN OWNER DECISION, RECORDED RATHER THAN ARGUED.** `SkyDome` is
> the former official name of a real venue; the trademark exposure (registrations
> historically maintained, residual goodwill in a former official name) was put
> to the owner on **2026-08-17** and the owner chose to ship it. It is their
> product and their risk to price. What this repo owes is that the decision is
> *visible* and *cheap to reverse*: the display name is the single exported
> constant `SKYDOME_NAME` in `parks.ts`, the park **id** does not move (it is a
> persistence key), and `ip.test.ts` now lists the name as a **banned real-park
> name with a dated, one-row exception**. That shape matters: the guard's list
> had no entry for it at all, which would have let the *next* legacy name through
> in silence. `ip.test.ts` also asserts each exception is live, carries a date
> and names its reversal path — so reverting `SKYDOME_NAME` makes the exception
> itself a test failure.
>
> ⚠ **THAT LAST CLAUSE WAS FALSE AS SHIPPED, AND IS NOW TRUE.** The liveness
> check asked only whether the term appeared *anywhere* in the scanned files, and
> three things satisfied it independently of what the park is called: the
> constant's own identifier (`SKYDOME_NAME` matches `/\bskydome\b/i`, so the
> variable vouched for its own value), the comments explaining the decision, and
> two test-table headers (`parks.test.ts`'s `[SKYDOME FENCE …]`,
> `fielding.test.ts`'s `[END TO END — SkyDome …]`) in files that ship nothing.
> Measured: reverting the constant, renaming the identifier and deleting the
> prose each left all three tests **green**. The check now requires the term in a
> **string literal of a non-test source** — text that reaches a user's eyes — and
> all three probes fail. The probe table is at the foot of `ip.test.ts`. The
> lesson generalises past this one row: a source-reading guard that greps raw
> text is satisfied by *talking about* the thing it polices.

⚠ **The bearings are ours; the distances are not.** A published profile names
*positions* ("LC alley"), not angles, so the seven are placed at even 15°
intervals in the order the profile lists them — no invented precision. What the
order *does* fix is that the distances are monotone on each half with dead centre
the strict maximum, so Fritsch–Carlson's zero slope at an extremum puts the
park's deepest point exactly on the published 400 ft.

⚠ **The backstop and the foul-ground depth are two fields now**, and that split
is a gameplay bug avoided rather than tidiness. `foulTerritoryFt` is read by
`fielding.ts` as the depth of a uniform catchable band running the *whole length*
of the foul line; setting it to the published 60 ft backstop made a **437 ft ball
5° foul a CATCH**. A real park has the stands almost on the line in the corners
and a deep well behind the plate, which is two numbers. `backstopFt` is
geometry-only (nothing in the physics reads it) and `stands.ts` clamps the bowl's
offset curve to it — the two hand over at |β| ≈ 72.8°, asserted in closed form.

⚠ **The height column now inverts the usual assumption**: dead centre is the
**deepest** wall in the park *and* the **lowest** (8 ft), while both corners are
over 12 ft and left is 14 ft 4 in. That is a real gameplay effect and it is
measured, not asserted — see the trough result in the M3 roadmap entry.

⚠ **And it is the first data in this repo the height interpolant can get wrong.**
Every knot used to carry a uniform 10 ft, so `pchipAt` on the height column was
reproducing a constant and a stage-4 mutation that pinned the height to its first
sample changed nothing at this park. Four local extrema later, that mutation
fails 7 tests. `parks.test.ts` asserts the property the choice rests on directly:
**no bearing reports a distance or a height outside the envelope of the two knots
bounding it** — measured worst overshoot **0.000e+0 ft** over the whole span at
both parks, where deleting Fritsch–Carlson's extremum guard fails 10 tests.

A second park, `Alpine Heights` at 5200 ft, exists so that **altitude can be
measured** rather than asserted — it is deeper, asymmetric, and carries a 16 ft
wall in left-centre. It also carries `surroundings: 'none'` against SkyDome's
`'city'`, which is the same "content is data, not a branch" rule the roof obeys:
the skyline builder returns an empty group for it rather than putting a downtown
tower on a mountain.

**The fence between samples is a monotone cubic Hermite** (Fritsch–Carlson /
pchip, in `pchip.ts` with the full argument). A wall is piecewise *smooth*, not
polygonal, and the interpolant answers to the physics and the renderer at once.
Linear in polar is C⁰ — measured, the one-sided slopes at the −22° knot differ by
**0.66 ft/deg**, which is five samples becoming five visible creases; pchip's
differ by **< 0.01**. A natural cubic is C² but global and it *rings*, bulging
past the sampled 400 ft at dead centre — inventing a distance the data does not
contain at the one bearing the park is defined by, and perturbing the whole curve
when a sample is added. Fritsch–Carlson is C¹, **local** and **overshoot-free**,
and sets the slope to 0 at a local extremum, so centre field is the true maximum
of a symmetric park. C¹ over C² is deliberate: no-overshoot is a *correctness*
property of a gameplay boundary; curvature smoothness is cosmetic. Outside
±45° the curve is **clamped, not extrapolated**.

⚠ **And it is now tested, which it was not.** `pchip.ts` shipped without a test
file: the only assertion that could see the interpolant was `parks.test.ts`'s
"it is not secretly linear" line, and a stage-4 review measured how thin that
was — zeroing every **interior knot slope** (deleting Fritsch–Carlson, keeping
the Hermite basis) moves Harbourfront's fence by up to **4.97 ft** and Alpine's
by **5.33**; zeroing *every* slope moves Harbourfront **6.54 ft** and Alpine's
wall **height 2.67 ft**. All 124 tests passed either way. A 5 ft error in fence distance is a
home run that isn't. `pchip.test.ts` now asserts the properties the choice rests
on — interpolation at the knots, **exact reproduction of a straight line** (the
one a wrong knot slope cannot fake), no-overshoot against an unlimited Hermite
that dips to −0.074 on the same data, locality (a moved sample changes the curve
by 0.52 beside it and by **exactly 0** past its second neighbour), zero slope at
an extremum, and the degenerate 0/1/2-knot cases — and then pins **GOLDEN
off-knot fence distances** at −33°, −12° and +12° in both parks, because every
property above is *also* true of an interpolant with the wrong slopes in it.

**The roof is a real mechanic.** Closed ⇒ wind is **exactly** `vec3(0,0,0)` (the
test asserts `=== 0`, not a tolerance), the temperature is pinned to 72 °F and the
humidity to 40 %, so ρ and therefore `K` are constants and **the park is
deterministic**: two unrelated seeds give byte-identical `track` arrays and an
identical `carryFt` to the last bit. That is what ranked play will default to.
Open ⇒ a seeded draw of temperature, humidity and wind — measured, 427–438 ft on
the same 103 mph swing against 422.6 ft with the roof shut.

⚠ **The wind's bearing window is UNIFORM, and the field that centres it is no
longer called `prevailingDeg`.** It was, and it was the *least* likely bearing
the sampler produced: the old mapping ran golf's `windBearing`
(`atan2(cross, along)`) onto the window, and golf damps `along` to 0.6× so
`cross` dominates — which piles the mapped bearing at **±swingDeg/2**. Measured
over 4000 seeds at Harbourfront (window ±60°): 0° drew **3.1 %**, ±30° drew
**7.2 %** each. That bimodality was an artefact of an upstream damping constant,
not a model choice, and a field named "prevailing" that is the rarest outcome is
a trap for the next park author. The bearing is now drawn uniformly across
`bearingCentreDeg ± swingDeg` **from the same seeded `mulberry32` stream** as the
temperature and humidity — one PRNG still, and no dependence on golf's internals,
so a golf retune cannot silently re-shape it. Uniform rather than peaked is the
honest ceiling: golf's underlying angle is uniform on the full circle, so no
mapping of one draw yields a genuine mode without inventing a distribution.
`parks.test.ts` asserts the histogram's *shape*, which is the only thing that can
see this class of bug — no single seed can.

⚠ **The 282 ft ceiling is enforced but essentially never bites**, and that is a
finding, not a bug. A ball reaches it only above **~120.2 mph** exit velocity hit
near-vertically (115 mph apexes 262.9 ft); a 125 mph ball at a *home-run* launch
angle apexes 200.3 ft, so **the roof never converts a home run**. What it does
convert is the hardest pop-up in the sport, which is roughly what a real dome roof
does. There is **no deflection model** — the dimension is enforced by ruling such
a ball `'roof'` (never a home run, played live where it lands); a restitution and
a panel normal are data we do not have.

**Wind is a Galilean boost, not a second integrator.** Both aero forces depend on
the *air-relative* velocity and gravity is invariant under a uniform translation,
so in a frame moving with a uniform wind `w` the equations of motion are exactly
the ones `stepBall` already solves: integrate from `v − w`, then add `w·t` back to
every sampled position. Stage 1's integrator, stage 1's coefficients, no copy —
and the equivalence is an identity — asserted against an **independent
ground-frame RK4 that carries the wind inside the accelerator** (`a(v) =
aeroAccel(v − w)`, i.e. the "add a wind term" implementation the boost replaces),
worst |Δ| **5.7e-13 … 1.4e-12 ft** over three winds and full flights. ⚠ That test
used to compare the boost against `p_air + w·t` recomputed from a *bit-identical*
air-frame integration and report `0.00e+0 ft over 652 substeps`. The number was
real and the derivation is right, but the evidence was **circular** — both sides
evaluated the same expression, so it could not have printed anything else, and it
killed only a sign flip and a `dt`-for-`t` slip. The residual is now small and
**nonzero**, which is what a measurement looks like. Two conditions come with it and both are enforced: `w` must be
**horizontal** (the ground crossing is solved on `z`, which is frame-invariant
only while `w.z = 0`; `w.z` is ignored, not silently integrated) and **uniform and
constant**. With `w = 0` the boost is skipped outright, so every stage 1–3 golden
is byte-identical. Independent check nobody fitted: a 10 mph wind straight out is
worth **+24.2 ft** on a 400 ft fly against a commonly published 20–25 ft, and a
10 mph headwind costs **33.4 ft** — more than the tailwind gains, which is the
right asymmetry for a `v²` drag law.

**Home-run resolution** walks the flight against `r − fence(bearing)` and resolves
the crossing **analytically** with the same `crossingFraction` every other event
uses; snapping to a substep moves a home-run call by most of a foot of wall
(mutation-verified). Above the wall ⇒ home run, below ⇒ off the wall, `|spray| >
45°` ⇒ foul with the pole itself **fair** (asserted two-sided and mirrored).

⚠ **A 400 ft *carry* is not a 400 ft home run**, and the tests say which 400 they
mean. A ball whose carry is exactly 400 ft lands at the base of a 400 ft wall and
is **in play**; clearing the published 8 ft wall there takes **407.2 ft** of
carry. The asserted boundary is on the *distance at wall height* —
`distanceAtHeight(flight, wall.heightFt)` — which is the quantity the resolver
actually compares: 400 ft + ¼ in clears, 395 ft does not (2.509 ft at the fence,
off the wall).

⚠ **And the exactly-400.000 row is now BRACKETED rather than sat on.**
`resolveFence`'s height test is strict (`pz > wall.heightFt`), so a ball bisected
to arrive at exactly wall height at exactly the fence is a coin flip on the last
bit. It happened to land on `homeRun` under the old uniform 10 ft wall and lands
on `offWall` under the published 8 ft one, **with nothing about the resolver
having changed** — a boundary test whose verdict depends on which side of a float
a bisection stops is not measuring the boundary. The clearing row is a quarter of
an inch over and the exact row is *printed* with whatever the resolver calls it.

### Altitude is derived — and the like-for-like number is inside the band

There is **no park factor** and there must never be one. Elevation reaches the
ball through `ρ → K` and nothing else; `parks.test.ts` holds a swing fixed, changes
only the air, and reads the gain.

| elevation | carry @ 27° | Δ | carry @ LA_opt | Δ |
| --- | --- | --- | --- | --- |
| 0 | 400.0 | — | 400.0 | — |
| 2500 | 414.3 | +14.3 | 414.5 | +14.5 |
| **5200** | **429.1** | **+29.1** | **430.0** | **+30.0** |
| 5280 | 429.5 | +29.5 | 430.5 | +30.4 |

Published altitude effect on a 400 ft fly: **~25–30 ft**. The model is **inside
the band**, at its top edge.

⚠ **This corrects stage 3b's "slightly high" reading, without moving a constant.**
That note compared **+34.7 ft** against the same 25–30 band — but +34.7 is the
105 mph *max-carry* rung, a **432 ft** fly, and the altitude gain is superlinear
in flight length (8.03 % of a 432 ft fly against 7.61 % of a 400 ft one).
Measured the way the published figure is *stated*, the model gives +29.1. Both
numbers are reproduced and asserted in the same test, so the reconciliation is
arithmetic rather than a story. `ν` did **not** move; only the yardstick was
corrected, and the fixed-ν choice is better supported than before.

### Fielding — the smallest model in the game

Landing point + hang time + **one** defender rating → out / 1B / 2B / 3B / HR.
No stolen bases, errors, substitutions, shifts, positioning, throws, cutoffs or
baserunner state. `fielding.ts` is 323 lines against a 500-line cap, and the cap
is the design — a third of it is the argument for the infield arc below.

- **The alignment is a constant** — seven standing positions, polar from the
  plate. That constant *is* the "no shifts" rule expressed as data.
- **The dirt edge is an ARC, not a circle**, and it is a function of bearing.
  See below: this is the one thing M1's visual gate found, and it is physics.
- **Reach ramps.** `react (0.5 s) → accelerate (1.8 s to 27 ft/s) → sprint`. The
  ramp is not cosmetic: an instantly-sprinting fielder is over-credited
  `v·t/2 = 24.3 ft` on every play. On a 4 s hang the ramped model covers
  **70.2 ft** against the instant-sprint model's **94.5**, and the published
  envelope prices ~100 ft on a 4 s hang as a *five-star* play — so the 94.5
  version would make a five-star play nearly routine. (`fielding.ts` claimed
  "118 ft" for the naive figure until stage 4's audit; its own test has printed
  94.5 all along.)
- **The rating reaches exactly one quantity**, `reachFt`, over ±15 %. Measured, it
  flips a real play: a 310 ft ball with a 4.0 s hang 76.3 ft from the LF is a
  single at 0.0 and an out at 1.0.
- Off the wall is **never** an out; a corner (|bearing| ≥ 30°) is a triple.
- A foul pop is caught only inside the park's own `foulTerritoryFt`, so that
  field is live data rather than decoration — ⚠ and it is priced as a UNIFORM
  band of that depth running the whole length of the foul line, which is why the
  published 60 ft BACKSTOP could not be poured into it. Setting it to 60 made a
  437 ft ball 5° foul a catch. The backstop is `backstopFt`, a separate field,
  read by the geometry alone. A narrowing foul wedge is a model this does not
  have, and the two-field split is the honest way to say so.

⚠ **The stated limitation, pinned by a test.** The model reads the ball's
*landing point*, and a ground ball does not stop where it lands — it rolls to the
fielder, who throws. A routine grounder to short lands 25.1 ft from him with
0.55 s of usable time, in which he covers **2.3 ft**; `GROUND_INTERCEPT_FT = 26`
is a labelled feel knob standing in for the roll and the throw, and setting it to
0 makes every routine ground ball a base hit (mutation-verified, 2 tests). A
second clause caps any unfielded ball landing on the dirt at a **single** — load
bearing, not tidy: a chopper landing 7 ft in front of the plate is 100 ft from
the nearest fielder's *standing spot*, and without it the miss arithmetic scores
it a double. When the duel wants real infield play the fix is a rolling phase,
and both are deleted rather than tuned.

⚠ **The infield edge is an arc struck from the RUBBER — fixed in the geometry,
after two goes at fixing the label.** Stage 4 shipped `INFIELD_DEPTH_FT =
RUBBER_D_FT + 95 = 155.5 ft` and used it as a **plate-centred** radius; stage 4b
noticed and corrected the *comment*. M1 then drew it, and the visual gate
measured the rendered dirt/grass boundary at **155.6 ft** — the renderer adding
no error of its own, because `stadium/field.ts` imports the constant rather than
copying it. The real thing is a 95 ft arc struck from the rubber, so the
plate-centred distance is

```
r(β) = d·cos β + √(R² − (d·sin β)²)      d = RUBBER_D_FT = 60.5, R = 95
```

155.5 ft at 0°, 149.6 at 20°, 135.1 at ±38° and **127.6 at the foul line** — the
old circle over-stated the dirt by up to **27.9 ft** down the lines, i.e. a
140 ft ball down the line was scored as an infield chopper (and handed 26 ft of
`GROUND_INTERCEPT_FT` roll-and-throw credit) when it had landed on outfield
grass. `infieldDepthFt(β)` is exported and `stadium/field.ts` samples it bearing
by bearing exactly as it samples `fenceAt`, so the drawn dirt is the dirt the
fielder model uses. The discriminant can never go negative (`d < R` at every
bearing, behind the plate included), so a clamp appearing there later is a bug
rather than a safety net.

- **The centre is the ambiguity, not the radius.** Groundskeeping references
  strike this arc variously from the front of the rubber (60.5 ft) and from the
  centre of the mound circle (59). We use the rubber, because 60.5 is already
  published in `zone.ts`: measured, the two centres differ by **1.5 ft** at dead
  centre and 0.5 at the foul line, against the 27.9 ft being removed.
- **The baseline cutouts are not modelled and need not be.** Every one is
  strictly inside the arc — second base is 127.3 ft out against an arc at 155.5,
  a 13 ft cutout around first reaches 103 against an arc at 127.6 — so the arc is
  the outer boundary of the dirt at every bearing, and "did this land on the
  dirt" needs nothing else.
- ⚠ **And the ladder moved — one class of call, 0.60 % of the lookup.** Swept
  over distance × bearing × hang × rating (1,228,500 cases), **7,376** change and
  every one is **OUT → SINGLE**, all at **130–155 ft** and **|β| 6–45°**: exactly
  the balls that were landing on outfield grass and being credited as infield.
  None of the thirteen named ladder rows moves. That is the whole behaviour
  change.

⚠ **The extra-base DEPTH DATUM was split off, and that is the judgement call in
the fix.** The obvious move once `infieldDepthFt` became bearing-dependent was to
measure the extra-base depth credit from the arc too — one symbol, one concept.
Measured, *that* is what moves the lookup: it re-calls **2.2 %** of the same
sweep, of which the dirt-boundary fix is 7,376 cases and the datum a further
**19,606** (12,470 SINGLE→DOUBLE, 7,136 DOUBLE→TRIPLE), and it flips two of the
thirteen named rows — the 'bloop into shallow RC' from 67.29 to 68.17 against a
68 ft threshold, and the 'deep LC screamer' from 129.42 to 131.20 against 130.
**Both flips are the datum; neither is the boundary.** There is no mechanism
behind them — but *not* because the bearing effect is imaginary. **The infield
arc is the wrong functional form for it.** The throw back really is longer down
the line: second base sits 127.28 ft out at 0°, so a 320 ft ball at 45° is
**247.0 ft** from it against **192.7 ft** for a 320 ft ball to centre — 54.3 ft of
extra throw, ~**16.3 ft** of index at `XB_DEPTH_PER_FT`. An arc datum hands that
same ball **8.4 ft**: half the magnitude, and derived from the curvature of a
grass line that has nothing to do with where anybody throws. Right sign, wrong
size, wrong cause — a coincidental proxy, not a mechanism. Pricing the effect
honestly would mean a law of cosines to the **bases** plus a re-fit of
`XB_DOUBLE_FT`/`XB_TRIPLE_FT`, which is a different change from the one-line
`infieldDepthFt(inp.bearingDeg)` that prompted it. So `XB_DEPTH_DATUM_FT` is a
flat **feel knob** at `infieldDepthFt(0)`, and the counterfactual is *computed and
printed* by `fielding.test.ts` rather than argued, because keeping it flat is also
what keeps the ladder still and a reviewer is entitled to suspect that is the
reason.

⚠ **A correction to this section's own earlier claim (M1 review).** It said the
real bearing effect was "already priced twice, through `missFt` … and through
`CORNER_DEG`". Half of that was false. `CORNER_DEG` occurs in exactly one
non-test place — the `outcome === 'offWall'` branch of `fieldBattedBall` — which
**returns before `xb` is computed**, so it never executes on the extra-base path
and prices nothing there. The `missFt` half stands and is the argument: the LF is
80.1 ft from the ladder's 320 ft/−43° ball down the line while the CF is 15.0 ft
from its 330 ft ball to centre, both printed. **One** honest bearing term, not
two. The decision does not change — a third, implicit one is still unwelcome —
only the count and the reason.
⚠ One consequence, and it is a real change from stage 4b: the depth term can now
go **negative** (to −8.37 ft at the foul line) for a ball past the arc but nearer
than 155.5 ft. It is still not clamped — such a ball is shallow, the throw back
is short, and a debit is the correct sign.

⚠ **Two audit corrections, stage 4b.** (1) The extra-base index carried a
`Math.max(0, …)` on the depth credit that was **provably unreachable** — the
infield-cap clause above it has already returned for everything shallower — so
"one mechanism now" was not true, it was one live mechanism and one dead one.
The dead branch is deleted. ⚠ Deleting it exposed something the clamp had been
hiding: the two clauses are equivalent **in effect**. Swept over the entire
infield (every distance, bearing, hang time and rating), the index a shallow ball
could reach without the cap peaks at **39.25** against the 68 ft single/double
threshold — so deleting the *cap* changes no call either, and its mutation is
**unobservable rather than merely unobserved**. The cap stays (it is the explicit
statement of the rule, and 28.75 ft of margin is an artefact of today's feel
knobs, not a theorem) and `fielding.test.ts` now **measures the margin**, so the
day a knob narrows it is a test failure rather than a wrong call. (2) The named
batted-ball ladder in `fielding.test.ts` is now labelled **GOLDEN** in the test
name and in the printed table: nothing outside this repo publishes "a 355 ft fly
with a 4.6 s hang is an out", so every row is frozen model output and a row that
moves is a decision to make, not a bug to fix. That distinction is what separates
it from the carry ladder, whose right-hand column really is published.

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
| `packages/relay-ui/src/lib/baseball/bat.ts` | The bat as DATA + derivations: the SI bridge, the published 33 in / 31 oz spec, `effectiveMassKg` / `massRatio` / `collisionEfficiency` (all derived, `eA` is a function so nobody can write the literal 0.20), the swing constants and the calibrated `e_T`. Split from `batSim.ts` at the 500-line cap, the same way `pitches.ts` is split from `pitchSim.ts` |
| `packages/relay-ui/src/lib/baseball/batSim.ts` | THE collision: one oblique rigid-body impulse solve in the line-of-centres frame producing EV, LA, spray, backspin AND sidespin together; the one swing rotation model (`contactGeometry`); the polar/axial handedness mirror; `decomposeSpin` |
| `packages/relay-ui/src/lib/baseball/batSim.test.ts` | The collision bench: prints the contact-point ladder, the collision grid and the timing table; asserts the derivations, the `(1+e)/(1+q) ≡ 1+eA` identity, the zero-obliquity closed form, the backspin band, the hook/slice signs and the handedness mirror |
| `packages/relay-ui/src/lib/baseball/battedBallSim.ts` | The flight, on stage 1's `stepBall` — never a second integrator. `launchFromAngles` (published EV/LA/spray/spin → a launch state), `simulateBattedBall` with the analytic ground crossing, `maxCarry` (argmax over LA), `distanceAtHeight` for the fence |
| `packages/relay-ui/src/lib/baseball/battedBallSim.test.ts` | The carry bench and stage 3's central experiment: prints the carry-ladder residual table in both airs, the spin sensitivity, the altitude ladder and the end-to-end undercut sweep; asserts the model's goldens, the +58 ft residual as a finding, and the lift structure |
| `packages/relay-ui/src/lib/baseball/pchip.ts` | Monotone cubic Hermite (Fritsch–Carlson) + the argument for it against linear and against a natural cubic. Extracted from `parks.ts` at the 500-line cap — extraction, not a raised cap |
| `packages/relay-ui/src/lib/baseball/pchip.test.ts` | The interpolator bench, added by stage 4's audit — `pchip.ts` shipped with no test and a mutation that zeroed every interior knot slope moved the fence 4.97 ft with the suite still green. Asserts interpolation, exact reproduction of a straight line, no-overshoot against an unlimited Hermite, locality, zero slope at an extremum, the degenerate cases, and GOLDEN off-knot fence distances |
| `packages/relay-ui/src/lib/baseball/parks.ts` | The park as DATA + `fenceAt` (pchip through the sampled wall), the roof mechanic (`roofClosed`, `parkConditions` — exactly-zero wind and pinned air when shut) and `resolveFence` (analytic fence crossing → homeRun/offWall/foul/roof/inPlay). Owns `SKYDOME_NAME`, the one line a name revert touches. Read by the physics AND by the geometry |
| `packages/relay-ui/src/lib/baseball/parkValidate.ts` | `validatePark()` and its bounds table. Extracted from `parks.ts` at the 500-line cap when the published profile added `backstopFt` and `surroundings` — everything in it runs at AUTHORING time and none of it is in the shipped chunk, so the split is a bundle win as well as a cap one |
| `packages/relay-ui/src/lib/baseball/parks.test.ts` | The park bench: prints the fence tables (pchip vs linear, with the knot-slope jump), the roof-open weather draw, the roof ceiling ladder, the wind-bearing histogram, the wind boost against an independent ground-frame RK4, and the altitude ladder; asserts the 400/395 wall boundary, the foul pole, `wind === 0` under a shut roof, byte-identical trajectories across seeds, the uniform bearing window, a TRIPWIRE on golf's wind sampler, and the altitude result against the published 25–30 ft band |
| `packages/relay-ui/src/lib/baseball/fielding.ts` | The deliberately tiny defence: fixed alignment, a ramped reach, one defender rating, → out / 1B / 2B / 3B / HR, and `infieldDepthFt(β)` — the 95 ft arc, read by the lookup AND by `stadium/field.ts`. 323 lines, and the cap is the design |
| `packages/relay-ui/src/lib/baseball/fielding.test.ts` | The fielding bench: prints the reach ladder and a named batted-ball ladder; asserts the catch boundary exactly on the reach, the single/double index boundary, the foul-territory boundary, the rating's ±15 % span, and the landing-point limitation |
| `packages/relay-ui/src/lib/baseball/derbyScoring.ts` | THE PAYOUT, and the LEAF of the derby's module graph — it imports nothing from the game, so `derbyRules` can check it against the format's derived cap with no cycle. One clamped scorer (`swingPoints`) that every outcome goes through, `validatePayoutCap` on the live config path and the full `validateDerbyPayout` sweep in the bench. Extracted at the 500-line cap in the M2 feel pass |
| `packages/relay-ui/src/lib/baseball/contactWindow.ts` | The bat GEOMETRY — `BAT_TIP_M`, `BAT_HANDLE_LIMIT_M` and the bisection that inverts `contactGeometry`. Three unrelated consumers (`derbySim`, `TimingBar`, the benches) and no knowledge of the format. Extracted at the same cap, same pass |
| `packages/relay-ui/src/lib/baseball/rng.ts` | THE seeded stream: `simDraw(state)` plus mulberry32's STEP, carried as a plain NUMBER so `snapshot()` can be total. Extracted from `derbyRules.ts` when the duel needed the identical stream — two three-line mixers in two sibling modes is "one implementation per concept" failing quietly |
| `packages/relay-ui/src/lib/baseball/batterAim.ts` | THE reticle/tap → `Swing` mapping, shared by the derby AND the duel: the calibrated reference undercut, the assist shoulder as a per-mode MODULATOR (`ReticleAssist`), the pull/oppo intent, `aimSwing` with the resultant overlap test, and `aimErrorForUndercutIn`, which inverts the shoulder. Moved UP out of `derbyRules.ts` rather than forked sideways; not one number changed and the derby's ~180 goldens are the proof |
| `packages/relay-ui/src/lib/baseball/duelRules.ts` | The duel's format (3 innings, the three count rules, the extras BOUND), the arsenal as data with a `chase` column, the DERIVED command map `pitchLocation`, the forced-advance base rules, `DUEL_ASSIST`, and the throwing config validator. The scope cap is written in its header the way `fielding.ts` writes its own |
| `packages/relay-ui/src/lib/baseball/duelInnings.ts` | The half-inning STATE MACHINE — `applyPa`, `advanceHalf`, `isWalkOff`, `halfIsOver`, `countAfter`, `paOutcomeOf`, the line score. Pure, and it takes a `Situation` structurally, so "an inning ended on the wrong out count" is a one-line test instead of a game replay |
| `packages/relay-ui/src/lib/baseball/duelState.ts` | The duel's readouts and the snapshot/restore pair, carrying the same ⚠ RULE about totality `derbyState.ts` states |
| `packages/relay-ui/src/lib/baseball/duelSim.ts` | The duel LOOP, and `fielding.ts`'s FIRST REAL CALLER: pitch → `aimSwing` → `swingContact` → `simulateBattedBall` → `resolveFence` → `fieldBattedBall`, then the count, the bases, the halves and the game-over condition. Writes no physics; does not import `PITCH_TEMPO` |
| `packages/relay-ui/src/lib/baseball/ai.ts` | ONE AI, BOTH roles, because the human alternates halves. On the mound: a count-tilted weighted draw over the arsenal, a corner to aim at, and a stop error. At the plate: TWO different reads of the same pitch — a late, good one for the swing/take decision and an early, poor GUESS for where the hands go. Seeded draws only, a FIXED number per decision |
| `packages/relay-ui/src/lib/baseball/duelSim.test.ts` | The duel bench: prints the command ladder, the forced-advance base table, the assist plateau comparison and the OUTCOME DISTRIBUTION at three difficulties; asserts the count rules, the base rules, every game-over condition, the walk-off, byte-identical replay, snapshot totality and the outcome bands |
| `packages/relay-ui/src/lib/baseball/ai.test.ts` | The AI bench: prints the arsenal tilt, the mound table and the plate table; asserts the fixed draw count, that every published pitch stays reachable at every count and difficulty, and — the failure mode it exists for — that difficulty MOVES every lever and moves it the right way |
| `packages/relay-ui/src/components/baseball/stadium/stands.ts` | The BANDED bowl: a `PROFILE` of stations (seats / dark fascia / emissive LED ribbon), lofted band by band and merged into ONE lit shell + ONE unlit ribbon strip + the skirt. Owns `bowlInnerRadiusFt` (the fair wall, the foul-ground offset curve, the backstop clamp) and the one procedural crowd texture — speckle and vomitories, no crowd mesh, gated by `quality.seatTexturePx` |
| `packages/relay-ui/src/components/baseball/stadium/centrefield.ts` | The centre-field ELEVATION — the structural frame the board array is recessed into, the hotel window band, the banners and flags — plus the recess `stands.ts` cuts in the deck for it. Owns the recess and therefore owns `CENTREFIELD_BOARD`, the board's real `{ widthFt, heightFt, faceDistFt, sillFt, bearingDeg }`, which the board slice takes. Builds NO board |
| `packages/relay-ui/src/components/baseball/stadium/grain.ts` | THE one seeded two-octave surface-noise tile, built ONCE and `.clone()`d per surface with a different `repeat` — golf's six identical turf normal maps are the anti-pattern this is written against. A MULTIPLIER around white, so it can never shift a surface's hue |
| `packages/relay-ui/src/components/baseball/stadium/crowd.ts` | The crowd as ONE procedural texture, extracted from `stands.ts` at the cap: clumps (the octave that survives minification), speckle, seat rows, and a four-section super-tile with a seeded per-section vomitory so the lattice is not periodic |
| `packages/relay-ui/src/components/baseball/stadium/daylightSpec.ts` | The SHAPE of a lighting row and the argument for every column — extracted from `daylight.ts` at the 500-line cap, types and prose only, so it costs the bundle nothing. `daylight.ts` re-exports the two type names, so not one of the fourteen import sites moved |
| `packages/relay-ui/src/components/baseball/stadium/daylight.ts` | The two ROWS. Day/night as DATA, read by the composer, the sky, the roof, the tower, the crowd, the FIELD and the SKYLINE. Cosmetic by hard rule: nothing in it is ever handed to `lib/baseball`, and `shared/prefs.test.ts` runs the carry ladder both ways to prove it |
| `packages/relay-ui/src/components/baseball/stadium/daylight.test.ts` | The rendered-levels bench: a VALIDATED five-line Lambert+ACES model that reproduces TEN golden pixels off THREE shipped PNGs to the byte, over three surface families (down-facing, up-facing, camera-facing vertical). Reads `StadiumGL.RENDER_TRANSFER`, so tone mapping, exposure and colour space are pinned rather than assumed |
| `packages/relay-ui/src/components/baseball/stadium/ballSkin.ts` | The ball's SEAMS as one procedural equirectangular map — a closed-form curve that lies exactly on the unit sphere (`c² = 4ab`), a distance field to it, and a stitch phase on ARC LENGTH. The one texture in the directory that WANTS mipmaps, and `ballSkin.test.ts` integrates the shipped classifier to say why |
| `packages/relay-ui/src/components/baseball/stadium/windows.ts` | A facade of windows as one seeded map, with a plain lane so one material can serve a glazed surface and an unglazed one. Two callers — the hotel band and the skyline — and one implementation |
| `packages/relay-ui/src/components/baseball/stadium/sky.ts` | The graded sky dome: zenith→horizon ramp, haze band, seeded cloud banding. Deliberately NOT grained — see M3b(4) |
| `packages/relay-ui/src/components/baseball/stadium/skyline.ts` | The city outside the bowl — a tapered concrete tower with an observation pod plus sixteen high-rises, ALL in one merged mesh and one draw call, seeded, and built only for a park whose `surroundings` say `'city'` |
| `packages/relay-ui/src/components/baseball/stadium/field.test.ts` | The ground bench, added because the visual gate could not see a face-down field: asserts every ground normal points UP, that the turf covers foul ground to the foot of the stands, that the warning track is the band it claims to be, and that the infield is an ANNULUS with 6,881 ft² of grass in it rather than a solid fan |
| `packages/relay-ui/src/components/baseball/stadium/camera.ts` | The four camera PLACEMENTS + the rig that moves between them: a quintic transition and a damped follow point, both driven by a `dtS` ARGUMENT so `lib/scene3d/clock.ts` can freeze them. `follow` is a column, true for `flight` alone; `batter` is `false` because that frame is what the swing is timed against. Extracted from `StadiumGL.tsx` when the table acquired state |
| `packages/relay-ui/src/components/baseball/shared/swingCopy.ts` | The derby's readout COPY — `describeSwing`, `coachSwing`, `parkCopyNumbers`. Pure `SwingResult → string`, so every outcome is testable in a millisecond instead of only through a 24-pitch mounted session |
| `packages/relay-ui/src/lib/baseball/determinism.test.ts` | Source-reading guard: no `Math.random`, `Date.now`, `performance.` or `new Date` in any baseball source |
| `packages/relay-ui/src/lib/baseball/budget.test.ts` | Anti-bloat guard: 500-line cap per shipping `lib/baseball` module (tests exempt), 700 per component, 900 for `StadiumGL.tsx`; no `three` in the sim; no barrel `index.ts` |
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
  `measureBreak`). 26 new tests over four files; `FIXED_MS`/`FIXED_DT` moved to
  `tuning.ts` and re-exported by `airPhysics.ts`; `budget.test.ts` added with the
  anti-bloat caps, four modules in rather than two thousand lines late.
  **`C_L` was NOT recalibrated** — see the segment sweep above. The one fitted
  number is `BREAK_SEGMENT_FT`, and the honest result is that no segment
  reconciles the eight; the finding is reported rather than absorbed into a
  per-pitch factor. Measured: plate speed 91.6–92.5 % of release across the
  arsenal, flight 0.410–0.485 s, four-seam break +0.3 in IVB / −0.4 in HB
  against published with nothing tuned to it.
  **Seven mutations were watched to fail** and reverted: mirrored tilt clock (5
  tests), dropped `activeSpin` factor (5), slider tilt shifted to a sweeper's
  (1 — only the golden pin caught it, which is what golden pins are for; a
  break-*direction* test now catches it on merit, 14.8° apart collapsing to
  0.9°), dropped gyro component (3), plate crossing snapped to a substep instead
  of interpolated (4), stage 1's gyro projection defeated (7, two of them stage
  1's own), and `BREAK_SEGMENT_FT` moved to the RMS optimum (4).
  **An adversarial review then re-derived the physics independently and found
  the conclusions sound but several claims overstated.** Corrected in place, all
  with numbers: the cutter carries *comparable and slightly lower* effective spin
  than a four-seamer (1800 vs 2139 rpm), not more; the ratio law holds to 4.3 %
  at L = 40 rather than 2 %, and is L-*dependent*; 50 ft rests on one external
  nomination plus one row, not "three independent constraints"; the uniform
  arm-side residual is a systematic deficit, not seam-shifted-wake evidence; the
  changeup and sinker are now golden-pinned (seven rows, not five); and `C_L`'s
  shape is ruled out by a monotonicity inversion in the published table rather
  than by assertion. Three more mutations were watched to fail — see
  `pitchSim.test.ts`'s log.
- **Stage 3 — hitting.** → **Done** for the collision and the flight; `parks.ts`
  and `fielding.ts` were **not** in this slice and remain open. `bat.ts` (the
  published bat spec, the one SI bridge, derived `M_eff`/`q`/`eA` reproducing the
  published 0.5816 kg / 0.2498 / 0.2002 triple, the swing constants, calibrated
  `e_T`), `batSim.ts` (one oblique impulse solve producing EV, LA, spray,
  backspin and sidespin together; one rotation model producing spray *and* the
  mistiming penalty), `battedBallSim.ts` on stage 1's `stepBall` unmodified, plus
  `isBarrel` in `tuning.ts`. 44 new tests over two files, 93 in the baseball
  suite.
  **Two negative results, both reported rather than absorbed — and both revisited
  in stage 3b below.** (1) The published carry ladder — an independent test of
  `C_D`/`C_L` in a regime they were never fitted to — missed by **+58.3 ft mean**,
  and no constant `C_D` repairs it (0.385 fits the level but flattens the slope
  the wrong way and breaks the plate-speed calibration by 2.2 mph). ⚠ The second
  half of that is still true; the first was fixed by a Reynolds-dependent `C_D`.
  (2) "No `e_T` satisfies both the published launch-angle and backspin targets"
  — ⚠ **RETRACTED**: that sweep held the undercut fixed at a value that is not
  published data. `C_D` and `C_L` did not move and no carry factor was added.
  A third, smaller limitation is pinned as goldens: the rigid-body collision has
  no bat vibration, so it gains 2.66 mph 4 in toward the handle where a real bat
  loses.
  **Fourteen mutations were watched to fail** and reverted, each against the whole
  93-test baseball suite: `e_T` → the textbook +0.20 (5), the tangential impulse
  deleted (9), the axial spin mirror made polar (1 — the LHB mirror test, which is
  exactly what it is for), the naive `ω·Δt` bat angle (2), the contact point
  pinned to the aim point (3), `M_eff` stripped of its rotational term (10), `eA`
  hand-set to 0.20 (4), the incoming pitch spin dropped from the contact patch (6),
  the backspin axis flipped (7), the batted ball's spin zeroed (11), the ground
  contact snapped to a substep (6), **a 0.87 carry fudge factor (8 — the finding
  is pinned as firmly as the numbers)**, the barrel window widened to 3°/mph (1),
  and the swing axis hand-set instead of derived (8).
- **Stage 3b — the adversarial review, and two repairs.** → **Done.** An
  adversarial review rebuilt the ladder independently to 9 decimal places and
  found stage 3's two negative results were one real defect and one artifact.
  Both are fixed **in the physics**, not in the prose:
  **(1) `dragCoef` is now Reynolds-dependent** — the drag crisis, 0.500 below
  Re 1.1e5 to 0.300 above 2.0e5 on a quintic smootherstep. The carry residual
  falls from **+58.3 ft to +7.7 ft** mean (RMS 9.5, inside the ±15 bar) and the
  launch-angle optimum at 90 mph from 31.0° to 28.5°, which were the same defect;
  stage 3's pushback that "the brief's 25–30° band is wrong" is withdrawn and
  folded in as the second symptom. It is **free against stages 1 and 2**: the
  four-seamer crosses the plate at 86.287 mph against 86.288, all sixteen
  published break residuals are unchanged to 0.1 in, and the largest golden move
  is 0.036 in on the curveball. What *did* move is the slow pitches' plate speed
  (curveball 73.5 → 72.7 mph) and the value of backspin (~4 → ~1.5 ft per
  100 rpm), both reported.
  **(2) `e_T` is now DERIVED and equals 0**, the Coulomb rolling value. Stage 3's
  "no `e_T` satisfies both published targets" is **retracted**: it swept `e_T` at
  a fixed 0.75 in undercut, and the undercut is a free swing parameter. The 2-D
  region says the bands overlap for `e_T ∈ [−0.16, +0.02]`; the Coulomb number
  (`J_t/J_n = 0.084` against μ ≈ 0.4–0.6, ~5–7× inside stick) says only
  `[0, +0.2]` is admissible; the intersection is `[0, +0.02]`. The reference
  undercut moved to 0.56 in and the swing now meets **both** published bands at
  once. The "~2.7×" was a mislabelled backspin ratio; the tangential-impulse gap
  at a fixed undercut is **1.413×**.
  **A third claim is retracted outright**: jamming is *not* "a property of an
  inside pitch, which is `aimZM`'s job". Measured, an inside pitch makes this
  batter **stronger** for six inches (peak EV 3 in inside, +3.0 mph). The model
  has no jamming mechanism anywhere; it is a second consequence of the missing
  measured `e(z)`, and it is now printed and asserted.
  **Smaller corrections**, all with numbers: `C_L_MAX`'s "never binds anywhere"
  comment was false for the batted ball (33 % of a ladder flight, worth ≤0.65 ft
  — measured, printed, and the reason the knob was left at 0.35); the residual is
  re-pinned at the precision its 2200 rpm assumption actually has (±10 ft) rather
  than ±0.05 ft; the slope claim is weakened, because the published table scatters
  ±6 ft about its own least-squares line (slope 6.086) and a 6.00-vs-5.72
  comparison was finer than the data; the spray bounds are two-sided and mirrored,
  which is what finally catches the naive-bat-angle mutation on merit; `−42.9°` →
  `−43.8°` and `3.3 ft` → `1.46 ft` were stale/wrong numbers in shipping source.
  **Nine more mutations were watched to fail** — see the logs at the bottom of
  `batSim.test.ts` and `battedBallSim.test.ts`. The two that matter most: the
  cubic smoothstep (caught by the RK4 convergence bench, which is what chose the
  quintic) and the fixed kinematic viscosity (15 tests, including stage 1's own
  plate-speed calibration).
- **Stage 4 — parks, fences, roof, fielding.** → **Done.** `parks.ts` (the `Park`
  shape, the home park (then `Harbourfront Dome`, renamed at M3) and `Alpine
  Heights` as data, `fenceAt`, the roof
  mechanic, `resolveFence`, `validatePark`), `pchip.ts` (extracted at the cap),
  `fielding.ts` (225 lines), and a wind term in `battedBallSim` implemented as an
  **exact Galilean boost** so there is still exactly one integrator. 28 new tests
  over two files, **124 in the baseball suite** (134 after stage 4b). `C_D`, `C_L`, `e_T`, the Reynolds
  band and `ν` were **not** touched.
  **The findings, reported rather than absorbed.** (1) The altitude effect is
  **+29.1 ft on a 400 ft fly at 5200 ft**, inside the published 25–30 band —
  stage 3b's "+34.7 ft, slightly high" compared a 432 ft fly against a figure
  quoted on a 400 ft one, and the reconciliation is asserted arithmetic. (2) The
  282 ft roof is enforced but needs **~120.2 mph** hit near-vertically to bite,
  and **never** converts a home run (a 125 mph home run apexes 200.3 ft) — the
  dimension exists and is asserted; there is no deflection model. (3) A 400 ft
  *carry* to a 400 ft fence is **not** a home run; the asserted boundary is on the
  distance at wall height, and the ~9 ft difference is printed. (4) Fielding reads
  the landing point, so the roll and the throw are missing and two labelled knobs
  stand in for them.
  **Twenty-three mutations were watched to fail** and reverted, each against the
  whole 124-test suite: the fence made linear (1), its monotonicity limiter
  removed (1), the fence extrapolated past the foul lines (2), a "tiny" wind under
  a shut roof (1), the closed-roof temperature unpinned (1), the park's elevation
  cut out of its air (1), the wind boost sign flipped (2), the un-boost using `dt`
  instead of `t` (1), the fence crossing snapped to a substep (1), the foul pole
  made foul (1), the roof ceiling deleted (1) and applied with the roof open (1),
  `validatePark`'s roofless-ceiling clause dropped (1), the fence height ignored
  (3) and not interpolated (2), the crossing bearing read from the wrong point
  (5), the fielder's acceleration ramp deleted (4), the infield-hit cap removed
  (1), `GROUND_INTERCEPT_FT` zeroed (2), the defender rating neutered (1),
  off-the-wall made catchable (2), the catch boundary loosened by a foot (2) and
  foul territory ignored (2).
  ⚠ **Two of those survived the first pass and both were real gaps**, not test
  noise: removing the infield-hit cap changed nothing because an unclamped depth
  term was silently doing the same job (two mechanisms covering one case, so
  neither was tested), and pinning the fence *height* to its first sample changed
  nothing because M1's wall was a uniform 10 ft (⚠ that mutation now fails 7
  tests — see M3, where the published height column arrived). Both are now
  asserted. ⚠ The
  first repair was itself half-right and stage 4b finished it: the clamp it
  restored is **unreachable**, so the file still had one live mechanism and one
  dead one. The dead branch is now deleted.
- **Stage 4b — the adversarial review of 3b and 4.** → **Done.** No blockers: the
  drag repair, the quintic finding, the roof analysis and the altitude result all
  reproduced independently. Three real gaps, all of the form "a mutation passes
  124/124", and a set of stale-prose corrections. **No physics constant moved.**
  **(1) `pchip.ts` had no test** — see the interpolator paragraph above.
  `pchip.test.ts` (7 tests) now covers the Fritsch–Carlson properties and pins
  golden off-knot fence distances; the zero-interior-slope mutation dies in three
  of them and the zero-every-slope mutation in four. (The review quoted 6.53 ft
  and 2.65 ft for the fence move; those are the *all*-slopes numbers, 6.54 and
  2.67 here — the interior-only mutation it describes moves 4.97. Both die.)
  **(2) The golf wind coupling had no tripwire.** Three mutations of
  `lib/golf/wind.ts` each passed the whole suite (`windMph`'s ×2.5 → ×1.0,
  doubling `makeWind`'s magnitude, deleting the 0.6 along-damping), so a golf
  retune moved this game's winds silently. `parks.test.ts` now pins `windMph` and
  a `makeWind` draw directly, labelled as an **upstream** tripwire rather than as
  a statement about baseball.
  **(3) `prevailingDeg` was the *least* likely bearing** — remapped and renamed;
  see the wind paragraph above.
  **(4) The Galilean-boost evidence was circular** — replaced with an independent
  ground-frame RK4; see the wind-boost paragraph.
  **And one nit that grew.** Deleting `fielding.ts`'s unreachable
  `Math.max(0, …)` showed that the infield cap and the depth term are equivalent
  in effect over the whole infield (margin 39.25 vs 68), so the cap's mutation
  cannot be killed by any input. The margin is now measured and asserted instead
  — see the fielding section.
  **Prose corrections, every one re-measured:** the carry ladder is **+7.71 ft**
  mean / **RMS 9.49** (`tuning.ts` and `battedBallSim.ts` said +7.2 / 9.1), the
  three-band table is **+15.49 / +7.71 / −0.06** with the high band's plate speed
  **86.244** (said +15.0 / +7.2 / −0.6 and 86.17), the four-seam plate speed is
  **86.287** (said 86.283), and the `C_D_SUBCRIT` sweep's RMS optimum is
  **0.5375** (said 0.545). ⚠ **Every one of those stale figures is the CUBIC
  smoothstep's** — re-measured, the cubic still gives exactly them — so nothing
  drifted: the prose was never re-run when 3b changed the shape to a quintic.
  Also corrected: `fielding.ts`'s "118 ft" naive reach (its own test prints
  **94.5**), `INFIELD_DEPTH_FT`'s DERIVED label (the 95 ft arc is struck from the
  rubber and used as a plate-centred radius — up to 27.9 ft apart at the lines),
  `bat.ts`'s "zero free parameters" (true of the collision solve; the free
  parameter migrated to the newly-calibrated 0.56 in undercut), the "which 400"
  convention now stated on `resolveFence` and `distanceAtHeight` themselves, the
  quintic ratios scoped to the pitch bench they were measured on, and the
  fielding ladder marked GOLDEN.
  **A finding of its own, recorded not acted on:** on a batted-ball flight it is
  **`C_L_MAX`**, not the crisis shape, that limits RK4's observed order — 2.0 /
  3.1 / 7.4 halving ratios and 150× the absolute error at the reference 2200 rpm,
  against 24.5 / 20.2 at spins where the clamp never binds. 3.4e-7 ft at 120 Hz
  is far below anything gameplay can see, and softening the clamp would move
  carry.
- **M1 — the visual gate and the grey-box stadium.** → **Done** (see the M1
  commit): `scripts/shoot-baseball.mjs` + `baseballpreview.*`, `StadiumGL.tsx` as
  a composer over `stadium/{geom,field,fence,mound,stands,roof,scale,quality}.ts`,
  every dimension read from `parks.ts` and verified by reading distances back out
  of the built vertex buffers (worst |Δ| 0.002 ft at Harbourfront, 0.006 at
  Alpine). Five scenes, byte-identical across runs.
- **M1 follow-ups — the gate's findings, closed.** → **Done.** The gate passed M1
  and found exactly one substantive defect, and it was **physics, not render**.
  **(1) `INFIELD_DEPTH_FT` is now `infieldDepthFt(β)`** — the 95 ft arc struck
  from the rubber, replacing a plate-centred circle that over-stated the dirt by
  27.9 ft down the lines. See the fielding section for the derivation, the
  0.60 %-of-the-lookup ladder move (7,376 cases, all OUT → SINGLE, all at
  130–155 ft off centre), and the separate **depth-datum** decision with its
  computed counterfactual. `stadium/field.ts` samples the same function, so the
  drawn dirt is the dirt the fielder model uses.
  ⚠ **And the gate's diagnosis of the SYMPTOM was wrong, which is worth more than
  the fix.** The dirt lot in the batter's-eye frame is *not* the radius: at
  900×1600 portrait the `batter` camera's 40° vertical fov is only **23.2°
  horizontally**, so it sees |β| ≤ 11.6°, where the arc moves by ≤2.2 ft. Counted
  in pixels, dirt is **36.6 % of that frame before the fix and 36.8 % after**
  (the 0.2 is the scale marker moving, not the dirt), against the ~60 % the gate
  reported. In `wide`, where the whole arc is visible, dirt falls 2.6 % → 2.4 %
  of frame and the outline visibly curves in at the corners. The real cause of
  the batter's-eye dirt lot is that the infield is drawn as a **solid fan with no
  grass** — see the M2 list.
  **(2) `sun.shadow.normalBias = 6` is recorded, not changed** — 6 world feet is
  ~50× a baseball's radius, so it will detach or delete the ball's contact shadow
  the day there is a ball, and it will present as "the ball floats", i.e. as
  three innocent subsystems. The note at the constant names the failure and the
  likely fix (a tight ~200 ft shadow cascade around the infield, not a bigger
  map — 1024² is a hard ceiling until an on-device Android test, and the gate
  measured 1.23 ft/texel across a ~1260 ft volume already).
  **(3) The scale reference's comment now says what is true.** It claimed to be
  drawn in every mode so that nobody forgets to check it; it is *built* in four
  and *legible* in two (`pitcher`, `batter`). `wide` is 1000 ft up, where a 6 ft
  object is 1 px and no placement fixes that. The marker moved from the middle of
  the batter's box to its front so that its BASE stays in the `batter` frame — it
  was 0.9° from being cropped, and a height reference whose contact with the
  ground is off-frame is not a height reference.
  > ⚠ **SUPERSEDED AT M2c, and left standing as the record rather than quietly
  > rewritten.** "Legible in two" was true of the M1 cameras and is **false
  > today**: M2c re-framed `batter` onto the strike zone and the marker left that
  > frame sideways, so it is built in four and legible in **one** (`pitcher`).
  > `stadium/scale.ts` is the current answer and the M2c entry below is where it
  > changed. The gate's magenta scan measures it directly — 40,336 px in each
  > `pitcher` shot, 11 px in each `wide`, **0 px in `batter`**.
- **M2 — art, and four things the gate photographed.** Recorded here so they are
  not lost, and deliberately **not** fixed in the M1 follow-up pass. The list is
  in **priority order**, and the ordering changed at M2e — see the first item.
  > ⚠ **THREE OF THE FOUR ARE CLOSED AT M3** — the bowl, the roof ring and the
  > infield grass; see the M3 entry below for what each cost and what it
  > measured. **The green foul-line fringe is NOT**, and it is the one item on
  > this list that got no attention, so it stays here rather than being quietly
  > dropped. The near-bowl transparency filed under the first item is also
  > untouched and is still a near-plane question, not a material one.
  - **The bowl is not a building — and M2e promoted it to FIRST.** It is an open
    lofted ribbon with no back and no seat deck, and the apron disc runs to
    570 ft past the bowl's 459–531 ft outer edge, so bare ground shows beyond the
    stands.
    ⚠ **What changed is not the defect but its consequence.** As a static art gap
    it was a thing a still frame showed you once. Now the camera EASES from the
    box to the upper deck on every home run, and a featureless grey slab
    **sweeps across roughly a third of the frame** during that 0.8 s move. That
    is the single thing most likely to make the follow read as motion sickness
    rather than as broadcast, and it is not a still-frame problem, so no
    screenshot in the gate can adjudicate it. It goes ahead of the other three.
    ⚠ **Related, and PRE-EXISTING — not caused by M2e.** `wide.png` and
    `park-alpine-wide.png` show the near bowl as **semi-transparent with radial
    spoke banding**: precisely the z-fighting symptom `CAMERAS`'s own `near` note
    records having FIXED by pushing `wide`'s near plane to 200 ft. Confirmed
    pre-existing by pixel diff — those two scenes differ from `main` by **32
    pixels, all of them tracer**. Filed as an art / near-plane item, not as a
    camera regression.
  - **The roof ring degenerates.** 120 ft of band over the outfield down to a 5 ft
    sliver behind home and along the sides (clamped by `MIN_BAND_FT`), which from
    above projects as a 2 px dark wire across the field and reads as an artifact.
    Proven to be the roof: the roofless Alpine shot has no such lines.
    ⚠ **SUPERSEDED — THE RING ITSELF WAS THE DEFECT, not its degenerate ends.**
    An owner note off the open-roof references (*"you can see how the dome
    collapses behind the outfield; then to the left and right you see the
    skyline"*) says a retractable roof has no OPEN state that is a band of even
    depth at every bearing — it nests its moving panels into a stack over one
    side. `stadium/roof.ts` now builds that stack (four panels, ±11°, 250 ft deep
    behind centre, nothing at the lines) and `MIN_BAND_FT`, `ROOF_BAND_FT` and
    `ROOF_SPLIT_DEG` are deleted with it. That file and `roof.test.ts` carry the
    derivation; the harness's `checkRoof` — which used to demand a measurable
    roof at all five fence bearings, i.e. **asserted the ring** and would have
    failed a correct collapse by design — now asserts the intended PROFILE.
  - **A ~1.5 in green fringe outside the foul lines**, from parallax on
    `field.ts`'s anti-z-fighting layer stack (0.18 ft of height offset displaces
    the edge ~0.1 ft laterally at batter-eye height). Cosmetic now, worse once
    textures land.
  - **The infield has no grass.** It is one solid dirt fan from the plate to the
    arc, where a real infield is grass inside the base paths with dirt cutouts —
    roughly 7,000 ft² of the arc's ~15,800 ft² of fair area. This, not the arc
    radius, is why the batter's-eye frame reads as a dirt lot, and it is the one
    M2 item with a measurement behind it.
- **M2c follow-ups — the review's blocker and its findings, closed.** → **Done.**
  **(1) Leaving a derby is no longer finishing one.** `DerbyGame`'s unmount
  safety net called `finish()`, which called `onFinish` — so "‹ Exit" one pitch
  into a session banked the run *and* told `BaseballScreen` the session was over.
  Measured with history `['/chats', '/games']`: the player landed on `/chats`
  with "Derby complete" on screen, because the results screen came up over the
  menu they asked for AND `consumeHistoryEntry('guess')` fired a second `nav(-1)`
  before `histGameRef` had re-rendered. One press, two pops, out of the Games
  tab. Split into `bank()` (score only) and `finish()` (bank **then** report),
  the net calling only `bank()` — golf's shape, which its nets state outright
  ("No setState here — the whole route may be unmounting"). New
  `BaseballScreen.test.tsx` holds it from inside the flow machine, with a
  sentinel `/chats` entry so a second pop is a visible screen rather than an
  argument.
  **(2) A tap during the ~380 ms wind-up no longer burns the pitch** — and the
  second-order half of that is the finding. `swingNow` guarded on the stage
  alone, so a tap before release resolved as a "−456 ms EARLY" whiff at a ball
  still in the hand (reachable by a double-tap on "Pitch it in": the button
  unmounts on serve and `ZoneReticle`'s full-bleed layer is live underneath).
  Ignoring it in the HUD was **not enough** — `ZoneReticle.swungRef` is a
  one-shot per flight, so the refused tap still latched the surface and ate the
  real swing. `onSwing` now returns whether the game took the tap.
  **(3) The home-run streak moved into the sim.** `bestStreak` is submitted to
  the leaderboard beside `score`/`homeRuns`/`bestFt`, all of which `commit()`
  already books — but it lived in a `useRef` in the HUD, i.e. outside
  `derbySnapshot` and un-round-trippable by `restore()`.
  **(4) The drawn contact window is derived, not copied.** `TimingBar` painted
  `CONTACT_MS = 26.4`, a figure that existed in `lib/baseball` only as
  `console.log` output. `derbyRules.contactWindowS` now *inverts*
  `contactGeometry` by bisection (one implementation, no re-derived algebra) and
  the widget takes it as a prop, per pitch. Measured, and the direction is the
  opposite of the plausible guess: the window is **28.91 ms at 72 mph and
  25.31 ms at 96 mph** — θ_c is increasing in pitch speed, so a fast ball reaches
  a bat that is further off square, and mistiming a fastball costs *more*.
  **(5) `getState().last` no longer aliases sim state anywhere.** `{ ...s.last }`
  is shallow, so `flight`, its `landing` and its four sample arrays were shared
  across the live sim, `getState()` and `snapshot()` — while `derbyState.ts`
  claimed "no exceptions to remember". The existing independence assertions
  mutated only scalars and could not see it.
  **(6) `stadium/scale.ts` said something false.** M2c re-framed the `batter`
  camera onto the strike zone, which put the 6 ft marker's centre at **121 % of
  frame width** — outside — while the file still called `batter` the scale
  cross-check. The marker did **not** move: fitting the whole box inside that
  frame needs |x| ≤ 1.50 ft, where its inner face lands at 66.6 % of frame width
  against a rule zone spanning 24.7 → 75.3 %, i.e. a magenta slab across the
  subject the camera exists to hold. The doc is corrected and the harness gains
  `park-alpine-pitcher` instead — the surviving scale camera at the second park,
  which exercises the park axis the old `batter`/`pitcher` pair never did.
  **Its claim was then overstated in turn, and is corrected in the M2c follow-up
  below:** that shot cannot see a fence.
  **Smaller:** the tempo's direction is written as a MULTIPLY in the four places
  that had it backwards (`derbySim.ts` ×2, `stadium/flight.ts`, `StadiumGL.tsx`);
  `BaseballScreen` sets `immersive` so the tab bar and navbar unmount under the
  canvas instead of painting beneath it; `apiRef` is nulled on unmount; the
  Games hub says four games.
  **Eight mutations were watched to fail** — the four in `DerbyGame.test.tsx`'s
  header and (19)–(22) in `derbySim.test.ts`'s.
- **M2c follow-up — two live surfaces nobody had watched fail, and two claims
  bigger than their evidence.** Both gates passed on the round above; the review
  is what found these, and every one was survivable by all 12 baseball tests.
  **(1) The contact band's POSITION was unasserted.** `DerbyGame.test.tsx` read
  `band.style.width` and nothing else, so `left: plateP − msToPct(contactMs)`
  mutated to `plateP + …` and the suite stayed green — a correctly-*sized* band
  sitting entirely on the LATE side of the plate crossing, i.e. the HUD telling
  the player to swing ~26 ms late on every pitch. Live surface, not dormant: the
  round above is what made `left` depend on `contactMs`. Now asserted against
  `platePct − expectedPct / 2`.
  **(2) `BaseballScreen`'s `setImmersive` effect was deletable.** It landed as a
  one-line footnote in a commit about four other things and no test could see it
  — the flag is invisible while a full-screen canvas covers the chrome anyway.
  Now asserted on mount, on the screen change to results, on "‹ Exit", and on
  unmount. Golf's equivalent (`components/golf/GolfScreen.tsx`) is untested the
  same way; that is context for how this happened, not a reason to leave it, and
  it is flagged to the golf owner rather than fixed from here.
  **(3) `park-alpine-pitcher` claimed a wall it cannot photograph.** The note
  said the shot exercises "Alpine's 347/390/415 wall"; `CAMERAS.pitcher` stands
  on the mound at `[0, 6, −55]` looking IN at `[0, 2.6, 0]`, so the fence is
  290–360 ft BEHIND the camera. What the pair actually differ by is the **roof**
  (282 ft retractable vs none) and **`foulTerritoryFt`** (28 vs 22, moving the
  backstop and stand foot) — 9.63 % of pixels, in the roof/sky rows plus two thin
  bands. Corrected in `shoot-baseball.mjs`, `stadium/scale.ts` and above. The
  shot is kept: a park-scoped structure check against a fixed 6 ft reference is
  still the second photographic scale shot. No geometry and no marker moved.
  **(4) `contactWindowS`'s `batSpeedMph` was accepted and never exercised.**
  `derbySim.test.ts` now drives it at 55 / 71.5 / 130 mph — harder is NARROWER,
  by the same ∂θ_c/∂ω > 0 that makes a faster pitch narrower — and asserts that
  `undefined` *is* the published swing. The HUD's call site is covered by the
  one white-box seam in `DerbyGame.test.tsx`, because `sim.cfg.batSpeedMph` is
  `undefined` for every shipping config and dropping the argument therefore moves
  no pixel and no number. ⚠ The first assertion written for it,
  `toHaveBeenCalledWith(v, undefined)`, **matches a one-argument call** and
  passed the mutation it existed for; the arguments array's LENGTH is what
  separates `f(v)` from `f(v, undefined)`.
  **Smaller:** `apiRef.current = null` deleted from the unmount net — `StadiumGL`
  is a CHILD of `DerbyGame` and cannot outlive it, so the justification was
  unfalsifiable and the write released nothing; `finish()`'s `if (result)` guard
  kept but recorded as unreachable today, with the argument, so the next reader
  does not go hunting; `contactWindowS`'s handle-side bound documented as
  unreachable inside the bracket and kept because it is `resolveSwing`'s overlap
  test written once, not a narrowed copy.
  **Five mutations were watched to fail** — (5) and (6) in `DerbyGame.test.tsx`'s
  header, the two in `BaseballScreen.test.tsx`'s, and (23) in `derbySim.test.ts`'s
  — **and a sixth was watched to PASS**, which is why the arity assertion above
  is written the way it is.
- **M2d — the HUD in the visual gate.** *Not done, and deliberately not attempted
  in the M2c follow-up pass.* The screenshot harness photographs `StadiumGL`
  through `baseballpreview.tsx`; it has never photographed `DerbyGame`, so the
  count chip, the timing bar, the exit-velocity tag and the reticle copy are
  outside the only gate that catches a broken render. Two things are missing and
  both are small: (a) a `?now=` clock stub in `baseballpreview.tsx`, because the
  HUD's play clock is `performance.now()` and a shot has to freeze it the way
  `?t=` freezes the ball; and (b) a ready-beacon pass-through —
  `DerbyGame` consumes `StadiumGL.onReady` without chaining it, so
  `window.__baseballReady` never fires with a HUD mounted. Neither is physics
  and neither is urgent; both are a milestone, not a follow-up.
- **M2 feel pass — "is this fun?" failed its checkpoint, and the fix was scoring,
  not physics.** → **Done.** The owner played the shipped derby and scored **122
  points, 1 home run, 1 barrel, best streak 1** over 24 pitches, and said "it's
  tough to hit, it's likely me, I can't get the timing right." It was not them.
  Three compounding defects, all measured headlessly, **no physics constant
  touched**:
  **(1) Scoring was home-run-only, so half of all good swings paid nothing.**
  Across every skill level modelled, **20–48 % of swings were `inPlay`** — real
  contact, often 350+ ft — and every one scored 0, byte-identical to a whiff.
  With the reticle at zone centre and the tap exactly on the crossing, **46 % of
  swings carried a mean 406.7 ft and paid nothing**. `derbyScoring.ts` now scores
  CONTACT continuously (`0.35 pts/ft` past a 155.5 ft datum nominated from
  `infieldDepthFt(0)`, the grass line), a foul at `0.25×` of what the same ball
  in play would pay, and `+25` for a Statcast barrel on top — with the home run
  unchanged at `100 + (carry − 350)` and still strictly the best outcome at
  every carry, asserted as a swept inequality.
  **(2) The timing cliff was a 15 ms knife edge, in WALL ms.** 76 % home runs to
  a hard zero between +30 and +45 ms of wall clock, with **95 % of the dead rows
  still MAKING CONTACT**. Fixed from both ends and the two are separate levers:
  scoring the contact turns the zero into a slope, and `PITCH_TEMPO` — an
  explicitly-labelled feel knob — moved **0.55 → 0.45**, which widens the window
  the player's thumb gets from ±48.0 to ±58.7 ms of wall clock (+22 %) while
  moving no outcome rate at any TRUE offset. Measured, reticle at zone centre,
  points per swing against the peak row: ±45 ms went **0 % → 25–42 %**, ±60 ms
  **0 % → 4–5 %**, and the dead-centre trough at 0 ms **48.9 % → 84.5 %**.
  **(3) The optimal strategy was undiscoverable and the intuitive one was a
  trap** — and it still is, deliberately, because it is correct baseball. A
  reticle-X sweep at perfect timing: dead centre 54 % home runs, ±0.2–0.3 ft
  70–98 %. Dead centre is the BEST contact on the board (406.7 ft mean carry,
  100 % barrel rate) and the DEEPEST wall in the park, and nothing on screen said
  so. Taught by a contextual, **self-extinguishing** line on exactly the swings
  that demonstrate it, plus a first-run tip quoting the park's own two fence
  numbers that retires itself on the player's first home run.
  ⚠ **And the sweep is ASYMMETRIC at a symmetric park, which is a MODEL DEFECT
  and is NOT taught.** (⚠ M3 note: the park is no longer symmetric, so the
  HOME-RUN half of this argument is confounded and the assertion moved onto the
  CARRY column, which no fence can reach and which did not move. The defect is
  unchanged; only the evidence for it had to be narrowed.) +0.2 ft beats −0.3 ft
  where the ±22° samples are both
  375 ft, and it wins on CARRY (401.8 against 387.4 ft) — that is `eA` climbing
  toward the handle in a rigid bat with no `e(z)`, i.e. § "The collision"'s "the
  model has no jamming at all", arriving in gameplay. The copy therefore says
  "off the middle", never "to the opposite field", and `derbySim.test.ts` asserts
  the asymmetry so it cannot be quietly closed with a knob.
  **Three extractions, at the cap, not a raised cap.** `derbyRules.ts` was at
  484/500 and this work adds a scorer to it: `contactWindow.ts` (bat geometry),
  `derbyScoring.ts` (the payout) and `shared/swingCopy.ts` (the HUD copy) came
  out first, leaving `derbyRules.ts` at 414 and `DerbyGame.tsx` at 629/700 —
  quoted on `budget.test.ts`'s OWN counting (`split('\n').length`), which is the
  number the cap is actually compared against; the 409/628 this line used to say
  were `wc -l`, one short of the guard on every file that ends in a newline.
  **The worker's clamp is held STRUCTURALLY, for every outcome.** The old check
  was one line — `homeRunPoints(MAX_SAFE_INTEGER) > cap` — which was sufficient
  only while home runs were the only thing that scored. It is now a loop over the
  outcome ENUM, run on the live config path, plus a bench test that drives a
  maximal session and evaluates the **worker's own acceptance predicate**
  reconstructed from `games.ts`'s source text. Shipping headroom **32.3 %**; a
  200 mph bat saturates at exactly 100 % and is still accepted, which is the
  structural cap doing its job.
  ⚠ **The skill curve flattened and the number is reported rather than hidden.**
  Median session over 40 seeds, gaussian timing + aim: novice **298 → 744**,
  perfect **3014 → 3742**, so the perfect ÷ novice ratio fell **10.1× → 5.0×**.
  That is the intended half (bad play stops scoring zero); the unintended half is
  the TOP, where good → perfect compressed **1.25× → 1.06×**. The honest fix for
  top-end separation is a streak or barrel-chain multiplier, not a steeper
  contact curve — and it is a scope call, because it touches the submission cap.
  **Fourteen mutations were watched to fail** — (24)–(33) in `derbySim.test.ts`'s
  header and (7)–(10) in `DerbyGame.test.tsx`'s — **and two survived their first
  assertion**, both recorded: the format validator's payout wiring (a substring
  match that the divisibility clause next door already satisfied), and the
  coaching line (which needed a harness fix — `DerbyGame.test.tsx` only ever
  pumped `requestAnimationFrame`, so the HUD's `setInterval` readout was FROZEN
  at its mount value in every test in the file).
  ⚠ **Then the review of that pass killed two more, both of which the whole
  suite had survived.** **(a) The enum was a hand-written list pretending to be
  an enum.** `DERBY_OUTCOMES: readonly DerbyOutcome[]` accepts any SUBSET of the
  union, so deleting `'whiff'` from it left 182/182 green AND `pnpm typecheck` at
  exit 0 while `validatePayoutCap`, `validateDerbyPayout`'s cap leg and both
  outcome loops in `derbySim.test.ts` silently shrank together — the file's own
  "⚠ IT IS A LOOP OVER `DERBY_OUTCOMES`, NOT A LIST" was false. Fixed by
  inverting the derivation: the array is `as const` and `DerbyOutcome =
  (typeof DERBY_OUTCOMES)[number]`, so the same deletion is now **13 typecheck
  errors across 5 files**. **(b) The scoreboard was asserted nowhere.**
  `CountChip` has no test file, and swapping its Score cell to `String(state.outs)`
  — the scoreboard displaying the out count — failed **0 tests**. The session
  test now accumulates the payouts the HUD itself printed, checks them against
  the Score cell after every pitch and closes on `onFinish`'s score; that
  mutation is 1 fail. The `kinds.size > 1` check next to it was also satisfied by
  {GONE!, Foul ball} and never required the in-play line, so it names the branch
  now.
- **M2e — the camera moves, and the tracer stops spoiling the outcome.** →
  **Done.** Owner feedback after playing the live build (1,540 points, 7 HR — the
  M2 feel pass worked). Three items, two of them defects:
  **(1) THE TRACER WAS DRAWN AHEAD OF THE BALL, and it was an information leak.**
  `setPaths` handed each tracer the whole flight the instant it was served, so
  the complete arc — **including the landing point** — was on screen before the
  ball got there. Confirmed by rendering, not by reading: `batter.png` at
  t = 0.30 s showed the yellow pitch line running past the ball down to the
  plate, and `homerun.png` at bt = 2.6 s showed the entire descending limb from
  the apex. The pitch half is the worse of the two — it shows the **break before
  the player has to commit** — and it was live for the 380 ms wind-up as well,
  because `serve()` hands over the flight before release. Fixed with a
  progressive `setDrawRange` (`tracer.reveal`): the path is still built ONCE from
  the sim's samples and **no vertex moves after `setPaths`**, so the visual
  gate's geometry comparison is unaffected. The reveal is SAMPLE-GRANULAR and
  deliberately a lower bound, so the tip lags the ball by up to one substep
  (measured 1.13 ft on a 94 mph pitch, 1.25 ft off a 105 mph bat) and **never
  leads it**. That lag is almost entirely along the view axis of the two cameras
  that watch those flights, which is why it was chosen over writing an
  interpolated tip vertex — that would break the prefix property the gate's
  geometry seam rests on.
  **(2) THE BALL LEFT THE FRAME AND WAS NEVER SEEN AGAIN.** `CAMERAS.flight`'s
  horizontal FOV at 900×1600 portrait is 2·atan(tan 27.5°·0.5625) = **32.6°**,
  i.e. ±16.3° about a FIXED axis. Measured before the fix at 105 mph / 26.5° /
  bt = 2.6 s, with the ball drawn at (∓164.65, 93.30, −196.22) scene ft: at −40°
  of spray it projects to **(−0.241, 0.467)** — **217 px off the left edge**, a
  sliver of tracer at the border — and at +40° to **(+1.716, 0.467)**, **645 px
  past the right edge**, with **no ball and no arc anywhere in the picture**.
  Widening the FOV cannot fix it (it needs 90°+, which throws the ball away to a
  few pixels); aiming at the ball can, at no cost in angular resolution — though
  it is not free in MOTION, see (3).
  ⚠ **The figures this entry first published — (−0.083, 0.470) and (1.098,
  0.470) — did not reproduce, and they understated the defect in two independent
  ways. The reasoning is the reusable part:**
  **(i)** the recorded pair is symmetric about u ≈ **0.5075**, which only a
  camera at **x = 0** can produce. `CAMERAS.flight` stands at **x = −40**, so the
  true pair is symmetric about u = **0.738** — and *that asymmetry is exactly why
  the oppo corner is ~3× worse than the pull corner* (645 px against 217). A
  symmetric pair out of an asymmetric rig is the tell, and spotting it is cheaper
  than re-measuring. (From x = 0 the same two balls give −0.479 / +1.479.)
  **(ii)** its **span** was 1.181 frame widths against a true **1.957** — 40 %
  short — so it understated *both* corners regardless of centring. Span depends
  only on the FOV and the ball positions (it is identical from x = 0 and from
  x = −40), so this is a second error and not a consequence of the first.
  **And the method that makes such a figure checkable:** validate it against the
  harness's own printed control before trusting it on a counterfactual. The
  `flight` scene has no swing, so its camera never follows and it still prints
  the fixed-axis projection every run — `ball on screen (1.074, 1.333)`. The
  recomputation above reproduces that as **(1.0738, 1.3333)** through the same
  code path that produced the two corrected rows.
  ⚠ **EVERY NUMBER IN (2) IS MEASURED AT `CAMERAS.flight.pos.x = −40`, AND THAT
  STAND HAS SINCE MOVED TO −12** with its static `look` decoupled and yawed
  5.55° toward the landmark. The corner pair is now (−0.632, 0.473) /
  (+1.334, 0.463) and the printed control is (0.521, 1.329); the corner standoff
  asymmetry falls 11.9 % → 3.6 %, and the oppo corner is no longer the worse of
  the two. The REASONING above — a symmetric pair out of an asymmetric rig is a
  tell, and a counterfactual is checked against a printed control — is what
  survives, and it is what caught the arithmetic both times. `stadium/camera.ts`
  carries the current derivation and the trade it costs in the four scenes where
  the camera follows the ball.
  **(3) THE CAMERA NOW FOLLOWS, through the machinery that already existed.**
  `CAMERAS` had four modes and nothing switched between them during play except
  one hard CUT to `flight` at contact. The placements moved to
  `stadium/camera.ts` — they acquired STATE (a transition, a follow point), and a
  table with state in it is a subsystem — and gained one column, `follow`, true
  for exactly one row. `batter` is `follow: false` and that is a **gameplay
  constraint, not framing**: it is the frame the swing is timed against, and
  `camera.test.ts` asserts a ball in the scene moves it by exactly zero. The
  transition is a quintic smootherstep over `CAMERA_EASE_S = 0.8 s`, whose zero
  derivative at u = 0 gives ~190 ms of near-hold on the box after contact — the
  "hold through contact" beat expressed by the curve rather than by a second
  timer. The look point damps onto the ball with `FOLLOW_TAU_S = 0.2 s`, so the
  ball is intended to sit AHEAD of the axis by ~v·τ and drift back to centre as
  it slows: an ease, not a rigid chase.
  ⚠ **IT IS NOT A "YAW-ONLY PULL-BACK", AND DESCRIBING IT THAT WAY MADE IT SOUND
  SMALLER AND SAFER THAN IT IS.** The rig interpolates **position** between
  `CAMERAS.batter.pos = [0, 3.2, 8]` and `CAMERAS.flight.pos = [−40, 120, 90]` —
  a **148.2 ft translation** — plus fov 40° → 55°, near 1 → 4 ft, and a look
  point slewing onto a moving ball, all inside `CAMERA_EASE_S = 0.8 s`. That
  averages 185 ft/s, and a quintic's peak rate is 30u²(1−u)² at u = ½ =
  **1.875×** its mean, so **mid-move the camera travels ~347 ft/s**. Even the
  follow alone is not a yaw: aiming at the −40° ball swings the axis **23.5° in
  bearing and 2.4° in elevation**. Nothing about the behaviour is wrong; the
  description was. It matters because this is the part most likely to read badly
  in motion, and a future reader deciding whether to touch it should know its
  real size.
  **The determinism cost was paid up front with golf's `lib/scene3d/clock.ts`**
  (PR #249). Camera motion is time-driven, and golf measured **23 of 25 scenes
  differing between two identical runs** from `performance.now()` alone.
  `StadiumGL` takes its `dt` from `tickSceneClock` and `baseballpreview.tsx`
  engages a 50 ms virtual clock and FREEZES it at the ready beacon, so `dt = 0`,
  `u` does not advance and the damping factor is `1 − e⁰ = 0`. **All 15 scenes
  are byte-identical across two runs**, the three new ones included.
  ⚠ **One claim in this file's own first draft was too strong and is corrected
  rather than left standing.** The exponential damping is exact under
  subdivision only for its HOMOGENEOUS part; a target that MOVES between samples
  is zero-order held, so two step sizes differ by `≈ v·Δh/2` — measured
  **1.34 ft** between 16.7 ms and 50 ms on a 202 ft/s ball, which is 0.19° at the
  ~400 ft the deck camera stands off a fly, i.e. 9 px of a 1600 px frame. It
  cannot reach the screenshot gate at all, because `?t=` freezes the ball and a
  frozen target is the stationary case. Bounded and asserted, not assumed away.
  **THE GATE WAS RE-BASED, AND IT GOT STRONGER RATHER THAN WEAKER.** The 0.002 ft
  drawn-vs-sim comparison now reads `tracerFull()` (the built path) instead of
  `tracer()` (the revealed prefix) — pointed at the prefix it would silently stop
  asking anything about the part of the curve the ball has not reached, which on
  `homerun` is the whole descending limb. It still reports **1.28e-7 ft forward
  and 1.27e-7 ft reverse**, unchanged. Three new checks sit beside it: the reveal
  COUNT re-derived by the harness from the sim's own sample times (kills a full
  reveal, an off-by-one lead, a stuck reveal); the BUFFER against the sim's own
  track, float for float (kills "rewrite the buffer each frame", which would have
  gutted the comparison above); and the TIP against the ball as a dot
  product toward the next hidden vertex, bounded by that vertex's own distance
  (kills a reversed buffer, and needs no frame convention).
  ⚠ **The buffer check's FIRST VERSION WAS A TAUTOLOGY AND COULD NOT FAIL** — a
  M2e follow-up finding, corrected rather than left standing. It compared
  `tracer()` against `tracerFull()`, and `stadium/tracer.ts` `subarray`s **the
  same backing `Float32Array`** for both readers, so the comparison was
  `positions[i] !== positions[i]`. Its own note claimed "an implementation that
  rewrote the vertex data per frame to end at the ball would pass (a) and (c) and
  fail here"; it would **not**, because such an implementation rewrites
  `positions` in place and both readers return the rewritten prefix identically.
  Nothing escaped in the meantime — the property was still defended by the
  reverse Hausdorff, which reads `tracerFull` over the whole path — but a dead
  assertion that reads as a live one, in a file whose charter is "IT ASSERTS
  NUMBERS, IT DOES NOT MERELY PRINT THEM", is worse than none. It is now two
  legs, **both measured against the sim** and neither against the renderer:
  the drawn prefix must equal the sim's leading samples **index for index**, and
  the built buffer must equal the whole track and be **the same length as it**.
  (`Math.fround` makes those EQUALITIES, not tolerances: a `BufferAttribute` is
  float32.) The prefix claim then falls out as a *consequence* of two sim-anchored
  measurements. **Two mutations were written into `flight.ts` as real behaviour
  and watched:** (M1) "rewrite the vertices each frame so the trail ends exactly
  at the ball" — the old comment's own example — fails **15/15 scenes**, on which
  the old check was **silent on all 15** and `(c)` was **skipped on all 15**
  (it only runs while `drawn < built`, which that mutation makes false by
  construction); and (M2) "resample the built polyline uniformly by ARC LENGTH",
  which is the same curve with the index-to-time correspondence destroyed and is
  the reason the index leg exists at all — forward Hausdorff **1.06e-7 ft**
  (19,000× under tolerance), reverse **2.18e-4 ft** (9× under), horizontal
  deflection **4.99e-2 in against a 5.00e-2 in tolerance, i.e. it PASSED**, and
  the index comparison fires on the **fourth float** of the buffer.
  Plus `checkFraming`,
  which projects the drawn ball through the drawing camera and asks the one
  question `checkBall` explicitly cannot — its own note warns that
  `Object3D.visible` is not "in this picture". Three new scenes: `follow-pull`,
  `follow-oppo` and `follow-ease` (mounted on the batter camera, eased to the
  deck, frozen exactly 400 ms in via a new `?from=` / `?ease=`, which is
  smootherstep(0.5) = 0.500 and the gate prints it). `flight.png` is the ONE
  pre-existing PNG unchanged, because the follow target is the BATTED ball only
  and that scene has a pitch in the air.
  **Fifteen mutations were watched to fail** — seven in `camera.test.ts`, five in
  `flight.test.ts`, three in `DerbyGame.camera.test.tsx` — **and two were watched
  to PASS**, both of which removed code:
  ⚠ **(a) `applyReveal`'s `struck ? full : count` branch was unreachable.**
  `contactTS` IS the plate crossing, i.e. the pitch track's own last sample, so
  `tS ≥ contactTS` already reveals the whole pitch through the ordinary path. Two
  mechanisms covering one case — the shape § "Fielding" records for the
  unreachable `Math.max(0, …)` — so the branch is deleted and the PREMISE is
  asserted instead. ⚠ **(b) `endPlay`'s `setMode('batter')` deleted failed 0 of 3
  tests**, because `nextPitch` set it too, 1500 ms later, with the aim reticle
  already up and the camera still sliding home under it. The second call is gone
  and the assertion now measures the GAP between the return and the next aim.
  ⚠ **Two of the new tests were hollow when first written**, and both are
  recorded at their sites: the HUD stub recorded `api.setMode` (which `DerbyGame`
  never calls — it sets React state, which becomes the `mode` PROP), so the
  recorder stayed empty and two tests passed on `[]`; and the
  frame-rate-independence test held the ball STILL, where a stationary target is
  copied exactly on first sight, so the damping it existed to police never ran.
  **Not done, and deliberately:** the art pass (turf, seams, infield grass, bowl
  detail) and the rest of the `lib/scene3d` reconciliation. `clock.ts` is adopted;
  `quality.ts` / `stats.ts` / `env.ts` are a separate slice.
  ⚠ **KNOWN LIMITS OF THE GATE ON THIS WORK — recorded, not fixed.** They come
  out of `baseball-visual-qa`'s pass on the follow camera and they are the things
  a green run does **not** say:
  - **The gate structurally CANNOT see the follow lag.** Every captured frame has
    the ball at exactly **(0.500, 0.500)** — `follow-pull` and `follow-oppo` both
    print it — because `?t=` / `?bt=` FREEZE the ball and a stationary target is
    the **converged** case of `1 − e^(−dt/τ)`. So `FOLLOW_TAU_S`'s note about
    "~30 ft of lag, the ball sits ahead of frame centre, which is what reads as
    speed" is **untested by the gate by construction**, and what the gate
    photographs is precisely the rigid-chase look that note says the constant
    avoids. The comment at the constant now says so. Only a real-time capture or
    on-device play can settle it.
  - **`FOLLOW_MIN_HANG_S = 1.2` is exercised by no scene.** It is asserted from
    both sides in `DerbyGame.camera.test.tsx` and photographed by nothing.
  - **On-device watch items, for which SwiftShader is the wrong instrument.**
    (a) The **near plane interpolating 1 → 4 ft** across the 148 ft translation.
    A wrong near plane already produced a translucent bowl and radial turf spokes
    on this very scene once — `CAMERAS`'s own `near` note records it — and where
    before only the four table values were reachable, **every intermediate value
    is now reachable at runtime**. (b) The **follow at full frame rate**: the
    whole point of `FOLLOW_TAU_S` is a behaviour at 60 fps that no still frame
    contains. "Renders fine in SwiftShader" is not evidence about either.
  - **Pre-existing, and NOT from this work:** `wide.png` and
    `park-alpine-wide.png` show the near bowl as **semi-transparent with radial
    spoke banding**. Confirmed pre-existing — those two scenes differ from `main`
    by **32 pixels, all tracer** — and filed under the M2 art list above as a
    near-plane item.
  - **Charter gaps with no scene at all:** there is no `batter-open` /
    roof-open pair and **no `night` scene**. Roof state is exercised only
    STRUCTURALLY, via `park-alpine-*` (Harbourfront's 282 ft ring against
    Alpine's absence of one), never as an open/closed pair at the same park.
- **M3 — the art pass, and the park becomes SkyDome.** → **Done.** The owner
  played the live build and passed M2's "is this fun" gate, so this round is
  ART plus one data change that turned out to be gameplay. **No physics constant
  moved**; `C_D`, `C_L`, `e_T`, the Reynolds band, `ν` and every aero golden are
  untouched, and the carry column of the aim sweep is byte-identical to M2's.
  **(1) THE PARK IS RENAMED AND ITS FENCE IS PUBLISHED DATA.** Seven stations of
  distance AND height, a 60 ft backstop, the whole profile in § "The park". The
  name is an owner decision dated in `parks.ts` and in `ip.test.ts`'s
  one-row exception; see that section for why the exception is written as an
  exception to a BANNED term rather than as an absent one.
  **(2) THE DEAD-CENTRE TROUGH MOVED, AND THE REASON IS THE HEIGHT COLUMN.**
  Same seeds, same swings, the carry column unchanged row for row:

  | reticle X | HR before | HR after | carry (unchanged) |
  | --- | --- | --- | --- |
  | −0.30 ft | 69.1 % | 67.7 % | 387.8 ft |
  | −0.20 | 69.8 | **80.6** | 400.4 |
  | −0.10 | 59.7 | 70.1 | 405.8 |
  | **0.00** | **54.9** | **67.7** | 406.6 |
  | +0.10 | 80.2 | 94.8 | 404.8 |
  | +0.20 | 96.2 | **100.0** | 401.7 |
  | +0.30 | 97.2 | 97.2 | 397.0 |
  | +0.40 | 82.3 | 82.3 | 389.5 |

  Trough/peak **0.565 → 0.677**: dead centre is still the worst viable aim — the
  trap survives and the HUD's coaching line still has something true to say —
  but it is a **shallower** trap, because centre field is now the deepest wall in
  the park AND the lowest (8 ft against a uniform 10, while the corners gained
  4½ ft). The pull shoulder also **narrowed**: −0.3 ft is now no better than the
  middle (both 67.7 %) because left field carries 14 ft 4 in on the line and
  11–12 ft through the gaps, so the asserted pull representative moved from −0.3
  to −0.2. All of it is GOLDEN-pinned, so the next fence edit is a diff.
  ⚠ **And one clause had to be re-argued rather than re-recorded.** "The sweep is
  asymmetric at a SYMMETRIC park" was the whole evidence that the `e(z)`-less bat
  has no jamming; the park is no longer symmetric, so the HOME-RUN column is
  confounded and is no longer evidence about the bat. The assertion moved onto
  **carry**, which no fence can reach and which is unchanged — the defect stays
  pinned, on a measurement the data change cannot touch.
  ⚠ **The skill curve compressed further and the number is reported, not
  restored.** The park plays smaller, so every skill level scores more and the
  top squashes: good 4630 → 5745, perfect 5254 → 6171, good→perfect **1.135× →
  1.074×**. Nothing in the chain mechanic moved. The bound is re-recorded at 1.05
  and joined by the *structural* version of the same claim — the chain must open
  the gap the flat payout leaves by ≥1.5× (measured 1.79×) — because tuning a
  payout to hide a fence change is the failure this file exists to prevent.
  **(3) THE BOWL IS A BUILDING.** A `PROFILE` of ten stations — three seating
  decks in deep navy, four dark fascia edges and **two emissive ribbon-board
  bands** — lofted band by band (so every seam is crisp) and merged into **one**
  lit shell plus **one** unlit strip. The crowd is speckle in ONE procedural
  texture, with the vomitory tunnel mouths and the aisles in the same tile; there
  is no crowd mesh and there will not be one, and `quality.seatTexturePx` is its
  only knob. Sections are laid out by **arc length**, not by angle: the bowl's
  radius varies nearly 10× between the 60 ft backstop and centre field, so an
  equal-angle tile came out stretched 2.5:1 in the `pitcher` frame and 2:1 in
  every outfield frame off one square texture.
  **(4) THE ROOF UNDERSIDE IS A SPACE FRAME.** Two ring chords plus a zigzag web
  and a radial post per cell, 96 cells, merged into one draw call and ~1,700
  triangles. Light exterior, dark underside — two single-sided sheets rather than
  one double-sided one, because a `DoubleSide` ring shows the same colour from
  above and below and the contrast IS the reference. `MIN_BAND_FT` 5 → 30 closes
  the M2 finding that the ring degenerated behind the plate into a 2 px wire that
  read as an artifact.
  **(5) THE TURF IS MOWN AND THE INFIELD HAS GRASS IN IT.** One unshared-vertex
  cell grid, one draw call: concentric 22 ft arcs in the outfield and radial
  wedges inside the skinned arc, with the radial levels ABSOLUTE (levels
  proportional to the local wall distance made the stripes ripple as the bearing
  swept). The infield dirt is an annulus between the base-path diamond inset 8 ft
  and `infieldDepthFt`, plus a 13 ft plate circle — **6,881 ft² of grass inside
  the 95 ft arc against the ~7,000 ft² the M2 list estimated**, and that closes
  the M1 gate's real finding (it blamed the arc RADIUS; the cause was a solid
  fan). Foul ground is turf out to the foot of the stands instead of the concrete
  apron showing through. The warning track is a distinctly redder crushed-brick
  against a browner clay. **Dirt falls from 39.6 % of the batting frame to
  30.4 %, turf rises 9.7 % → 19.3 %** (pixel classification, and it reproduces
  the M2 note's 39.6 % on the old shot exactly, which is what makes it a
  measurement).
  **(6) A SKYLINE.** A tapered concrete tower with an observation pod and sixteen
  high-rises, one merged mesh, one draw call, seeded. Architecture is a typology
  and a silhouette, not trade dress; every vertex is generated from a profile
  written in the file. Its bearing was chosen against a FRUSTUM, not by taste:
  the `flight` camera's horizontal half-FOV is 16.3° about a fixed axis, so the
  first placement at −38° projected 34° off-axis and was simply not in the
  picture.
  ⚠ **GPU: 22 → 26 draws and 2,249 → 15,060 triangles at the worst scene**,
  against ceilings of **40 and 120,000**. Four extra calls bought a banded bowl,
  a truss, a mown field and a city, and that is the merge discipline working:
  authored naively it would have been ~40 more. Neither ceiling moved. Shadow map
  stays 1024²; the skyline is deliberately not a shadow caster, since the sun's
  ortho volume is sized from the bowl (±630 ft) and widening it to hold a 790 ft
  tower 1,250 ft out would spend the infield's texels on nothing.
  ⚠ **THE VISUAL GATE COULD NOT SEE THE WORST DEFECT OF THE PASS, AND THAT IS THE
  MOST USEFUL THING THIS ROUND FOUND.** The mown-turf grid's first winding put
  every normal at −y, so a `FrontSide` material drew **nothing** and every camera
  photographed the grey concrete apron underneath the field — and **all fifteen
  scenes passed**. The harness checks draw calls, triangles, fence distances read
  back out of the vertex buffer, the tracer against the sim, the reveal and the
  framing; none of those is "is the grass visible". A human found it in one
  glance. `stadium/field.test.ts` now asserts every ground normal points UP,
  from the built geometry, which is the assertion that would have caught it.
  **Twenty mutations were watched to fail** — the headers of
  `stadium/{geom,stands,field,skyline}.test.ts` list them with their fail counts
  — **and three were watched to PASS and then repaired**, all three of which are
  worth more than the ones that died:
  ⚠ **(a) `bowlInnerRadiusFt` had TWO clamps doing one job.** `Math.min(atLine,…)`
  appeared inside the offset expression AND again on the way out, so deleting the
  outer one changed nothing at any bearing — the same shape as `fielding.ts`'s
  unreachable `Math.max(0, …)`. The dead clamp is deleted and both survivors are
  now observable.
  ⚠ **(b) The skyline test's "the tower reaches the ground" clause swept up a
  neighbouring high-rise.** Its 200 ft axis radius contained a building whose own
  footing at y = 0 satisfied the clause, so deleting the tower's base shell
  passed. 70 ft contains the tower's widest ring (52 ft) and nothing else.
  ⚠ **(c) The infield's "there is a hole in it" clause was a vertex count**, and
  a vertex count cannot express that shape: "no dirt vertices between 20 and
  100 ft" is false of the real geometry (the inner ring dips to 82 ft near the
  lines) AND true of a solid fan, which has an apex and a rim and nothing
  between. It reads the inner edge's radius against the base-path diamond now —
  119.3 ft at dead centre where a fan gives 155.5.
  **Determinism:** all 15 scenes byte-identical across two consecutive full runs,
  with a seeded skyline, a seeded ribbon palette and a seeded crowd texture in
  the scene. **Bundle:** `three` is still its own 537.85 kB chunk, unchanged to
  the byte and to the hash, and the main entry chunk is **846.11 kB before and
  after**; `StadiumGL`'s own lazy chunk grew 18.26 → 25.50 kB.
- **M3b — the art audit's seven findings, and two of them inverted.** →
  **Done.** All render-side; **no physics constant moved** and no aero golden
  changed. 15/15 scenes byte-identical across two consecutive full runs, worst
  scene **29 draws / 16,292 triangles** against the unchanged 40 / 120,000
  ceilings.

  **(1) THE IP EXCEPTION DID NOT SELF-RETIRE, AND THE DOCUMENTED PROPERTY WAS
  FALSE.** `ip.test.ts` and this file both promised that reverting
  `SKYDOME_NAME` makes the allowlist a test failure. Measured: it did not.
  Deleting the `PERMITTED` row failed (2 tests) and an unused extra term failed
  (1), but **reverting the name, renaming the identifier to `PARK_NAME`, and
  deleting the prose all stayed GREEN**. Three things kept the term "live"
  independently of what the park is called: the constant's own identifier
  (`SKYDOME_NAME` matches `/\bskydome\b/i`), the comments explaining the
  decision, and two test-table headers in files that ship nothing. The liveness
  check now requires the term in a **string literal of a non-test source** —
  text that reaches a user's eyes — via a small comments-first scanner whose
  behaviour is pinned on fixtures. All five probes now fail. The general lesson
  is in the file: a source-reading guard that greps raw text is satisfied by
  *talking about* the thing it polices.

  **(2) THE NEAR DIRT WEDGE IS NOT A CAMERA-HEIGHT BUG — THE RELATIONSHIP RUNS
  THE OTHER WAY.** The `batter` eye at 3.2 ft is a crouching catcher's, and
  raising it to 5.5 ft does move the plate-circle rim from y = 1076 to y ≈ 1315
  and halve the brown band. But the 13 ft skinned circle is centred on the PLATE
  and so is the strike zone, so nothing moves one without moving the other:
  raising the eye with the look direction held puts the zone bottom at v = 1.140,
  **224 px below the bottom of the picture**, and re-aiming to recover it gives
  the whole gain back. Holding the zone framed exactly as M2c framed it, the best
  reachable dirt band per eye height is monotone the WRONG way — 346 px at
  3.2 ft, 419 at 4.0, 462 at 4.4, 501 at 4.8, 613 at 5.2, and **above ~5.3 ft no
  placement at any standoff or focal length frames the zone at all**. The lever
  is STANDOFF and FOCAL LENGTH, because the zone's angular size and the
  release-to-zone separation both fall as 1/z while the ground's depression angle
  does not. Shipped: `[0, 4, 19.5]`, fov 20°, aim −1.90°. Dirt band **524 px
  (32.7 %) → 419 px (26.2 %)**, classified dirt **30.5 % → 24.4 %**, turf
  **16.6 % → 27.6 %**; the zone slides 59.5 % → 62.4 % of frame height and loses
  4.7 % of its height, and the ball at release doubles from 4.3 px of radius to
  7.5. The full ladder and the trade are written out on `CAMERAS.batter`;
  `camera.test.ts` now asserts the zone framing AND the dirt bound, with four
  mutations watched — including the 5.5 ft one, which is not a strawman but the
  change the gate recommended.

  **(3) THE BOWL DID NOT CLOSE BEHIND HOME PLATE, AND IT WAS ONE `Math.sign`.**
  `wallTopFt` held the rail at "the nearer foul line's height" outside fair
  territory, and `Math.sign(−180)` picks the LEFT line where `Math.sign(+180)`
  picks the RIGHT — 14 ft 4 in against 12 ft 7 in, a **1.75 ft crack** at the one
  bearing that is dead centre of the `pitcher` frame (measured on the render as a
  53 px step in the bowl foot). Two fixes, both wanted: the rail now blends to
  the MEAN of the two lines across foul ground, so it is periodic; and
  `geom.ring` closes a full circle on its **own first sample**, so closure is a
  property of the primitive rather than of the data drawn round it. ⚠ The first
  version of that closure sorted the closing sample in with the forced extra
  bearings — its bearing IS `b0`, so an ascending sort moved it to the FRONT and
  the ring lost its last segment instead of gaining a closure: a ~180 px hole
  straight through the backstop, found in a PNG and not in a test. `geom.test.ts`
  now carries all three cases. A separate blend for the RADIUS was written and
  then **removed for failing to die**: the backstop clamp holds a constant from
  |β| ≈ 73° to 180° in both parks, so no input can read it near the seam.

  **(4) CROSS-GAME PARITY: THE GROUND HAS GRAIN NOW, AND IT IS SEEDED.** Golf
  bought grain with ~9,500 `Math.random()` calls and lost determinism; baseball
  bought byte-identical PNGs with no procedural surface detail at all. One
  `mulberry32`-seeded two-octave tile (`stadium/grain.ts`), built ONCE and
  `.clone()`d per surface with a different `repeat` — golf's six identical turf
  normal maps are the anti-pattern, `PuttGL` is the model. UVs come from world
  position (`geom.planarUV`) so turf, warning track, clay, the plate circle and
  the mound all sample the same tile at a material boundary with no seam.
  Measured (mean |px − 3×3 blur|, luminance levels; golf fairway is 3.43):

  | surface | before | after |
  | --- | --- | --- |
  | infield clay (`pitcher`) | **0.0000** (one colour) | **2.89** |
  | outfield turf (`wide`) | 0.83 | **3.64** |
  | warning track (`wide`) | 0.97 | **3.88** |
  | roof TOP surface (`wide`) | 0.14 | 0.26, sd 6.9 → **11.8** |
  | sky (`homerun`) | **0.0000**, one value | 0.027, range 176.5 → 170.1–174.1 |

  ⚠ **The sky is deliberately NOT grained and that is the finding, not a miss.**
  A 256 px map over a 360° dome is magnified ~100× at the `batter` lens, so any
  per-texel noise is filtered to a smooth wobble before it reaches a pixel — and
  unfiltered it would be sensor noise, which is not what a sky looks like. What
  it got instead is what a sky has: a zenith-to-horizon gradient, a haze band and
  seeded cloud banding, on one `BackSide` dome. So "flat fill, identical at five
  separated points" is answered while the grain number stays near zero.

  **(5) THE CROWD IS KEPT, AND THE MEASUREMENT SAYS WHY.** Deleting it banks no
  draw call — it has never had one, it is a `map` on a material the bowl needs —
  so the whole saving is one canvas against a deck that becomes a flat navy slab.
  The reason it was invisible is diagnosable: at 115 ft one 256 px tile is
  minified 4:1, and a field of independent 1 px speckles averages to its own mean
  under exactly the filtering that stops it shimmering. The fix is a SECOND,
  COARSER octave — 12-texel clumps (~1.4 ft on the ground, a block of seats)
  that survive minification. Measured at the same sample points, `pitcher`,
  ~115 ft: sd **1.94 → 3.40** on a clean seating patch and **→ 7.21** over the
  wider deck. The tile is also four sections wide now with a seeded per-section
  vomitory offset, which is what breaks the perfectly periodic lattice — it
  cannot be done with `Texture.repeat`, so the tile had to grow rather than the
  sampling change. ⚠ And a UV bug rode in with it: `u` was handed to the shader
  in SECTIONS where a texture wraps every 1.0, so the four-section canvas was
  squeezed into every single section — four aisles and four vomitories each. It
  rendered as a plausible bowl and was given away by a residual 2 px line at the
  seam.

  **(6) THE SMALLER ONES.** The infield's radial **sunburst mow is deleted** —
  no groundskeeper cuts spokes from the plate, and one pattern rule made the
  function shorter, not longer. Batter's boxes and a catcher's box are drawn
  (rule-book 6 × 4 ft and 43 in × 8 ft) and cost **no draw call**, because
  merging them with the two foul lines takes the chalk from 2 calls to 1. The
  mound takes a finer grain tile — its geometry was right to 4 px and a 5.3°
  cone under a near-axial sun has no Lambert term to separate its faces with, so
  relief had to come from the surface. The roof's top gets per-column panel bays
  and a retractable-split seam, on a loft that already existed. The skyline's
  boxes get a shared window map (`stadium/windows.ts`, one implementation, two
  callers) and the tower samples a **plain lane** in the same map so a concrete
  mast does not come back covered in office glazing. The tower moved 1150 →
  1500 ft, which is what un-clips its observation pod in `homerun` (34.5° of
  elevation against a 55° frame that tips up to hold a ball).

  **(7) TWO HONESTY ITEMS, FLAGGED AND NOT CHANGED.** The fence profile now
  carries **"reference unverified"**, on the same standard `C_L`'s fit, `C_D`'s
  subcritical branch and the 95 ft infield arc already carry: no citation is
  attached to it anywhere, so "published data" is a provenance claim nothing in
  the tree supports. No number moved — they are inputs to the physics exactly as
  the ball's mass is, and moving one to chase an unverified reference is the
  mistake `BREAK_SEGMENT_FT` exists to prevent. And **the roof height is measured
  now**: `RoofPart.sample` reads the peak and both radii out of the drawn vertex
  buffer, the harness differences them against `parks.ts` at five bearings and
  exits non-zero past 0.05 ft. It printed `roofPeak 282 ft` straight from its own
  input before, which reads as a measurement and is not one — and the ceiling is
  a real mechanic (`resolveFence` rules a ball that reaches it `'roof'`).
  Mutation-verified: drawing the roof 40 ft low now prints `worst |Δ| 40.000 ft`
  and fails the run.

  **(8) THE CENTRE-FIELD STRUCTURE — owner scope, added mid-slice.** Modelled
  from a reference photo of the real venue's centre-field elevation: a dark
  structural frame the board array is RECESSED INTO, a step-back soffit, a band
  of hotel windows over it, and a line of banners and two flags under the roof
  edge. `stands.ts` cuts a real recess in the deck for it — the whole profile is
  pushed out past the structure and lifted above it inside `RECESS_HALF_DEG`, and
  `geom.ring` gained a forced-sample list so the wedge's side walls are vertical
  at every quality tier rather than landing up to 22 ft off wherever
  `bowlStepDeg` fell. **Three draw calls** (structure, window band, banners+flags
  merged), windows as texture rather than geometry, everything seeded.
  `centrefield.ts` owns the recess and therefore exports the board's real
  geometry as **`CENTREFIELD_BOARD`** — `{ widthFt: 100, heightFt: 50,
  faceDistFt: 430, sillFt: 26, bearingDeg: 0 }`, unchanged from the size the
  gate verified. **No board is mounted here.**
- **M4 stage 1 — the DUEL, headless.** → **Done.** Seven new modules, no
  components, no physics written: `duelRules.ts` (444), `duelInnings.ts` (236),
  `duelState.ts` (280), `duelSim.ts` (462), `ai.ts` (361), `batterAim.ts` (380)
  and `rng.ts` (34), all inside the 500-line cap, plus `duelSim.test.ts` and
  `ai.test.ts`. Every number the duel reports comes out of a module that was
  calibrated before it existed; what is new is the bookkeeping, the command map
  and the opponent.
  **(1) THE FORMAT AND ITS HARD CAP.** 3 innings, 3 outs, 4 balls, 3 strikes, a
  foul at two strikes stays at two. No stolen bases, no errors, no substitutions,
  no shifts, no pickoffs, no leads, no throws. Baserunners advance **by force
  only** — a single moves every runner one base and a walk moves only the forced
  ones — which is a **stated rule, not a model**, and it biases scoring **DOWN**
  in every one of its omissions (a real single scores from second more often than
  not; a real fly ball with a man on third and one out often scores him). The
  rule is pinned by a table test that asserts `advanceRunners([_,2,_], 1).runs`
  is 0. Extra innings are the ordinary rule of baseball; `MAX_INNINGS = 9` is a
  **BOUND, not a rule**, and the bench prints the longest game any seed produced.
  **(2) THE COMMAND MAP IS DERIVED FROM THE ZONE, NOT PICKED.** One scalar
  accuracy-bar stop has to become a two-dimensional displacement, so it needs a
  magnitude and an axis, and one sentence fixes both: at `|e| = 1` the
  displacement is the CALLED zone's half-width and half-height, so **a full miss
  on a pitch aimed at dead centre lands exactly on the called corner** — the
  first pitch that is not a strike. The axis is the arm slot (early ⇒ up and arm
  side), mirrored through `zone.armSideX` once. The sim takes numbers, never
  gestures.
  **(3) THE FINDING, AND IT IS THE ONE WORTH READING.** The reticle assist
  shoulder is a labelled feel knob calibrated **for a home run derby**, and
  played as a duel it made the game unplayable. An aim error under **3.33 in**
  moves the swing's undercut by less than a tenth of an inch — i.e. reproduces
  the CALIBRATED reference swing, 101 mph at 27°, 411 ft, over the wall at every
  bearing at SkyDome — and 3.33 in is **54 %** of the 6.15 in at which contact is
  lost altogether. Measured over 24 seeded duels: **40 % of balls in play left
  the park, 6 singles against 47 home runs, 21 runs a game**.
  ⚠ **AND NO AI KNOB FIXES IT.** The plateau's share of the contact range is
  `(0.10/2.14)^(1/(p+1))` — it depends on the fade POWER alone. Narrowing
  `fullMissIn` rescales both edges together and leaves the ratio at 54 %;
  widening the AI's aim or timing spread only adds whiffs, because
  `P(home run | contact)` is a ratio the spread cancels out of. All eight AI feel
  knobs were swept and none of them moves it.
  So the shoulder became a **modulator on the one implementation** —
  `batterAim.ReticleAssist`, defaulting to the derby's pair so nothing there
  moved — and the duel carries `DUEL_ASSIST`, with **both** numbers calibrated
  against a stated property rather than a run total: `fadePower = 1.5` so the
  reference plateau is **29 %** of the contact range instead of 54 %, and
  `fullMissIn = 12` so the **contact edge does not move** (6.02 in against 6.15).
  The duel is therefore not harder to make CONTACT with, only harder to SQUARE
  UP, and `duelSim.test.ts` prints and asserts both fractions.
  **(4) THE OUTCOME TABLE — 16 seeded games per difficulty, AI against AI at the
  same skill on both sides.**

  | difficulty | runs/game | pitches | PA/game | K/PA | BB/PA | HR/PA | HR per ball in play | 1B/2B/3B |
  | --- | --- | --- | --- | --- | --- | --- | --- | --- |
  | 0.15 | 5.06 | 100 | 29.0 | 38.4 % | 11.6 % | 8.6 % | 17 % | 79/17/3 |
  | 0.50 | 6.19 | 93 | 28.9 | 34.8 % | 5.8 % | 8.7 % | 15 % | 94/23/3 |
  | 0.85 | 8.25 | 94 | 33.4 | 21.0 % | 1.5 % | 6.7 % | 9 % | 153/41/9 |

  MLB reference: K 22 %, BB 8.5 %, HR 3 % of plate appearances and ~5 % of balls
  in play. So the medium row is MLB-shaped on strikeouts and walks and sits
  ~2.5× above it on home runs, which is the arcade brief. Representative
  finals at 0.50: **10-2, 7-4, 1-0, 7-6, 11-4**. The bands are asserted, and so
  is the **shape** of the curve, which no single band can see: a better AI
  strikes out less and walks less at every step.
  ⚠ **Two honest weaknesses in that table.** The difficulty-0.85 pitcher issues
  essentially no walks (1.5 %), because he throws 64 % of his pitches in the
  called zone and a plate appearance ends before four balls can accumulate; and
  93 pitches for three innings is long against the 2.5–4 min brief. Both are feel
  knobs for the stage-2 pass, not model defects.
  **(5) WHAT `fielding.ts` COULD NOT ANSWER,** reported rather than papered over
  in `duelSim`. Its landing-point limitation, which the derby never exercised
  because a derby has no defence, is **load-bearing in a duel**: the clause that
  caps any unfielded ball landing on the dirt at a SINGLE means **every ground
  ball is a base hit**. A topped ball lands ~4 ft from the plate, 105 ft from the
  nearest fielder's standing spot, and is scored a single every time — there is
  no 6-3 groundout anywhere in this game. That is exactly the "when the duel
  wants real infield play the fix is a rolling phase" its own constant predicts,
  and it is now a duel-visible fact rather than a note. Two smaller ones: the
  interface has no way to express a sacrifice fly (a caught fly with a man on
  third is a plain OUT, consistent with forced-advance-only), and `'roof'` falls
  through its outcome switch to the ordinary miss arithmetic, which is correct
  per `parks.ts` but is undocumented in `fielding.ts`.
  **(6) EIGHTEEN MUTATIONS WERE WATCHED,** against a verified-green baseline;
  seventeen failed on the first attempt. The one that **survived** is recorded
  because it is worth more than the others: swapping the walk and strikeout
  checks in `paOutcomeOf` failed nothing, and the reason is that one pitch moves
  one number, so **no legal count can reach four balls and three strikes at
  once** — the reordering is UNREACHABLE, not merely unobserved, the same
  category `fielding.ts` records for its infield cap. The guard is now the
  PROPERTY the ordering rests on (exclusivity over all 60 legal count × outcome
  pairs) plus the ordering asserted directly on the impossible input, and the
  mutation now fails.
- **M4 stage 2 — the duel's HUD and scene.** The pitching slingshot
  (`pullAim` released into an `AccuracyBar` sweep, handed to `servePitch` as an
  intended location plus a stop error), the batting HUD reusing the derby's
  reticle and timing bar, the videoboard wiring, and the camera modes for a
  pitcher's half. None of it exists yet; stage 1 is headless on purpose.

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
- **`C_D` is now a CURVE, and break barely notices.** Break is a *difference*
  between a spun and a spinless trajectory that share the same drag, so a change
  to `C_D` very nearly cancels out of it: stage 3b's Reynolds dependence moved the
  eight golden break rows by at most **0.036 in** (the curveball, the slowest and
  so the only one deep in the crisis band) and left all sixteen published
  residuals unchanged to 0.1 in. What it *does* move is the plate SPEED of the
  slow pitches — the curveball arrives at 72.7 mph instead of 73.5. If you are
  chasing a break error, `C_D` is not the lever; if you are chasing a plate speed,
  it is.
- **Break numbers only mean something with a convention attached.** 22.59 in and
  15.23 in are the *same pitch* measured over 55 ft and 45 ft. Convert published
  targets into our convention; never move a coefficient to close the gap.
- **The measured segment sets SCALE, never SHAPE.** `|v|` cancels out of
  `Δ ≈ ½·K·C_L·L²`, so every pitch's break moves together when `L` moves and the
  ratios between pitches do not move at all (measured: ≤ 0.011 between L = 40 and
  L = 50). If one pitch is out relative to the others, `BREAK_SEGMENT_FT` is not
  the lever — its spin/efficiency data is, or the missing physics is.
  `pitchSim.test.ts` asserts the ratio law so that a per-pitch fudge factor is a
  test failure.
- **`C_L`'s SHAPE is not the lever either, and the reason needs no `C_L`.** The
  ratio law makes `C_L(S)`'s functional form the one thing that *could* change
  the relative pattern, so "the error is not in a coefficient" cannot be asserted
  by fiat. It is closed by monotonicity alone: the cutter out-spins the changeup
  (S 0.175 vs 0.152) and breaks **half** as much in the published columns, which
  a monotone `C_L` forbids at any segment. Refitting `C_L` cannot reach the
  table, so nobody needs to try.
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
  gravity rotates the velocity 7.1° through the flight (measured, on that row —
  the arsenal spans 2.8° for the four-seamer to 12.0° for the curveball), so an
  axis parallel at
  release is not parallel at the plate and a real sliver of transverse spin
  appears — 0.14 in over the last 10 ft, 1.44 in over 50 ft. That is physics, not
  a leak in the projection; the leak would show up in the 10 ft figure and in
  stage 1's superposition test.
- **A carry number without its AIR and its BACKSPIN is meaningless**, exactly as a
  break number is without its air and its segment. 4.7 ft between ISA and
  game-day sea level, 34.7 ft to a mile high, and ~1.5 ft per 100 rpm of backspin
  at the ladder optimum (it was ~4 under the constant `C_D`: the drag crisis puts
  far more drag on the slow tail, which is exactly where a high-spin ball was
  buying its extra carry). Every carry figure in this document is quoted at
  game-day sea level with 2200 rpm.
- **`eA` is a FUNCTION, never the literal 0.20.** The derivation
  `1/M_eff = 1/M + (z−z_cm)²/I_cm`, `q = m/M_eff`, `eA = (e−q)/(1+q)` closes on the
  published 0.5816 kg / 0.2498 / 0.2002 triple, which is the whole reason the bat
  spec, the COR and the ball's mass all reach exit velocity through one channel.
  Hand-setting it breaks the `(1+e)/(1+q) ≡ 1+eA` identity everywhere except the
  point it was set at (mutation-verified: 4 tests).
- **Spin is AXIAL on the hitting side too.** A left-handed batter is not "a
  right-handed batter with `y` negated": `mirrorPolarY` flips `v.y`,
  `mirrorAxialY` flips `ω.x` and `ω.z` and leaves `ω.y`. Get it wrong and the
  lefty's pulled ball slices instead of hooking while EV and LA stay perfect.
- **The batted ball's "sweet spot" is in the wrong place, on purpose, for now.**
  The rigid model has no bending modes, so `eA` climbs toward the balance point:
  4 in toward the tip costs 11.53 mph (correct), 4 in toward the handle *gains*
  2.71 mph (incorrect), and an *inside pitch* — a smaller aim radius — is rewarded
  out to ~6 in, so there is **no jamming in this model at all**. All three are
  golden-pinned. The fix is a measured `e(z)`, not a nudge.
- **A 400 ft CARRY is not a 400 ft home run.** A ball carrying exactly 400 ft
  lands at the base of a 400 ft wall. Clearing the published 8 ft wall there
  needs 407.2 ft (it was ~409 against the old uniform 10 ft).
  Every fence assertion says which quantity it means — `distanceAtHeight(flight,
  wallHeight)` is the one the resolver compares — because "a 400 foot homer" has
  no answer until you fix which 400.
- **Wind is a Galilean boost and it MUST stay horizontal.** `simulateBattedBall`
  integrates from `v − w` and adds `w·t` back, which is *exact* for a uniform
  wind and needs no change to `aeroAccel` — but the ground crossing is solved on
  `z`, and `z` is frame-invariant only while `w.z = 0`. `w.z` is ignored on
  purpose. An updraft needs the crossing solved in the boosted frame, and that is
  a different piece of work.
- **A park factor is the fifth category.** Altitude reaches the ball through
  `ρ → K` and nothing else, and the like-for-like measurement (+29.1 ft on a
  400 ft fly at 5200 ft) is inside the published band without one. If a park ever
  "plays big", the honest dials are its fence data and its air — never a
  multiplier on carry.
- **Fielding reads the LANDING POINT, so there is no roll and no throw.** Two
  labelled knobs stand in for them (`GROUND_INTERCEPT_FT`, and the cap that makes
  any unfielded ball on the dirt a single). Do not tune them to fix an infield
  outcome; the fix is a rolling phase, and then both are deleted.
- **"On the dirt" is a FUNCTION of bearing; "how deep" is a flat datum.** They
  were one constant only because a wrong plate-centred circle happened to equal
  the arc's centre-field crossing. `infieldDepthFt(β)` answers the first and
  `XB_DEPTH_DATUM_FT` the second, and collapsing them back into one symbol
  re-calls 1.6 % of the lookup and flips two named ladder rows — measured, and
  printed by `fielding.test.ts` as a counterfactual so the choice stays visible.
- **A scene number in world FEET is not scale-free, and the ball is 0.12 ft.**
  `StadiumGL`'s `sun.shadow.normalBias = 6` is right for a 1260 ft shadow volume
  and ~50× wrong for a baseball. Anything tuned against stadium-sized geometry —
  shadow bias, near planes, the anti-z-fighting layer offsets in `field.ts` — has
  to be re-read the day a ball-sized object enters the scene, and the symptom
  will be a floating ball, not a shadow complaint.
- **A payout is capped for EVERY outcome or the score vanishes silently.**
  `packages/relay-worker/src/games.ts` REJECTS (400, never truncates) a score
  above `rounds × MAX_POINTS_PER_ROUND`, and `DerbyGame.bank()` swallows it with
  `.catch(() => undefined)` — so an over-cap score disappears with no UI signal
  at all. `derbyScoring.swingPoints` is the ONE entry point and the ONE place the
  clamp lives, and `validatePayoutCap` loops over `DERBY_OUTCOMES` rather than
  listing the outcomes that happen to score today. A hand-written list cannot see
  "somebody added a sixth outcome and forgot the cap", which is exactly the shape
  the `bestStreak` bug had.
- **`PITCH_TEMPO` is the ONLY legitimate lever on how hard the timing is.** The
  contact window is DERIVED from the bat's length (~26 ms of TRUE time) and
  nothing may widen it — but the player lives in wall time, where his window is
  `contactWindowS / PITCH_TEMPO`: ±48.0 ms at 0.55, ±58.7 ms at 0.45. Turning it
  moves no outcome rate at any true offset; it rescales the axis the thumb is on.
  One test is stated in wall ms and therefore DOES depend on it, on purpose —
  `derbySim.test.ts`'s cliff/slope sweep — and it is the measurement that
  justifies the value.
- **A TRAIL THAT REACHES PAST THE BALL IS AN INFORMATION LEAK, not a look bug.**
  The tracers are built once from the sim's samples and REVEALED with
  `setDrawRange`; no vertex may move after `setPaths`, because the visual gate's
  0.002 ft drawn-vs-sim comparison reads the built buffer (`tracerFull`) and a
  buffer that is re-authored every frame is not a thing that comparison can be
  about. The reveal count is a LOWER bound on purpose — the tip lags by up to one
  substep and never leads. If a check ever needs "what is on screen", that is
  `tracer()`; if it needs "what the renderer built", that is `tracerFull()`.
  Confusing them narrows the geometry check to a prefix and it fails silently.
- **NEVER assert one read-back against another read-back of the same buffer.**
  `tracer()` and `tracerFull()` are two `subarray` windows onto one
  `Float32Array`, so `read()[i] !== readAll()[i]` is `positions[i] !==
  positions[i]` — identically false, for **every** implementation, including the
  in-place per-frame rewrite it was written to catch. The gate shipped exactly
  that as its "the geometry must not change" assertion. A read-back is only
  evidence against **something the renderer did not produce**: the sim's own
  track, or a snapshot the harness took itself. Same rule that made
  `ballScene()` and `read()` read out of the Object3D in the first place, one
  level up.
- **The render layer's clock is `lib/scene3d/clock.ts`, never `performance.now()`.**
  Anything time-driven in the scene — the camera transition, the follow damping,
  the standalone replay loop — takes `dt` from `tickSceneClock`, and every branch
  must tolerate `dt === 0`. That is the whole of what lets a moving camera
  coexist with byte-identical PNGs. Golf measured 23 of 25 scenes differing
  between two identical runs before it did this, and the cause was time, not RNG.
- **A GROUND SURFACE CAN RENDER FACE-DOWN AND PASS THE VISUAL GATE.** The mown
  turf's first winding faced every normal at −y; a `FrontSide` material drew
  nothing and every camera photographed the concrete apron underneath the field,
  and all fifteen scenes came back green. The harness asserts draw calls,
  triangles, fence distances read out of the vertex buffer, the tracer against
  the sim, the reveal and the framing — none of which is "is this surface
  visible". Winding is DERIVED in `geom.ts`'s notes and now ASSERTED in
  `stadium/field.test.ts`; a new ground mesh gets a normal check or it gets no
  guard at all.
- **`mergeGeometries` takes the INTERSECTION of attributes, and that is a
  feature.** One bowl band authored without UVs dropped the `uv` attribute from
  all nine and the crowd texture sampled texel (0,0) everywhere — a flat-looking
  bowl with no error anywhere. Zero-filling would be worse: the parts that had
  the attribute would render right and the ones that did not would render black,
  which looks like a lighting bug and is a geometry one. Every part gets every
  attribute, including the ones that only need a placeholder — that is what the
  crowd texture's white fascia lane is for.
- **ANYTHING FACING THE PLATE HAS TO BE AUTHORED BRIGHTER THAN IT SHOULD LOOK.**
  `StadiumGL` puts the one shadow-casting sun BEHIND home so it lights the
  outfield wall the batter is looking at; the backstop therefore faces the sun's
  back and is carried entirely by the hemisphere fill at roughly half weight. A
  true backstop-pad green of `0x1b3b2c` rendered as pure black across the middle
  of the `pitcher` frame. The same applies to the roof underside, which came out
  as a hole punched in the sky at `0x2a2e36`.
- **A boundary test must BRACKET the boundary, not sit on it.** `resolveFence`'s
  height test is strict, so bisecting a ball to arrive at exactly wall height at
  exactly the fence is a coin flip on the last bit — it read `homeRun` under a
  10 ft wall and `offWall` under the published 8 ft one with nothing in the
  resolver having changed. Assert a quarter of an inch either side and PRINT the
  exact row.
- **⚠ A `DirectionalLight` HAS A DIRECTION AND NO POSITION, SO A "FIELD RIG"
  LIGHTS EVERYTHING THAT IS NOT THE FIELD TOO — and this has now shipped THREE
  TIMES on three different surfaces.** The night row aims the one directional
  nearly straight down, which is right for the turf and wrong for every surface
  the rig is not standing inside: the parked roof deck rendered at **86 %** of
  its own daytime luminance, the concourse at **81 %**, and the skyline at
  **65 %** with the landmark tower's concrete shaft at **96.1** against a
  floodlit turf at **83.2** — an unlit object 1,250 ft outside the park, the
  brightest large mass in a night frame. `sunIntensity` cannot separate them:
  two surfaces with the same normal hold a FIXED ratio at every intensity, and
  the concourse proves it independently of the deck — their night
  `E_hemi/E_total` triples agree to four places. **Reflectance is the only
  per-surface channel a shared light leaves**, so each is a `daylight.ts`
  column. The exactly-derived "rig removed" albedo is BLACK for all three
  (0.22, 0.00 and 0.14 rendered), so every shipped value is a lift and every
  lift is anchored to something already measured — the deck to the stack's own
  soffit, the concourse to the deck's own per-channel factor, the city to the
  sky dome's horizon stop. Every one of the three passed the whole suite and
  was found by a human looking at a PNG; the guards are now
  `daylight.test.ts`'s dark-mass tests and the harness's `NIGHT_MASS_PATCHES`.
- **⚠ A MULTIPLYING MAP CANNOT MAKE ANYTHING BRIGHTER, so "lit" has to be
  authored as a DARKER SURROUND.** `crowd.ts` learned this for the night crowd;
  `windows.ts` had the identical defect and nobody had measured it. A "lit"
  window is `rgba(255,236,190, ~0.9)` over a white wall lane, i.e. ×0.9 of the
  concrete beside it — measured, the tallest high-rise's lit windows rendered
  **74.9 against a wall at 85.8** at night and **119.7 against 132.4** by day.
  The lit windows in that map had never been lit. The fix is `cityWallGain`
  (pull the wall lane down) plus a tint that IS the window colour — and the
  tint has to carry the colour temperature too, because both night lights are
  blue and a neutral tint renders a neutral window (measured: (73,76,74) grey
  sparkle at exactly the same luminance as the shipped warm (100,73,43)).
- **A park's SURROUNDINGS are data, exactly like its roof.** The skyline builder
  reads `park.surroundings` and returns an empty group for anything that is not
  `'city'`; its first version did not and put a 790 ft downtown communications
  tower on a mountain park at 5,200 ft. An `if (park.id === …)` in a builder is
  the failure mode, and `skyline.test.ts` is the guard.
- **The called zone is the rule zone plus one ball RADIUS a side (19.90 in),
  not a diameter (22.81 in).** A strike is any part of the ball over any part of
  the plate and we integrate the ball's *centre*, so the centre may sit one
  radius outside an edge. The 1.91 ft figure that circulates is the diameter
  version and would widen each side of the plate by an extra 1.45 in.
