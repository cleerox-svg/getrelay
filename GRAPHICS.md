# Relay graphics — the platform decision record

Cross-game. Golf (`GOLF.md`) and baseball (`BASEBALL.md`) both render through the
choices recorded here. **Read this before proposing a renderer, an engine, a
post-processing stack, or a new binary asset.**

This file exists because the decision it records did not stick the first time.
`GOLF.md` has carried a one-line rejection of Unity/Godot→WebGL since the golf
assessment, and the question came back anyway. A platform decision buried in a
game doc is not a decision record.

---

## 1. We do not use Unreal Engine or Unity. We use Three.js.

### Unreal — not viable at any effort level

Epic removed HTML5 export in 4.24 (2019). There is no browser target. The only
path is **Pixel Streaming**: the engine runs on a cloud GPU and streams WebRTC
video to the browser.

That means **one GPU instance per concurrent player** — roughly €45/CCU/month on
managed platforms, or $0.50–1.50/hr self-hosted — plus streaming latency on a
game whose whole appeal is a timing meter. On a free PIN messenger where the
games exist for retention, the cost curve rises linearly with success. Rejected.

### Unity Web — technically possible, and it collides with five things Relay does

| Relay reality | The collision |
|---|---|
| No COOP/COEP headers (`packages/relay-ui/public/_headers`) | No `SharedArrayBuffer`, so no threaded Unity wasm. Adding those headers breaks every cross-origin call — `relay-api.averrow.com`, Giphy, R2 — unless each one also gets CORP headers |
| `public/sw.js` stale-while-revalidates all of `/assets/*` into `SHELL_CACHE` with no ceiling | A 30–80 MB `.wasm`+`.data` payload is cached unbounded. Under iOS storage pressure Safari evicts the **whole origin**, taking the app shell with it |
| `deploy-ui.yml` has a documented incomplete-Pages-upload failure mode and a 10-minute job timeout | A multi-hundred-MB payload materially raises the odds of shipping a broken bundle |
| Golf shipped a 2048² shadow map that **killed the Android WebView GPU process** | Unity URP is far heavier than the budget this device fleet demonstrably survives |
| iOS Safari caps the WASM heap; Unity's own guidance is a 256 MB memory setting and <50 MB of assets | Both shells run inside a WebView — the worst case for this, not the best |

### Unity as a Library (native embed) — breaks the delivery model

Both Capacitor shells load from a remote `server_url` (see
`packages/relay-ui/capacitor.config.ts` and `CLAUDE.md`). Every web change
therefore reaches Android and iOS users the moment `deploy-ui` finishes — no
AAB, no IPA, no store review.

UaaL puts the game **inside the binary**. Every gameplay tweak becomes a store
review, each shell grows 30–60 MB, and PWA users lose the games entirely. It
trades away the single best property of Relay's release pipeline.

**But the disqualifier is the runtime lifecycle, not the release pipeline**, and
it is specific to Relay being a *messenger*:

- Only **one Unity runtime per process, ever**. You cannot load a second instance.
- After `Application.Unload`, Unity **retains 80–180 MB resident** so it can
  resume instantly.
- On **iOS, after `Application.Quit` you cannot reload Unity in the same app
  session at all** — one load/unload cycle per process.
- UaaL renders **full-screen only**.

Now picture the real access pattern: a user is chatting, taps Games → Golf,
plays a hole, backs out to answer a message, taps back in. That
enter/leave/re-enter loop is precisely what UaaL handles worst. In a *game* app
Unity is the app and never unloads; in a messenger the game is a transient
screen, and on iOS the second entry may simply not work. That is structural, not
something to engineer around.

### Native-only was evaluated and deferred — how to revisit it

Going native-only (dropping the web app) is a real way to raise the ceiling: it
escapes the WebView GPU sandbox and its heap cap, gets native compressed
textures and compute, makes post-processing affordable, unlocks Play Asset
Delivery / iOS on-demand resources instead of streaming assets every cold load,
and brings engine *authoring* tooling — Shader Graph, Timeline, animation state
machines, lightmap baking.

It was not chosen, for four reasons beyond the lifecycle problem above:

1. **~43,000 lines of tested TypeScript would need porting.** Golf's sim is
   ~8k lines with 3.2k of tests; baseball's ~3.7k with 4.8k of tests, real-units
   RK4 with drag-crisis modelling and mechanically-enforced determinism. Porting
   hand-tuned physics to C# risks silently changing behaviour, and the tests that
   would catch that need porting too.
