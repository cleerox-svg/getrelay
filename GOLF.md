# Golf — the in-app game

A 3D golf game inside the Relay **Games** hub (`/games`), built on Three.js and
a small hand-rolled physics sim. It is large and self-contained enough to have
its own sub-agent (`golf`), its own conventions, and its own visual gate
(`golf-visual-qa`).

**This doc describes what ships today.** Section 1 is the current state,
sections 2–5 are the code map and the rules that bite, section 6 is retained
DECISION HISTORY (clearly marked, not a live plan), and the final section is an
append-only defect list owned by another session.

Read alongside:

- **`/GRAPHICS.md`** — the platform decision record: why Three.js and not
  Unity/Unreal, why WebGPU is deferred, why there is no `EffectComposer`, the
  GPU budget rules, and why the visual gate must be deterministic. Those
  decisions are NOT restated here; this doc cross-references them.
- **`packages/relay-ui/src/lib/scene3d/README.md`** — the contract for the
  shared multi-game 3D kit that golf and baseball both consume.
- **`terrain.ts`'s "HOW TO AUTHOR A HOLE" header** — the authoring contract for
  Course holes. It is the source of truth; this doc only points at it.

---

## 1. What ships today

### 1.1 The hub — `GolfScreen`

Tapping the Golf chiclet (or the featured hero) in `routes/Games.tsx` mounts
`components/golf/GolfScreen.tsx`, a self-contained hub with **three top tabs**:

| Tab | Segments | What's there |
|---|---|---|
| **Play** | — | `GolfMenu`: a painted hero for the selected course with **Play round**, a **Change course** picker, single-hole play, a **Challenge a friend** CTA, a local personal-bests strip, and a mode strip (Mini-Golf / Driving Range / Course) that reveals each mode's picker. |
| **Arena** | Daily · Events · Ranks | `GolfDaily` (seeded daily hole + streak), `GolfTournaments` (rapid 3-hole events, seeded, synthesized course), `GolfLeaderboard` over three boards (Mini-Golf / Course / Range). |
| **Clubhouse** | Profile · Locker · Season · Wallet | `GolfProfile` (records + rank), `GolfShop` (cosmetics), `GolfSeason` (season track + claims), `GolfWallet` (coin balance + ledger). |

The header carries the player's framed avatar and a **coin balance chip** on
every tab; tapping the balance jumps to the Locker. The Arena tab carries a 🔥
streak chip and a 🏆 live-event chip so a returning player sees them without
opening the tab.

Immersive play (`setImmersive`) hides the app chrome for the full-bleed 3D
scenes; background music switches between a menu track and a ducked round pad
(`lib/audio`), and every HUD carries a `MuteButton`.

**Friend challenges.** `NewChallengeSheet` (course / length / hole + create and
send) drops a `relay://challenge/<id>` message on the normal composer send path;
`ChallengeCard` renders that message in the chat rail as a live card and runs
the round in a `CourseGame` overlay — no cross-tab navigation. Backed by
`POST /game/challenge`, `POST /game/challenge/:id/result`,
`GET /game/challenge/:id`.

**Coin economy.** `lib/golf/economy.ts` is a small zustand store (deliberately
outside the messenger `lib/store.ts`) caching wallet, cosmetics catalog /
ownership / equip, and the season track, each behind a fetch-once `ensure*()`
that degrades to empty when unauthed or offline. `lib/golf/cosmetics.ts` is the
`three`-free render seam: it resolves the equipped catalog item's `visual`
generically (no per-id logic) into a `GolfCosmetics` the `*GL.tsx` scenes read
ONCE at scene build — ball skin and tracer colour — plus a `GolfFrame` avatar
overlay. Default equip renders byte-identically to the pre-economy scenes.

### 1.2 Course mode — 4 courses, 45 authored holes

`lib/golf/courses/` is a registry of real, playable courses, all **pure
`CourseHole` DATA** — no per-hole code:

| Course | id | Holes | Par | Yards |
|---|---|---|---|---|
| Augusta National | `augusta` | 18 | 72 | 7,555 |
| Listowel · Vintage | `listowel-vintage` | 9 | 36 | 3,366 |
| Listowel · Heritage | `listowel-heritage` | 9 | 36 | 3,395 |
| Listowel · Millennium | `listowel-millennium` | 9 | 36 | 3,445 |

`courses/index.ts` exports `GOLF_COURSES` / `getCourse(id)` and is `three`-free,
so the menu and hole-picker can import it without pulling the 3D chunk.
`courses/builder.ts` supplies `hole()` (defaults), `greensideHazard()` (places a
hazard at the minimum distance that clears the wobbled fringe pad) and
`defineCourse()` (derives `par`/`yards` from the holes so a scorecard can never
drift from the data). `validateCourse()` is run as a **hard gate** by
`courses/courses.test.ts` over every hole of every course.

Each course file states its DATA CONFIDENCE up front — Augusta's pars, yardages
and dogleg directions are real, its survey geometry is not; Listowel Vintage's
card is confirmed, the other two nines are plausible authoring. Refining them is
a data edit, never a code change.

Play modes: **full round** (scorecard, running to-par, one wind for the round)
or **single hole** from the picker's map cards (`HoleThumb` draws a pure-SVG
top-down map from the same terrain math the scene uses). `CourseGame.tsx` is the
HUD wrapper (club selector, power meter, accuracy bar, spin puck, wind chip,
distance-to-pin / strokes / lie, hole-out banner, records recap, telemetry
panel); `CourseGL.tsx` is the lazy Three.js scene driving a live `CourseSim`.

Signature per-hole content that is authored, not derived: doglegs, elevation
change, hazard placement, cart paths, and — on 13 of Augusta's 18 holes — a
`bloom` flowering grove (2 of those in the `'understory'` form). Nothing in the
renderer parses a hole's name.

### 1.3 Mini-Golf — 3 courses, 24 holes

`lib/golf/puttCourses/` mirrors the Course registry (`PUTT_COURSES`,
`getPuttCourse(id)`, `three`-free), each course 8 holes, par 23, in the 100×125
virtual board (`x` right, `y` **down**):

| Course | id | Theme | Signature |
|---|---|---|---|
| The Back Garden | `garden` | garden | Physics-coupled slopes, banked rails, a ramp to climb. The default. |
| Windmill Links | `windmill-links` | links | **Moving obstacles** — windmills and swinging gates you read the beat of, plus timing/carom risk-reward lines. |
| Pirate Cove | `pirate-cove` | cove | Barrel **tunnels** (portal pairs), tide-pool **water**, **sand** traps, ramps and breaking slopes. |

Both a course picker and single-hole play are wired (same
`"<id>"` / `"<id>#<holeIdx>"` encoding as Course mode), and the last-played
course is persisted.

`puttSim.ts` is a real mini-put engine, not the old flat arcade one: Coulomb
constant deceleration derived from the shared Stimpmeter model, physics-coupled
slopes from a per-hole slope FIELD (`puttField.ts` — tilt planes, ramps,
undulation), one static-rest rule mirroring `courseSim`, and speed-dependent cup
capture through the shared `greenPhysics.cupCaptured` rescaled to mini speeds.
Banked rails (`Wall.bank`) steer the ball along the rail.

`puttObstacles.ts` is the **moving-obstacle and tunnel math** — pure, no three,
no canvas — and every obstacle's geometry is a function of the sim's own
deterministic `simTime` accumulator, never wall-clock. Blades and arms both
reflect the ball AND impart their surface velocity at the contact point; tunnels
map velocity from one mouth's local frame onto the other's. `PuttGL.tsx` reads
the SAME helpers (`windmillBladeAngle` / `pendulumAngle` / `mouthNormal`) to
draw them, so drawn == played, and renders the green as a displaced
BufferGeometry sampled from `puttHeightAt`.

Holes are DATA validated by `validatePuttHole` (par 2–3; cup and tee on the
green; the cup point holds a rest; every obstacle's SWEPT disc fits the bounds
and clears cup and tee; hazards never cover cup/tee, overlap, or wall the board
off; both tunnel mouths in bounds and reachable). `GolfGame.tsx` is the HUD and
drives off the course's ACTUAL hole count.

### 1.4 Driving Range

Down-range 3D with two modes: **Practice** (open, unlimited) and **Target
Challenge** (8 balls at island pins, proximity scoring). A data-driven **layout**
picker (persisted, default `fairway`), defined in `rangeTargets.ts`:

- `lane` — grass causeway through the water in both modes; every club lands and rolls.
- `practiceLane` — lane in Practice; Challenge is full water + islands.
- `fairway` — grass fairway with a crossing water hazard (247–285 yd) holding island targets.

