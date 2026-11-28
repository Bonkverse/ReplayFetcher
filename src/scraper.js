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
// How far back bonk.io looks from the number asked (roughly; see cursor.js).
const LOOKBACK = 1000;

// ─── Helpers ──────────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Username length guard now lives in participants.js (MAX_USERNAME_LENGTH).

function clamp(val, min, max) {
    return Math.min(Math.max(val, min), max);
}

// ─── Cycle-reset detection ────────────────────────────────────────────────────
//
// A cycle ends when bonk.io wipes its replays and starts numbering from 1
// again. bonk.io only returns replays at or below the number you ask for (from
// the ~1,000 below it), so after a wipe the scraper's requests (highest stored
// + 10) just come back empty and it looks caught up forever. wasWiped() checks
// for that directly when nothing new has arrived for a while.

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
        let lastResetCheck   = 0;            // when we last checked for a wipe
        const holes          = new Map();    // replay id → { at: first missed, checks }

        console.log(
            `[Scraper] Resuming — cycle ${cycle}, from replay ${cursor + 1}` +
            (stored != null && stored !== position ? ` (saved position was ${position})` : "")
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

            const step = advance(cursor, returnedIds);

            // ── Nothing new ───────────────────────────────────────────────────
            if (!step.fresh.length) {
                // Quiet for a long time: check whether bonk.io wiped its
                // replays and started a new cycle.
                const now = Date.now();
                if (now - lastNewAt > config.delays.resetCheck && now - lastResetCheck > config.delays.resetCheck) {
                    lastResetCheck = now;
                    if (await this.#wasWiped(cursor)) {
                        ({ cycle, position } = await beginNewCycle(cycle));
                        cursor = position - 1;
                        holes.clear();
                        wasCaughtUp = false;
                        newerExists = false;
                        lastNewAt = Date.now();
                        console.log(`[Scraper] Now on cycle ${cycle} — starting from replay ${cursor + 1}`);
                        continue;
                    }
                }
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

    /**
     * True if bonk.io has wiped its replays (a new cycle has started).
     *
     * In a normal cycle, asking for our newest stored replay always returns it
     * (and the ones below it). After a wipe it returns nothing. To tell a wipe
     * from bonk.io having trouble, bonk.io must also be serving low IDs (the
     * new cycle's first replays), and the newest replay must still be missing
     * when we ask again a minute later.
     */
    async #wasWiped(cursor) {
        // bonk.io looks ~1,000 IDs back from the number asked, so below that
        // the new cycle's low IDs would still come back and hide a wipe.
        if (cursor < LOOKBACK) return false;
        const ask = async (startingFrom) => {
            const res = await fetchReplays(startingFrom);
            await sleep(config.delays.between);
            return res;
        };

        // Gone = nothing came back from the ~1,000 IDs at or below our newest.
        const gone = (res) =>
            res.status === "caught_up" ||
            (res.status === "ok" && res.replays.every((r) => r.id <= cursor - LOOKBACK));

        const newest = await ask(cursor);
        if (!gone(newest)) return false;                     // still there, or an error

        const low = await ask(BATCH);
        if (low.status !== "ok" || !low.replays.length) {
            console.warn(`[Cycle] Replay ${cursor} is gone from bonk.io, but it isn't serving new replays yet — checking again later`);
            return false;
        }

        await sleep(config.delays.resetConfirm);
        const again = await ask(cursor);
        if (!gone(again)) return false;

        console.log(
            `[Cycle] bonk.io wiped its replays: replay ${cursor} is gone and it now serves ` +
            `${low.replays.map((r) => r.id).sort((a, b) => a - b).join(", ")}`
        );
        return true;
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