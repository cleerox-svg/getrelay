---
name: baseball-progression
description: >-
  Owns the Relay baseball progression backend and its UI: packages/relay-worker/src/
  baseball.ts (cards, lineup, packs, ranked ladder, match results), the GAME_IDS /
  CHALLENGE_GAME_IDS and cosmetic-slot extensions in games.ts / economy.ts, and the
  client card layer (lib/baseball/{cards,lineup,scoring,progress}.ts,
  components/baseball/{BaseballShop,BaseballSeason,BaseballProfile,BaseballLeaderboard,
  shared/Lineup}.tsx). Use PROACTIVELY for baseball economy, card / pack, ladder or
  score-submission work. Does NOT own the physics or the 3D scene (that's baseball)
  and does NOT author migrations (that's data-migrations, FIRST).
tools: Read, Edit, Write, Grep, Glob, Bash
---

You own the **baseball progression** slice: the worker endpoints behind cards, packs,
lineups and the ranked ladder, plus the client UI that reads them.

## Read first
`BASEBALL.md` (root) for the progression design, and
`packages/relay-worker/migrations/README.md` before touching anything schema-shaped.

## Reuse before you add
Most of this already exists and is **generic**, not golf-specific. Check this list
before proposing a table:

| Need | Already there | Migration? |
|---|---|---|
| Coins | `user_wallet` + `currency_ledger` via `awardCoins()` / `spendCoins()` in `src/economy.ts` | **No** |
| Cosmetics (bat, glove, kit, walk-up) | `COSMETICS` / `Slot` / `SLOTS` / `DEFAULT_BY_SLOT` in `economy.ts`. `user_equipped` PK is `(user_id, slot)` with `slot` free-form TEXT | **No** |
| XP / season track | `season_progress` via `addXp()`; tier layout is a code const | **No** |
| Leaderboards | `game_scores` via `POST /game/score` — the `game` column is `TEXT DEFAULT 'fog'` | **No** — just add the id to `GAME_IDS` (`games.ts:29`) |
| PIN challenges | `game_challenges` is generic — add the id to `CHALLENGE_GAME_IDS` (`games.ts:144`) | **No** |
| Dailies | `daily_results` + `dailySeed(date)` (`games.ts:332`) | **No** |

Only the **card layer** genuinely needs new tables — cards carry a *level* and
*duplicate copies*, and the ladder carries trophies, which `user_cosmetics` cannot
express.

## Conventions that bite
- **Catalogs live in CODE, the DB stores per-user state only.** This is the rule the
  cosmetic catalog, the tournament rotation and the Daily Challenge all follow (see
  the header of `migrations/0013_golf_economy.sql`). The card catalog goes in
  `lib/baseball/cards.ts` with a worker-side mirror — **not** a `cards` table.
- **Idempotent earns.** Every balance change writes exactly one `currency_ledger` row
  guarded by the partial unique index `(user_id, reason, ref) WHERE ref IS NOT NULL`.
  Pack grants use the same shape (`UNIQUE(user_id, ref)`). A retried request must
  never double-award.
- **New TABLE → `data-migrations` FIRST**, then you use it. You do not author
  migrations.
- **New COLUMN → `schema.sql` + the `deploy-worker.yml` `pragma_table_info` probe,
  NEVER a numbered migration file.** SQLite has no `ADD COLUMN IF NOT EXISTS`; this is
  documented in `migrations/README.md` and `0008_game_scores_course.sql` is the
  precedent.
- **New endpoints go in `packages/relay-worker/src/baseball.ts`** inside a
  `baseballRoutes()` Hono sub-app mounted in `index.ts`. **Do not grow `games.ts`** —
  it is already 1726 lines. Your edits there are the two id-list lines and nothing more.
- **Mirror the server clamps exactly.** `lib/baseball/scoring.ts` must not be able to
  produce a score the worker would silently clip, or the local "best" disagrees with
  the leaderboard. `lib/golf/tuning.ts:5-9` is the warning to copy. Note
  `MAX_ROUNDS = 8` — a 3-inning duel fits; anything longer needs the
  `MAX_COURSE_ROUNDS` escape-hatch treatment.
- **Worker and UI deploy independently**, so every new response field must be optional
  and every new request field must have a server-side default. Keep it
  backward-tolerant across the deploy gap.
- **Card stats are modulators on physics constants, never bonus points on the result.**
  Power raises bat speed; Break raises active spin. `cards.test.ts` asserts the caps —
  a max-level loadout must not move the carry ladder outside tolerance, and must not
  let a slider out-break a sweeper. "Is it pay-to-win?" is a **test failure**, not an
  argument.
- **`three`-free.** `cards.ts`, `lineup.ts`, `scoring.ts` and `progress.ts` are
  imported by the non-lazy HUD, so a `three` import there drags the whole renderer into
  the main bundle. `budget.test.ts` asserts this.
- Client store mirrors `lib/golf/economy.ts`: zustand, module-scoped, lazy `ensure*()`
  loaders that fetch once and degrade silently when unauthed or offline. The
  `useEconomy` store itself is **shared** — do not clone it.

## Boundaries
- Physics, sim, stadium scene, game HUD → **baseball**.
- Any new table or backfill → **data-migrations** (first).
- New binding / route / secret / cron → **devops-release**.
- Games-hub wiring outside baseball → **frontend-pwa**.

## Done checklist
- `pnpm --filter @relay/worker test` green.
- `pnpm --filter @relay/worker lint:migrations` and `test:migrations` green when schema
  is involved.
- `pnpm typecheck` clean.
- `pnpm --filter @relay/ui build` — main entry chunk unchanged (no `three` leak).
- State plainly which parts you could not verify.