`RangeGame.tsx` is the HUD (controls, layout picker, telemetry + "Copy
telemetry"); `RangeGL.tsx` is the lazy scene.

> **Standing user feedback, not yet actioned:** the water + floating-island
> range reads as "odd" / un-golf-like. Course mode is the destination; the range
> is a practice surface and a physics test bed.

### 1.5 Controls

Shared between Range and Course, because `CourseSim` deliberately reuses the
Range's tuned launch/flight/roll pipeline:

- **Pull-back = power + aim (slingshot).** One drag sets both: power tracks the
  pull MAGNITUDE (vertical power meter), the pull's ANGLE steers the shot — it
  flings OPPOSITE the pull (drag right, aim left), clamped to ±40° with a
  deadzone. On the Course, steering is measured off the bearing-to-pin, so
  "straight" points at the flag on a dogleg.
- **Spin** via a contact-point **spin puck** (back/top + draw/fade) → a bounded
  flight curve; backspin checks and zips back on the bounce.
- **Accuracy** via a **tap-timing bar**: release arms the shot, a marker sweeps,
  tap to fire; off-centre adds hook/slice.
- **Live aim prediction.** While aiming, the turf shows a wind-adjusted
  predicted arc to a **landing reticle**, a **pre-wind reticle** (the gap reads
  the wind push), a **roll-out marker** and a **tap-timing dispersion cone**
  (worst hook ↔ worst slice). It is `predict()` — the CURRENT
  club/power/aim/spin/wind stepped through the SAME pipeline as the live shot
  via `snapshot()`/`restore()`, no commit, no state mutation. The harness
  asserts `predict()` matches the committed shot to the yard, per club.
- **Aim-holing cue.** On the green the aim line and cup reticle pulse
  gold/green when `predict(0).result === 'holed'`.
- **Putting.** A putt-specific quadratic power map with a low minimum speed so a
  dead tap rolls ~1.5 ft and short putts are controllable.

**Club ladder** (full power, neutral spin, firm fairway lie, harness-measured):
Driver 291 carry / 377 total, 3-Wood 260/329, Hybrid 243/303, 5-Iron 217/266,
7-Iron 191/230, 9-Iron 165/196, PW 137/161, SW 109/128. Forgiving/linear power
map (`s = baseSpeed·√(FLOOR + (1−FLOOR)·power)`). CARRY is loft + baseSpeed;
TOTAL is carry plus a run-out the bounce/roll core derives from the LANDING LIE.

### 1.6 Physics, surfaces and testing

- **The physics is a small, deterministic ballistics sim — keep it, don't
  replace it.** World space: `d` downrange, `x` lateral, `h` height; gravity +
  drag + wind + bounce/roll; spin as bounded accelerations. Yard-space arcade
  units (`GRAVITY = 16`), not real units.
- **Landing lies.** One shared bounce+roll core MODULATED per surface by a
  `TERRAIN` table in `rangeSim.ts` (restitution, forward bounce-keep, roll
  multiplier, run-out, backspin bite, settle threshold). The Course maps each
  lie straight onto those numbers without touching the integrator, and adds a
  `cartpath` material. The Range only classifies `grass` / `island` / `water` /
  `fence`; the Course classifies tee / fairway / rough / fringe / green /
  bunker / water / cartpath / OB.
- **Slopes are physics-coupled EVERYWHERE** — putts break, the ball rolls
  downhill and checks uphill, sidehill lies push. `heightAt()` / `gradientAt()` /
  `surfaceAt()` in `terrain.ts` are ONE source of truth for both the rendered
  mesh and the ball; `slopeAccel()` (≈ −g·gradient) is added each grounded
  substep.
- **Greens** run `greenPhysics.ts`: Stimpmeter speed → friction
  (μ = 0.611/stimp, `GREEN_STIMP = 10`), roll-out `d = v²/(2a)`, and an
  ELLIPTIC cup-capture falloff (`r_eff = cupR·√(1−(speed/limit)²)`) so an
  on-line putt at holing pace reliably DROPS. There is no pin collision.
  `BALL_R = 0.2`, `CUP_R = 0.5` — one source of truth for scale.
- **One rest rule.** A grounded ball rests when `speed ≤ restSpeed(surf)` AND
  `|slopeAccel| ≤ staticHold(surf)`, on every surface. Off the green the hold is
  static friction (`frictionFor(surf) · STATIC_HOLD_FACTOR`, 1.3); on the
  green/fringe it IS the Stimpmeter μ·g. This is what stops a slow ball creeping
  downhill forever.
- **Headless harness** (vitest). `pnpm --filter @relay/ui test` drives the REAL
  sims and prints per-club / per-layout dynamics tables with regression-failing
  assertions. **Tune against this and against device telemetry — never guess.**
  Current golf + `scene3d` coverage: **629 tests across 18 files** —
  `courses.test.ts` 330, `courseSim` 67, `puttCourses` 35, `foliage` 30,
  `terrain` 26, `puttSim` 22, `instancing` 16, `rangeSim` 15, `greenPhysics` 15,
  `courseData` 14, `scene3d/quality` 12, `scene3d/env` 12, `clock` 10,
  `golf/scene/quality` 8, `scene3d/budget` 5, `components/golf/budget` 4,
  `scene3d/stats` 4, `env.irradiance` 4.
- **In-app telemetry.** A last-shot debug panel plus a "Copy telemetry" button
  (last 30 shots as JSON) so real device numbers can be diffed against the
  harness.

### 1.7 Scores, records and the worker

Golf's server surface lives in `packages/relay-worker/src/games.ts` and
`economy.ts`, over these D1 tables (each in `schema.sql` AND a numbered
migration):

| Table | Migration | What |
|---|---|---|
| `game_scores` | `0006`, `0008` (`course`) | Shared contact-scoped leaderboard. `GAME_IDS` includes `golf` (mini-golf), `golfrange`, `golfcourse`. Clamps: ≤8 rounds, ≤2000 pts each. Adding a game id needs no migration. |
| `golf_records` | `0007` | Per-user best shots: MAX longest drive, MAX longest holed putt, MIN closest-to-pin. `GET`/`POST /game/golf-records`, upsert-on-improve. |
| `game_challenges` | `0009` | Async friend challenges. |
| `daily_results`, `daily_streaks` | `0011` | Daily challenge + streak. |
| `tournaments`, `tournament_entries`, `tournament_trophies`, `tournament_placements` | `0012` | Rapid events. |
| `user_wallet`, `currency_ledger`, `user_cosmetics`, `user_equipped`, `season_progress` | `0013` | Coin economy, cosmetics, season track (`/economy/*`). |

**Three boards, three submit paths.** Keep them straight — they do not share a
code path:

- **`golf`** (Mini-Golf) and **`golfrange`** (Range Target Challenge) submit from
  `GolfScreen`'s own effects when the results screen appears, each behind an
  exactly-once ref guard and each rejecting a 0-round game. Mini-Golf also sends
  its to-par as board metadata.
- **`golfcourse`** (Course full round) submits from `CourseGame`'s
  `onRoundComplete`, which fires **when the FINAL hole is CARDED — not when a
  button is pressed.** The card holds one entry per hole holed out, so
  `card.length === course.holes.length` IS "the round is over", and reading it in
  its own effect (rather than in the carding effect) guarantees the last hole's
  strokes are already in the total. `revealScorecard()` is **purely
  presentational**. ⚠ This matters: reporting used to fire from
  `revealScorecard()`, so a player who tapped "Menu" instead of "See scorecard"
  on the final hole silently discarded the whole round — and in a tournament,
  destroyed their event entry. Do not re-couple reporting to a UI affordance.
- **Single-hole play reports via `onHoleComplete`, never `onRoundComplete`** —
  a separate effect, fired on hole-out, also exactly-once. The daily challenge
  rides this path; the rapid tournament plays a full round and captures
  `onRoundComplete` itself (so it posts to the event, NOT to `golfcourse`, and
  there is no double-post).

**Which of those three a Course round is wired to comes from ONE discriminated
union** — `CourseIntent` in `GolfScreen` (`normal` | `daily` | `tournament`),
switched on once by `coursePlan()` to produce the course, the starting hole, the
seed AND the reporting channel together. It replaced five independent state slots
(`dailyActive`, `dailySeed`, `tourneyActive`, `tourneyCourse`, `tourneySeed`)
that were cleared in exactly one place — `CourseGame`'s `onExit`, which neither a
back GESTURE nor `useGameFlow`'s guarded LEAVE arm calls. The flag survived and
corrupted a LATER, unrelated round: a practice hole POSTed as the day's daily
(burning the entry), a picked hole silently replaced by the synthesized
tournament course, and a full 18 posting nowhere because `onRoundComplete` was
`undefined` while a daily was "active". `startGolf()` now resets the intent
unconditionally, and each special flow carries its OWN course/hole/seed so it
cannot touch the player's Course-mode selection. `GolfScreen.test.tsx` drives the
real screen out of a daily/tournament round with `nav(-1)` and pins all three.

**A finished daily/tournament result is PERSISTED before it is POSTed**
(`lib/golf/pendingResult.ts`, localStorage, same idiom as `stats.ts`). It used to
be plain component state, so holing out and then tapping another tab lost the
score silently — no request, no error, nothing shown, day's entry spent. The
record is written on hole-out, `GolfScreen` opens on the tab that owns it
(`GolfDaily` / `GolfTournaments` are what POST), and it is cleared **only once
the POST resolves**, so a failure is retried on the next mount. Exactly-once
survives a remount because the record carries a monotonic `id` (from a persisted
counter — never `Date.now()`/`Math.random()`): `submitPendingResult` hands a
second caller for the same id the FIRST in-flight promise instead of issuing a
second request, and releases the claim on failure. The per-mount `submittingRef`
identity guards in both components are NOT sufficient on their own — a record
read back off localStorage is a different object.

Best-shot metrics are computed by a single `CourseSim.recordShot()` off `stop()`
(shared by live fire, `simulateShot` and `simulatePutt`): longest drive = the
first full swing's total (an OB/water opener doesn't lock it — the replay does);
closest-to-pin = min rest `distToPin` among non-holing, non-water/OB, NON-PUTT
shots; longest putt = a putt that holes out. `CourseGame` shows this hole's
numbers plus persisted bests with a "New best!" badge; the `api.ts` client
(`getGolfRecords` / `postGolfRecords`) is seeded on mount and refreshed from the
POST's read-after-write, so it survives offline/401.

---

## 2. Code map

### 2.1 Layering rules

Four rules decide where new code goes. Rules 1, 3 and 4 have mechanical checks
(a build inspection and two budget tests); rule 2 is a review responsibility, as
no test can see it.

1. **`three` stays lazy.** The `*GL.tsx` scenes are `lazy()`-imported so `three`
   never enters the app entry chunk. Anything a scene imports (`scenery.ts`,
   `water.ts`, `scene/*`, `scene3d/*`) is therefore reachable ONLY from those
   lazy modules. Verify with `pnpm --filter @relay/ui build`: `three` is its own
   ~538 kB chunk and the entry chunk carries no `Three.js Authors` banner.
   ⚠ **The three chunk is not named `three-*.js`** — Rollup names a shared chunk
   after its first module, and it currently emits as **`clock-*.js`** because
   `lib/scene3d/clock.ts` leads it. Grep the banner, not the filename.
2. **One shared scene kit.** `lib/golf/scenery.ts` owns fog, the sky dome + sky
   gradient + PMREM env map, the `SURFACE_RGB` per-lie palette, the mow-stripe /
   fringe / roughness constants, and the turf textures — `makeFairwayTurf()`
   (bold world-locked stripes), `makeTurfColor()` (plain mown fill),
   `makeTurfNormalMap()`, `makeContactShadowTexture()`. The tree grove lives in
   `components/golf/scene/foliage.ts` — it moved there when it was instanced,
   because an `InstancedMesh` needs its count up front and so cannot be a pair of
   `add…()` calls that each drop a `Group` into the scene. **Change the look
   THERE, not per-scene.**
   How the scenes consume it differs, and the difference is deliberate: the
   RANGE is one fairway, so it lays `makeFairwayTurf()` over its whole ground.
   The COURSE is multi-surface, so `CourseGL` BAKES a top-down albedo
   (`makeSurfaceMap`, painted from `surfaceAt` + the shared `SURFACE_RGB`) for
   the ground and gives green / fringe / tee / bunkers / water their own overlay
   meshes; `makeTurfColor()` there only dresses the distant fill plane. Both
   share the blade normal map and `TURF_ROUGHNESS` / `TURF_NORMAL_SCALE`, so
   grass detail cannot diverge again.
   ⚠ **`scenery.ts`'s own file header is stale on this point.** It describes a
   two-mode `makeTurfColor('green' | 'neutral')` where `'neutral'` is a
   near-white luminance detail multiplying the Course's per-vertex colours.
   `makeTurfColor()` takes no arguments, and the Course does not vertex-colour
   its ground — the baked surface map replaced that. Vertex colours survive only
   on the fringe collar/apron mesh and the confetti points.
