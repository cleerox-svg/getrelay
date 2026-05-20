-- One-shot fix: swap Bradey's email from bleerox@gmail.com to
-- bradeyleroux@gmail.com. Idempotent — re-running matches no rows.
--
-- Apply via the Seed contacts workflow:
--   Actions → Seed contacts → Run workflow → file: 0003_rename_bradey_email.sql
--
-- The CASE clause keeps the pending-claim mechanism intact:
--   * If Bradey hasn't signed in yet → google_sub is 'pending:bleerox@gmail.com'
--     and we rewrite it to 'pending:bradeyleroux@gmail.com', so findOrCreateUser
--     will claim the same row when Bradey signs in with the new email.
--   * If he already signed in → google_sub is a real Google id and we leave
--     it alone; just the email field updates.

UPDATE users
SET
  email = 'bradeyleroux@gmail.com',
  google_sub = CASE
    WHEN google_sub = 'pending:bleerox@gmail.com'
      THEN 'pending:bradeyleroux@gmail.com'
    ELSE google_sub
  END
WHERE email = 'bleerox@gmail.com';
