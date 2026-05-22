-- One-shot cleanup: delete user_sports_subs rows that reference teams
-- which aren't currently active in their league.
--
-- Why this exists: between v0 launch and PR #81, the team picker on
-- /settings/sports was populated by the NHL stats endpoint
-- (api.nhle.com/stats/rest/en/team), which returns every franchise the
-- NHL has ever recognised — including Atlanta Flames, Atlanta
-- Thrashers, Brooklyn Americans, California Golden Seals, Cleveland
-- Barons, Colorado Rockies, Detroit Cougars, Detroit Falcons, Hartford
-- Whalers, Quebec Nordiques, etc. Any user who tapped one of those
-- "Follow" buttons during that window left an orphan row in
-- user_sports_subs that's now invisible (the picker no longer shows
-- defunct teams, so the row can't be un-followed via the UI) and that
-- will never match a live game (the upstream schedule endpoints don't
-- reference defunct franchises).
--
-- This migration deletes those orphans by allowlisting the *current*
-- active set for each league, computed from the public NHL Web API
-- (api-web.nhle.com/v1/standings/now) and the MLB Stats API
-- (statsapi.mlb.com/api/v1/teams?sportId=1&activeStatus=Y).
--
-- Idempotent: re-running deletes zero additional rows once the set is
-- aligned. Apply via the "Seed contacts" workflow:
--   gh workflow run "Seed contacts" -F file=0004_clean_defunct_sports_subs.sql
--
-- When a franchise relocates or contracts: write a new follow-up
-- migration that adjusts these allowlists, rather than mutating this
-- file in place (so re-applies stay deterministic).

-- NHL — 32 currently-active franchises. Abbreviations match what
-- /v1/standings/now returns under teamAbbrev.default, which is also
-- what fetchNhlTeams() now stores in user_sports_subs.team_key.
-- Includes UTA (Utah Hockey Club, formerly Arizona Coyotes — ARI
-- franchise relocated for the 2024-25 season; ARI is therefore
-- defunct and any ARI sub gets cleaned).
DELETE FROM user_sports_subs
WHERE league = 'NHL'
  AND team_key NOT IN (
    'ANA','BOS','BUF','CAR','CBJ','CGY','CHI','COL',
    'DAL','DET','EDM','FLA','LAK','MIN','MTL','NJD',
    'NSH','NYI','NYR','OTT','PHI','PIT','SEA','SJS',
    'STL','TBL','TOR','UTA','VAN','VGK','WPG','WSH'
  );

-- MLB — 30 currently-active franchises. team_key for MLB is the MLB
-- statsapi team_id (integer rendered as string), not the abbr —
-- because the abbr can collide across leagues (TOR is both a Jay
-- and a Maple Leaf). IDs sourced from
-- statsapi.mlb.com/api/v1/teams?sportId=1&activeStatus=Y.
DELETE FROM user_sports_subs
WHERE league = 'MLB'
  AND team_key NOT IN (
    '108','109','110','111','112','113','114','115',
    '116','117','118','119','120','121','133','134',
    '135','136','137','138','139','140','141','142',
    '143','144','145','146','147','158'
  );
