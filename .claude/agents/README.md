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
| `android` | Capacitor native shell, FCM wiring, Gradle signing, Android CI |
| `data-migrations` | D1 `schema.sql` + numbered migrations + lint/test tooling |

## Cross-cutting agents (invoked around feature work)

| Agent | Role |
|---|---|
| `devops-release` | `wrangler.toml` bindings/routes/secrets, deploy + CI workflows |
| `code-reviewer` | Read-only diff review before commit/PR |
| `qa-verify` | Runs typecheck / tests / migration tests / builds; reports pass-fail |

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
- Native (Capacitor/FCM) behavior → **android**; the web UI it wraps →
  **frontend-pwa** (branch on `lib/platform.ts`).

## Standard flow

1. **Orchestrator** plans and decomposes; sequences data/devops handoffs first.
2. **Feature agent(s)** implement their slice (parallel when independent).
3. **code-reviewer** reviews the working diff.
4. **qa-verify** runs the real checks and reports.
5. Fixes route back to the owning agent; repeat 3–4 until green.
6. Orchestrator commits, pushes to the working branch, opens a **draft PR**,
   and subscribes to PR activity.

## Cross-domain discipline

An agent edits only the files in its scope. When a task needs another domain,
it hands off rather than reaching across — the orchestrator coordinates the
boundary. Worker and UI deploy independently, so keep protocol/API changes
backward-tolerant across a deploy gap.
