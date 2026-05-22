#!/usr/bin/env bash
# Lint migration SQL files for D1-specific gotchas that aren't enforced
# by local SQLite or vanilla SQL parsers — so they only blow up at
# remote-deploy time. Two real production failures motivated this:
#
#   - PR #75: used `BEGIN TRANSACTION; ... COMMIT;` for the canonical
#     SQLite table-rebuild. D1 rejected outright: "please use the
#     state.storage.transaction() ... APIs instead of the SQL
#     BEGIN TRANSACTION or SAVEPOINT statements".
#
#   - PR #76: used `PRAGMA foreign_keys=OFF; ... =ON;` to bracket the
#     rebuild. D1 doesn't honour that pragma the way vanilla SQLite
#     does; the `DROP TABLE messages` step still failed with
#     "FOREIGN KEY constraint failed".
#
# The fix in both cases is `PRAGMA defer_foreign_keys = ON;` at the
# top of the migration, plus stashing-and-restoring referencing rows
# manually when ON DELETE CASCADE would otherwise silently delete
# child rows during the rebuild (see scripts/test-migrations.sh for
# the assertion that catches that).
#
# Run via `pnpm --filter @relay/worker lint:migrations`.

set -euo pipefail
shopt -s nullglob

cd "$(dirname "$0")/../migrations"

fails=0

emit() {
  # Use GitHub Actions error annotations when running in CI so the
  # failure is hyperlinked to the offending file. Falls back to
  # plain text locally.
  local file="$1"
  local line="$2"
  local msg="$3"
  if [ "${GITHUB_ACTIONS:-}" = "true" ]; then
    echo "::error file=packages/relay-worker/migrations/${file},line=${line}::${msg}"
  else
    echo "FAIL ${file}:${line}: ${msg}" >&2
  fi
  fails=$((fails + 1))
}

# Each rule is an extended-regex pattern + a remediation message.
# Patterns operate on a single line with comments stripped. Anchored
# loosely so they catch leading whitespace but not the same keyword
# appearing inside a string literal — good enough for migrations,
# where statements live one per line and string literals don't tend
# to contain SQL keywords.
check_line() {
  local file="$1"
  local line_no="$2"
  local raw="$3"
  # Strip -- comments so a literal "BEGIN TRANSACTION" inside an
  # explanatory comment doesn't trigger.
  local code="${raw%%--*}"

  if [[ "$code" =~ (^|[[:space:]])BEGIN[[:space:]]+(TRANSACTION|DEFERRED|IMMEDIATE|EXCLUSIVE)([[:space:]]|;|$) ]]; then
    emit "$file" "$line_no" "D1 rejects explicit transactions in user SQL ('BEGIN TRANSACTION'). \`wrangler d1 execute --file\` already wraps the whole file in its own coordinated transaction with automatic rollback. Drop the BEGIN/COMMIT; if you need to defer FK checks across statements use 'PRAGMA defer_foreign_keys = ON' at the top."
  fi

  if [[ "$code" =~ (^|[[:space:]])COMMIT([[:space:]]|;|$) ]]; then
    emit "$file" "$line_no" "D1 rejects explicit COMMIT in user SQL. Drop it; the implicit transaction commits on file end."
  fi

  if [[ "$code" =~ (^|[[:space:]])ROLLBACK([[:space:]]|;|$) ]]; then
    emit "$file" "$line_no" "D1 rejects explicit ROLLBACK in user SQL. On failure the import-level transaction rolls back automatically."
  fi

  if [[ "$code" =~ (^|[[:space:]])SAVEPOINT[[:space:]] ]]; then
    emit "$file" "$line_no" "D1 rejects SAVEPOINT in user SQL."
  fi

  if [[ "$code" =~ PRAGMA[[:space:]]+foreign_keys[[:space:]]*= ]]; then
    emit "$file" "$line_no" "D1 doesn't honour 'PRAGMA foreign_keys = ON/OFF' across statements the way vanilla SQLite does. For table rebuilds use 'PRAGMA defer_foreign_keys = ON' (per-transaction, deferred to commit) plus a stash-and-restore of any tables with ON DELETE CASCADE FKs into the rebuilt table — otherwise the CASCADE fires during DROP TABLE and silently deletes child rows."
  fi

  if [[ "$code" =~ (^|[[:space:]])ATTACH[[:space:]] ]]; then
    emit "$file" "$line_no" "D1 rejects ATTACH DATABASE in user SQL."
  fi
}

for f in *.sql; do
  line_no=0
  while IFS= read -r line || [ -n "$line" ]; do
    line_no=$((line_no + 1))
    check_line "$f" "$line_no" "$line"
  done < "$f"
done

if [ "$fails" -gt 0 ]; then
  echo "" >&2
  echo "Found $fails D1 migration lint issue(s)." >&2
  echo "See packages/relay-worker/scripts/lint-migrations.sh for the rules and the production failures that motivated each." >&2
  exit 1
fi

echo "All migrations pass D1 lint checks."
