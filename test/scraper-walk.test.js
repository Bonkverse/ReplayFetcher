// Runs the real scraper loop against a fake bonk.io that behaves like the real
// replay API (checked Nov 24, 2026): asking for N returns up to 10 replays with
// id <= N, newest first, from only the ~1,000 IDs below N.
//
// Run with: node --test --experimental-test-module-mocks

import { test, mock } from "node:test";
import assert from "node:assert/strict";
import { advance, holeRequests } from "../src/cursor.js";

// ─── Pure helpers ────────────────────────────────────────────────────────────

test("advance: a full window moves the cursor and asks for more", () => {
    const r = advance(100, [110, 109, 108, 107, 106, 105, 104, 103, 102, 101]);
    assert.deepEqual(r, { cursor: 110, fresh: [101, 102, 103, 104, 105, 106, 107, 108, 109, 110], holes: [], more: true });
});

test("advance: a partial window reports holes and stops", () => {
    const r = advance(100, [104, 102, 101, 100, 99]);
    assert.deepEqual(r, { cursor: 104, fresh: [101, 102, 104], holes: [103], more: false });
});

test("advance: only old IDs means nothing new", () => {
    assert.deepEqual(advance(100, [100, 99, 98]), { cursor: 100, fresh: [], holes: [], more: false });
});

test("holeRequests: packs nearby holes into one request", () => {
    assert.deepEqual(holeRequests([5, 3, 12, 40]), [
        { startingFrom: 12, ids: [3, 5, 12] },
        { startingFrom: 40, ids: [40] },
    ]);
});

// ─── Whole scraper against a fake bonk.io ────────────────────────────────────

test("scraper stores every replay through bursts, rate limits, late and missing IDs", async () => {
    const { config } = await import("../config.js");
    Object.assign(config.delays, {
        between: 1, rateLimit: 30, caughtUp: 5, initialBackoff: 1, maxBackoff: 5, holeTtl: 400, stall: 60,
    });

    // bonk.io's side
    const t0 = Date.now();
    const uploads = new Map();                 // id → time it becomes visible
    const deleted = new Set([57, 58, 905]);    // never visible
    for (let id = 101; id <= 130; id++) deleted.add(id); // a run of 30 missing IDs
    let nextId = 1;
    const upload = (n, lateBy = 0) => {
        for (let i = 0; i < n; i++, nextId++) uploads.set(nextId, Date.now() + (nextId % 17 === 0 ? 40 + lateBy : 0));
    };
    upload(50);                                // already there at start
    let requests = 0;
    const fakeFetch = async (startingFrom) => {
        requests++;
        if (requests % 25 === 0) return { status: "ratelimit" };
        const now = Date.now();
        const replays = [];
        for (let id = startingFrom; id > startingFrom - 1000 && id > 0 && replays.length < 10; id--) {
            const at = uploads.get(id);
            if (at !== undefined && at <= now && !deleted.has(id)) replays.push({ id, replaydata: "x" });
        }
        return replays.length ? { status: "ok", replays } : { status: "caught_up" };
    };

    // our side
    const stored = new Set();
    let state = { cycle: 6, position: 1 };
    mock.module("../src/api.js", { namedExports: { fetchReplays: fakeFetch } });
    mock.module("../src/replayDoc.js", { namedExports: { buildReplayDoc: async (r) => ({ id: r.id }) } });
    mock.module("../src/db.js", {
        namedExports: {
            migrate: async () => {},
            getState: async () => ({ ...state }),
            saveState: async (s) => { state = { ...s }; },
            beginNewCycle: async () => { throw new Error("no cycle reset expected"); },
            insertBatch: async (_c, docs) => { for (const d of docs) stored.add(d.id); },
            closeDb: async () => {},
            setScraperStatus: async () => {},
            maxStoredId: async () => (stored.size ? Math.max(...stored) : null),
        },
    });
    const { Scraper } = await import("../src/scraper.js");
    const scraper = new Scraper();
    const lines = []; const log = mock.method(console, "log", (...a) => lines.push(a.join(" ")));
    const warn = mock.method(console, "warn", () => {});
    const running = scraper.run();

    // a steady trickle, a burst of 120 (like a 65-min pause), then quiet
    for (let i = 0; i < 20; i++) { upload(3); await new Promise((r) => setTimeout(r, 15)); }
    upload(120);
    for (let i = 0; i < 20; i++) { upload(2); await new Promise((r) => setTimeout(r, 15)); }
    await new Promise((r) => setTimeout(r, 900));
    scraper.stop("test");
    await running;
    log.mock.restore(); warn.mock.restore(); if (process.env.DEBUG) console.error(lines.join("\n"));

    const expected = [...uploads.keys()].filter((id) => !deleted.has(id));
    const missing = expected.filter((id) => !stored.has(id));
    assert.deepEqual(missing, [], `missed ${missing.length} replays: ${missing.slice(0, 20).join(", ")}`);
    assert.equal(state.position, Math.max(...expected), "saved position is the newest replay ID");
    console.log(`  ${expected.length} replays, ${requests} requests to the fake bonk.io`);
});
