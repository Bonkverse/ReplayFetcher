import { config }                                    from "../config.js";
import { migrate, getState, saveState, beginNewCycle,
         insertBatch, closeDb, setScraperStatus,
         maxStoredId }                               from "./db.js";
import { fetchReplays }                              from "./api.js";
import { buildReplayDoc }                          from "./replayDoc.js";
import { BATCH, requestFor, advance, holeRequests } from "./cursor.js";

// Missed IDs (not there yet when we passed them) are re-checked for
// config.delays.holeTtl, at most this many requests per caught-up poll.
const HOLE_REQUESTS_PER_POLL = 3;
// After config.delays.stall with nothing new, look this far ahead in case 10+
// IDs in a row are missing and newer replays sit past them.
const LOOKAHEAD = 500;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Username length guard now lives in participants.js (MAX_USERNAME_LENGTH).

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

// ─── Cycle-reset detection ────────────────────────────────────────────────────

/**
 * Returns true if the returned replay IDs indicate a new cycle has started.
 *
 * How it works:
 *   After being caught up, the next successful batch should have IDs just above
 *   our current position. If instead the max returned ID is tiny relative to
 *   our position, Chaz wiped the DB and the IDs have reset.
 *
 * Example: position = 1 400 000, threshold = 0.01 (1%)
 *   → maxReturnedId must be < 14 000 to trigger a cycle reset.
 *
 * We only check this AFTER being caught up (wasCaughtUp = true) because during
 * normal scraping the returned IDs will always be near our position. The
 * caught-up gate prevents false positives early in a cycle when our position
 * is still low.
 *
 * @param {number[]} returnedIds   IDs in the API response batch.
 * @param {number}   position      Current scraper position before this batch.
 * @param {boolean}  wasCaughtUp   Whether we were in caught-up state last iteration.
 */
function isCycleReset(returnedIds, position, wasCaughtUp) {
    if (!wasCaughtUp) return false;
    if (position < 1000) return false; // Too early in a cycle to have meaningful signal.

    const maxId = Math.max(...returnedIds);
    const isReset = maxId < position * config.cycleResetThreshold;

    if (isReset) {
        console.log(
            `[Cycle] Reset detected: position was ${position}, ` +
            `but new batch max ID is ${maxId} ` +
            `(${((maxId / position) * 100).toFixed(3)}% of position, ` +
            `threshold: ${config.cycleResetThreshold * 100}%)`
        );
    }

    return isReset;
}

/** Decodes replays for storage; ones that fail are logged and skipped. */
async function decodeAll(replays) {
    const docs = [];
    const failedIds = [];
    await Promise.all(
        replays.map(async (r) => {
            try {
                docs.push(await buildReplayDoc(r));
            } catch (e) {
                failedIds.push(r.id);
                console.warn(`[Scraper] Decode failed for replay ${r.id}: ${e.message}`);
            }
        })
    );
    return { docs, failedIds };
}

// ─── Scraper ──────────────────────────────────────────────────────────────────

export class Scraper {
    #running     = false;
    #stopPromise = null;
    #stopResolve = null;

