import pg from "pg";
import { config } from "../config.js";
import { distinctAvatars } from "./avatars.js";

// ─── Pool ─────────────────────────────────────────────────────────────────────

const pool = new pg.Pool({
    connectionString: config.databaseUrl,
    keepAlive: true,
    max: 5,
});

pool.on("error", (err) => {
    console.error("[DB] Unexpected pool error:", err.message);
});

// ─── Schema ───────────────────────────────────────────────────────────────────

/**
 * Idempotent migration — safe to call on every startup.
 *
 * Key design decisions
 * ────────────────────
 * replays PK = (cycle, id)
 *   Replay IDs reset to 1 at the start of every cycle, so id alone is not
 *   globally unique. The composite key lets us keep every historical cycle
 *   in the same table without collisions.
 *
 * replaydata BYTEA
 *   Stored as raw PSON binary, gzip-compressed (see codec.js).
 *   ~40-60% smaller than the original base64/LZString-encoded API string.
 *
 * replay_players FK → (cycle, replay_id)
 *   Matches the composite PK on replays.
 *
 * maps PK = (mapid, version)
 *   A map's geometry can be edited by its author after publishing — bonk.io's
 *   own `dbv` field (found in every replay's startingState.mm) tells us which
 *   version any given replay was actually played on. Keying on (mapid, version)
 *   and never overwriting an existing row means we capture map history
 *   correctly for free, instead of clobbering older geometry with "latest
 *   wins" semantics.
 *
 * scraper_state
 *   Single row (id = 1). Stores both position and cycle so restarts and
 *   redeploys always resume exactly where they left off.
 *
 * replay_participants PK = (cycle, replay_id, slot)
 *   One row per player slot in each replay, with bonk.io's own `guest` flag.
 *   This is the searchable "who played in this replay" index. It replaces
 *   replay_players for search: that table keys on username (collapsing two
 *   same-named players in one replay) and has no guest flag, and its FK to
 *   players forced every guest name into the players identity table.
 *   No FK to players: guests have no stable identity to point at.
 *
 * replay_meta PK = (cycle, replay_id)
 *   Match-level fields (mode, teams, length, player counts) so result pages
 *   can show and filter on them without decoding replays.
 *
 * players / replay_players
 *   Registered accounts only from now on (see participants.js). Existing
 *   guest rows from before this change are left in place; see
 *   scripts/cleanup_guest_players.sql once the backfill has run.
 *
 * backfill_state
 *   Cursor for backfill_participants.js and backfill_avatars.js, kept in
 *   Postgres (not a local file) because Railway containers lose local files
 *   on every redeploy.
 *
 * avatars PK = hash, replay_participants.avatar_hash
 *   The skin each participant wore in that replay, stored once per distinct
 *   skin (see avatars.js for the form and the hash). A player's latest skin
 *   is the avatar_hash of their newest participant row. No FK from
 *   avatar_hash: avatars are inserted first in the same transaction, and a
 *   FK would add a lookup to every one of millions of rows for no gain.
 *   Unlike players.avatars (an unordered set), this says which skin was
 *   worn when.
 */