3. **`lib/scene3d/` is game-neutral.** The shared multi-game kit (clock, env,
   instancing, quality, stats), consumed by BOTH golf and baseball. Its
   contract — game-neutral exported names and filenames, config in / no game
   constants imported, unit-agnostic, no `lib/golf`/`lib/baseball` imports,
   500-line cap, no barrel `index.ts`, per-game budget tables — is written in
   `lib/scene3d/README.md` and the mechanical half is enforced by
   `lib/scene3d/budget.test.ts`. Moving existing game code in is a pure move +
   re-export, must be pixel-identical, and is **deferred entirely while baseball
   is under construction in a parallel session**.
4. **Size ratchet.** `components/golf/budget.test.ts` gives every NEW file a
   500-line cap and grandfathers the legacy components at their current size,
   **shrink-only**. It also fails on a stale entry and reports any file that has
   shrunk by 25+ lines so the reclaimed lines get BANKED by lowering the number.
   New scene work belongs in `components/golf/scene/` (real 500-line cap), not
   bolted onto a component that is already too big. `lib/scene3d/budget.test.ts`
   additionally pins `onBeforeCompile` to exactly one site (`lib/golf/water.ts`)
   — it is the one pattern that does not survive a WebGPU node pipeline
   (`/GRAPHICS.md` §2).

Both budget tests are deliberately scoped away from baseball paths: an
assertion here firing on their file would be a failure they cannot act on.

### 2.2 Key files

Every path below resolves on disk. Root for UI paths is
`packages/relay-ui/`.

**Hub, menus and economy** (all `three`-free — the non-lazy path)

| Area | Path |
|---|---|
| Hub shell: Play / Arena / Clubhouse tabs, flow wiring, immersive + music, the `CourseIntent` union | `src/components/golf/GolfScreen.tsx` |
| Persisted, submit-once pending Daily / Tournament result (`readPending` / `writePending` / `clearPending` / `submitPendingResult`) | `src/lib/golf/pendingResult.ts` |
| Play tab: course hero, Course + Mini-Golf pickers, range expansion, challenge CTA | `src/components/golf/GolfMenu.tsx` |
| Arena: daily hole + streak / rapid events / boards | `src/components/golf/GolfDaily.tsx`, `GolfTournaments.tsx`, `GolfLeaderboard.tsx` |
| Clubhouse: records + rank / cosmetics shop / season track / wallet | `src/components/golf/GolfProfile.tsx`, `GolfShop.tsx`, `GolfSeason.tsx`, `GolfWallet.tsx` |
| Coin balance pill (shop bar, hub header, profile) | `src/components/golf/CoinBalance.tsx` |
| Friend challenges: create+send sheet, live in-chat card | `src/components/golf/NewChallengeSheet.tsx`, `ChallengeCard.tsx` |
| Economy store (wallet / cosmetics / season, fetch-once + graceful degrade) | `src/lib/golf/economy.ts` |
| `three`-free cosmetics render seam (`GolfCosmetics`, `GolfFrame`) | `src/lib/golf/cosmetics.ts` |
| Pure-SVG top-down hole map for the picker | `src/components/golf/HoleThumb.tsx` |
| Shared HUD widgets (accuracy bar, club selector, power meter, spin puck, telemetry, wind chip, mute) | `src/components/golf/shared/` |
| Local personal bests (localStorage), last-played course ids | `src/lib/golf/stats.ts` |
| Hub wiring + `/games/golf` deep link | `src/routes/Games.tsx` |
| Best-shot records API client | `src/lib/api.ts` (`getGolfRecords`/`postGolfRecords`) |

**Course mode**

| Area | Path |
|---|---|
| Course registry (`GOLF_COURSES`, `getCourse`) | `src/lib/golf/courses/index.ts` |
| Authored hole data — 45 holes | `src/lib/golf/courses/augusta.ts`, `listowel-vintage.ts`, `listowel-heritage.ts`, `listowel-millennium.ts` |
| Authoring helpers + `validateCourse()` (the hard gate) | `src/lib/golf/courses/builder.ts`, `types.ts` |
| Course validator suite (330 tests, every hole of every course) | `src/lib/golf/courses/courses.test.ts` |
| Terrain + hole model + **"HOW TO AUTHOR A HOLE" contract header** | `src/lib/golf/terrain.ts` |
| Course sim (terrain-aware; `snapshot`/`restore`/`predict`; putt power; records) | `src/lib/golf/courseSim.ts` |
| Green + putting physics (Stimp → μ, roll-out, elliptic cup capture, `BALL_R`/`CUP_R`) | `src/lib/golf/greenPhysics.ts` |
| Course 3D scene | `src/components/golf/CourseGL.tsx` |
| Course HUD: round + scorecard, records recap, wind, telemetry | `src/components/golf/CourseGame.tsx` |
| Rapid-tournament 3-hole course synthesis | `src/lib/golf/tournamentCourse.ts` |
| Per-round wind model (shared by Course + Range) + `mulberry32` | `src/lib/golf/wind.ts` |

**Mini-Golf**

| Area | Path |
|---|---|
| Mini-golf registry (`PUTT_COURSES`, `getPuttCourse`) | `src/lib/golf/puttCourses/index.ts` |
| Authored boards — 24 holes | `src/lib/golf/puttCourses/garden.ts`, `windmill-links.ts`, `pirate-cove.ts` |
| Board authoring helpers (`puttHole`, `seg`, `windmill`, `pendulum`, `tunnel`) + `validatePuttHole`/`validatePuttCourse` | `src/lib/golf/puttCourses/builder.ts`, `types.ts` |
| Mini-put sim (Coulomb, slope-coupled, shared cup capture) | `src/lib/golf/puttSim.ts` |
| Per-hole slope FIELD (tilt planes, ramps, undulation) | `src/lib/golf/puttField.ts` |
| Moving obstacles + tunnels (pure, `simTime`-driven) | `src/lib/golf/puttObstacles.ts` |
| Mini-golf 3D scene (displaced green, obstacles drawn from the physics helpers) | `src/components/golf/PuttGL.tsx` |
| Mini-golf HUD + round | `src/components/golf/GolfGame.tsx` |

**Driving Range**

| Area | Path |
|---|---|
| Range physics/sim (headless) + the `TERRAIN` lie table | `src/lib/golf/rangeSim.ts` |
| Sim harness (dynamics tables + regression assertions) | `src/lib/golf/rangeSim.test.ts` |
| Layouts, pins, `surfaceAt` | `src/lib/golf/rangeTargets.ts` |
| Club ladder | `src/lib/golf/clubs.ts` |
| Range 3D scene | `src/components/golf/RangeGL.tsx` |
| Range HUD + controls + telemetry + layout picker | `src/components/golf/RangeGame.tsx` |
| Shared tuning constants (`FIXED_MS`, `PUTT_*`, `HOLES`, `RANGE_BALLS`) | `src/lib/golf/tuning.ts` |

**Rendering, the shared kit and the visual gate**

| Area | Path |
|---|---|
| Shared scene kit: turf colour + normal, sky dome, fog, `SURFACE_RGB` | `src/lib/golf/scenery.ts` |
| Shared WATER: level geometry, Gerstner waves, Fresnel + sky/planar reflection, foam, splash, wet bank, reeds, quality tiers | `src/lib/golf/water.ts` |
| The tree grove — shared by Course + Range, 3 draw calls; per-hole blossom rides the same batch | `src/components/golf/scene/foliage.ts` |
| The understory drift's geometry — blobs inscribed in the sim's collider (`shrubR`/`shrubH`), with the containment proof | `src/components/golf/scene/drift.ts` |
| Golf's sky palette + `scene.environment` wiring + the hemi cut | `src/components/golf/scene/env.ts` |
| Bunker sand: albedo + normal + roughness off one height field | `src/components/golf/scene/sand.ts` |
| Golf's per-scene budget table + `?quality=`/`?shadow=` resolution | `src/components/golf/scene/quality.ts` |
| Golf size ratchet (500-line cap + shrink-only grandfathers) | `src/components/golf/budget.test.ts` |
| Shared kit: freezable virtual clock, procedural sky IBL, instanced scatter, tier POLICY, GPU instrumentation | `src/lib/scene3d/clock.ts`, `env.ts`, `instancing.ts`, `quality.ts`, `stats.ts` |
| Shared kit contract (prose) + its mechanical enforcement | `src/lib/scene3d/README.md`, `src/lib/scene3d/budget.test.ts` |
| Ball material (dimple normal map, PMREM mirror ball) | `src/lib/golf/ballTexture.ts` |
| Headless screenshot + GPU harness (29 scenes) | `scripts/shoot-golf.mjs`, `golfpreview.html`, `src/golfpreview.tsx` |
| Committed GPU ceilings + the game-neutral harness reporter | `scripts/budgets.golf.json`, `scripts/lib/shoot-report.mjs` |
| Metric course data layer — largely unreachable, see §4 | `src/lib/golf/courseData.ts` |

**Worker**

| Area | Path |
|---|---|
| Leaderboard, records, challenges, daily, tournaments | `packages/relay-worker/src/games.ts` |
| Wallet, cosmetics, season | `packages/relay-worker/src/economy.ts` |
| Tournament period/seed/award math | `packages/relay-worker/src/tournaments.ts` |
| Migrations | `packages/relay-worker/migrations/0006–0013` (see §1.7) |

### 2.3 Commands

- `pnpm --filter @relay/ui test` — the golf sim harness (dynamics tables, hole
  validators, budget ratchets).
- `pnpm --filter @relay/ui shoot:golf` — headless screenshots of all 29 scenes
  AND the numeric GPU gate (draw calls / triangles vs
  `scripts/budgets.golf.json`; non-zero exit on a regression). One scene:
  `pnpm --filter @relay/ui shoot:golf secondAim`.
- `pnpm typecheck` · `pnpm --filter @relay/ui build` (confirm `three` stays a
  lazy chunk and the entry chunk is unchanged).
- `pnpm --filter @relay/worker test` — worker suite, including golf-records,
  challenge, daily, tournament and economy coverage.

---

## 3. Conventions that bite

- **Keep the physics.** It is small, deterministic and unit-tested. Tune against
  the vitest harness and device telemetry. Don't replace the integrator.