2. **The agent fleet cannot do Unity Editor work.** Much of engine fidelity work
   is *in the editor* — scene authoring, material graphs, lightmap baking,
   animation state machines. Agents write C# fine; they cannot drive the Editor.
   This project is agent-delivered end to end.
3. **Assets remain the gate either way.** An engine with programmer-art renders
   programmer-art with better lighting. The reference titles (PGA Shootout,
   Baseball Clash) are *stylized*, not photoreal, and a well-executed stylized
   look is reachable on WebGL2.
4. **The current budget is not spent.** The measured 1,034 draw calls on the
   course tee view are not a web limitation — they are ~400 un-instanced tree
   meshes. Instancing returns roughly 30× the draw-call headroom without
   changing platform.

> **Revisit native when BOTH hold:** (a) the web path has actually been pushed —
> scene IBL, instanced foliage, and at least one commissioned asset set landed
> and judged on the visual gate — and it demonstrably falls short of the target
> look; and (b) the target is confirmed as photoreal/broadcast rather than
> polished-stylized. Deciding before (a) means changing platform to solve a
> content problem.

**If native is ever chosen, prefer a separate game app over UaaL.** Its own
process sidesteps the runtime-lifecycle trap entirely and decouples release
cadence. The cost is losing the in-messenger retention hook, which is the reason
the games exist — so that trade is the actual decision, not the rendering tech.

**Also consider Filament** before assuming native means an engine. Google's
real-time PBR renderer is C++, mobile-first, Metal on iOS, Vulkan/GLES3 on
Android — **and WebGL2**, so it does not force abandoning web. It offers a
materially better material model than hand-rolled Three.js. It is a renderer,
not an engine: no editor, no animation tooling, no Capacitor integration story.

### What actually closes the gap

Three.js r185 is already a renderer. The gap to a reference title is **content
and measurement**, not the engine:

- **Authored assets** — Relay's scenes are 100% procedural. There is not one
  GLTF, texture file or HDRI in the repo. This is the largest single lever, and
  it is the one thing the agent fleet cannot manufacture.
- **Scene-wide image-based lighting** — golf already has ACES tone mapping, a
  warm key sun with soft shadows and distance haze. It now also has
  `scene.environment`, tier-gated: `lib/scene3d/env.ts` paints a real
  equirectangular sky (sun disc at a true angular size, circumsolar halo,
  horizon band, ground bounce) in **half-float** and prefilters it with
  `PMREMGenerator`; `components/golf/scene/env.ts` holds golf's colours and cuts
  the hemisphere fill in the same call. Two things are worth carrying forward:
  the fill MUST come down as the env goes on (otherwise the ambient is
  double-counted and everything flattens to grey), and the sun disc contributes
  essentially nothing to diffuse — a 0.53° disc is 6.7e-5 sr — so the **halo** is
  the knob that puts direction into the ambient, while the key light stays a real
  `DirectionalLight`.
- **Instancing** — for crowds, galleries and foliage.
- **Skeletal animation** — authored in Blender and exported as GLTF. Using an
  engine as a *content tool* is fine; shipping its runtime is not.

Notably, none of this needs a header change: meshopt and the KTX2 Basis
transcoder are single-threaded and never touch `SharedArrayBuffer`.

---

## 2. WebGPU — deferred, with a written unblock condition

Three.js `WebGPURenderer` has been production-ready since r171 and recommended
since r182, and WebGPU ships default-on in Safari 26 and Chrome Android. We are
still on `WebGLRenderer`, deliberately.

**The reason is the test harness, not the shaders.** The GLSL surface is tiny —
exactly one `onBeforeCompile` in the repo (`lib/golf/water.ts:1148`) and one
`ShaderMaterial` (`water.ts:773`), about 250 lines of GLSL. Porting it to TSL is
days of work.

The blocker is that `scripts/shoot-golf.mjs` and `scripts/shoot-baseball.mjs`
launch Chromium with `--use-angle=swiftshader`, which provides **WebGL2**. Under
`WebGPURenderer` the harness would silently fall back to the WebGL2 node backend
and screenshot a code path we do not ship — a gate that returns green while
testing the wrong renderer is worse than no gate.

