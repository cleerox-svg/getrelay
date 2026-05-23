# Sports

Per-user feed of NHL + MLB game cards on the **Sports** tab, plus a per-game
drill-down detail page. Pushes notifications on goal / score / final to users
who follow the relevant team. Backed entirely by free public league APIs —
no third-party data provider.

This doc tracks the data model, upstream endpoints, caching, and what each
field on a card means. The implementation lives in
`packages/relay-worker/src/sports.ts` and the matching client code is in
`packages/relay-ui/src/{routes/Sports.tsx,routes/SportsDetail.tsx,components/SportsCard.tsx,lib/store.ts}`.

## User-visible surfaces

| Surface | Purpose |
|---|---|
| `/sports` tab | Chronological feed of every followed team's current + previous game. Cards are sortable across teams: live → upcoming today → finished today → previous-day finals. |
| `/sports/:league/:id` | Detail page: scoreboard, linescore, scoring plays, three stars (NHL), per-team box scores. |
| `/settings/sports` | Manage followed teams and per-event push toggles (start, score, final). |
| Bottom-nav badge | Red dot on the Sports tab when any followed team has a live game. |
| Web Push | Goal / score / final notifications. Per-event opt-out. |

## Upstream APIs

Each upstream call sets `cf: { cacheTtl }` so the Cloudflare edge caches the
response across Worker invocations. Live data has short TTLs; static-ish
data (rosters, standings) has long TTLs.

### NHL — `api-web.nhle.com`

| Endpoint | Used for | Edge TTL |
|---|---|---|
| `/v1/club-schedule/{abbr}/week/now` | Today's matchup, start time, venue, TV broadcasts | 30s |
| `/v1/club-schedule-season/{abbr}/now` | Most-recent-final lookup ("previous" card) | 5min |
| `/v1/gamecenter/{id}/boxscore` | Live score / period / clock overlay on the list card | 10s |
| `/v1/gamecenter/{id}/landing` | Canonical live state + series status; full detail page (linescore, scoring summary, three stars, box score) | 30s |
| `/v1/standings/now` | Season W-L-OTL records per team (also: list of active franchises for the team picker) | 5min |

### MLB — `statsapi.mlb.com`

| Endpoint | Used for | Edge TTL |
|---|---|---|
| `/api/v1/schedule?hydrate=linescore,team(record),venue,seriesStatus,broadcasts(all)` | List card (matchup, inning/outs, records, broadcasts, postseason series) | 30s today / 5min previous |
| `/api/v1/game/{pk}/linescore` | Live overlay (inning, outs, runs) for the list card | 10s |
| `/api/v1.1/game/{pk}/feed/live` | Full detail page (gumbo feed — linescore, scoring plays, box) | 30s |
| `/api/v1/teams?sportId=1` | Team picker list | 24h |

## Worker endpoints

| Route | Returns |
|---|---|
| `GET /sports` | `{ games: SportsGame[], subs: SportsSub[] }` — flat today list plus per-team current + previous. Per-user cached for 5min when no live games; bypassed during live play. |
| `GET /sports/teams?v=2` | Selectable teams per league (cached 24h). |
| `GET /sports/nhl/:id?abbr=XXX` | `SportsGameDetail`. Bypasses our cache on live games. |
| `GET /sports/mlb/:id?teamId=N` | `SportsGameDetail`. Bypasses our cache on live games. |

## Data shape (selected fields)

```ts
SportsTeam {
  abbr        // "MTL"
  name        // "Montréal Canadiens"
  logo        // CDN URL or null
  score       // null pre-game; number live / final
  record      // "48-24-10" (NHL W-L-OTL) | "29-22" (MLB W-L) | null
}

SportsGame {
  league      // "NHL" | "MLB"
  status      // "pre" | "live" | "final"
  statusDetail // "7:00 PM ET" | "Bot 8th · 2 outs" | "P2 12:34" | "Final"
  startTime   // ms epoch
  homeTeam, awayTeam
  venue       // arena/stadium name
  ourSide     // "home" | "away" — which side the viewer's followed team is on
  series      // playoffs only: round, "Game N of 7", natural-language seriesLabel
  broadcast   // "SN" | "TBS, MLBN" | null
}
```

## Why the list and detail can disagree

Two separate upstream feeds back the same numbers:

- **List card** uses MLB's lightweight `/game/{pk}/linescore` and NHL's
  `/gamecenter/{id}/boxscore`. Both have been observed to lag actual game
  state by minutes (especially the NHL boxscore around pre→live transitions).
- **Detail page** uses MLB's `/v1.1/game/{pk}/feed/live` (gumbo) and NHL's
  `/gamecenter/{id}/landing`. These are the canonical real-time sources.

To bridge the gap, the client store (`lib/store.ts:loadSports`) re-fetches
the per-game detail for every non-final game in the list and overlays
`status`, `statusDetail`, `score`, and `series` onto the list snapshot. That's
why every poll tick fans out to detail fetches for live and pregame matchups.

## Polling

Both the Sports tab and the detail page poll on a `setTimeout` cadence:
**30s when any game is live, 5min otherwise.** Mobile browsers throttle
`setTimeout` while the PWA is backgrounded, so both pollers subscribe to
`visibilitychange` + `online` and force-refresh on resume.

## Series labels

