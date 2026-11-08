#!/usr/bin/env node
/**
 * One-time backfill: decode every replay already in `replays` and fill
 * replay_participants (one row per slot, with bonk.io's guest flag) and
 * replay_meta (mode, teams, length, player counts).
 *
 * The scraper writes both tables for new replays from now on; this covers
 * everything collected before that, including the cycle 5 import. Nothing
 * needs to be re-fetched from bonk.io: the guest flag, slots and scores are
 * all inside the stored replay data.
 *
 * Safe to stop and re-run at any time:
 *   - every insert is ON CONFLICT DO NOTHING
 *   - the cursor is saved in Postgres (backfill_state) after every batch, so
 *     a redeploy or a closed console doesn't lose progress
 *
 * Usage (from the replay service's shell, in /app):
 *   node src/backfill_participants.js                  resume or start
 *   node src/backfill_participants.js --dry-run        decode a sample, write nothing
 *   node src/backfill_participants.js --batch-size=500
 *   node src/backfill_participants.js --fresh          ignore the saved cursor
 *
 * Long run: about a million replays. Run it in the background so a closed
 * console doesn't stop it:
 *   nohup node src/backfill_participants.js > backfill.log 2>&1 &
 *   tail -f backfill.log
 */

import {
    migrate, closeDb, insertParticipantsBatch, readReplayPage,
    getBackfillState, saveBackfillState, clearBackfillState,
} from "./db.js";
import { decodeStoredReplay } from "./codec.js";
import { extractParticipants, extractMatchMeta } from "./participants.js";

const NAME = "participants_v1";

const args = process.argv.slice(2);
const flag = (name, def) => {
    const hit = args.find((a) => a.startsWith(`--${name}=`));
    return hit ? hit.split("=")[1] : def;
};
const BATCH_SIZE = parseInt(flag("batch-size", "400"), 10);
const FRESH = args.includes("--fresh");
const DRY_RUN = args.includes("--dry-run");

let stopping = false;
process.on("SIGINT", () => {
    console.log("\n[Backfill] Stopping after the current batch…");
    stopping = true;
});
process.on("SIGTERM", () => { stopping = true; });

async function decodeRows(rows) {
    const docs = [];
    let failed = 0;
    await Promise.all(
        rows.map(async (row) => {
            try {
                const decoded = await decodeStoredReplay(row.replaydata);
                docs.push({
                    cycle: row.cycle,
                    id: row.id,
                    participants: extractParticipants(decoded),
                    meta: extractMatchMeta(decoded),
                });
            } catch {
                failed++;
            }
        })
    );
    return { docs, failed };
}

async function dryRun() {
    const rows = await readReplayPage(0, 0, 300);
    const { docs, failed } = await decodeRows(rows);
    const all = docs.flatMap((d) => d.participants);
    const guests = all.filter((p) => p.guest);
    const level0Registered = all.filter((p) => !p.guest && p.level === 0).length;
    const guestAboveLevel0 = guests.filter((p) => p.level > 0).length;
    const modes = {};
    for (const d of docs) modes[d.meta.mode ?? "?"] = (modes[d.meta.mode ?? "?"] ?? 0) + 1;

    console.log(`[Dry run] ${rows.length} replays read, ${docs.length} decoded, ${failed} failed`);
    console.log(`[Dry run] ${all.length} participants, ${guests.length} guests (${((100 * guests.length) / Math.max(1, all.length)).toFixed(1)}%)`);
    console.log(`[Dry run] registered at level 0: ${level0Registered} · guests above level 0: ${guestAboveLevel0}`);
    console.log(`[Dry run] modes:`, modes);
    console.log(`[Dry run] sample:`, JSON.stringify(docs[0], null, 2).slice(0, 800));
}

async function run() {
    await migrate();

    if (DRY_RUN) {
        await dryRun();
        return;
    }

    if (FRESH) await clearBackfillState(NAME);
    const saved = await getBackfillState(NAME);
    let cursor = saved ? { cycle: saved.cycle, id: saved.lastId } : { cycle: 0, id: 0 };
    let processed = saved?.processed ?? 0;
    let failedTotal = 0;

    console.log(
        saved
            ? `[Backfill] Resuming after cycle ${cursor.cycle} id ${cursor.id} (${processed.toLocaleString()} done)`
            : "[Backfill] Starting from the beginning"
    );

    const t0 = Date.now();
    let sinceStart = 0;

    while (!stopping) {
        const rows = await readReplayPage(cursor.cycle, cursor.id, BATCH_SIZE);
        if (rows.length === 0) break;

        const { docs, failed } = await decodeRows(rows);
        await insertParticipantsBatch(docs);

        const last = rows[rows.length - 1];
        cursor = { cycle: last.cycle, id: last.id };
        processed += rows.length;
        sinceStart += rows.length;
        failedTotal += failed;
        await saveBackfillState(NAME, { cycle: cursor.cycle, lastId: cursor.id, processed });

        const rate = sinceStart / Math.max(1, (Date.now() - t0) / 1000);
        console.log(
            `[Backfill] cycle ${cursor.cycle} id ${cursor.id} · ${processed.toLocaleString()} done · ` +
                `${rate.toFixed(0)}/s${failedTotal ? ` · ${failedTotal} undecodable` : ""}`
        );
    }

    console.log(
        stopping
            ? `[Backfill] Stopped at cycle ${cursor.cycle} id ${cursor.id}. Re-run to resume.`
            : `[Backfill] Done. ${processed.toLocaleString()} replays processed, ${failedTotal} undecodable.`
    );
}

run()
    .catch((err) => {
        console.error("[Backfill] Failed:", err);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
