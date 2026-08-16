# `lib/scene3d` — the shared 3D kit

Machinery that drives a Three.js scene, owned by **no single game**. Golf is the
first consumer; baseball is the second. A fidelity gain made here lands in both.

The platform-level reasoning behind this kit — why Three.js and not Unity or
Unreal, why WebGPU is deferred, why there is no `EffectComposer`, and the GPU
budget rules — lives in `/GRAPHICS.md`. Read that first.

---

## The contract

Every module here must satisfy all six. Rules 1, 4 and 5 are enforced
mechanically by `budget.test.ts`; 2, 3 and 6 are review responsibilities because
no test can see them.

### 1. Game-neutral names

`pickSceneQuality`, not `pickGolfQuality`. `SceneQuality`, not `GolfQuality`. No
`golf`, `course`, `hole`, `baseball`, `park` or `stadium` in any exported
identifier or filename.

A name is the cheapest possible signal that a module is shared. Once one export
says `golf`, the next person assumes the file is golf's and stops considering
the other consumer.

### 2. Config in, no constants imported

A module takes what it needs as parameters. `buildSkyEnv(renderer, cfg)` receives
sun elevation and azimuth, horizon colour, ground-bounce colour. Golf passes turf
green; baseball passes infield brown.

**A module that reaches into a game's constants is broken**, even if it happens
to compile. That is how a "shared" kit quietly becomes single-game.

### 3. Unit-agnostic

Golf runs an arcade yard-space (`GRAVITY = 16`, not real units). Baseball runs
real feet with `g = 32.174`. **No module here may assume a unit or a world
scale** — take extents, radii and distances as parameters.

This is the single easiest way to make the kit golf-only by accident, because
golf-derived defaults compile perfectly and simply look wrong at ballpark scale.

### 4. No sim imports

Nothing here imports `lib/golf/*` or `lib/baseball/*`. The dependency arrow runs
one way: games depend on the kit, never the reverse.

This also keeps the kit out of the sims' determinism contract. `lib/baseball` is
asserted three-free by its own budget test; if the kit imported it, or it
imported the kit, that guarantee would leak.

### 5. 500-line cap, no barrel `index.ts`

Mirrors `lib/baseball/budget.test.ts`. **At the cap the fix is extraction, not a
raised cap.** `components/golf/CourseGL.tsx` reached 2,630 lines with no cap
watching it, and it is now the file nobody wants to touch.

No barrel file: every import names the module it wants, so a consumer never pays
for the whole kit to use one function.

### 6. Per-game budget tables

The *policy* is shared; the *numbers* are not. A stadium's shadow volume is
~900 ft across and a golf hole's is not, so a tier module takes a budget table
rather than hardcoding sizes.

The shared policy is the one from `components/baseball/stadium/quality.ts`:
**default DOWN, promote only on measured evidence.** A capability sniff answers
"what does this driver *allow*", never "what can this GPU *afford*".

---

## Extraction rule

Moving existing game code into this kit is **a pure move plus a re-export**. It
must be pixel-identical, and it must be gated by the visual QA of *every* game
that consumes the module.

**Never merge a move with a policy change.** The live example: `lib/golf/water.ts`
`pickWaterQuality` promotes on `cores > 4 && maxTextureSize >= 8192`, which is
the exact heuristic `stadium/quality.ts` calls out as wrong — so it is tempting
to fix it while extracting. Don't. That produces an unreviewable diff and a "why
does the water look different" bug that nobody can bisect. Move it byte-identical
first, change the policy in a separate, separately-gated commit.

While baseball is under active construction in a parallel session, extraction is
**deferred entirely** — its visual gate cannot certify pixel-identity against a
tree that is still moving. New modules are fine; moves are not.

---

## Modules

| Module | What it owns |
|---|---|
| `clock.ts` | A freezable virtual clock, so a screenshot harness controls time instead of the platform. Default is a strict no-op. |

---

## Why `clock.ts` exists, in one paragraph

The visual gate is the only check that can catch a broken *look* — typecheck and
unit tests never will. It was measured producing **23 of 25 golf scenes differing
between two runs with no code change at all**, which made it unable to prove any
change was pixel-identical.

The cause was not RNG (the generators were already seeded, and seeding the
remaining ones changed the count by zero). It was time: every animated scene
sampled `performance.now()`, so the captured frame was a function of machine
speed. Worse, `golfpreview.tsx`'s readiness beacon counted 45 frames while
SwiftShader renders at ~3 fps — its 4-second wall-clock fallback won the race on
every single scene, so the frame-count path never executed once.

`clock.ts` makes time an input. The preview runs an exact number of fixed steps
and freezes; `dt` becomes 0, nothing advances, and a screenshot taken any number
of frames later is identical. Anything here that animates must take its time from
this module, never from `performance.now()` directly.