Secondary costs: `renderer.init()` is async and would race the synchronous
`useEffect` scene build in all four `*GL.tsx` components; there is no
`forceContextLoss()` equivalent for teardown; `renderer.info` changes shape,
which breaks the numeric GPU budget; and Capacitor ships Android **WebView**,
where WebGPU lags Chrome — so most native users would get the fallback anyway.

**Also: no named fidelity gap is blocked by WebGL2.** IBL, cascaded shadows,
instancing, GLTF skinning and KTX2 all ship on WebGL2 today. WebGPU buys cheap
draw submission, and at 40–80 draw calls submission is not the bottleneck.

> **Unblock when BOTH hold:** (a) the screenshot harness can run a real WebGPU
> adapter reproducibly in CI with a pinned Dawn/SwiftShader, and (b) an
> on-device frame-time probe shows draw-call submission — not fill rate, not
> VRAM — is the measured bottleneck.

**Standing hedge:** keep the GLSL surface portable. Exactly one
`onBeforeCompile` is allowed, in `water.ts`; this is asserted by a budget test.
Every new shader is a self-contained `ShaderMaterial` in its own file under
`lib/scene3d/shaders/`, so a future TSL port is N independent file rewrites
rather than archaeology inside a 1,400-line module.

---

## 3. No `EffectComposer`. No post-processing stack.

Adding a composer means the scene stops rendering to the default framebuffer.
At a 1080×2400 phone with `pixelRatioCap = 1.5` (1620×3600 = 5.83 M px):

| Target | Bytes/px | Memory |
|---|---|---|
| HalfFloat colour render target | 8 | **46.6 MB** |
| Depth24/Stencil8 | 4 | 23.3 MB |
| Same colour target with `samples: 4` | 32 | **186 MB** |
| UnrealBloom mip chain at half res | — | ~11 MB |

**The Android WebView GPU process died on a 16 MB shadow map.** A 46 MB render
target is a coin flip and a 186 MB one is a certainty.

There is also a silent regression built in: `WebGLRenderer({ antialias: true })`
gives MSAA on the **default framebuffer only**. The moment a composer is added,
all antialiasing disappears unless the render target is explicitly created with
`samples: 4` — which is the 186 MB line above.

**Instead, bloom is additive billboard sprites**: a soft additive quad on the
ball at grazing sun angles, additive highlights on water driven by the Fresnel
terms `water.ts` already computes, and a sun disc with a halo. Zero render
targets, zero extra fill rate beyond a few quads, no MSAA loss. At phone size
this reads as bloom.

Related rejections, for the same budget reason:

- **GTAO / SSAO** — needs a depth+normal prepass, i.e. a second full scene
  render, for an effect nearly invisible on a sunlit outdoor scene at phone
  size. Bake ambient occlusion into vertex colours in Blender instead; it is
  free at runtime.
- **TAA** — jittered projection plus a history buffer plus motion vectors, with
  a fast ball and a moving camera. It will smear the one object the player is
  tracking. If post ever lands, FXAA is the only AA worth considering.

---

## 4. GPU budget rules

These are the rules that keep the device fleet alive. They come from a real
crash, not from caution.

1. **Default DOWN; promote only on measured evidence.** A capability sniff
   answers "what does this driver *allow*", never "what can this GPU *afford*".
   `components/baseball/stadium/quality.ts` states this correctly and is the
   reference implementation. `lib/golf/water.ts:105` `pickWaterQuality` does the
   opposite — it promotes on `cores > 4 && maxTextureSize >= 8192`, which a
   typical mid-range Android satisfies. That is a known defect, not a pattern to
   copy.
2. **Every new GPU cost is tier-gated and off at `low`.**
3. **Every tier is overridable by URL parameter** (`?quality=`, `?shadow=`) so it
   can be bisected on a real handset without a rebuild. This is the only way the
   on-device evidence ever gets collected.
4. **"Renders fine in SwiftShader" is not evidence of on-device safety.** The
   screenshot harness validates composition, geometry and materials. It does not
   validate GPU behaviour. Shadow-map size, render-target count and fill rate
   must be checked on hardware.
5. **Numeric budgets are committed and enforced.** Draw calls and triangles are
   printed per scene by the harness and checked against a committed budget file;
   a regression exits non-zero.

---

## 5. Assets

- **Assets never enter the Vite build.** They are served from R2 through the
  worker, content-hashed and immutable. This keeps `dist/` small, avoids the
  Pages upload failure mode, and — importantly — R2 returns a real **404** for a
  missing object, whereas `public/_redirects` (`/* /index.html 200`) would return
  **HTML with a 200**, which reaches `GLTFLoader` as a parse error.
