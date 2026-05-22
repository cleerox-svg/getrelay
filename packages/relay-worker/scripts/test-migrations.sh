#!/usr/bin/env bash
# Apply schema + every migration to a fresh local D1 with realistic
# seed data, then assert no data was silently lost. Complements
# scripts/lint-migrations.sh, which catches D1-rejected syntax patterns
# statically; this script catches the *semantic* class of failure
# (FK CASCADE during DROP TABLE, mis-mapped INSERT...SELECT columns,
# etc) that the lint can't see.
#
# The motivating bug was PR #76's table-rebuild migration: it ran
# clean against `wrangler d1 execute --local` because local SQLite
# doesn't enforce FK constraints the way remote D1 does — but it
# silently dropped every row in message_reactions via ON DELETE
# CASCADE when DROP TABLE messages fired. Asserting that a seeded
# message_reactions row survives the migration catches that.
#
# Run via `pnpm --filter @relay/worker test:migrations`.

set -euo pipefail

cd "$(dirname "$0")/.."

# Fresh persistence dir per run so we never re-use state from a
# previous test (which would mask migrations that aren't idempotent).
DB_DIR="$(mktemp -d -t relay-d1-test-XXXXXX)"
trap "rm -rf $DB_DIR" EXIT

W=(pnpm exec wrangler d1 execute relay-db --local --persist-to "$DB_DIR")

# Helper: run a sql command, fail loudly if wrangler does.
run_sql() {
  if ! "${W[@]}" --command "$1" > /dev/null 2>&1; then
    echo "FAIL: SQL command errored:" >&2
    echo "$1" >&2
    "${W[@]}" --command "$1" >&2 || true
    exit 1
  fi
}

run_file() {
  local f="$1"
  if ! "${W[@]}" --file "$f" > /dev/null 2>&1; then
    echo "FAIL: $f errored on local D1" >&2
    "${W[@]}" --file "$f" >&2 || true
    exit 1
  fi
}

scalar() {
  # Run a `SELECT something AS v ...` and print the value.
  "${W[@]}" --command "$1" --json | jq -r '.[0].results[0].v'
}

assert_eq() {
  local label="$1"
  local expected="$2"
  local got="$3"
  if [ "$got" = "$expected" ]; then
    echo "  pass  $label: $got"
  else
    echo "  FAIL  $label: expected $expected, got $got" >&2
    exit 1
  fi
}

echo "== applying src/schema.sql =="
run_file src/schema.sql

echo "== seeding representative rows =="
# Two users so we can have a sender + a reactor (avoiding the
# UNIQUE PK collision on message_reactions if both were the same user).
# A 1to1 chat for FK satisfaction. A message. A reaction on that
# message — this is the row whose survival catches FK-CASCADE
# data loss during a table rebuild.
run_sql "
INSERT INTO users (id, google_sub, email, pin, display_name, created_at, last_seen_at) VALUES
  ('u_test_a','gs_a','a@test.local','AAAA1111','Tester A',1700000000000,1700000000000),
  ('u_test_b','gs_b','b@test.local','BBBB2222','Tester B',1700000000000,1700000000000);
INSERT INTO chats (id, type, created_by, created_at) VALUES
  ('c_test','1to1','u_test_a',1700000000000);
INSERT INTO chat_participants (chat_id, user_id, joined_at) VALUES
  ('c_test','u_test_a',1700000000000),
  ('c_test','u_test_b',1700000000000);
INSERT INTO messages (id, chat_id, sender_id, sequence, message_type, body, created_at) VALUES
  ('m_test','c_test','u_test_a',1,'text','hello world',1700000000000);
INSERT INTO receipts (message_id, recipient_id, delivered_at, read_at) VALUES
  ('m_test','u_test_b',1700000000001,NULL);
INSERT INTO message_reactions (message_id, user_id, emoji, created_at) VALUES
  ('m_test','u_test_b','👍',1700000000002);
"

echo "== applying migrations in order =="
shopt -s nullglob
migrations=(migrations/*.sql)
if [ ${#migrations[@]} -eq 0 ]; then
  echo "  (no migrations to apply)"
else
  for f in "${migrations[@]}"; do
    run_file "$f"
    echo "  applied $(basename "$f")"
  done
fi

echo "== verifying seeded rows survived =="
assert_eq "messages(m_test) exists" "1" \
  "$(scalar "SELECT COUNT(*) AS v FROM messages WHERE id = 'm_test'")"
assert_eq "message body preserved" "hello world" \
  "$(scalar "SELECT body AS v FROM messages WHERE id = 'm_test'")"
assert_eq "receipts(m_test, u_test_b) exists" "1" \
  "$(scalar "SELECT COUNT(*) AS v FROM receipts WHERE message_id = 'm_test' AND recipient_id = 'u_test_b'")"
assert_eq "message_reactions(m_test, u_test_b, 👍) exists" "1" \
  "$(scalar "SELECT COUNT(*) AS v FROM message_reactions WHERE message_id = 'm_test' AND user_id = 'u_test_b'")"
assert_eq "users count includes seeded" "2" \
  "$(scalar "SELECT COUNT(*) AS v FROM users WHERE id IN ('u_test_a','u_test_b')")"
assert_eq "chat_participants for c_test" "2" \
  "$(scalar "SELECT COUNT(*) AS v FROM chat_participants WHERE chat_id = 'c_test'")"

echo ""
echo "All migrations applied cleanly with no data loss."
