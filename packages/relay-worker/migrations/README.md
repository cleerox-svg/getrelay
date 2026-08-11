# D1 migrations

One-shot SQL scripts applied manually against the live D1 database. Schema
itself lives in `../src/schema.sql` and is applied on every worker deploy.

| File | Purpose | Apply via |
|---|---|---|
| `0001_add_is_admin.sql` | (Applied automatically by `deploy-worker.yml`'s probe step) | n/a |
| `0002_seed_contacts.sql` | Pre-create four placeholder users as contacts of `cleerox@gmail.com`. Idempotent. | `gh workflow run "Seed contacts"` or the **Seed contacts** workflow in the Actions tab |
| `0003_rename_bradey_email.sql` | One-shot email swap for one of the seeded contacts. Idempotent. | Same as above, with `file: 0003_rename_bradey_email.sql` |
| `0004_clean_defunct_sports_subs.sql` | DELETE `user_sports_subs` rows for teams not in the current active 32-NHL / 30-MLB set. Cleans up orphan subs left behind by the pre-PR-#81 picker bug. Idempotent. | Same as above, with `file: 0004_clean_defunct_sports_subs.sql` |
| `0005_native_push_tokens.sql` | Create `native_push_tokens` for FCM device tokens registered by the Capacitor Android/iOS apps (no Web Push in a WebView). Idempotent. | Same as above, with `file: 0005_native_push_tokens.sql` |
| `0006_game_scores.sql` | Create `game_scores` for the Fog mini game (one row per completed game; contact-scoped leaderboards computed as MAX(score) per user over a time window). Idempotent. | Same as above, with `file: 0006_game_scores.sql` |
| `0007_golf_records.sql` | Create `golf_records` for the in-app golf Course game (one row per user holding personal-best longest drive / closest-to-pin / longest putt; worker upserts a column only when the new value beats the stored one). Idempotent. | Same as above, with `file: 0007_golf_records.sql` |
| `0010_chat_keys.sql` | Create `chat_keys` for envelope encryption of message bodies at rest (one row per chat holding the chat's DEK wrapped under the root KEK, plus the wrap IV and KEK version). Idempotent. | Same as above, with `file: 0010_chat_keys.sql` |

## Columns are added by the deploy probe, not by a numbered file

`ALTER TABLE ... ADD COLUMN` has no `IF NOT EXISTS` form in SQLite, so a
numbered migration that adds a column is not idempotent — and
`test:migrations` applies `schema.sql` first and then every migration in
order, so such a file fails with `duplicate column name` on the very
check that is supposed to guard it.

New columns therefore go in **two** places: `src/schema.sql` (for fresh
databases) and a `pragma_table_info` probe block in
`.github/workflows/deploy-worker.yml` (for the live one). That's how
`is_admin`, `sports_notifications`, the `sports_notify_*` trio,
`game_feed_shared`, and `status_updated_at` all landed. Numbered
migration files remain the right tool for everything that *can* be
written idempotently: `CREATE TABLE IF NOT EXISTS`,
`CREATE INDEX IF NOT EXISTS`, and data backfills.

## How the pending-user claim works

`0002_seed_contacts.sql` inserts rows with `google_sub = 'pending:<email>'`.
The `findOrCreateUser` function in `src/auth.ts` looks up by `google_sub`
first; if there's no match, it falls back to matching `email` where
`google_sub LIKE 'pending:%'` and overwrites the `google_sub` with the real
one on first sign-in. The PIN, display name, and mutual contact rows
survive the transition.

## D1 rules for migration authors

Before writing a new migration, read this. Two production rollbacks
(PR #75, #76) traced back to assumptions about SQLite that don't hold
on Cloudflare D1.

### Don't use explicit transactions

```sql
-- NO. D1 rejects this outright:
BEGIN TRANSACTION;
-- ... statements ...
COMMIT;
```

`wrangler d1 execute --file` already wraps the whole file in its own
coordinated transaction with automatic rollback on failure. User-level
`BEGIN TRANSACTION`, `COMMIT`, `ROLLBACK`, and `SAVEPOINT` are forbidden.

### Don't use `PRAGMA foreign_keys = ON/OFF`

```sql
-- NO. D1 doesn't honour this across statements.
PRAGMA foreign_keys = OFF;
-- ... rebuild ...
PRAGMA foreign_keys = ON;
```

D1 enforces foreign keys per-statement; the pragma doesn't span the
import. For table rebuilds that need to drop a referenced table, use:

```sql
PRAGMA defer_foreign_keys = ON;
```

which defers FK checks until commit time and is honoured inside D1's
implicit transaction. It is **not** enough by itself if a child table
has `ON DELETE CASCADE` — the cascade fires on `DROP TABLE parent` and
will silently delete the child rows. The fix in that case is to stash
and restore:

```sql
PRAGMA defer_foreign_keys = ON;

CREATE TABLE _stash_reactions AS SELECT * FROM message_reactions;
DELETE FROM message_reactions;

-- ... drop + rebuild + rename the parent table ...

INSERT INTO message_reactions (message_id, user_id, emoji, created_at)
  SELECT message_id, user_id, emoji, created_at FROM _stash_reactions;
DROP TABLE _stash_reactions;
```

### When changing a CHECK constraint, ask first if you actually need to

We tried twice to add `'sticker'` to `messages.message_type`'s CHECK list.
Both attempts hit the rules above and rolled back in prod. The third PR
(#77) sidestepped the migration entirely by encoding stickers as
`type='image'` with a URL-pattern discriminator on the client. A
schema-free approach is often safer than a SQLite table rebuild for an
enum-style addition; consider that path before reaching for a migration.

If you still need to change a CHECK, the canonical SQLite recipe
(create new table, copy data, drop old, rename, recreate indexes) works
on D1 *only* if you follow the rules above (no `BEGIN TRANSACTION`, use
`defer_foreign_keys`, stash-and-restore child rows that CASCADE).

## Pre-commit checks

Two scripts under `../scripts/` guard against the failure modes above.
Both run automatically on PRs that touch `migrations/`, `schema.sql`, or
the scripts themselves (see `.github/workflows/test-migrations.yml`).

### Lint

```sh
pnpm --filter @relay/worker lint:migrations
```

Statically scans every `.sql` file under `migrations/` for the
D1-rejected patterns above (`BEGIN TRANSACTION`, `COMMIT`, `SAVEPOINT`,
`PRAGMA foreign_keys`, `ATTACH`). Comments are stripped before scanning
so an explanatory `-- BEGIN TRANSACTION won't work here` doesn't false-
positive. Exits non-zero on any match with a remediation message.

### Apply + assert

```sh
pnpm --filter @relay/worker test:migrations
```

Spins up a fresh local D1 (`wrangler d1 execute --local --persist-to`
against a tmp dir), applies `src/schema.sql`, seeds two users, a chat,
a message, a receipt, **and a `message_reactions` row referencing the
message**, then applies every migration in order. After all migrations
run, it asserts:

- The seeded message still exists
- The seeded receipt row still exists
- The seeded `message_reactions` row still exists with the same emoji

That `message_reactions` assertion is what catches `ON DELETE CASCADE`
silently dropping child rows during a table rebuild — the v2 sticker
migration would have failed this assertion if it had been run before
deploy. (It also fails with `FOREIGN KEY constraint failed` on this
version of wrangler, which is even louder.)

## Applying a migration to prod

Same workflow as before. Push the file to `main`, then:

```sh
gh workflow run "Seed contacts" -F file=0004_my_migration.sql
```

The "Seed contacts" workflow is misleadingly named — it's a generic
one-shot SQL applier; the seeding was just the first thing we used it
for. Once we have more than two non-seed migrations it's worth renaming.
