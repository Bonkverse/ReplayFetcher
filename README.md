# bonk-scraper

A 24/7 Bonk.io replay scraper that stores decoded, compressed replays in Postgres. Built for Railway deployment.

---

## Architecture

```
bonk2.io API  ──fetch──►  api.js        (HTTP, typed result union)
                              │
                              ▼
                          scraper.js    (main loop, backoff, shutdown)
                              │
                    ┌─────────┴──────────┐
                    ▼                    ▼
                codec.js             db.js
          (decode + gzip)      (Postgres pool, schema, upserts)
```

### Storage design

| Field | Type | Notes |
|-------|------|-------|
| `replays.replaydata` | `BYTEA` | Raw PSON binary, gzip-compressed |
| `players.avatars` | `JSONB` | Append-only set, queryable (no order: use `avatars` below for "which skin, when") |
| `avatars` | `hash` → `JSONB` | Each distinct skin once, keyed by a hash ([Skins](#skins)) |
| `replay_participants.avatar_hash` | `TEXT` | The skin that player wore in that replay |
| `replay_players` | join table | Many-to-many, indexed on `username` |
| `scraper_state.position` | `BIGINT` | Highest replay ID stored (the scraper's cursor); on startup the scraper uses `MAX(id)` for the cycle |

**Why BYTEA + gzip instead of storing the original encoded string?**

The original `replaydata` string from the API is:
  `raw PSON binary → base64 (+33%) → LZ-compressed → URI-encoded`

We reverse all of that to get the raw PSON bytes, then gzip them.
Result: **40–60% smaller** than the original string, with full round-trip fidelity.

---

## How the scraper reads bonk.io

bonk.io's `replay_get` returns **up to 10 replays with `id <= startingFrom`, newest first**, and only from about the 1,000 IDs below it. It's not "the next 10 from here". Asking for `308274` returns `308274 … 308265`.

So the scraper keeps a cursor, the highest ID it has stored, and asks for `cursor + 10` to get the IDs just above it. A full window means more may be waiting, so it asks again right away. Otherwise it's caught up and waits 2 minutes. IDs inside a window that weren't there yet are re-checked for 30 minutes. If nothing new turns up for 10 minutes, it looks 500 IDs ahead in case 10+ IDs in a row are missing (see `src/cursor.js`).

Before November 2026 the scraper moved forward by how many replays came back. Whenever more than 10 new replays were waiting, after every rate-limit pause and in busy moments, it only ever got the newest 10. That lost about 56k of cycle 6's 60k missing IDs. `scripts/gap_report.js --recover` fetches them back.

---

## Resilience

| Scenario | Behaviour |
|----------|-----------|
| bonk.io down / timeout | Exponential back-off: 30s → 1min → 2min … up to 30min |
| Rate-limited (non-success response) | Wait 65 minutes, then carry on from the cursor (nothing is skipped) |
| Caught up (no new replays) | Re-check IDs that weren't there yet, wait 2 minutes, check again |
| DB insert failure | Don't advance the cursor — retry the same window next iteration |
| Decode failure on a replay | Log it, skip it, still advance the cursor to avoid an infinite loop |
| SIGINT / SIGTERM | Finish current batch, close DB, exit cleanly |

---

## Railway deployment

### 1. Create a new Railway project

```bash
railway init
```

### 2. Add a Postgres plugin

In the Railway dashboard → **New** → **Database** → **Postgres**.

Railway will inject `DATABASE_URL` into your service automatically.

### 3. Set environment variables

```
START_POSITION=<first replay id of the current cycle, e.g. 12096>
```

(`DATABASE_URL` is injected automatically — you don't need to set it.)

### 4. Deploy

```bash
railway up
```

Or connect your GitHub repo in the Railway dashboard for automatic deploys on push.

### 5. Monitor

Railway's log viewer will show lines like:

```
[DB] Schema up-to-date.
[Scraper] Resuming — cycle 6, from replay 384819
[Scraper] Cycle 6 | 10 stored. Up to replay 384828
[Scraper] Cycle 6 | 7 stored, 1 not there yet (384832). Up to replay 384836
[Scraper] Caught up at cycle 6, replay 384836 — polling every 2 min
[Scraper] Caught 1 late replays: 384832
```

---

## Local development

```bash
cp .env.example .env
# edit .env with your local Postgres credentials

npm install
node --env-file=.env src/index.js
```

---

## Starting a new replay cycle

This is automatic. When Chaz wipes replays, bonk.io starts numbering from 1 again, and the scraper's requests (highest stored + 10) start coming back empty. After 30 minutes with no new replays, it checks for a wipe (at most once every 30 minutes):

1. It asks bonk.io for the newest replay it has stored. In a normal cycle that's always there.
2. If that's gone, it asks for replay 10. If bonk.io is serving replays there, it's alive and on a new cycle.
3. A minute later it checks the newest stored replay once more. Still gone means a wipe: it logs `[Cycle] bonk.io wiped its replays …`, moves to the next cycle and starts from replay 1.

If bonk.io is down or not serving the new cycle's replays yet, it doesn't switch; it checks again 30 minutes later.

To switch by hand (say a new cycle starts far above 1), run this and restart the service. The scraper reads the highest stored ID for the cycle, so `position` is only used while the new cycle is empty:

```sql
UPDATE scraper_state SET cycle = <new cycle>, position = <first ID of the new cycle> WHERE id = 1;
```

---

## Players, guests and slots

Each replay's players are stored in `replay_participants`, one row per slot
(`cycle, replay_id, slot`), with bonk.io's own `guest` flag, level, team,
ping and score. Match-level fields (mode, teams, length, player counts) are
in `replay_meta`. The replay site searches these tables.

Why: registered bonk.io usernames are unique and permanent, but guest names
aren't (anyone can be a guest called "New Player"). The older
`replay_players` table keys on username and has no guest flag, and its
foreign key to `players` pushed every guest name into the `players` table as
if it were an account. Now `players` and `replay_players` only receive
registered accounts.

Scores: `startingState.scores` is indexed by slot in free-for-all and by
team number (red = 2, blue = 3, ...) in team modes.

### Backfilling existing replays (one time)

New replays get participants automatically. For everything collected before,
run the backfill from the service shell (it decodes the stored replays, so
nothing is re-fetched from bonk.io):

```bash
node src/backfill_participants.js --dry-run          # check a sample first
nohup node src/backfill_participants.js > backfill.log 2>&1 &
tail -f backfill.log
```

It saves its position in Postgres after every batch, so if it stops (closed
console, redeploy), run the same command again to continue.

Once it says `Done`, optionally remove old guest-only names from `players`
with `scripts/cleanup_guest_players.sql` (it previews before deleting).

## Skins

The skin each participant wore is in the replay itself
(`playerArray[i].avatar`, `{ layers: [...], bc }`). `src/avatars.js`
normalizes it (known fields only, empty layer slots kept) and hashes a
canonical JSON form; `avatars` stores each distinct skin once and
`replay_participants.avatar_hash` points at it. A few hundred thousand skins
instead of a copy in every one of millions of participant rows.

A player's latest skin is the one on their newest participant row:

```sql
SELECT a.avatar, rp.cycle, rp.replay_id
FROM replay_participants rp
JOIN avatars a ON a.hash = rp.avatar_hash
WHERE lower(rp.username) = lower('SomePlayer') AND NOT rp.guest
ORDER BY rp.cycle DESC, rp.replay_id DESC
LIMIT 1;
```

(`idx_rpart_lower_username` covers it.) New replays get `avatar_hash`
automatically. For replays stored before, run the backfill from the service
shell once (decodes stored replays, nothing re-fetched; resumable like the
participants backfill, cursor `avatars_v1`):

```bash
node src/backfill_avatars.js --dry-run              # check a sample first
nohup node src/backfill_avatars.js > backfill_avatars.log 2>&1 &
tail -f backfill_avatars.log
```

Don't change `normalizeAvatar()` or `canonicalJson()` casually: the hash of
every stored skin depends on them.

`npm test` runs the unit tests (`test/`, no database needed).

## Querying the data

```sql
-- All replays a player appeared in
SELECT r.id, r.mapid, r.fetched_at
FROM replays r
JOIN replay_players rp ON rp.replay_id = r.id
WHERE rp.username = 'SomePlayer'
ORDER BY r.id DESC;

-- Top players by number of replays
SELECT rp.username, COUNT(*) AS replay_count
FROM replay_players rp
GROUP BY rp.username
ORDER BY replay_count DESC
LIMIT 20;

-- Current scrape position
SELECT position FROM scraper_state;
```

---

## File structure

```
src/
  index.js     Entry point, signal handlers
  scraper.js   Main loop — fetch → decode → store → advance
  api.js       bonk.io HTTP client, typed result union
  codec.js     LZString/PSON decode + gzip compress/decompress
  db.js        Postgres pool, migrations, batch upsert
  participants.js  Per-slot players and match metadata from a decoded replay
  avatars.js   Skin form and hash (see Skins)
  backfill_*.js    One-time backfills over stored replays
test/          node --test unit tests
config.js      All constants and env-var reads
railway.toml   Railway build/deploy config
.env.example   Required environment variables
```