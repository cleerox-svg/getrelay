# Relay sub-agent fleet

All future work on Relay is driven through specialized sub-agents. The **main
session is the orchestrator**: it plans, decomposes the task, routes each slice
to the agent that owns it, runs independent slices in parallel, and gates every
change through review + QA before commit/PR. Each agent carries only the
context and conventions for its slice, so it stays expert and its context stays
small.

## Feature-domain agents (own a code slice)

| Agent | Owns |
|---|---|
| `messaging-core` | Worker API: auth, contacts, chats, messages, blocks, me, pin, status |
| `realtime` | Durable Objects (`UserHub`, `ChatRoom`), WS protocol, UI ws client |
| `push` | Web Push (VAPID) + FCM native push, subscribe/send paths |
| `media` | R2 uploads, avatars, GIFs (Giphy proxy), stickers/emoji pickers |
| `sports` | Sports tab: NHL/MLB polling, subs, score-change push, Sports UI |
| `frontend-pwa` | React PWA: routes, components, store, api client, theming, service worker |
| `golf` | In-app golf game: `lib/golf/*` sim/data + `components/golf/*` scenes/HUD + GOLF.md |
| `baseball` | In-app baseball game: `lib/baseball/*` sim/physics/data + `components/baseball/*` stadium scene/HUD + BASEBALL.md |
| `baseball-progression` | Baseball cards/packs/ladder: worker `src/baseball.ts`, the `GAME_IDS`/cosmetic-slot extensions, card + shop UI |
| `android` | Capacitor native shell, FCM wiring, Gradle signing, Android CI |
| `ios` | Capacitor iOS shell, FCM-via-APNs wiring, ASC cloud signing, iOS CI |
| `data-migrations` | D1 `schema.sql` + numbered migrations + lint/test tooling |

## Cross-cutting agents (invoked around feature work)

| Agent | Role |
|---|---|
| `devops-release` | `wrangler.toml` bindings/routes/secrets, deploy + CI workflows |
| `code-reviewer` | Read-only diff review before commit/PR |
| `qa-verify` | Runs typecheck / tests / migration tests / builds; reports pass-fail |
| `golf-visual-qa` | Renders the golf scenes headlessly and reviews the actual pixels (Course/Range parity) |
| `baseball-visual-qa` | Renders the baseball stadium headlessly, reviews the pixels, checks the park's DIMENSIONS and the drawn break against the sim's own numbers |

## Routing rules (orchestrator)

- Touching `src/do/*` or `lib/ws-protocol.ts` → **realtime** (protocol changes
  hit worker **and** UI together).
- Any new table/column/index or backfill → **data-migrations FIRST**, then the
  feature agent uses it.
- New binding / route / secret / cron / DO class → **devops-release**.
- New endpoint under an existing domain → that domain's feature agent, inside
  its `*Routes()` sub-app (never bloat `index.ts`).
- Sports or push notification payloads → **sports** and **push** coordinate on
  one shared payload shape.
- Native (Capacitor/FCM) behavior → **android** or **ios** by shell; the web UI
  they both wrap → **frontend-pwa** (branch on `lib/platform.ts`). A change to
  the shared `capacitor.config.ts` or to `lib/native-push.ts` affects BOTH
  shells — route it to one and have the other review, don't split it.
- Golf game (`src/**/golf/**`, GOLF.md) → **golf**, not frontend-pwa. Any change
  to a golf 3D scene, its materials, lighting or geometry → **golf** implements,
  then **golf-visual-qa** gates the RENDER (before/after screenshots) before the
  orchestrator commits — typecheck/tests never catch a broken or regressed look.
- Baseball game (`src/**/baseball/**`, BASEBALL.md) → **baseball**, not frontend-pwa.
  Any change to the stadium scene, its materials, lighting or geometry → **baseball**
  implements, then **baseball-visual-qa** gates the RENDER before the orchestrator
  commits. Physics changes additionally require the vitest **dynamics tables to be
  re-read**, not merely green — a change can stay inside tolerance while walking the
  whole ladder one direction.
- Baseball cards / packs / ladder / score submission → **baseball-progression**. A new
  TABLE → **data-migrations FIRST**. A new COLUMN → `schema.sql` + a
  `deploy-worker.yml` pragma probe, never a numbered migration.
- The shared kits (`lib/scene3d/*`, `components/games/shared/*`) are consumed by BOTH
  golf and baseball. A change there requires **golf-visual-qa AND baseball-visual-qa** —
  it can regress a game whose own code did not change.

## Standard flow

1. **Orchestrator** plans and decomposes; sequences data/devops handoffs first.
2. **Feature agent(s)** implement their slice (parallel when independent).
3. **code-reviewer** reviews the working diff.
4. **qa-verify** runs the real checks and reports.
4b. For 3D scene/material/lighting/geometry changes, the matching visual gate —
    **golf-visual-qa** (Course/Range parity) or **baseball-visual-qa** (stadium
    dimensions + drawn break vs the sim) — renders the scenes and reviews the
    pixels. A visible regression or a no-op "visual" change is a finding,
    invisible to steps 3–4. A shared-kit change runs BOTH.
5. Fixes route back to the owning agent; repeat 3–4b until green.
6. Orchestrator commits, pushes to the working branch, opens a **draft PR**,
   and subscribes to PR activity.

## Cross-domain discipline

An agent edits only the files in its scope. When a task needs another domain,
it hands off rather than reaching across — the orchestrator coordinates the
boundary. Worker and UI deploy independently, so keep protocol/API changes
backward-tolerant across a deploy gap.
