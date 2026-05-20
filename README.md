# Relay

PIN-to-PIN messaging app. BBM Consumer experience, rebuilt for 2026 on
Cloudflare Workers + D1 + Durable Objects + R2 + React PWA.

See **[`RELAY_BUILD_SPEC.md`](./RELAY_BUILD_SPEC.md)** for the full build spec.

---

## Repo layout

```
relay/
├── packages/
│   ├── relay-worker/    Cloudflare Worker (Hono) — API, WS, D1, DOs
│   └── relay-ui/        React PWA (stub until Session 4)
├── RELAY_BUILD_SPEC.md  the spec
├── turbo.json
└── package.json
```

## Cloudflare resources

| Resource | Name | ID |
|---|---|---|
| D1 database | `relay-db` | `166b7407-11eb-4031-bd44-563d268cc085` |
| Worker | `relay-worker` | (deploy creates) |
| DO classes | `ChatRoom`, `UserHub` | |

Schema is already applied to the remote D1. To re-apply (idempotent — uses
`CREATE TABLE IF NOT EXISTS`):

```
cd packages/relay-worker
pnpm db:apply:remote
```

## Local development

Prereqs: Node 22, pnpm 9, a Google OAuth client (dev), and Wrangler authed to
your Cloudflare account.

```sh
pnpm install
cp packages/relay-worker/.dev.vars.example packages/relay-worker/.dev.vars
# fill in GOOGLE_ID, GOOGLE_SECRET, JWT_SECRET
pnpm db:apply:local --filter @relay/worker     # creates a local sqlite copy
pnpm dev
```

Worker on `http://localhost:8787`. The UI dev server is a Session 4
deliverable; for now you can hit the API directly:

```sh
curl http://localhost:8787/health
# → {"ok":true,"service":"relay-worker"}
```

## Google Cloud Console setup

1. Create OAuth 2.0 Client ID — **Web application**.
2. Authorized redirect URIs:
   - `http://localhost:8787/auth/google/callback`
   - `https://relay-api.averrow.com/auth/google/callback`
3. Consent screen: name "Relay", scopes `openid email profile`.
4. Drop the client into `.dev.vars` for local, and:
   ```sh
   wrangler secret put GOOGLE_ID     --env production
   wrangler secret put GOOGLE_SECRET --env production
   wrangler secret put JWT_SECRET    --env production
   ```

## Deployment

```sh
cd packages/relay-worker
wrangler deploy --env production
```

Custom domain `relay-api.averrow.com` is bound via the `[[routes]]` block in
`wrangler.toml`. UI deployment to `relay.averrow.com` via Cloudflare Pages
lands in Session 5.

## Session map

| Session | Status |
|---|---|
| 1 Foundation + Google Auth | scaffolded in this branch |
| 2 Contacts + Chats | endpoints stubbed (501) |
| 3 Realtime: UserHub + ChatRoom | DO classes stubbed (501) |
| 4 React PWA | empty package |
| 5 Polish + deploy | pending |
