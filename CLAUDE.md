# Relay — project guide for Claude

Relay is a PIN-to-PIN messenger (BBM-inspired), built on **Cloudflare Workers
(Hono) + D1 + Durable Objects + R2** with a **React PWA** and **Capacitor
native Android + iOS** shells. Full spec in `RELAY_BUILD_SPEC.md`; Sports tab in
`SPORTS.md`.

## Work through the sub-agent fleet

Future work on this repo is orchestrated across specialized sub-agents in
`.claude/agents/`. **Read `.claude/agents/README.md` first** — it is the fleet
map and routing rules. The main session acts as the **orchestrator**: plan,
decompose, route each slice to the agent that owns it, run independent slices
in parallel, and gate every change through `code-reviewer` then `qa-verify`
before commit/PR.

Quick routing: worker API (auth/chats/messages/contacts/blocks) →
`messaging-core`; Durable Objects + WebSocket → `realtime`; push (Web Push +
FCM) → `push`; R2/avatars/GIFs/stickers → `media`; Sports tab → `sports`;
React UI/PWA → `frontend-pwa`; in-app golf game (`src/**/golf/**`, GOLF.md) →
`golf` then `golf-visual-qa` screenshots the render; Capacitor Android →
`android`; Capacitor iOS → `ios`; D1 schema + migrations → `data-migrations`
(**first**, before feature code); `wrangler.toml` + deploy/CI →
`devops-release`.

## Repo layout
- `packages/relay-worker/` — Cloudflare Worker (API, WS, D1, DOs, R2).
- `packages/relay-ui/` — React PWA (also wrapped by the Capacitor Android app).

## Commands
- `pnpm typecheck` — types across the monorepo (turbo).
- `pnpm --filter @relay/worker test` — worker tests (vitest / workers pool).
- `pnpm --filter @relay/worker lint:migrations` / `test:migrations` — D1 checks.
- `pnpm --filter @relay/worker build` — dry-run deploy; `pnpm --filter @relay/ui build`.
- `pnpm dev` — run worker (:8787) and UI (:5173) locally.

## Cut a mobile build only when the native app changes
After a PR merges to `main`, cut a new mobile build **only if the merge
includes native-impacting changes** — otherwise skip it. Both Capacitor
WebViews load from `server_url` (default `https://relay.averrow.com`), so
**web-only** changes (routes, components, worker endpoints, D1 schema,
styling) reach Android and iOS users the moment `deploy-ui` finishes — no new
AAB or IPA, no store review. Cutting one for those churns review for a binary
that delivers nothing new.

Cut a new build when the merge touches something that ships **inside** the app:
- a Capacitor plugin added/removed/upgraded (camera, biometrics, push, etc.);
- a new permission / usage string — `AndroidManifest.xml` or `Info.plist`;
- native push / FCM wiring, deep-link, or `capacitor.config.ts` changes;
- app icon / splash, or signing config;
- `targetSdkVersion` / `applicationId` (Android), entitlements /
  deployment target / bundle id (iOS);
- a `server_url` change or a cosmetic version bump for a store listing.

Work out **which** shell is affected — most native changes hit only one. A
change to shared native surface (`capacitor.config.ts`, `lib/native-push.ts`,
the push payload shape) needs **both**.

- **Android** — run **Build Android APK / AAB** against `main` with
  `build_type=release-aab` and `publish=true`; the AAB rolls out to the Play
  **Internal testing** track.
- **iOS** — run **Build iOS IPA** against `main` with `build_type=release-ipa`
  and `publish=true`; the IPA goes to **TestFlight**. See `IOS.md`.

Each upload starts its own store review, so batch native changes and don't
fire several builds minutes apart. Both workflows use `cancel-in-progress`, so
a new run supersedes one still building.

## Conventions that bite
- **D1 migrations must be idempotent and use NO explicit transactions**
  (`BEGIN`/`COMMIT`/`SAVEPOINT` are rejected). New schema goes in **both**
  `schema.sql` and a numbered `migrations/000N_*.sql`. See `migrations/README.md`.
- New API endpoints go inside a `*Routes()` Hono sub-app, mounted in
  `src/index.ts` — don't bloat `index.ts`.
- WS protocol (`lib/ws-protocol.ts`) is shared by worker and UI — change both,
  keep it backward-tolerant. Worker and UI **deploy independently**.
- Native Android has no Web Push API — it uses FCM. Guard native branches with
  `lib/platform.ts`. Secrets live in Wrangler / GitHub Actions — never commit them.
