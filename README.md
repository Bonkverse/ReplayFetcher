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
| `scraper_state.position` | `BIGINT` | Survives restarts/redeploys |

**Why BYTEA + gzip instead of storing the original encoded string?**

The original `replaydata` string from the API is:
  `raw PSON binary → base64 (+33%) → LZ-compressed → URI-encoded`

We reverse all of that to get the raw PSON bytes, then gzip them.
Result: **40–60% smaller** than the original string, with full round-trip fidelity.

---

## Resilience

| Scenario | Behaviour |
|----------|-----------|
| bonk.io down / timeout | Exponential back-off: 30s → 1min → 2min … up to 30min |
| Rate-limited (non-success response) | Wait 65 minutes, then retry |
| Caught up (no new replays) | Wait 5 minutes, then check again |
| DB insert failure | Don't advance position — retry same batch next iteration |
| Decode failure on a replay | Log it, skip it, still advance position to avoid infinite loop |
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
[Scraper] Starting from position 12096
[Scraper] Batch: 10 stored. Position → 12106
[Scraper] Batch: 10 stored. Position → 12116
...
[Scraper] Caught up at position 1382000 — waiting 5 min for new replays
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

When Chaz wipes replays and a new cycle begins:

1. Find the first ID of the new cycle (visible in the API response or bonkverse).
2. In Railway → Variables, update `START_POSITION` to that ID.
3. In Railway → Postgres, run:
   ```sql
   UPDATE scraper_state SET position = <new_start_id> WHERE id = 1;
   ```
   (Or just truncate all tables and let the scraper recreate the state row.)
4. Redeploy.

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