- **A hole is DATA.** Author against the **"HOW TO AUTHOR A HOLE"** contract
  header in `terrain.ts` — that header, not this doc, is the source of truth. It
  covers the corridor (`centerline`, `fairwayHalf`, `fairwayTaper`, `roughHalf`),
  the green (`r`, `raise`, `tiltPct`, `tiltDir`, `undulation`) and its `fringeW`
  collar, organic edges (`edgeNoise`/`edgeRadius`/`featureSeed`, `EDGE_WOBBLE`),
  `hazards`, `cartPath`, `terrain`, and the optional `bloom` canopy. The engine,
  shaders, HUD and scene frame are all hole-agnostic and derive from the
  `CourseHole`, so a new hole or a whole new course is data only.
  - `surfaceAt()` precedence is strict — green > fringe > bunker/water >
    cartpath > tee > fairway > rough > ob — so a hazard can never touch the
    putting surface.
  - Invariants (pin inside the MIN wobbled green; hazards outside
    `maxGreenPadRadius`; green tilt ≲ μ) are enforced by `validateCourse()`, so
    a mis-authored hole fails a test rather than shipping.
- **⚠ GREEN DESIGN GUARD.** A resting putt can only hold where slope ≲ μ (~6.1%
  at stimp 10). Keep green tilt + undulation under that, or raise stimp/μ in
  lockstep. `builder.ts` derives the cap from `greenPhysics` rather than
  hardcoding it.
- **⚠ ONE intent for Course play, and never a flag per flow.** What a Course
  round IS (normal / daily / tournament) lives in a single discriminated union in
  `GolfScreen`, switched on once. Adding a new flow means a new `kind` — NOT
  another boolean, because a boolean has to be cleared by every exit path and two
  of golf's exit paths (the back gesture, and the guarded free screen's leave arm)
  call nothing at all — so the reset belongs on the ENTRY side. Same rule for the
  finished score: persist it via `lib/golf/pendingResult.ts` and clear it only
  after the POST resolves. See §1.7.
- **⚠ CourseSnapshot rule.** Any new MUTABLE `CourseSim` field MUST be added to
  `CourseSnapshot` + `snapshot()` + `restore()`. A guard test dumps all own data
  props independently and asserts byte-identical state after `predict()`, so it
  fails loudly if a field is forgotten. Prediction and the live shot are ONE
  integrator over ONE state — keep it that way.
- **⚠ Terrain winding.** The Course ground is a custom displaced
  BufferGeometry; its triangles must be wound so the top surface FRONT-faces up.
  A downward winding gets back-face culled and the whole textured ground
  vanishes, leaving only the flat fill plane (the long-standing "flat grass"
  look). Keep the fill plane a few yards BELOW the terrain minimum so it backs
  only the far-horizon void.
- **⚠ Frustum culling on aim aids.** All aim-aid objects set
  `frustumCulled = false`. A cached `boundingSphere` goes stale between aims and
  three culls the arc BEFORE drawing, which is why depth/renderOrder patches
  can't fix it. `shoot:golf secondAim` is the only sequence that catches this
  class — two real rendered aims with a fire between them.
- **Dispose GPU resources.** Track every geometry / material / texture via the
  scene's `track()` helper; scenes `forceContextLoss()` on unmount.
- **Seeded, never `Math.random`.** Every texture, particle and placement
  generator in a scene is `mulberry32`-seeded, and animated scenes take their
  time from `lib/scene3d/clock.ts`, never `performance.now()`. This is what
  makes the visual gate a gate (§5.5).
- **Test GPU-cost changes on a low-end device**, not just the headless harness.
  SwiftShader validates composition, geometry and materials; it says nothing
  about fill rate, VRAM or shadow-map size — the class of cost that actually
  killed a WebView GPU process (`/GRAPHICS.md` §4 rule 4).
- **Authored art needs a harness frame in the same change.** A hole carrying
  `bloom` (or any per-hole art) with no scene in `SCENES` is art that can ship
  or regress unreviewed. Three Augusta holes did exactly that.
- **Visual change workflow.** Any change to a scene, its materials, lighting or
  geometry: `golf` implements → `code-reviewer` (diff) → `qa-verify`
  (typecheck / tests / build) → **`golf-visual-qa`** (before/after screenshots,
  Course vs Range parity) → human review. Typecheck and unit tests never catch a
  broken render. Capture a **before** and an **after**; a "visual" change with no
  visible delta is itself a finding.

---

## 4. Known-dead and known-misleading code

Recorded so the next reader is not misled. None of it is a bug in play; all of
it looks live and isn't.

- **`CourseHole.wind` is DEAD.** The field exists, is documented in the
  authoring header, is defaulted to `{along: 0, cross: 0}` by `hole()`, and is
  read exactly once — in the `CourseSim` constructor. Every construction site in
  `CourseGame` immediately calls `setWind()` with the ROUND wind
  (`applyRoundState` on `nextHole`/`playAgain`, and explicitly in the
  constructor path and `playRoundAgain`), so a per-hole value could never take
  effect. No authored hole sets one. If per-hole wind is ever wanted, the change
  is in `CourseGame`'s round-wind application, not in the data.
- **`lib/golf/courseData.ts` is largely unreachable from the app.** It is an
  18 kB metric (SI) data layer — `HeightField`, `SurfaceMask`, `CourseData`,
  `buildTerrainMesh`, `buildCourseData`, its own `SURFACE_RGB` /
  `decodeSurface`. `CourseGL` imports **five** things from it and nothing else:
  `sampleHeightField`, `FLAGSTICK_HEIGHT_M`, `HOLE_DIAMETER_M`,
  `BALL_DIAMETER_M`, `YD_PER_M`. The rest is exercised only by
  `courseData.test.ts` (14 tests). The live model is `terrain.ts`, in yard
  space. Note the name collision: the `SURFACE_RGB` the scene actually uses
  comes from `scenery.ts`, not from here.
- **`HOLE_1` / `COURSE_HOLES` in `terrain.ts` are QA fixtures, not shipping
  content.** `COURSE_HOLES = [HOLE_1]` has no importer. `HOLE_1` is the
  showcase dogleg-right par 5 the sim tests and the screenshot harness's default
  `course`/`secondAim` scenes run on (`golfpreview.tsx`). No player can reach
  it — Course mode plays `GOLF_COURSES`. Keep it: it is the stable baseline
  frame for the visual gate.
- **`water.ts`'s `pickWaterQuality` promotes on a capability sniff**
  (`cores > 4 && maxTextureSize >= 8192`), which a typical mid-range Android
  satisfies — so the tier meant to be gated behind headroom is what most phones
  get. Called out as a **known defect** in `/GRAPHICS.md` §4 and in
  `scene3d/README.md`'s extraction rule. Do NOT copy the pattern; the correct
  one is `lib/scene3d/quality.ts` (default DOWN). Fixing it is its own gated
  commit, never folded into a move.
- **Open water makes a frame non-exact.** Everything else in the harness is
  exact-pixel comparable; a frame with open water in it is not (§5.5).

---

## 5. Rendering, GPU cost and the visual gate

Platform-level reasoning is in `/GRAPHICS.md` — this section is golf's
implementation of it.

### 5.1 Quality tiers

- **The policy is shared, the numbers are not.** `lib/scene3d/quality.ts`
  (`pickSceneQuality`) implements **default DOWN, promote only on measured
  evidence**; golf's table lives in `components/golf/scene/quality.ts`. The only
  automatic decisions step DOWN — a WebGL1 context, `maxTextureSize < 4096`, a
  fragment precision below `highp`. `high` is unreachable without an explicit
  `?quality=high`; it exists to be forced on a handset, not handed out.
