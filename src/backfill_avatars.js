#!/usr/bin/env node
/**
 * One-time backfill: the skin each participant wore, for replays stored
 * before the scraper started recording it. Decodes every replay already in
 * `replays`, stores each distinct skin in `avatars`, and sets
 * replay_participants.avatar_hash where it's still NULL.
 *
 * Nothing is fetched from bonk.io: the skins are inside the stored replay
 * data. Replays whose participants were never written (participants
 * backfill not run for them) are skipped by the UPDATE; run
 * backfill_participants.js first if that applies.
 *
 * Safe to stop and re-run at any time:
 *   - avatars are ON CONFLICT DO NOTHING, and only NULL avatar_hash rows
 *     are updated
 *   - the cursor is saved in Postgres (backfill_state, name "avatars_v1")
 *     after every batch
 *
 * Usage (from the replay service's shell, in /app):
 *   node src/backfill_avatars.js                  resume or start
 *   node src/backfill_avatars.js --dry-run        decode a sample, write nothing
 *   node src/backfill_avatars.js --batch-size=500
 *   node src/backfill_avatars.js --fresh          ignore the saved cursor
 *
 * Long run (about as long as the participants backfill). In the background:
 *   nohup node src/backfill_avatars.js > backfill_avatars.log 2>&1 &
 *   tail -f backfill_avatars.log
 */

import {
    migrate, closeDb, readReplayPage, setParticipantAvatars,
    getBackfillState, saveBackfillState, clearBackfillState,
} from "./db.js";
import { decodeStoredReplay } from "./codec.js";
import { extractParticipants } from "./participants.js";

const NAME = "avatars_v1";

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
    console.log("\n[Avatars] Stopping after the current batch…");
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
                docs.push({ cycle: row.cycle, id: row.id, participants: extractParticipants(decoded) });
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
    const withSkin = all.filter((p) => p.avatarHash);
    const distinct = new Set(withSkin.map((p) => p.avatarHash));
    console.log(`[Dry run] ${rows.length} replays read, ${docs.length} decoded, ${failed} failed`);
    console.log(`[Dry run] ${all.length} participants, ${withSkin.length} with a skin, ${distinct.size} distinct skins`);
    const sample = withSkin[0];
    if (sample) console.log(`[Dry run] sample ${sample.username}: ${sample.avatarHash} ${sample.avatarJson.slice(0, 300)}`);
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
    let updatedTotal = 0;

    console.log(
        saved
            ? `[Avatars] Resuming after cycle ${cursor.cycle} id ${cursor.id} (${processed.toLocaleString()} done)`
            : "[Avatars] Starting from the beginning"
    );

    const t0 = Date.now();
    let sinceStart = 0;

    while (!stopping) {
        const rows = await readReplayPage(cursor.cycle, cursor.id, BATCH_SIZE);
        if (rows.length === 0) break;

        const { docs, failed } = await decodeRows(rows);
        updatedTotal += await setParticipantAvatars(docs);

        const last = rows[rows.length - 1];
        cursor = { cycle: last.cycle, id: last.id };
        processed += rows.length;
        sinceStart += rows.length;
        failedTotal += failed;
        await saveBackfillState(NAME, { cycle: cursor.cycle, lastId: cursor.id, processed });

        const rate = sinceStart / Math.max(1, (Date.now() - t0) / 1000);
        console.log(
            `[Avatars] cycle ${cursor.cycle} id ${cursor.id} · ${processed.toLocaleString()} replays · ` +
                `${updatedTotal.toLocaleString()} participants set · ${rate.toFixed(0)}/s` +
                `${failedTotal ? ` · ${failedTotal} undecodable` : ""}`
        );
    }

    console.log(
        stopping
            ? `[Avatars] Stopped at cycle ${cursor.cycle} id ${cursor.id}. Re-run to resume.`
            : `[Avatars] Done. ${processed.toLocaleString()} replays, ${updatedTotal.toLocaleString()} participants set, ${failedTotal} undecodable.`
    );
}

run()
    .catch((err) => {
        console.error("[Avatars] Failed:", err);
        process.exitCode = 1;
    })
    .finally(() => closeDb());