Postseason cards split the series treatment into two pieces so the
context reads at a glance and the human sentence reads cleanly:

1. **Top bar** — a colored round chip + `GAME N OF M` tag, rendered
   between the league header and the matchup. Mirrors how dedicated
   sports apps frame postseason cards ("ROUND 3 · GAME 2").
2. **Bottom line** — natural-language series state below the matchup,
   e.g. `Montreal up 1 game to 0 over Carolina`. Built by
   `buildSeries()` in the worker; consumes home/away full team names
   so the label uses team names rather than abbreviations.

Series is fetched for any game with an NHL gameId or MLB postseason
gameType — the `gameType === 3` gate was dropped because the schedule's
`gameType` field has been observed missing on some late-round playoff
entries. The detail page wears the same split layout.

### Pregame detail layout

When `status === 'pre'`, the detail page hides the score lockup (which
would otherwise render as "AWAY – at – HOME" with stray em-dashes) and
shows a centered `AWAY vs HOME` with a `Sat · 7:00 PM ET`-style line
underneath. Live and final games keep the score lockup as-is.

## Starting goalies (NHL pregame)

The NHL detail page surfaces a "Starting Goalies" card between the
header and the linescore, pulled from `landing.matchup.goalieComparison`
on `/v1/gamecenter/{id}/landing`. Worker exposes one probable starter
per side (the row marked `starter: true` if any, else the first listed —
NHL orders them likely → backup) with their season-to-date stats:

| Field | Source | Notes |
|---|---|---|
| `name` | goalie's `name.default` (falls back to `firstName + lastName`) | |
| `starter` | `starter === true` | Renders a "Likely" pill |
| `wins / losses / otLosses / shutouts` | matching numeric fields | Each independently nullable for short-season backups |
| `gaa` | `goalsAgainstAverage` | Formatted to two decimals |
| `savePct` | `savePercentage` (0–1) | Formatted ".932" — NHL convention, no leading zero |

The list is only filled while `matchup.goalieComparison` is present,
which is the pregame window. Once the puck drops the boxscore's
`playerByGameStats.goalies` takes over and the section disappears.

## Recent matchups (head-to-head)

The detail page surfaces the last five completed games between the
two teams currently on the card, rendered as a compact list with
"AWAY @ HOME · away-home" rows and the winning side bolded.

- **NHL**: filter `/v1/club-schedule-season/{homeAbbr}/now` for
  finals where the opposing team is `awayAbbr` (or vice versa). The
  same upstream is already CF-cached at 5 min from the "previous
  game" list-card lookup, so the detail page reads warm.
- **MLB**: `statsapi.mlb.com/api/v1/schedule?teamId=&opponentId=`
  does the filter server-side — we just keep the most recent
  finals from the last ~18 months window.

Renders nothing when there are no qualifying finals (e.g. first
matchup of the season).

## Team comparison stats (NHL)

The NHL detail page surfaces a "Team Stats" card with four
side-by-side comparison bars — goals per game, goals against per
game, power play %, penalty kill %. Postseason values are shown
when the matchup has a series attached (i.e. the same playoff
gating we use for the series header); otherwise the section reads
"Team Stats — Regular Season".

Data source: `https://api.nhle.com/stats/rest/en/team/summary?cayenneExp=seasonId={season} and gameTypeId={2|3}`.
One fetch returns all 32 teams' rows; the worker matches the
matchup's home / away teams by `teamId` (read from the landing
response) to dodge place-name encoding gotchas like "Montréal" vs
"Montreal". CF-cached at 10 min.

`gameTypeId`: 2 for regular season, 3 for postseason. The current
NHL season is derived from the wall clock — months 10–12 belong to
the season starting that year, months 1–9 to the season that
started the prior October.

The section is hidden when both teams' rows are missing (e.g.
asking for postseason stats on two teams that didn't make the
playoffs). Individual values render `—` when omitted.

## Team leaders (NHL)

Alongside the comparison bars, the NHL detail page surfaces a
"Team Leaders" card with per-team **points / goals / assists**
leaders. Same `period` field — postseason when the matchup has a
series, regular season otherwise.

Data source: `https://api-web.nhle.com/v1/club-stats-season/{abbr}/{seasonId}/{gameTypeId}` —
one fetch per side. The skaters array is iterated locally to pick
the top in each category (so the points leader and the goals leader
can differ, mirroring how dedicated apps surface this). Names are
preformatted to "F. Lastname" by the worker. Both fetches are
CF-cached at 10 min.

A leader is only emitted when at least one skater has a positive
value in that stat — keeps the card from displaying "Leader:
nobody, 0 goals" for a team with zero appearances. Rows where
neither side has a leader are hidden; the whole card disappears
when neither team has any leaders at all.

## Push notifications

Driven by `runSportsCron(env)` which fires every minute (Worker
`scheduled` handler). For each `(league, team)` followed by at least one
user, it fetches the current game and compares it to the last-seen state
in the `kv_state` D1 table. Changes (pre → live, score delta, status → final)
queue a push to every subscriber with the matching per-event toggle on.

| Toggle | Trigger |
|---|---|
| `sports_notify_start` | `status` flips from `pre` → `live` |
| `sports_notify_score` | Either team's score increases |
| `sports_notify_final` | `status` flips to `final` |

The master `sports_notifications` switch on the user row gates all three.