- **meshopt, not Draco.** `MeshoptDecoder` ships inside the `three` package as a
  single ESM module with its wasm base64-inlined: no hosting, no COOP/COEP, and
  faster decode than Draco.
- **No shipped HDRI.** A 2k `.hdr` is 3–8 MB in a repo that justifies a 300 KB
  mp3. Environment lighting is procedural: paint a gradient, run it through
  `PMREMGenerator`. `lib/scene3d/env.ts` is the implementation; the pattern was
  first proved by `lib/golf/scenery.ts` `makeSkyEnvMap`, which is still what the
  `low` tier uses. ⚠ **`PMREMGenerator` derives its cube size from
  `image.width / 4`** — `makeSkyEnvMap`'s 8×128 gradient is therefore a **2×2
  cube**, a flat wash with no direction in it, which is why it was only ever
  worth attaching to a mirror ball. Three's documented minimum equirect is 64×32
  and its "ideal" is 1024×512 (a 256 cube, ~6 MiB). `env.ts` ships 512×256 → a
  128 cube → **1.5 MiB**, on the grounds that a smooth procedural sky does not
  earn 4.5 MiB more on a fleet that lost a WebView GPU process to a 16 MB shadow
  map. `skyEnvBytes()` computes this without a GPU, and a unit test pins it.
- **KTX2 is worth its wasm, eventually.** The reason is **VRAM, not download
  size**: WebP decompresses to full RGBA in VRAM, while KTX2/ASTC/ETC2 stays
  compressed at a 4–8× saving. VRAM is what kills this fleet. When it lands, the
  Basis transcoder is hosted **in R2**, never in `public/` — `sw.js`'s asset
  regex would otherwise swallow the `.js` half into the unbounded shell cache.
- **Original art only.** No trademarked course or venue likenesses, no real club
  or park names, no real logos. `lib/baseball/ip.test.ts` enforces this for
  baseball.

---

## 6. The multi-game kit (`src/lib/scene3d/`)

Shared 3D machinery lives here so a fidelity gain in one game is available to the
other. Six rules, the mechanical ones enforced by `lib/scene3d/budget.test.ts`:

1. **Game-neutral names.** `pickSceneQuality`, not `pickGolfQuality`. No
   `golf`/`course`/`hole` in any exported identifier or filename.
2. **Config in, no constants imported.** A module that reads a golf constant is
   broken. Callers pass their own colours, angles and extents.
3. **Unit-agnostic.** Golf runs an arcade yard-space (`GRAVITY = 16`); baseball
   runs real feet at `g = 32.174`. No shared module may assume a unit or a world
   scale. This is the easiest way to make the kit single-game by accident.
4. **No sim imports.** Nothing here imports `lib/golf/*` or `lib/baseball/*`.
5. **500-line cap, no barrel `index.ts`.**
6. **Per-game budget tables.** The *policy* is shared; the *numbers* are not — a
   stadium's shadow volume is ~900 ft across and a golf hole's is not.

**Extraction rule.** Moving existing game code into the kit is a pure move plus
re-export, must be pixel-identical, and must be gated by the visual QA of **every
game that consumes it**. Never merge a move with a policy change: fixing
`water.ts:105`'s tier heuristic during its extraction would produce an
unreviewable diff and a "why does the water look different" bug. Move first,
change policy in a separate gated commit.

---

## 7. The visual gate is load-bearing, so it must be deterministic

`scripts/shoot-golf.mjs` and `scripts/shoot-baseball.mjs` are the only check that
catches a broken or regressed *look* — typecheck and unit tests never will.

That gate only means something if an unchanged scene renders identically twice.
When this program started it did not: **23 of 25 golf scenes differed between two
consecutive runs with no code change at all**, because animated content (water
`uTime`, confetti, moving highlights) was sampled at wall-clock time. Static
scenes were already byte-identical, which is what isolated the cause.

Rules that follow:

- Scene randomness is **seeded** (`mulberry32`), never `Math.random`.
- Animated scenes are driven by a **freezable virtual clock** under the preview
  harness, so the captured frame does not depend on machine speed.
- The harness fails the run on any `console.error` — that is how three.js reports
  a shader compile failure before silently skipping the mesh. Never suppress it.
