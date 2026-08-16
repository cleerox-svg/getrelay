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

A park is a **data entry and zero code**: `parks.ts` holds the `Park` shape, the
generic fence/roof/air machinery, and a `validatePark()` that
`parks.test.ts` runs against a deliberately-broken park (14 distinct complaints,
asserted individually). Adding a venue is a row in `PARKS`.

**M1's home park is `Harbourfront Dome`** — original name, Toronto homage:
−45° 328 ft, −22° 375, 0° 400, +22° 375, +45° 328, a uniform 10 ft wall,
250 ft of elevation, a retractable roof 282 ft up, 28 ft of foul ground. A second
park, `Alpine Heights` at 5200 ft, exists so that **altitude can be measured**
rather than asserted — it is deeper, asymmetric, and carries a 16 ft wall in
left-centre so the height column is exercised by something.

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
is **in play**; clearing a 10 ft wall there takes ~409 ft of carry. The asserted
boundary is on the *distance at wall height* — `distanceAtHeight(flight, 10)` —
which is the quantity the resolver actually compares: 400 ft clears (10.000 ft at
the fence), 395 ft does not (4.560 ft at the fence, off the wall).

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
  field is live data rather than decoration.

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
| `packages/relay-ui/src/lib/baseball/parks.ts` | The park as DATA + `fenceAt` (pchip through the sampled wall), the roof mechanic (`roofClosed`, `parkConditions` — exactly-zero wind and pinned air when shut), `resolveFence` (analytic fence crossing → homeRun/offWall/foul/roof/inPlay) and `validatePark()`. Read by the physics AND by stage 4's geometry |
| `packages/relay-ui/src/lib/baseball/parks.test.ts` | The park bench: prints the fence tables (pchip vs linear, with the knot-slope jump), the roof-open weather draw, the roof ceiling ladder, the wind-bearing histogram, the wind boost against an independent ground-frame RK4, and the altitude ladder; asserts the 400/395 wall boundary, the foul pole, `wind === 0` under a shut roof, byte-identical trajectories across seeds, the uniform bearing window, a TRIPWIRE on golf's wind sampler, and the altitude result against the published 25–30 ft band |
| `packages/relay-ui/src/lib/baseball/fielding.ts` | The deliberately tiny defence: fixed alignment, a ramped reach, one defender rating, → out / 1B / 2B / 3B / HR, and `infieldDepthFt(β)` — the 95 ft arc, read by the lookup AND by `stadium/field.ts`. 323 lines, and the cap is the design |
| `packages/relay-ui/src/lib/baseball/fielding.test.ts` | The fielding bench: prints the reach ladder and a named batted-ball ladder; asserts the catch boundary exactly on the reach, the single/double index boundary, the foul-territory boundary, the rating's ±15 % span, and the landing-point limitation |
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
  shape, `Harbourfront Dome` and `Alpine Heights` as data, `fenceAt`, the roof
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
  nothing because M1's wall is a uniform 10 ft. Both are now asserted. ⚠ The
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
- **M2 — art, and four things the gate photographed.** Recorded here so they are
  not lost, and deliberately **not** fixed in the M1 follow-up pass:
  - **The bowl is not a building.** It is an open lofted ribbon with no back and
    no seat deck, and the apron disc runs to 570 ft past the bowl's 459–531 ft
    outer edge, so bare ground shows beyond the stands.
  - **The roof ring degenerates.** 120 ft of band over the outfield down to a 5 ft
    sliver behind home and along the sides (clamped by `MIN_BAND_FT`), which from
    above projects as a 2 px dark wire across the field and reads as an artifact.
    Proven to be the roof: the roofless Alpine shot has no such lines.
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
  **Smaller:** the tempo's direction is written as a MULTIPLY in the four places
  that had it backwards (`derbySim.ts` ×2, `stadium/flight.ts`, `StadiumGL.tsx`);
  `BaseballScreen` sets `immersive` so the tab bar and navbar unmount under the
  canvas instead of painting beneath it; `apiRef` is nulled on unmount; the
  Games hub says four games.
  **Eight mutations were watched to fail** — the four in `DerbyGame.test.tsx`'s
  header and (19)–(22) in `derbySim.test.ts`'s.
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
- **Stage 5 — game & scene.** `derbySim.ts`, `duelSim.ts` (3 innings, 3 outs, no
  steals/errors/subs/shifts), `ai.ts`, the crowd/lights/skyline builders, HUDs,
  and the budget / determinism / IP guard tests.

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
  lands at the base of a 400 ft wall. Clearing a 10 ft wall there needs ~409 ft.
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
- **The called zone is the rule zone plus one ball RADIUS a side (19.90 in),
  not a diameter (22.81 in).** A strike is any part of the ball over any part of
  the plate and we integrate the ball's *centre*, so the centre may sit one
  radius outside an edge. The 1.91 ft figure that circulates is the diameter
  version and would widen each side of the plate by an extra 1.45 in.
