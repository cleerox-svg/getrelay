# @relay/ui

Mobile-first React PWA for Relay. Vite + React 19 + React Router v7 + Zustand.

## Dev

```sh
cp .env.example .env       # default points VITE_API_BASE_URL at localhost:8787
pnpm install
pnpm --filter @relay/ui dev
```

Open `http://localhost:5173`. The worker must also be running on
`http://localhost:8787` (`pnpm --filter @relay/worker dev`).

## Build

```sh
pnpm --filter @relay/ui build   # outputs dist/
```

Production deploy lands in Session 5 (Cloudflare Pages on `relay.averrow.com`).