export async function migrate() {

    // Separate + non-fatal: some managed Postgres users lack CREATE EXTENSION
    // privileges. If it fails, we just skip the trigram index below.
    try {
        await pool.query(`CREATE EXTENSION IF NOT EXISTS pg_trgm;`);
    } catch (err) {
        console.warn("[DB] Could not create pg_trgm extension (non-fatal):", err.message);
    }

    await pool.query(`
        CREATE TABLE IF NOT EXISTS scraper_state (
            id       INT     PRIMARY KEY DEFAULT 1,
            cycle    INT     NOT NULL,
            position BIGINT  NOT NULL
        );

        CREATE TABLE IF NOT EXISTS replays (
            cycle        INT         NOT NULL,
            id           BIGINT      NOT NULL,
            mapid        BIGINT,
            replaydata   BYTEA       NOT NULL,
            fetched_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (cycle, id)
        );

        -- Query replays by cycle efficiently
        CREATE INDEX IF NOT EXISTS idx_replays_cycle
            ON replays (cycle);

        CREATE TABLE IF NOT EXISTS players (
            username   TEXT        PRIMARY KEY,
            level      INT         NOT NULL DEFAULT 0,
            avatars    JSONB       NOT NULL DEFAULT '[]'::jsonb,
            seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        CREATE TABLE IF NOT EXISTS replay_players (
            cycle      INT    NOT NULL,
            replay_id  BIGINT NOT NULL,
            username   TEXT   NOT NULL REFERENCES players(username) ON DELETE CASCADE,
            PRIMARY KEY (cycle, replay_id, username),
            FOREIGN KEY (cycle, replay_id) REFERENCES replays(cycle, id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_replay_players_username
            ON replay_players (username);

        CREATE INDEX IF NOT EXISTS idx_replay_players_cycle
            ON replay_players (cycle);

        -- Versioned map archive. See migrate() doc comment above for why
        -- (mapid, version) is the PK.
        CREATE TABLE IF NOT EXISTS maps (
            mapid       BIGINT      NOT NULL,
            version     INT         NOT NULL,
            name        TEXT,
            author      TEXT,
            author_id   BIGINT,
            published   BOOLEAN,
            votes_up    INT,
            votes_down  INT,
            remix_of    BIGINT,
            mapdata     BYTEA,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            PRIMARY KEY (mapid, version)
        );

        CREATE INDEX IF NOT EXISTS idx_maps_mapid_version
            ON maps (mapid, version DESC);

        CREATE TABLE IF NOT EXISTS replay_participants (
            cycle      INT      NOT NULL,
            replay_id  BIGINT   NOT NULL,
            slot       SMALLINT NOT NULL,
            username   TEXT     NOT NULL,
            guest      BOOLEAN  NOT NULL,
            level      INT      NOT NULL DEFAULT 0,
            team       SMALLINT,
            ping       INT,
            score      INT,
            PRIMARY KEY (cycle, replay_id, slot),
            FOREIGN KEY (cycle, replay_id) REFERENCES replays(cycle, id) ON DELETE CASCADE
        );

        -- Exact, case-insensitive username lookups (registered players)
        CREATE INDEX IF NOT EXISTS idx_rpart_lower_username
            ON replay_participants (lower(username), cycle, replay_id);

        -- Registered-only lookups by exact name (guests excluded)
        CREATE INDEX IF NOT EXISTS idx_rpart_registered_username
            ON replay_participants (username) WHERE NOT guest;

        CREATE TABLE IF NOT EXISTS replay_meta (
            cycle         INT      NOT NULL,
            replay_id     BIGINT   NOT NULL,
            mode          TEXT,
            teams         BOOLEAN,
            quickplay     BOOLEAN,
            win_limit     INT,
            rounds        INT,
            frames        INT,
            map_version   INT,
            player_count  SMALLINT NOT NULL DEFAULT 0,
            guest_count   SMALLINT NOT NULL DEFAULT 0,
            PRIMARY KEY (cycle, replay_id),
            FOREIGN KEY (cycle, replay_id) REFERENCES replays(cycle, id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_replay_meta_mode
            ON replay_meta (mode);

        -- Approximate upload days for replays collected after the fact (the
        -- cycle 5 import and cycle 6's first days). Filled by hand; read by
        -- the replay site. Declared here so the schema is in one place.
        CREATE TABLE IF NOT EXISTS replay_cycle_days (
            cycle     INT    NOT NULL,
            day       DATE   NOT NULL,
            first_id  BIGINT NOT NULL,
            last_id   BIGINT NOT NULL
        );

        CREATE TABLE IF NOT EXISTS backfill_state (
            name        TEXT        PRIMARY KEY,
            cycle       INT         NOT NULL,
            last_id     BIGINT      NOT NULL,
            processed   BIGINT      NOT NULL DEFAULT 0,
            updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
    `);

    // The skin each participant wore (see the migrate() doc comment). Added
    // to the existing table: NULL until written by the scraper or
    // backfill_avatars.js, and for participants whose replay had no avatar.
    await pool.query(`
        CREATE TABLE IF NOT EXISTS avatars (
            hash           TEXT        PRIMARY KEY,
            avatar         JSONB       NOT NULL,
            first_seen_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );

        ALTER TABLE replay_participants
            ADD COLUMN IF NOT EXISTS avatar_hash TEXT;
    `);

    // Live status for the replay site (countdown to the next fetch, "N new
    // replays added"). Columns added to the existing single-row state table.
    await pool.query(`
        ALTER TABLE scraper_state
            ADD COLUMN IF NOT EXISTS status          TEXT,
            ADD COLUMN IF NOT EXISTS next_fetch_at   TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS status_at       TIMESTAMPTZ,
            ADD COLUMN IF NOT EXISTS last_run_added  INT,
            ADD COLUMN IF NOT EXISTS last_run_at     TIMESTAMPTZ;
    `);

    // Separate call: only works if pg_trgm actually installed above.
    try {
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_maps_name_trgm
                ON maps USING gin (name gin_trgm_ops);
        `);
    } catch (err) {
        console.warn("[DB] Could not create trigram index on maps.name (non-fatal):", err.message);
    }

    // Substring ("contains") username search on the replay site.
    try {
        await pool.query(`
            CREATE INDEX IF NOT EXISTS idx_rpart_username_trgm
                ON replay_participants USING gin (lower(username) gin_trgm_ops);
        `);
    } catch (err) {
        console.warn("[DB] Could not create trigram index on replay_participants (non-fatal):", err.message);
    }

    console.log("[DB] Schema up-to-date.");
}

// ─── State ────────────────────────────────────────────────────────────────────

/**
 * Returns { cycle, position }, creating the state row if this is the first run.
 * The seed values come from config (env vars CURRENT_CYCLE / START_POSITION).
 */
export async function getState() {
    const res = await pool.query(
        `INSERT INTO scraper_state (id, cycle, position)
         VALUES (1, $1, $2)
         ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id
         RETURNING cycle, position`,
        [config.currentCycle, config.defaultStartPosition]
    );
    const row = res.rows[0];
    return { cycle: row.cycle, position: Number(row.position) };
}

/**
 * Atomically saves the current cycle + position.
 * Called after every successful batch so the scraper can always resume cleanly.
 */
export async function saveState({ cycle, position }) {
    await pool.query(
        `UPDATE scraper_state SET cycle = $1, position = $2 WHERE id = 1`,
        [cycle, position]
    );
}

/**
 * Transitions to a new cycle.
 * - Increments the cycle number.
 * - Resets position to 1 (new cycle IDs start from the beginning).
 * - Returns the new { cycle, position } state.
 *
 * Existing replay/player data is intentionally preserved — historical cycles
 * are valuable. Only the scraper's cursor resets.
 */
export async function beginNewCycle(currentCycle) {
    const newCycle = currentCycle + 1;
    await pool.query(
        `UPDATE scraper_state SET cycle = $1, position = 1 WHERE id = 1`,
        [newCycle]
    );
    console.log(`[DB] Cycle transition: ${currentCycle} → ${newCycle}`);
    return { cycle: newCycle, position: 1 };
}

// ─── Live status ────────────────────────────────────────────────────────────

/**
 * Records what the scraper is doing and when it will next ask bonk.io for
 * replays, so the replay site can show a countdown. Called right before
 * every wait. Never throws: a status write must not stop the scraper.
 *
 * @param {"caught_up"|"fetching"|"rate_limited"|"retrying"} status
 * @param {number} waitMs  how long until the next fetch
 * @param {{ added: number }|null} finishedRun  set when a fetch run ends
 */
export async function setScraperStatus(status, waitMs, finishedRun = null) {
    try {
        await pool.query(
            `UPDATE scraper_state SET
                 status         = $1,
                 next_fetch_at  = NOW() + ($2::int * INTERVAL '1 millisecond'),
                 status_at      = NOW(),
                 last_run_added = COALESCE($3, last_run_added),
                 last_run_at    = CASE WHEN $3::int IS NULL THEN last_run_at ELSE NOW() END
             WHERE id = 1`,
            [status, Math.round(waitMs), finishedRun ? finishedRun.added : null]
        );
    } catch (err) {
        console.warn("[DB] Could not record scraper status (non-fatal):", err.message);
    }
}

// ─── Replays ─────────────────────────────────────────────────────────────────

/**
 * Bulk-inserts a batch of replays and upserts related players and map
 * metadata in one transaction. If the transaction fails the entire batch is
 * rolled back — the scraper retries from the same position on the next
 * iteration.
 *
 * @param {number} cycle  The current cycle number.
 * @param {Array<{
 *   id: number,
 *   mapid: number|null,
 *   replayBytes: Buffer,
 *   players: Array<{username, level, avatar}>,   // registered accounts only
 *   participants: Array<{slot, username, guest, level, team, ping, score}>,
 *   meta: object|null,                           // see participants.extractMatchMeta
 *   map: {
 *     mapid: number,
 *     version: number,
 *     name: string|null,
 *     author: string|null,
 *     authorId: number|null,
 *     published: boolean|null,
 *     votesUp: number|null,
 *     votesDown: number|null,
 *     remixOf: number|null,
 *     mapBytes: Buffer|null,
 *   } | null
 * }>} docs
 */
export async function insertBatch(cycle, docs) {
    if (docs.length === 0) return;

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        const newlyInserted = [];

        for (const doc of docs) {
            const inserted = await client.query(
                `INSERT INTO replays (cycle, id, mapid, replaydata)
                 VALUES ($1, $2, $3, $4)
                 ON CONFLICT (cycle, id) DO NOTHING
                 RETURNING id`,
                [cycle, doc.id, doc.mapid ?? null, doc.replayBytes]
            );

            // Versioned map upsert — DO NOTHING on conflict since a captured
            // (mapid, version) pair is immutable (see migrate() doc comment).
            if (doc.map?.mapid != null && doc.map?.version != null) {
                const m = doc.map;
                await client.query(
                    `INSERT INTO maps
                        (mapid, version, name, author, author_id, published,
                         votes_up, votes_down, remix_of, mapdata, updated_at)
                     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
                     ON CONFLICT (mapid, version) DO NOTHING`,
                    [
                        m.mapid,
                        m.version,
                        m.name ?? null,
                        m.author ?? null,
                        m.authorId ?? null,
                        m.published ?? null,
                        m.votesUp ?? null,
                        m.votesDown ?? null,
                        m.remixOf ?? null,
                        m.mapBytes ?? null,
                    ]
                );
            }

            if (inserted.rowCount > 0) newlyInserted.push({ ...doc, cycle });

            for (const p of doc.players) {
                if (!p.username) continue;

                // Guard against NaN, not just null/undefined: an unguarded
                // NaN here throws "invalid input syntax for type integer"
                // from Postgres, and since the scraper's own retry-on-
                // failure loop doesn't advance `position` or skip the
                // offending replay, one malformed level would otherwise
                // stall the live scraper on the same batch indefinitely.
                const safeLevel = Number.isFinite(p.level) ? p.level : 0;

                await client.query(
                    `INSERT INTO players (username, level, avatars, seen_at)
                     VALUES ($1, $2, $3::jsonb, NOW())
                     ON CONFLICT (username) DO UPDATE SET
                         level   = GREATEST(players.level, EXCLUDED.level),
                         avatars = (
                             SELECT jsonb_agg(DISTINCT elem)
                             FROM jsonb_array_elements(
                                 players.avatars || EXCLUDED.avatars
                             ) AS elem
                         ),
                         seen_at = NOW()`,
                    [p.username, safeLevel, JSON.stringify([p.avatar])]
                );

                if (inserted.rowCount > 0) {
                    await client.query(
                        `INSERT INTO replay_players (cycle, replay_id, username)
                         VALUES ($1, $2, $3)
                         ON CONFLICT DO NOTHING`,
                        [cycle, doc.id, p.username]
                    );
                }
            }
        }

        await writeParticipantsAndMeta(client, newlyInserted);

        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

// ─── Bulk insert (large one-off migrations/backfills) ─────────────────────────

/**
 * Bulk variant of insertBatch(), built for large one-off migrations (see
 * migrate_mongo_cycle5.js) where the same doc shape needs to go in at far
 * higher volume than the live scraper's fixed 10-per-batch cadence.
 *
 * insertBatch() does one query per player per replay in a loop — fine for 10
 * replays a batch, but at hundreds of thousands of docs the network round
 * trips (not decode, not Postgres itself) become the bottleneck. This uses
 * one multi-row `INSERT ... SELECT * FROM UNNEST(...)` per table per batch —
 * 4 round trips total regardless of batch size, instead of roughly
 * (2 + 2 × avg players per replay) × batch size.
 *
 * Two things this has to do that a naive translation wouldn't:
 *   - Postgres raises "ON CONFLICT DO UPDATE command cannot affect row a
 *     second time" if the same conflict target (e.g. the same username, or
 *     the same mapid+version) appears twice in one multi-row INSERT. Since
 *     the same player or map very likely shows up in many replays within one
 *     batch, players and maps are deduped/merged client-side first so each
 *     appears at most once per statement.
 *   - The original only inserts replay_players rows for replays that were
 *     actually newly inserted (skipping ones ON CONFLICT DO NOTHING already
 *     had). This preserves that by filtering to the ids Postgres actually
 *     returned from the replays insert.
 *
 * NOT used by the live scraper — insertBatch() stays exactly as-is there.
 *
 * Same doc shape as insertBatch(). Returns { replaysInserted } so callers can
 * report an accurate "actually inserted" count rather than "docs attempted"
 * (which ON CONFLICT DO NOTHING can make misleading on a rerun).
 */
export async function insertBatchBulk(cycle, docs) {
    if (docs.length === 0) return { replaysInserted: 0 };

    const client = await pool.connect();
    try {
        await client.query("BEGIN");

        // ── replays ──────────────────────────────────────────────────────
        const replayRes = await client.query(
            `INSERT INTO replays (cycle, id, mapid, replaydata)
             SELECT $1::int, * FROM UNNEST($2::bigint[], $3::bigint[], $4::bytea[])
             ON CONFLICT (cycle, id) DO NOTHING
             RETURNING id`,
            [
                cycle,
                docs.map((d) => d.id),
                docs.map((d) => d.mapid ?? null),
                docs.map((d) => d.replayBytes),
            ]
        );
        const insertedIds = new Set(replayRes.rows.map((r) => Number(r.id)));
        const insertedDocs = docs.filter((d) => insertedIds.has(d.id));

        // ── maps — dedupe by (mapid, version) within this batch ────────────
        const mapByKey = new Map();
        for (const d of docs) {
            if (d.map) mapByKey.set(`${d.map.mapid}:${d.map.version}`, d.map);
        }
        const mapRows = [...mapByKey.values()];

        if (mapRows.length > 0) {
            await client.query(
                `INSERT INTO maps
                    (mapid, version, name, author, author_id, published,
                     votes_up, votes_down, remix_of, mapdata, updated_at)
                 SELECT m.mapid, m.version, m.name, m.author, m.author_id, m.published,
                        m.votes_up, m.votes_down, m.remix_of, m.mapdata, NOW()
                 FROM UNNEST(
                     $1::bigint[], $2::int[], $3::text[], $4::text[], $5::bigint[],
                     $6::boolean[], $7::int[], $8::int[], $9::bigint[], $10::bytea[]
                 ) AS m(mapid, version, name, author, author_id, published,
                        votes_up, votes_down, remix_of, mapdata)
                 ON CONFLICT (mapid, version) DO NOTHING`,
                [
                    mapRows.map((m) => m.mapid),
                    mapRows.map((m) => m.version),
                    mapRows.map((m) => m.name ?? null),
                    mapRows.map((m) => m.author ?? null),
                    mapRows.map((m) => m.authorId ?? null),
                    mapRows.map((m) => m.published ?? null),
                    mapRows.map((m) => m.votesUp ?? null),
                    mapRows.map((m) => m.votesDown ?? null),
                    mapRows.map((m) => m.remixOf ?? null),
                    mapRows.map((m) => m.mapBytes ?? null),
                ]
            );
        }

        // ── players — dedupe + merge (max level, all avatars) by username ──
        // p.level is guarded here, not just trusted from the caller: `?? 0`
        // only catches null/undefined, never NaN, and Math.max() with NaN
        // anywhere in the comparison always returns NaN — so one malformed
        // level would otherwise poison that username's merged value for the
        // whole batch, not just its own row (this is exactly what caused a
        // "invalid input syntax for type integer: NaN" mid-migration).
        const playerByName = new Map();
        for (const d of docs) {
            for (const p of d.players) {
                if (!p.username) continue;
                const safeLevel = Number.isFinite(p.level) ? p.level : 0;
                const existing = playerByName.get(p.username);
                if (!existing) {
                    playerByName.set(p.username, { level: safeLevel, avatars: [p.avatar] });
                } else {
                    existing.level = Math.max(existing.level, safeLevel);
                    existing.avatars.push(p.avatar);
                }
            }
        }
        const playerRows = [...playerByName.entries()];

        if (playerRows.length > 0) {
            await client.query(
                `INSERT INTO players (username, level, avatars, seen_at)
                 SELECT u.username, u.level, u.avatars::jsonb, NOW()
                 FROM UNNEST($1::text[], $2::int[], $3::text[]) AS u(username, level, avatars)
                 ON CONFLICT (username) DO UPDATE SET
                     level   = GREATEST(players.level, EXCLUDED.level),
                     avatars = (
                         SELECT jsonb_agg(DISTINCT elem)
                         FROM jsonb_array_elements(
                             players.avatars || EXCLUDED.avatars
                         ) AS elem
                     ),
                     seen_at = NOW()`,
                [
                    playerRows.map(([username]) => username),
                    playerRows.map(([, v]) => v.level),
                    playerRows.map(([, v]) => JSON.stringify(v.avatars)),
                ]
            );
        }

        // ── replay_players — only for replays actually inserted this run ──
        const rpCycle = [];
        const rpReplayId = [];
        const rpUsername = [];
        for (const d of insertedDocs) {
            for (const p of d.players) {
                if (!p.username) continue;
                rpCycle.push(cycle);
                rpReplayId.push(d.id);
                rpUsername.push(p.username);
            }
        }

        if (rpUsername.length > 0) {
            await client.query(
                `INSERT INTO replay_players (cycle, replay_id, username)
                 SELECT * FROM UNNEST($1::int[], $2::bigint[], $3::text[])
                 ON CONFLICT DO NOTHING`,
                [rpCycle, rpReplayId, rpUsername]
            );
        }

        await writeParticipantsAndMeta(
            client,
            insertedDocs.map((d) => ({ ...d, cycle }))
        );

        await client.query("COMMIT");
        return { replaysInserted: insertedIds.size };
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

// ─── Participants + match metadata ───────────────────────────────────────────

/**
 * Writes replay_participants and replay_meta rows for the given docs inside
 * the caller's transaction. Two multi-row UNNEST inserts regardless of batch
 * size. ON CONFLICT DO NOTHING makes it safe to re-run (backfill restarts,
 * scraper retries).
 *
 * @param {import("pg").PoolClient} client
 * @param {Array<{cycle: number, id: number, participants?: Array, meta?: object|null}>} docs
 */
async function writeParticipantsAndMeta(client, docs) {
    // Skins first, so every avatar_hash below points at a stored avatar.
    await writeAvatars(client, docs.flatMap((d) => d.participants ?? []));

    const c = [], r = [], slot = [], name = [], guest = [], level = [], team = [], ping = [], score = [],
        avatarHash = [];
    for (const d of docs) {
        for (const p of d.participants ?? []) {
            c.push(d.cycle);
            r.push(d.id);
            slot.push(p.slot);
            name.push(p.username);
            guest.push(!!p.guest);
            level.push(p.level ?? 0);
            team.push(p.team ?? null);
            ping.push(p.ping ?? null);
            score.push(p.score ?? null);
            avatarHash.push(p.avatarHash ?? null);
        }
    }

    if (name.length > 0) {
        await client.query(
            `INSERT INTO replay_participants
                (cycle, replay_id, slot, username, guest, level, team, ping, score, avatar_hash)
             SELECT * FROM UNNEST(
                 $1::int[], $2::bigint[], $3::smallint[], $4::text[], $5::boolean[],
                 $6::int[], $7::smallint[], $8::int[], $9::int[], $10::text[]
             )
             ON CONFLICT (cycle, replay_id, slot) DO NOTHING`,
            [c, r, slot, name, guest, level, team, ping, score, avatarHash]
        );
    }

    const metaDocs = docs.filter((d) => d.meta);
    if (metaDocs.length > 0) {
        const m = metaDocs.map((d) => d.meta);
        await client.query(
            `INSERT INTO replay_meta
                (cycle, replay_id, mode, teams, quickplay, win_limit, rounds,
                 frames, map_version, player_count, guest_count)
             SELECT * FROM UNNEST(
                 $1::int[], $2::bigint[], $3::text[], $4::boolean[], $5::boolean[],
                 $6::int[], $7::int[], $8::int[], $9::int[], $10::smallint[], $11::smallint[]
             )
             ON CONFLICT (cycle, replay_id) DO NOTHING`,
            [
                metaDocs.map((d) => d.cycle),
                metaDocs.map((d) => d.id),
                m.map((x) => x.mode ?? null),
                m.map((x) => x.teams ?? null),
                m.map((x) => x.quickplay ?? null),
                m.map((x) => x.winLimit ?? null),
                m.map((x) => x.rounds ?? null),
                m.map((x) => x.frames ?? null),
                m.map((x) => x.mapVersion ?? null),
                m.map((x) => x.playerCount ?? 0),
                m.map((x) => x.guestCount ?? 0),
            ]
        );
    }
}

/**
 * Inserts the distinct avatars among `participants` (avatars.js), skipping
 * ones already stored. One statement per batch.
 */
async function writeAvatars(client, participants) {
    const { hashes, json } = distinctAvatars(participants);
    if (hashes.length === 0) return;
    // Sorted so concurrent writers (scraper + backfill) take row locks in the
    // same order and can't deadlock on the same new avatars.
    const order = hashes.map((_, i) => i).sort((a, b) => (hashes[a] < hashes[b] ? -1 : 1));
    await client.query(
        `INSERT INTO avatars (hash, avatar)
         SELECT * FROM UNNEST($1::text[], $2::jsonb[])
         ON CONFLICT (hash) DO NOTHING`,
        [order.map((i) => hashes[i]), order.map((i) => json[i])]
    );
}

/**
 * Backfill entry point for backfill_avatars.js: stores the avatars of these
 * replays' participants and sets avatar_hash on participant rows that don't
 * have one yet. Rows written by the scraper already have it and are left
 * alone. One transaction per batch.
 *
 * @param {Array<{cycle: number, id: number, participants: Array}>} docs
 * @returns {Promise<number>} participant rows updated
 */
export async function setParticipantAvatars(docs) {
    const rows = docs.flatMap((d) =>
        (d.participants ?? [])
            .filter((p) => p.avatarHash)
            .map((p) => ({ cycle: d.cycle, id: d.id, slot: p.slot, hash: p.avatarHash, p }))
    );
    if (rows.length === 0) return 0;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await writeAvatars(client, rows.map((x) => x.p));
        const res = await client.query(
            `UPDATE replay_participants AS rp
             SET avatar_hash = v.hash
             FROM UNNEST($1::int[], $2::bigint[], $3::smallint[], $4::text[])
                 AS v(cycle, replay_id, slot, hash)
             WHERE rp.cycle = v.cycle AND rp.replay_id = v.replay_id
               AND rp.slot = v.slot AND rp.avatar_hash IS NULL`,
            [
                rows.map((x) => x.cycle),
                rows.map((x) => x.id),
                rows.map((x) => x.slot),
                rows.map((x) => x.hash),
            ]
        );
        await client.query("COMMIT");
        return res.rowCount;
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/**
 * Backfill entry point: participants + meta for replays already in the
 * replays table. One transaction per batch.
 */
export async function insertParticipantsBatch(docs) {
    if (docs.length === 0) return;
    const client = await pool.connect();
    try {
        await client.query("BEGIN");
        await writeParticipantsAndMeta(client, docs);
        await client.query("COMMIT");
    } catch (err) {
        await client.query("ROLLBACK");
        throw err;
    } finally {
        client.release();
    }
}

/** Backfill cursor, stored in Postgres so it survives container restarts. */
export async function getBackfillState(name) {
    const res = await pool.query(
        `SELECT cycle, last_id, processed FROM backfill_state WHERE name = $1`,
        [name]
    );
    if (!res.rows.length) return null;
    const row = res.rows[0];
    return { cycle: row.cycle, lastId: Number(row.last_id), processed: Number(row.processed) };
}

export async function saveBackfillState(name, { cycle, lastId, processed }) {
    await pool.query(
        `INSERT INTO backfill_state (name, cycle, last_id, processed, updated_at)
         VALUES ($1, $2, $3, $4, NOW())
         ON CONFLICT (name) DO UPDATE SET
             cycle = EXCLUDED.cycle, last_id = EXCLUDED.last_id,
             processed = EXCLUDED.processed, updated_at = NOW()`,
        [name, cycle, lastId, processed]
    );
}

export async function clearBackfillState(name) {
    await pool.query(`DELETE FROM backfill_state WHERE name = $1`, [name]);
}

/** Reads one page of replays after (cycle, id), in key order. */
export async function readReplayPage(afterCycle, afterId, limit) {
    const res = await pool.query(
        `SELECT cycle, id, replaydata
         FROM replays
         WHERE (cycle, id) > ($1::int, $2::bigint)
         ORDER BY cycle, id
         LIMIT $3`,
        [afterCycle, afterId, limit]
    );
    return res.rows.map((row) => ({ cycle: row.cycle, id: Number(row.id), replaydata: row.replaydata }));
}

// ─── Teardown ─────────────────────────────────────────────────────────────────

export async function closeDb() {
    await pool.end();
}