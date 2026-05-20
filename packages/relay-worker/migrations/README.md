# D1 migrations

One-shot SQL scripts applied manually against the live D1 database. Schema
itself lives in `../src/schema.sql` and is applied on every worker deploy.

| File | Purpose | Apply via |
|---|---|---|
| `0001_add_is_admin.sql` | (Applied automatically by `deploy-worker.yml`'s probe step) | n/a |
| `0002_seed_contacts.sql` | Pre-create four placeholder users as contacts of `cleerox@gmail.com`. Idempotent. | `gh workflow run "Seed contacts"` or the **Seed contacts** workflow in the Actions tab |

## How the pending-user claim works

`0002_seed_contacts.sql` inserts rows with `google_sub = 'pending:<email>'`.
The `findOrCreateUser` function in `src/auth.ts` looks up by `google_sub`
first; if there's no match, it falls back to matching `email` where
`google_sub LIKE 'pending:%'` and overwrites the `google_sub` with the real
one on first sign-in. The PIN, display name, and mutual contact rows
survive the transition.