- **⚠ A tier may never RAISE a scene's cost, so sizes are PER SCENE.** "Default
  1536² everywhere" reads as a step down because two of three scenes were at
  2048² — but `PuttGL` was already at **1024²**, and a flat default would have
  made a currently-safe scene 2.25× more expensive in shadow memory. **Course
  and Range: 1536² (from a shipped 2048²). Putt: 1024², unchanged. `low` drops
  the shadow pass entirely** (and Putt's map to 512²). `high` raises the map in
  no scene — it buys `pixelRatioCap` only, and even that is 2 at `medium` and
  `high` because that is what all three scenes cap at today.
  `SHIPPED_SHADOW_MAP_SIZE` is written down rather than inferred, so a future
  edit that raises a row has to change that line too — and changing it is a claim
  that an on-device test was run. The four dials are `shadows`, `shadowMapSize`,
  `pixelRatioCap` and `ibl`; `quality.test.ts` asserts no tier of any scene
  exceeds what that scene ships, and that every dial is monotonic across tiers.
- **Knobs, for the on-device bisect that is still owed:**
  `?quality=low|medium|high` and `?shadow=1024|1536|2048` (an allowlist — a
  fat-fingered value falls back to the tier), plus `?water=high|medium|low`.
  `?shadow=` is deliberately allowed to go UP: reproducing the configuration
  that crashed is half of bisecting it. The scenes themselves read them, so the
  app and the preview take the identical code path, and
  `shoot-golf.mjs --query=shadow=2048` shoots the whole matrix at a forced knob.
  ⚠ `?shadow=` applies globally, so Putt is NOT a control in a forced run.
- **The 1536² tier was visually verified and it is free.** The Course shadow
  camera is 640 × 680 world units — 0.42 units/texel at 1536² against 0.31 at
  2048² — and `BALL_R` is 0.2, so the ball's shadow is **sub-texel at both
  sizes**. Ball seating never came from the shadow map (`CourseGL` draws an
  explicit soft contact disc). Worst measured scene was `course-approach` at
  `meanAbs 0.087`; frames are indistinguishable at 1:1. 2048² was paying 2.25×
  the memory for detail the shadow frustum cannot resolve.
  ⚠ That removes the *visual* objection only. Whether 1536² still trips the
  WebView GPU process is untested on hardware.

### 5.2 Numbers, printed and enforced

Each scene calls an `onStats` prop every ~30 frames with `renderer.info` plus
the resolved tier and its reason; `golfpreview.tsx` publishes it as
`window.__golfStats` (readable straight off a handset console). `shoot-golf.mjs`
prints a GPU line per scene and checks it against the committed
`scripts/budgets.golf.json` (29 scene entries), exiting non-zero on a
regression. The reporter is game-neutral (`scripts/lib/shoot-report.mjs`).
Regenerate a baseline explicitly with `--update-budgets` — **never
automatically**, or the gate rewrites its own thresholds when they fail.
Tightening a ceiling after a measured win is the opposite thing and is correct.

**Where the committed baseline sits.** Worst draw calls in the whole game:
`range-water` **110**, `range` **89**, then every Course and Mini-Golf scene at
**24–50**. Worst triangles: `augusta15` **128.5k**, `augusta8` **127.6k**,
`augusta2` **121.2k**; `putt-water` is **30 calls / 94.1k triangles**, still ~9×
every other putt scene and carrying a `_bug` note in the budget file so the
ceiling is not mistaken for approval (see defect 2 below).

**What these numbers cannot see.** They count what the CPU SUBMITTED. Fill rate,
VRAM and shadow-map size are invisible to them and to SwiftShader. A green
budget is not evidence of on-device safety. Worked example: turning on
`scene.environment` measured identical draw calls and identical triangles on all
six compared scenes (only `textures` moved, +2) while adding a **cubeUV sample
to every lit fragment** — on a full-screen turf scene, most of the frame.

**The frame-time probe exists but does not feed the tier.** `stats.ts`
`makeFrameProbe` reports a MEDIAN (never a mean — a phone's outliers are free)
and rides along in the stats payload. It is deliberately not wired into
promotion: the median arrives after the scene is built, so promoting on it would
mean persisting a verdict across sessions, and persisted cross-run state would
make the harness's tier depend on a previous run. The bar a future promotion
must clear is written in `quality.ts`'s header (≤20 ms median over ≥300 settled
frames at `medium`, twice, same device + scene). The probe's value is kept OUT
of the harness printout because it is wall-clock and would make an unchanged run
print differently twice.

### 5.3 Water, and the shoreline

Water is single-sourced in `lib/golf/water.ts` across all three scenes — Course,
Range and Putt attach ONE material to their own geometry and make no look
decisions of their own.

- **Level surfaces with per-vertex depth.** Geometry carries an `aDepth`
  attribute (yards of water above the bed); the shader discards where it is ≤ 0,
  so the visible waterline is where the level plane meets the rising bank — a
  terrain-derived shoreline that cannot disagree with the outline `surfaceAt`
  classifies.
- **`heightAt` grades a WATER PAD** (`terrain.ts`) exactly like the green pad:
  hills AND the tee→green grade are erased inside a water hazard's outline and
  ramped back over a skirt, so the basin rim is one height all the way round.
  Without it a level plane is impossible — measured rim spread on this course's
  ponds was 1.3–2.7 yd against a 2.2 yd basin. `waterLevelAt(hole, hz)` is the
  single source for the waterline. **Bunkers are excluded** — sand genuinely
  follows the ground it sits in.
- **Gerstner waves** in the vertex shader with analytic normals, steepness
  DERIVED from amplitude (`k·a`); passing both separately once left the surface
  geometrically calm but *shaded* as heavy chop.
- **Fresnel + reflection**: the sky gradient always (the same
  `makeSkyGradientTexture` that feeds the ball's PMREM, so pond and sky dome
  can't drift), and on the `high` tier a true planar reflection — a SECOND full
  scene render per frame, which is why it is gated.
- **Wind-driven**: wave direction, amplitude, wavelength and whitecaps come from
  the hole wind, via the same `windMph`/`windBearing` the HUD's WindChip reads.
- **`makeWaterFX`**: droplet crown + expanding ripple rings, seeded.
- **Wet bank** (`makeWetBankMaterial` / `attachBankWetness`) — a dark,
  low-roughness overlay revealed by per-vertex alpha, straddling the waterline.
  It is what makes water look like it TOUCHES the land. Height above the
  waterline alone is NOT enough to place it: the water pad grades the surround
  level, so ground stays within inches of the waterline for yards outward.
  Multiply the shared height profile (`bankWetnessFromHeight`) by a smoothstepped
  horizontal falloff from the shore.
- **Reeds** (`makeReeds`) — clumped cattail tufts at the margin. A pond's
  outline is the most artificial thing left in frame once the surface reads
  right; reeds break that curve and give the water something to be *behind*.
  Blades and heads bake into ONE merged geometry per belt (one draw call,
  coloured per vertex) and sway in the vertex shader, injected into a standard
  material via `onBeforeCompile` so they keep the scene's lighting, shadows and
  fog. Placement clumps deliberately — an evenly spaced ring reads as
  landscaping and walls the pond off. The Course finds its shoreline by
  BISECTING the terrain (the basin dishes, so height rises monotonically
  outward) rather than assuming a radius; Putt uses the rectangular variants
  (`makeWetBankRect` / `reedRectAnchors`). The Range lake's only shoreline is the
  distant fence line, so it takes neither.

**Gotchas that cost real time here:**

- Clipping the reflection at the waterline via `renderer.clippingPlanes` flips
  the renderer's plane COUNT every frame, and three rebuilds *every* material's
  program when that count changes — a full shader recompile per frame. Use an
  **oblique near plane** on the reflection camera instead (inside the projection
  matrix, and free).
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
  view-space position that, or the shader silently fails to compile, three logs
  to `console.error` (NOT `pageerror`) and skips the mesh, so the scene renders
  minus the water and looks plausibly fine. `shoot-golf.mjs` captures console
  errors for exactly this reason.

### 5.4 Lighting, IBL, sand and the instanced grove

- **Lighting rig.** ACES filmic tone mapping + exposure, a warm key sun with a
  soft-shadow map over a sky/ground hemisphere fill, a deep sky with defined
  cumulus, warm dense distance fog, and richly striped turf with strong blade
  normals. Shared by Course and Range.
- **Scene-wide IBL at `medium`/`high`.** `lib/scene3d/env.ts` paints a real
  equirect — a sun disc at a true 0.53° angular size (energy-conserved when it
  falls below a texel), a circumsolar halo, a three-stop sky and a turf-green
  ground bounce — in **half-float**, because an 8-bit canvas clamps at 1.0 and
  would cap the sun at sky brightness. `components/golf/scene/env.ts` holds
  golf's palette, every colour lifted from the sky dome so dome / water
  reflection / env can't drift.
  - **⚠ THE TRAP.** IBL added on TOP of the existing hemisphere fill
    double-counts the ambient and flattens everything to grey — which looks
    exactly like "the IBL didn't work" and sends you tuning the wrong knob. The
    fill comes down IN THE SAME CALL: `hemiFill()` is the only way a golf scene
    sets hemisphere intensity and it reads the same `quality.ibl` flag. Numbers
    derived, not guessed: the painted sky's cosine-weighted irradiance on an
    up-facing normal is `(0.44, 1.09, 2.18)` at intensity 1 against the
    hemisphere light's `(0.64, 0.86, 1.05)`, so `ENV_INTENSITY = 0.5` with
    `HEMI_IBL_FACTOR = 0.28` holds total ambient luminance within ~10% while
    moving the colour. Measured mean signed delta per channel: **R −1.0,
    G +0.9, B +10.8** — warm key, cool sky-lit shade.
  - **`low` keeps the old behaviour exactly** — ball-only `envMap`, full
    hemisphere fill, `scene.environment` untouched, and the 21 KB 2×2 PMREM
    rather than 1.5 MiB. `quality.test.ts` asserts it.
  - **Memory:** 512×256 equirect → a 128 cube → 1.5 MiB per scene, no mips
    (cubeUV packs every roughness level into the one target). `skyEnvBytes()`
    computes it without a GPU and a unit test pins it. Three's "ideal"
    1024×512 would be 6 MiB — 4.5 MiB more for a gradient, on a fleet that lost
    a WebView GPU process to a 16 MB shadow map.
- **Real sand** (`components/golf/scene/sand.ts`). Albedo, normal and roughness
  all come off ONE tileable seeded value-noise height field plus cosine rake
  ridges, so the grain you see, the bumps the sun rakes and the packed/loose
  sheen agree. Roughness tracks height *inversely* — a rake compresses what it
  pushes down, so furrow floors are glossier than the crust standing proud. The
  Course and Putt used to paint their own near-identical grain; it is now one
  generator with a `repeat`/`base`/`rake` per scene.
- **Instanced foliage** (`lib/scene3d/instancing.ts` +
  `components/golf/scene/foliage.ts`). Collect a transform and an optional
  per-instance tint per prop, commit **one `InstancedMesh` per distinct
  geometry**. `buildGrove(scene, track, placements)` takes the whole list rather
  than handing back an `add…()` pair, because a builder you must remember to
  `commit()` is one somebody will forget, leaving a treeless course that
  typechecks. Course and Range both call it, so the grove is ONE
  implementation. **Three batches, not four** — trunk / leaf blob / pine tier;
  both species' trunks are the same tapered cylinder at different scales. The 5
  leaf materials became **one white material + `instanceColor`** (three
  multiplies `instanceColor` into `diffuseColor`, so the material MUST be white
  or the palette comes out as a tint of one colour). ⚠ **The trade: triangles go
  UP** — an `InstancedMesh` is frustum-culled all-or-nothing, so the whole grove
  is submitted in every view. Right way round on mobile: submission is the cost.
- **Blossom.** `CourseHole.bloom { color, fraction, form? }` is authored in HOLE
  DATA, never derived from the hole's name — parsing "Pink Dogwood" into a
  colour at render time would couple the renderer to copy text. It rides the
  EXISTING instanced leaf batch, so **draw calls are unchanged**. Which
  broadleaves flower is `bloomRoll(tree.seed, hole.terrain.seed)`; the hole seed
  is in the mix because tree seeds are a function of `d` alone, so without it
  every flowering hole would bloom at the same downrange stations. `fraction` is
  never 1 — pines never flower and a share of broadleaves stays green, so the
  grove reads as accent trees rather than a repainted hedge. 13 Augusta holes
  carry a bloom; 2 use `'understory'`.
  - **⚠ `'canopy'` is a render tint. `'understory'` is a SOLID.** A canopy
    bloom sets `CourseTree.bloom` and nothing else, so the tree list is
    byte-identical to the same hole with the field stripped — unit-tested. An
    understory bloom emits `shrubR`/`shrubH` and `courseSim.brushShrub` damps
    horizontal velocity inside it, so it CHANGES PLAY. The narrower guarantee
    that holds — "an understory bloom adds a drift and changes nothing else the
    ball touches" — is what `courses.test.ts` asserts. **The general rule is
    worth more: art at ball height is an obstacle, and a bloom field that moved
    a ball without the sim knowing is exactly the silent see-what-you-play
    break.**
  - **⚠ The drift is INSCRIBED IN ITS COLLIDER by construction.**
    `components/golf/scene/drift.ts` has no dimensions of its own; it reads
    `shrubR`/`shrubH` and places blobs so that, in the space where the envelope
    is the unit half-ball, each blob is a sphere of radius ρ with
    |centre| ≤ 1−ρ. Two unit tests hold the two directions apart: every blob
    inside the collider, and the drawn mass reaching ≥0.85 of its radius / ≥0.8
    of its height. *A drift you can see but not feel and a collider you can feel
    but not see are the same defect.*
  - **⚠ A wider trunk is the obvious fix for a phantom obstacle and it is the
    wrong one.** The trunk cylinder REFLECTS and runs from the ground to
    `5.25·scale`, so widening it to cover a 3 yd shrub would carom balls off
    invisible air for the 5–8 yd above it — the one height band a recovery shot
    genuinely flies through. A shrub is short, wide and SOFT: it needs its own
    volume, its own height and its own response. `brushShrub` never reflects and
    never touches `vh` — a shrub catches a ball and drops it.
- **Trees clear the corridor.** `courseTrees` slides each tree straight out
  along ±x until its collidable trunk is entirely off playable ground
  (perpendicular clearance ≥ `roughHalf + trunkR`), leaving it alone when it
  already is. This exists because the grove is laid out at a lateral **x-offset**
  from the centerline while `surfaceAt` classifies by **perpendicular** distance,
  so on a dogleg the tree line cut the corner. Guarded over every hole of every
  course by `courses.test.ts`. ⚠ **A canopy over the rough is not a defect — it
  is what a tree-lined hole IS.** The line is: you may be under a tree, you may
  be in its brush, you may not be inside its trunk. Clearing by CANOPY instead
  of trunk deletes the `brushShrub` feature entirely (`shrubR` < `canopyR`), and
  a sim test catches it.

### 5.5 The visual gate, and its determinism

`pnpm --filter @relay/ui shoot:golf` boots Vite, drives the pre-installed
Chromium with software GL (`--use-angle=swiftshader
--enable-unsafe-swiftshader`), loads `golfpreview.html?scene=…` for each of 29
scenes (no app shell, no auth), and writes PNGs to `.golf-shots/` (git-ignored).
It is committed, it is what the **`golf-visual-qa`** agent runs, and it fails the
run on any `console.error` — that is how three reports a shader compile failure
before silently skipping a mesh.

Scene coverage, 29 in total: **6** Course views on `HOLE_1` (tee, green,
approach, a dragged aim, a played-lie aim, hole-out celebration); **1**
`secondAim` two-aim regression sequence; **10** named real-hole scenes across 9
holes (Augusta 2, 8, 10, 12, 13, 15, 16 — plus a second `augusta16pond` wedge-in
view — 17, and Listowel Heritage 3); **2** Range layouts; **10** Mini-Golf views
spanning all three putt courses, including windmill, pendulum, tunnel, water,
sand, ramp, banked rail, sidehill and a dragged aim.

**The harness is DETERMINISTIC — keep it that way.** Two runs with no code
change once differed on **23 of 25** scenes, which made the gate worthless: it
could not tell a real regression from the machine having run a bit faster. The
cause was never RNG — the generators were already seeded. It was **animation
sampled at wall-clock time**. Two fixes, both load-bearing:

- **`lib/scene3d/clock.ts` — a freezable virtual clock.** All three render loops
  take `now` from `tickSceneClock(rafNow)` instead of the rAF timestamp, and
  anything else needing a timestamp (`RangeGL`'s `divotStart`, `water.ts`'s
  splash `ringStart`) uses `sceneNow()`. **Untouched it is a pass-through** —
  `tickSceneClock` returns the rAF timestamp verbatim, so the shipped app is
  bit-for-bit unaffected. `golfpreview.tsx` is the ONLY caller of
  `engageVirtualClock()`; it freezes the clock at the instant it raises
  `window.__golfReady`, after which `dt === 0`, no substep runs, and every later
  frame is identical. **Loops must tolerate `dt === 0` — never divide by it.**
- **Readiness counted in FRAMES, never milliseconds.** SwiftShader renders these
  scenes at ~3 fps, so the beacon's old "45 frames" condition took ~15 s and its
  4 s wall-clock safety net beat it to the flag on *every single scene* — the
  frame path had never once run. The virtual step is **100 ms**, matching the dt
  clamp all three loops apply and the real SwiftShader frame time; at 100 ms the
  course camera easing (`1 − 0.001^dt`) converges 50% per frame, where a 16.7 ms
  step would screenshot the `?at=` views mid-flight.

Where a sequence genuinely needs motion, `shoot-golf.mjs` asks for it in VIRTUAL
milliseconds (`advanceScene(page, ms)` → `window.__sceneClock.advance`), never
`waitForTimeout`, then renders a few frozen frames before capturing (Chromium
can hand back the frame *before* the last one rendered).

**So screenshots ARE exact-pixel comparable — except where open water is in
frame.** Water-free scenes are byte-identical run to run. A frame containing
open water differs by 10–200 px (≤0.015%, per-pixel maxΔ up to ~44): a 1-px line
on the water's silhouette, where `water.ts`'s `if (vDepth <= 0.0) discard;`
shoreline leaves near-zero-alpha fragments whose 8-bit rounding flips. It is
SwiftShader per-GL-context behaviour (implicit-LOD sampling next to discarded
fragments); `?water=low` and disabling Chromium's program cache both reduce but
do not remove it. It is NOT the clock and not fixable from scene state: virtual
time at freeze is exactly 2300 ms on 6/6 consecutive loads, a water-free hole is
6/6 byte-identical, and a water hole is 6/6 different while being stable
*within* a page load. **Treat "has open water in frame" as the predicate, not a
fixed scene list. A diff of that size on a water scene is noise; anything
larger, or on a non-water scene, is a real regression.**

---

## 6. History — how it got here

**Everything below is retained DECISION HISTORY, not a live plan.** It is kept
because the reasoning is still useful and because several conclusions are
load-bearing. The work items in it are done unless §4 or the defect list says
otherwise.

### 6.1 The original brief and the platform assessment

The reference the user asked to match was **PGA TOUR Golf Shootout** (a Unity
game) — its aiming (shot line + landing reticle + power arc + wind-adjusted
landing) and its textured, lit 3D look.

The assessment, which still stands: **not an engine problem.** Keep the physics
(small, correct, tested). Do not build a rendering engine — Three.js already is
one and can reach the target look. The two real gaps were **aim/trajectory
control** (buildable on the existing sim) and **art + shading**. A Unity rewrite
was rejected as the wrong fit for a messenger mini-game; the full argument,
including Unreal, Unity-as-a-Library and native-only, is now
`/GRAPHICS.md` §1 and that is the version to cite.

**The real bottleneck was, and still is, art CONTENT.** Agents can write the
shaders, procedural textures, lighting rig and integration; the last mile is
real art. The sharpest single demonstration: Augusta names 13 holes after a
flowering plant and the renderer drew a plain green tree line on every one of
them. No engine change fixes that.

### 6.2 The three roadmap steps (all delivered)

1. **Aim/shot control** — `predict()` plus the on-turf arc, reticles and
   dispersion cone in both scenes. Remaining ideas that were never built: a
   draggable landing reticle, and folding the power arc onto the ball itself.
   Both build on `predict()`.
2. **Visuals in Three.js** — tone mapping, sun + soft shadows, hemisphere fill,
   sky + haze, striped turf, then scene-wide IBL and real sand. Post-process
   bloom was **rejected outright** (`/GRAPHICS.md` §3 — an `EffectComposer`
   render target is 46 MB at phone size). Billboard tree sprites were never
   built; `instancing.ts` ships `makeImpostorQuads` for a future far band.
   - **Gotcha, learned the hard way:** a 2048² shadow map once crashed the
     WebView GPU process on real Android (black screen, app restart needed)
     though it rendered fine in software GL. It was reverted, then re-enabled by
     request with a standing requirement to re-verify that never happened. It is
     now resolved by a TIER (§5.1) with `?shadow=2048` to reproduce the crashing
     configuration on a handset without a rebuild.
3. **Hole engine → a real course** — the milestone that grew into four courses
   and 45 holes. In order: `terrain.ts` (a hole is DATA) → `courseSim.ts`
   (terrain-aware, reusing the Range's tuned ballistics and lie materials) →
   `CourseGL.tsx` (the same data drives the mesh) → playable Hole 1 → range
   parity (predicted arc, power meter, textures) → the frustum-cull fix and the
   `snapshot`/`restore` refactor → `greenPhysics.ts` and the Coulomb green → the
   one static-friction rest rule → the scalable surface model + elliptic cup
   capture + the clean green (the bold on-turf slope-read overlay was built and
   then REMOVED; the HUD break text stays) → organic feature outlines, the first
   cut, long-grass rough and a textured tee → best-shot records → the course
   registry, the four authored courses, and the hub around them.
   - **Terminology:** the fairway↔rough intermediate is the "first cut"; the
     "fringe" is the collar around the green.
   - `buildOrganicDisc`/`buildOrganicAnnulus` in `CourseGL` draw the green cap,
     fringe collar, bunkers and terrain-following water from the SAME
     `edgeRadius` + `featureSeed` + angle convention as the model, so
     drawn == played == baked. Water became a terrain-FOLLOWING organic disc to
     fix a dark-crescent/faceted-seam bug where a flat plane let the higher
     downrange basin rim poke through; it is now a level pad instead (§5.3).
   - The scene frame is DERIVED from the hole (centerline + roughHalf + tee/pin
     extent), which is why any of the 45 holes renders correctly with no
     per-hole code.
   - **Mini-Golf consolidation: RESOLVED, deliberately partial.** The old "port
     `puttSim` onto a real heightfield so it can share `greenPhysics`" item is
     done — Mini-Golf now reuses `greenPhysics`'s FUNCTIONS (roll-out decel +
     elliptic cup capture) over a real slope field (`puttField.ts`). It keeps its
     own mini-scale CONSTANTS (`tuning.ts` `PUTT_*`, roughly an 8× scale
     difference from the yard-space Course values) **by design**; only the shared
     functions port. Do not "finish" this by unifying the constants.

### 6.3 Two graphics findings worth not re-deriving

- **1,034 draw calls on the tee view of Hole 1** was the standout measurement —
  an order of magnitude above the whole baseball stadium — and it was **559
  individual meshes of tree**, not a batching failure. Three `InstancedMesh`es
  took it to **41**, and the worst scene in the whole game to 110. Measured
  worst-first: course 1034 → 41, augusta2 964 → 33, secondAim 895 → 49,
  aim 790 → 50, augusta13 685 → 24, played 653 → 48, approach 593 → 32,
  celebrate 583 → 30, green 581 → 28, augusta16 424 → 39, listowel3 419 → 37,
  augusta12 365 → 39, augusta16pond 320 → 34, range-water 290 → 110,
  range 269 → 89. The art is provably unchanged: the per-tree RNG DRAW ORDER is
  byte-identical to the old builder's, and a throwaway parity harness compared
  all 559 world matrices and leaf colours (558 identical, 1 differing by
  0.001 yd from float32 `instanceMatrix` vs float64 `matrixWorld`). Variety was
  never in the meshes or the materials — it is in the seeded jitter, and an
  instance matrix expresses all of it.
- **Warm-hued blossom reads as AUTUMN, and chroma is not the lever.** The gate
  passed the pink/magenta holes emphatically and rejected every warm-hued hole
  and no other. Two distinct mistakes: (a) the **wrong season's feature** —
  Firethorn and Nandina were authored from pyracantha's orange and nandina's red
  BERRIES, an autumn/winter feature, when Augusta's frame of reference is April
  and both flower white; and (b) the **wrong FORM for the hue** — yellow, orange
  and red ARE the autumn palette, so a tree-sized crown in one of them has no
  signal left that says spring at any saturation. Green leaves standing OVER a
  warm mass is a silhouette autumn cannot produce, and it is also simply true:
  forsythia, pyracantha and nandina are 2–3 m shrubs and Carolina jessamine is a
  vine. None is a canopy tree. `courses.test.ts` now carries an autumn guard — a
  bloom in hue 0–65° at sat > 0.45 may not use the default `'canopy'` form — and
  it caught a fourth hole nobody had looked at. **The magenta side (~300–355°) is
  deliberately exempt and must stay exempt.**
  - Related tuning finding: **contiguity, not area, is what reads as planting.**
    Two holes spanning nearly the same horizontal extent read very differently
    when one's colour is two unbroken ribbons and the other's is nine islands.
    And **distance haze eats the colour before it can read** — far drifts
    desaturate down the depth gradient (0.55 near → 0.14 far) until they fall
    below a chroma gate entirely. The levers are drift SPAN and blossom fog
    handling, not `fraction`.

*Lesson worth keeping from the same era: the harness can ABLATE. Rendering a
scene with one object removed costs one 30-second run and beats arithmetic about
which mesh is expensive. It is how a 187k-triangle putt board was traced to a
wet-bank plane that was passing one axis's segment count to both axes.*

### 6.4 What is still genuinely open

- **The on-device GPU measurement.** Every knob is now a URL parameter, so this
  is a ten-minute job on a handset rather than a rebuild cycle: `?shadow=2048`
  reproduces the configuration that killed the WebView GPU process, `?shadow=1536`
  is the shipping default, `?shadow=1024` the known-survivable fallback — bisect
  in that order. `?quality=low` drops the shadow pass entirely (if that is the
  only survivor, the finding is much bigger than a map size). `?water=medium`
  drops the planar reflection pass, `?water=low` also the detail normals. Read
  `window.__golfStats` in the device console for live draw call / triangle /
  tier numbers and a median frame time. **Until someone holds a low-end
  Android, nothing here is evidence.**
- **`pickWaterQuality`'s promoting capability sniff** (§4) — the thing most in
  need of confirming on real hardware.
- **The range's water-island idiom** still reads as un-golf-like to the user.
- **A harness view composed for SAND** is still owed (defect 5 below), and a
  second view of Augusta 10's corner (defect 19).
- The numbered list below is the live tracker for render-level defects.

---

## Open defects — visual gate findings

> ⚠ **This list is APPEND-ONLY and is owned by another session.** Do not
> renumber, reword, reorder or tidy it, and do not move it from the end of this
> file. Reference it from above instead. Entries carry their own status markers.
>
> Reading aid only (nothing below was altered): entries citing the quoted
> section titles **"Instanced foliage"**, **"Blossom"** and **"Blossom, part 2"**
> refer to material now in §5.4 and §6.3; `SCENES` is `shoot-golf.mjs`'s scene
> matrix (§5.5).

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
   → Still open, and generalised: "authored art with no harness frame" is the
   class, and it cost three unreviewed flowering holes (see "Blossom, part 2").
   Partially relieved by accident — the new `augusta17` tee view catches one of
   that hole's greenside bunkers at the top of frame — but a view *composed* for
   sand is still owed.
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
   → **And then half-undone, on the holes nobody could see.** The same change
   bloomed 13 holes; only 3 had harness frames. The gate passed those 3 and
   rejected every WARM-hued hole (12, 15, 17, and 8 once it was looked at) for
   reading as autumn. See "Blossom, part 2" below — the fix is a season
   correction on 15/17 and a new `understory` bloom form on 8/12, plus harness
   scenes for all three of the holes that had none.
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
9. **An understory drift is a phantom obstacle.** ⚠ The one real cost of
   `BloomForm: 'understory'`, and the reason it must not spread further
   unresolved. A drift is a visually solid mass **7.5–9.9 yd across and 4.3–5.7
   yd tall**; the sim collides with the trunk cylinder only, at **r 1.32–1.74
   yd**. A ball can therefore roll through eight yards of apparent flowering
   shrub and feel nothing. `'canopy'` never had this problem because the blossom
   sat up in the crown, where nothing was collidable anyway — **moving the mass
   down moved it into the one height band the collision model ignores.**
   Tolerable at holes 8 and 12, where the drifts sit inside a tree line the ball
   has no business being in. Resolve it before a third hole gets the form: either
   shrink the drift inside the trunk radius, or teach `courseTrees` to emit it as
   a collidable. `foliage.ts`'s header now says so rather than claiming
   drawn == played unqualified.
   → **FIXED, by the collider — and NOT by a wider trunk.** See "The drift, made
   honest" below. Drawn extent is now **0.95 of the collider radius** (was 5.7×
   it), and the art is *inscribed in the collider by construction* rather than
   sized to match it by hand.
10. **The drift is bigger than the tree it grows under.** Radius 7.5–9.9 yd
   against a canopy radius of 5.6–7.4 yd, and 4.3–5.7 yd tall is nearly double a
   real forsythia. That is why the near clumps read faintly boulder-like.
   Shrinking it also shrinks defect 9.
   → **FIXED in the same change.** Radius **5.3–7.0 yd** against a canopy radius
   of 5.6–7.4 (inside it at every scale, by arithmetic: 3.2 < 3.4) and
   **2.6–3.5 yd** tall, which is a real 2.4–3.2 m forsythia. The boulder read
   turned out to be the BLOB size rather than the mass size — individual blobs
   were 3.6–7.6 yd across and are now 2.5–4.7.
11. **15 Firethorn and 17 Nandina got half the fix, and now look like each
   other.** They were corrected for SEASON (berry colour → April white flowers)
   but remain `form: 'canopy'` — so the argument that justified the fix, that
   pyracantha and nandina top out at 2–3 m and were never canopy trees, is not
   implemented for either. Two consequences: they read as generic white
   flowering trees rather than as those plants, and their blooms are
   near-identical to each other (mean RGB [201,214,209] vs [211,213,199], sat
   0.06 vs 0.07). Add 2's pale pink, 9 Carolina Cherry and 11 White Dogwood and
   **four-plus holes converge on the same near-neutral** — an identity loss for a
   system whose whole purpose is per-hole identity. 15's white also carries a
   mint cast (hue 153°) from green ambient bounce.
12. **Every Augusta frame is a tee view.** No harness scene shows a course tree
   line from close up, which is where the understory drifts' shade facets are
   still olive [134,138,32]. At tee distance that reads as shading; to a player
   who has missed into the trees it may not. Same "authored art with no frame"
   class as defects 5 and 6.
13. **Any frame with open water cannot be exact-pixel regression-checked.** First
   caught on `augusta-16-redbud`, which produced three different hashes across
   three runs *including two runs of identical code* — 24–37 px at
   x 513–664 / y 623–634, the animated pond surface at a different phase.
   ⚠ **It is not that frame only.** A later gate re-shot `augusta-12-golden-bell`
   at an unchanged HEAD and got 68 px of variance at x 257–466 / y 623–638 — its
   own pond. The scenes already in the documented water set are
   `course-played-aim`, `listowel-heritage-3`, `putt-water`, `augusta-12`,
   `augusta-16-redbud` and `augusta-16-pond`; **treat "has open water in frame"
   as the predicate, not the list.** Everything else on those frames is exact:
   in the same run pair hole 12's yellow was bit-identical, 5,412 px across the
   same 54 components, so the drift render itself is fully seeded.
14. **The near-corridor tree on hole 8 is a dogleg-layout bug.** Hole 8 plants a
   full-size **collidable** tree at `d 332, x 0.2` — in the rough, near the
   middle of the corridor at the dogleg corner — and five more overhang playable
   ground by 2.4–5.3 yd. Pre-existing: that trunk has always been there and has
   always been drawn. The cause is that the grove is laid out at a lateral
   **x-offset** from the centerline rather than perpendicular to it, so on a
   34° dogleg the tree line crosses the corridor it is supposed to flank.
   **That makes it a content bug on every dogleg, not a hole-8 quirk**, and it
   is only visible now because making a collider match its art put a second
   volume on the same ground. Worth its own investigation.
   → **INVESTIGATED, and it is an order of magnitude worse than filed. Still
   open.** Measured across all four courses with the game's own corridor test:

   |  | filed | measured |
   |---|---|---|
   | collidable trunks inside the rough | 1 | **171** |
   | canopies overhanging playable ground | 5 | **359** |
   | out of how many trees | — | 3,084 |

   The two definitions genuinely disagree, and that is the whole bug:
   `surfaceAt` (`terrain.ts:842-845`) classifies the corridor by
   `nearestOnPolyline(...).dist <= roughHalf` — **perpendicular** distance to the
   centerline — while `courseTrees` (`terrain.ts:1049-1054`) offsets in **x**.
   For a centerline running at θ to the d axis the achieved clearance is
   `off · cos θ`, verified exactly: hole 8's tree at `d 332` sits 41.45 yd
   perpendicular against an intended 50, and 41.45/50 = 0.8290 = cos 34.0°.

   It therefore scales with dogleg angle, which is why hole 8 is one of the
   *mildest* cases rather than the whole story. Holes turning under 28° are
   clean; Augusta 10 (51°) and 13 (50°) carry 12–14 trunks each, and the worst
   tree on the property stands **12.8 yd inside the OB line**.

   **Fix direction, measured, not guessed.** Dividing the offset by cos θ *and*
   sampling the centerline at the tree's own `d` (today it is sampled at the
   unshifted row `d`, a second smaller error worth ~2 yd on a 34° dogleg) takes
   it to **2 trunks / 11 canopies**, moving trees a mean 6.7 yd. A true-normal
   offset is *worse* — 23 trunks — because near the vertex the normal from one
   leg swings the tree toward the other leg. All 13 residuals sit within 21 yd
   of a dogleg vertex: the unmitred corner.

   → **FIXED — by `clearOfCorridor`, and by fixing LESS than first proposed.**
   `courseTrees` now slides each tree straight out along ±x until its collidable
   trunk is entirely off playable ground (perpendicular clearance ≥
   `roughHalf + trunkR`), leaving it alone when it already is. **246 → 0**,
   guarded over every hole of every course by `courses.test.ts`.

   ⚠ **Two counts appear in this entry and they measure different things.** 171
   is trunk CENTRES inside the corridor (`perp < roughHalf`); 246 is trunks
   *touching* it (`perp − trunkR < roughHalf`), which is what the guard asserts
   and therefore the honest number for the fix. They partition the same 530
   trees against the canopy count — 171 + 359 and 246 + 284 both total 530 — so
   quoting one against the other's baseline overstates or understates the change.
   Verified against the real bundled `courseTrees`, not a reimplementation: tree
   count, per-tree identity (kind/seed/scale/d) and bloom assignment are all
   preserved, so nothing but x moves.

   ⚠ **The first attempt fixed too much, and the sim tests caught it.** Pushing
   until no part of the tree overlapped playable ground — trunk *and* canopy —
   read as the more principled invariant and was implemented first. It is wrong:
   `shrubR` (3.2·scale) is smaller than `canopyR` (3.4·scale), so a tree cleared
   by its canopy can never have its understory drift reach the corridor, and the
   `brushShrub` damping shipped in #261 becomes dead code for any in-play ball.
   `courseSim.test.ts`'s Augusta 8 case asserts exactly that drift-in-play and
   went undefined. The wider target cost 530 moved trees to delete a feature.
   **A canopy over the rough is not a defect — it is what a tree-lined hole IS.**
   The line is: you may be under a tree, you may be in its brush, you may not be
   inside its trunk.

   Three targets were implemented and measured before choosing:

   | target | trunks in | canopies over | trees moved | holes | mean move |
   |---|---|---|---|---|---|
   | `roughHalf + trunkR` (shipped) | 0 | 530 (intended) | 246 (8%) | 32/45 | 0.41 yd |
   | `roughHalf + canopyR` | 0 | 0 | 530 (17%) | 35/45 | 1.15 yd |
   | `off` = `roughHalf + 8` | 0 | 0 | 1,763 (57%) | 40/45 | 4.27 yd |

   Restoring the grove's nominal `off` was rejected too: **any** sloped
   centerline shortens clearance a little, so it relays out 57% of the grove for
   uniformity no player can perceive.

   **The design question dissolved rather than being answered.** Past the last
   centerline vertex `nearestOnPolyline` clamps to the endpoint, so the corridor
   is a disc of radius `roughHalf` there — and a tree at `cx ± off` sits at
   `√((d−dEnd)² + off²) ≥ off`, i.e. *always already outside it*. There was never
   a violation out there. The earlier "exact solve" broke only because forcing
   `perp == off` **pulled trees in** where they were fine; "push out, never pull
   in" needs no rule for the cap at all.

   Implementation notes worth keeping: bisection, not trigonometry, because the
   nearest segment changes under the tree near a vertex and closed-form
   per-segment offsets mitre badly there — a true-normal offset measured **worse
   than doing nothing** (23 trunks), since the normal from one leg swings the
   tree toward the other. The guard writes out its own perpendicular measure
   longhand rather than importing `nearestOnPolyline`, so the fix and the
   assertion cannot agree by construction, and counts the trees it checked so it
   cannot pass vacuously. The rows still sample the centerline at the unshifted
   `d` while planting at `ld`/`rd` (±3 yd, ~2 yd of drift on a 34° dogleg); left
   alone deliberately, since `clearOfCorridor` measures at the tree's own `d`.

   **The visual gate passed it, and measured what it costs.** Only 4 of 28
   frames moved, all in the tree-line band, all doglegs: augusta13 (50°) 1.300%,
   augusta2 (35°) 0.460%, augusta8 (34°) 0.386%, augusta15 (28°) 0.041%. Five
   more differ by ≤91 px of known defect-13 pond noise; 19 are byte-identical,
   including `course-hole1` and `range-fairway` — HOLE_1's grove already stood 8
   yd outside the OB edge and correctly did not move. On hole 13 the flanking
   band lost 2 of its 6 free-standing crowns and the left grove's inner edge
   pulled back 37 px, but the horizon stays tree-lined edge to edge, the largest
   gap is ~1.5 crown widths, and the grove's inner edge is still well outside the
   fairway's. **The tree pixels that left the corner are exactly the trunks that
   were standing on ground the hole invites you to play; you cannot keep both.**
   Ground contact, hazards, cart path and blossom all verified unchanged — hole
   8's drift visibly moved WITH its tree, so #261's brushShrub premise is
   preserved in pixels and not just in argument.
   **Augusta 10, the worst hole, came through BETTER than its proxy.** It had no
   harness frame, so `augusta10` was added and shot either side of the fix. On
   the same crown-blob method used on 13, hole 10 held all 6 mid-band crowns
   (13 went 6 → 4), **gained** 1.2% of crown silhouette (13 lost 2.5%), gained
   0.6 pt of column coverage (13 lost 7.3), and its corner-side inner edge moved
   3 px where 13's went back 32. Where 13 thinned without opening, 10 did not
   thin — it redistributed. Camellia is unchanged at mean rose (192,109,113)
   either side, with the dominant right-hand group pixel-identical.

   ⚠ **CORRECTION to `af3f068`'s commit message**, which read hole 10's smaller
   raw delta (1.212% vs 13's 1.300%) as proof that 13 was a fair proxy. That
   inference is wrong. Hole 10 has **13% less tree in shot to begin with** — it
   plays from an elevated tee (`teeElev 14 → greenElev 4`, against 13's level
   9 → 8) down a falling corridor, so its skyline sits 21 px lower and its
   flanking crowns are ~30 px shorter. Normalised per visible crown pixel, hole
   10 moved **more**: 0.456 against 13's 0.427, which is exactly what the sharper
   turn predicts. The proxy was fair in kind, not in magnitude, and the raw pixel
   comparison flattered it.

   **The fix is visible doing its job.** In the before frame a trunk at
   x[242–246] stood with bunker sand directly beneath its base — the inside-corner
   fairway bunker (`{ kind: 'bunker', d: 268, x: -60, r: 9 }`). After, no trunk in
   frame has sand or cart path within 4 px of its base, and that bunker's legible
   sand went **81 → 193 px**, more than doubling, because the trunk and its shadow
   came off it. The nearest trunks now sit behind the sand's top edge in depth:
   crowding the corridor, not standing in it.
15. **Hole 8 is under-planted for a hole called Yellow Jasmine.** After the drift
   was resized to its collider, yellow fell to 0.165% of frame and only the near
   right-hand cluster reads as deliberate planting; on the before frame you would
   name yellow as a feature of the hole, on the after you probably would not.
   Not a defect but a tuning value: `yellowJasmine.fraction` 0.6 → ~0.85, with
   hole 12 at 0.8 / 0.376% as the reference for "enough". Deliberately left out
   of the collider change so the physics delta stayed reviewable on its own.
   → **FIXED at 0.85, and the gate passed it — but only the near half improved.**
   Yellow went 0.173% → 0.259% of frame (+49%) at 34 draw calls unchanged,
   +5,760 triangles, riding the existing instanced leaf batch. Only 1,676 px
   differ, in five clusters at x 98–761: the left tree-line foot went from one
   lonely 15 px clump to a continuous 67 px drift, so the corridor is now framed
   on **both** sides rather than reading lopsided. Split by depth the gain is
   +57% near (y > 552) against +21% far — see defect 16 for why the far half did
   not move, and why raising `fraction` again is the wrong lever.
16. **Hole 8's FAR tree line still reads as scattered specks**, and raising
   `fraction` again will not fix it — 0.85 is already near saturation there
   (4 of ~5 broadleaf crowns between x 230–680 carry a drift). Two findings from
   the gate on the 0.85 frame:
   • **Contiguity, not area, is what reads as planting.** Hole 8 and hole 12
     span nearly the same horizontal extent of frame (342 px vs 352 px). Hole 12
     reads better because its yellow is two unbroken ribbons — widest blob
     161 px — where hole 8's is nine islands averaging 38 px, leaving 100–130 px
     of bare trunk line at x 198–475 and x 604–705. **The area-share ratio the
     tuning was aimed at is a red herring.**
   • **Distance haze eats the colour before it can read.** Far drifts desaturate
     down the depth gradient — sat 0.55 near, 0.44 mid, 0.24 far, and 0.14 at
     x 237–260, where the mound is visible to the eye but reads as pale grey
     stone and falls below the chroma gate entirely, so it does not even appear
     in the 0.259% measurement. Hole 12 never shows this because its drift is
     close to camera.
   Levers are drift *span* (world radius / instances per shrub, so one far drift
   covers more trunk spacing) and blossom fog handling — not `fraction`.
17. **Cleared trees settle on a common offset line.** A consequence of the defect
   14 fix, cosmetic, not blocking. Pushing every violator out to the *same*
   clearance boundary lands them on one offset curve, so on the sharpest doglegs
   the gaps go from irregular to near-uniform — on hole 13, σ 15 px → 2.5 px,
   with two pairs now standing 17–23 px apart against ~8 px trunks (adjacent,
   never interpenetrating). Fix is a small SEEDED jitter on the post-clear x, so
   cleared trees scatter around the boundary instead of lining up on it. Must be
   seeded — an unseeded jitter makes every screenshot a false regression.
18. **The tee peg renders above the ball, not below it.** A white cylindrical
   stub protrudes from the TOP of the ball on every Course tee scene. Pre-existing
   and byte-identical across the defect 14 before/after, so it is not a
   regression from that change — but it is in every tee frame the harness shoots,
   which is most of them, and nobody had named it.
19. **Augusta 10's frame reviews the approach to the corner, not the corner.**
   The new `augusta10` tee view carries the whole diff and every trunk with a
   ground contact, so it will catch a grove regression — but hole 10's corner
   apex, its entire second leg and its green (`d 402, x −204`) sit behind the
   crest and off-frame left, with the corner bunker reduced to a ~60×6 px sliver
   at the horizon. Any of that hole's illegally-placed trunks that sat on the
   **second leg** are therefore still unreviewed. A 51° dogleg needs a second
   view from the corner or landing zone; the harness already supports
   pin-relative `at=` lies (`golfpreview.tsx`), and `augusta16pond` is the
   precedent for a second view of one hole.