    stop(reason = "unknown") {
        if (!this.#running) return;
        console.log(`\n[Scraper] Shutdown requested (${reason}) — finishing current batch…`);
        this.#running = false;
        this.#stopResolve?.();
    }

    async run() {
        this.#running = true;
        this.#stopPromise = new Promise((r) => (this.#stopResolve = r));

        await migrate();

        let { cycle, position } = await getState();
        // The cursor is the highest replay ID stored (see cursor.js). Older
        // versions saved a running count here that drifted above the real
        // IDs, so the database wins when it has replays for this cycle.
        const stored = await maxStoredId(cycle);
        let cursor = stored ?? Math.max(0, position - 1);
        let consecutiveFails = 0;
        let wasCaughtUp      = false;
        let runAdded         = 0;            // replays stored in the current fetch run
        let lastNewAt        = Date.now();
        let newerExists      = false;        // a run of missing IDs with replays past it
        const holes          = new Map();    // replay id → { at: first missed, checks }

        console.log(
            `[Scraper] Resuming — cycle ${cycle}, from replay ${cursor + 1}` +
            (stored != null && stored + 1 !== position ? ` (saved position was ${position})` : "")
        );

        // Nothing new right now: re-check missed IDs, then wait for the next poll.
        const idle = async () => {
            if (!wasCaughtUp) {
                console.log(
                    `[Scraper] Caught up at cycle ${cycle}, replay ${cursor} — ` +
                    `polling every ${config.delays.caughtUp / 60_000} min`
                );
            }
            wasCaughtUp = true;
            const recheck = await this.#recheckHoles(cycle, holes);
            runAdded += recheck.added;
            if (recheck.rateLimited) {
                console.warn(`[Scraper] Rate-limited — waiting ${config.delays.rateLimit / 60_000} min`);
                await this.#wait("rate_limited", config.delays.rateLimit);
                return;
            }
            // A fetch run just ended: record how many replays it added
            // (the replay site shows "N new replays added").
            const finishedRun = runAdded > 0 ? { added: runAdded } : null;
            runAdded = 0;
            await this.#wait("caught_up", config.delays.caughtUp, finishedRun);
        };

        while (this.#running) {
            const result = await fetchReplays(requestFor(cursor));

            // ── Network error ─────────────────────────────────────────────────
            if (result.status === "network_error") {
                consecutiveFails++;
                const wait = clamp(
                    config.delays.initialBackoff * Math.pow(2, consecutiveFails - 1),
                    config.delays.initialBackoff,
                    config.delays.maxBackoff
                );
                console.error(
                    `[Scraper] Network error (fail #${consecutiveFails}): ${result.error.message}` +
                    ` — retrying in ${wait / 1000}s`
                );
                await this.#wait("retrying", wait);
                continue;
            }

            // ── Rate-limited ──────────────────────────────────────────────────
            // Nothing is lost while we wait: we pick up from the cursor after.
            if (result.status === "ratelimit") {
                console.warn(
                    `[Scraper] Rate-limited — waiting ${config.delays.rateLimit / 60_000} min`
                );
                await this.#wait("rate_limited", config.delays.rateLimit);
                continue;
            }

            consecutiveFails = 0;
            const replays     = result.status === "ok" ? result.replays : [];
            const returnedIds = replays.map((r) => r.id);

            // ── Cycle-reset check ─────────────────────────────────────────────
            if (replays.length && isCycleReset(returnedIds, cursor, wasCaughtUp)) {
                ({ cycle, position } = await beginNewCycle(cycle));
                cursor = position - 1;
                holes.clear();
                wasCaughtUp = false;
                console.log(`[Scraper] Now on cycle ${cycle} — restarting from replay ${cursor + 1}`);
                // Don't process this batch under the old cycle — loop again
                // from the new position so the fetch is clean.
                continue;
            }

            const step = advance(cursor, returnedIds);

            // ── Nothing new ───────────────────────────────────────────────────
            if (!step.fresh.length) {
                // Been quiet a while: maybe 10+ IDs in a row are missing and
                // newer replays sit past them. If so, step over this block.
                if (!newerExists && Date.now() - lastNewAt > config.delays.stall) {
                    newerExists = await this.#newerExists(cursor);
                }
                if (newerExists) {
                    const now = Date.now();
                    for (let id = cursor + 1; id <= cursor + BATCH; id++) holes.set(id, { at: now, checks: 0 });
                    cursor += BATCH;
                    await saveState({ cycle, position: cursor });
                    await this.#wait("fetching", config.delays.between);
                    continue;
                }
                await idle();
                continue;
            }

            wasCaughtUp = false;
            newerExists = false;
            lastNewAt   = Date.now();

            // ── Decode & compress (new replays only) ──────────────────────────
            const fresh = new Set(step.fresh);
            const { docs, failedIds } = await decodeAll(replays.filter((r) => fresh.has(r.id)));

            // ── Persist ───────────────────────────────────────────────────────
            try {
                await insertBatch(cycle, docs);
            } catch (err) {
                console.error("[Scraper] DB insert failed:", err.message);
                await this.#wait("retrying", config.delays.initialBackoff);
                continue;
            }

            // ── Advance ───────────────────────────────────────────────────────
            // A replay that fails to decode still moves the cursor past it, so
            // a permanently corrupt replay never blocks progress.
            const now = Date.now();
            for (const id of step.holes) holes.set(id, { at: now, checks: 0 });
            cursor = step.cursor;
            runAdded += docs.length;
            await saveState({ cycle, position: cursor });

            console.log(
                `[Scraper] Cycle ${cycle} | ${docs.length} stored` +
                (failedIds.length ? `, ${failedIds.length} decode-failed (ids: ${failedIds.join(", ")})` : "") +
                (step.holes.length ? `, ${step.holes.length} not there yet (${step.holes.join(", ")})` : "") +
                `. Up to replay ${cursor}`
            );

            if (step.more) await this.#wait("fetching", config.delays.between);
            else await idle();
        }

        console.log("[Scraper] Shutting down — closing DB…");
        await closeDb();
        console.log("[Scraper] Done.");
    }

    /**
     * Re-asks bonk.io for IDs that weren't there when we first passed them,
     * and stores any that have appeared. Drops IDs older than config.delays.holeTtl.
     */
    async #recheckHoles(cycle, holes) {
        const now = Date.now();
        let expired = 0;
        for (const [id, seen] of holes) {
            if (now - seen.at > config.delays.holeTtl) { holes.delete(id); expired++; }
        }
        if (expired) console.log(`[Scraper] ${expired} IDs never appeared on bonk.io — giving up on them`);

        // Least-checked first, so a long run of IDs bonk.io never kept can't
        // crowd out a newer late replay.
        const checks = (ids) => Math.min(...ids.map((id) => holes.get(id).checks));
        const batch = holeRequests([...holes.keys()])
            .sort((a, b) => checks(a.ids) - checks(b.ids) || a.startingFrom - b.startingFrom)
            .slice(0, HOLE_REQUESTS_PER_POLL);

        let added = 0;
        for (const { startingFrom, ids } of batch) {
            for (const id of ids) holes.get(id).checks++;
            if (!this.#running) break;
            const res = await fetchReplays(startingFrom);
            if (res.status === "ratelimit") return { added, rateLimited: true };
            if (res.status === "ok") {
                const want = new Set(ids);
                const found = res.replays.filter((r) => want.has(r.id));
                if (found.length) {
                    const { docs } = await decodeAll(found);
                    try {
                        await insertBatch(cycle, docs);
                        for (const r of found) holes.delete(r.id);
                        added += docs.length;
                        console.log(`[Scraper] Caught ${found.length} late replays: ${found.map((r) => r.id).join(", ")}`);
                    } catch (err) {
                        console.error("[Scraper] DB insert failed (late replays):", err.message);
                    }
                }
            }
            await sleep(config.delays.between);
        }
        return { added, rateLimited: false };
    }

    /** True if bonk.io has replays well past `cursor` (we're stuck behind missing IDs). */
    async #newerExists(cursor) {
        const res = await fetchReplays(cursor + LOOKAHEAD);
        await sleep(config.delays.between);
        return res.status === "ok" && res.replays.some((r) => r.id > cursor + BATCH);
    }

    /** Records status + next fetch time for the replay site, then waits. */
    async #wait(status, ms, finishedRun = null) {
        await setScraperStatus(status, ms, finishedRun);
        return this.#sleepInterruptible(ms);
    }

    #sleepInterruptible(ms) {
        return Promise.race([sleep(ms), this.#stopPromise]);
    }
}