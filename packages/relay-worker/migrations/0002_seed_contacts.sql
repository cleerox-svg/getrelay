-- One-shot seed: pre-create four users as contacts of cleerox@gmail.com.
-- Idempotent — re-runs are no-ops thanks to INSERT OR IGNORE.
--
-- When each of these emails signs in with Google, auth.findOrCreateUser
-- detects the `pending:<email>` google_sub, claims the row by overwriting
-- google_sub with the real one, and the PIN + contact rows survive intact.
--
-- Apply via: gh workflow run "Seed contacts" (workflow_dispatch).

-- 1) Insert placeholder users. UUIDs are deterministic so re-running
--    this script doesn't generate new rows on every apply.
INSERT OR IGNORE INTO users
  (id, google_sub, email, pin, display_name, created_at)
VALUES
  ('8c1f3a5e-9b21-4d40-a8e1-100000000001',
   'pending:mleerox91@gmail.com', 'mleerox91@gmail.com',
   'M7K3P2RT', 'Matthew', unixepoch() * 1000),
  ('8c1f3a5e-9b21-4d40-a8e1-100000000002',
   'pending:dleerox@gmail.com',   'dleerox@gmail.com',
   'D5XQNJ8A', 'Daniel',  unixepoch() * 1000),
  ('8c1f3a5e-9b21-4d40-a8e1-100000000003',
   'pending:jleduc26@gmail.com',  'jleduc26@gmail.com',
   'J9VR4FBN', 'Jewlz',   unixepoch() * 1000),
  ('8c1f3a5e-9b21-4d40-a8e1-100000000004',
   'pending:bleerox@gmail.com',   'bleerox@gmail.com',
   'B3HK7YQX', 'Bradey',  unixepoch() * 1000);

-- 2) Mutual contact rows. SELECT cleerox's id so we don't hard-code it.
INSERT OR IGNORE INTO contacts (owner_id, contact_id, added_at)
SELECT cleerox.id, peer.id, unixepoch() * 1000
FROM users cleerox, users peer
WHERE cleerox.email = 'cleerox@gmail.com'
  AND peer.email IN (
    'mleerox91@gmail.com',
    'dleerox@gmail.com',
    'jleduc26@gmail.com',
    'bleerox@gmail.com'
  );

INSERT OR IGNORE INTO contacts (owner_id, contact_id, added_at)
SELECT peer.id, cleerox.id, unixepoch() * 1000
FROM users cleerox, users peer
WHERE cleerox.email = 'cleerox@gmail.com'
  AND peer.email IN (
    'mleerox91@gmail.com',
    'dleerox@gmail.com',
    'jleduc26@gmail.com',
    'bleerox@gmail.com'
  );

-- 3) Clear any Google-supplied profile picture URLs from existing users so
--    everyone defaults to letter-initials. Users can upload their own via
--    POST /me/avatar (R2-backed). avatar_r2_key is left alone.
UPDATE users SET avatar_url = NULL WHERE avatar_url IS NOT NULL;
