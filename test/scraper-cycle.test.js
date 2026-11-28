// Runs the real scraper loop against a fake bonk.io (same API as the real one:
// asking for N returns up to 10 replays with id <= N, newest first, from the
// ~1,000 below N) through a replay wipe, and through bonk.io going quiet.
//
// Run with: node --test --experimental-test-module-mocks

import { test, mock } from "node:test";
import assert from "node:assert/strict";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One fake bonk.io + fake DB shared by the tests below (module mocks are per file).
const bonk = { replays: new Set(), silent: false, requests: 0 };
const db = { cycle: 6, position: 1, stored: new Map(), newCycleCalls: 0 };

function fakeFetch(startingFrom) {
    bonk.requests++;
    if (bonk.silent) return { status: "caught_up" };
    const out = [];
    for (let id = startingFrom; id > startingFrom - 1000 && id > 0 && out.length < 10; id--) {
        if (bonk.replays.has(id)) out.push({ id, replaydata: "x" });
    }
    return out.length ? { status: "ok", replays: out } : { status: "caught_up" };
}

const storedIn = (cycle) => db.stored.get(cycle) ?? new Set();

mock.module("../src/api.js", { namedExports: { fetchReplays: async (n) => fakeFetch(n) } });
mock.module("../src/replayDoc.js", { namedExports: { buildReplayDoc: async (r) => ({ id: r.id }) } });
mock.module("../src/db.js", {
    namedExports: {
        migrate: async () => {},
        getState: async () => ({ cycle: db.cycle, position: db.position }),
        saveState: async (s) => { db.cycle = s.cycle; db.position = s.position; },
        beginNewCycle: async (c) => { db.newCycleCalls++; db.cycle = c + 1; db.position = 1; return { cycle: c + 1, position: 1 }; },
        insertBatch: async (cycle, docs) => {
            if (!db.stored.has(cycle)) db.stored.set(cycle, new Set());
            for (const d of docs) db.stored.get(cycle).add(d.id);
        },
        closeDb: async () => {},
        setScraperStatus: async () => {},
        maxStoredId: async (cycle) => (storedIn(cycle).size ? Math.max(...storedIn(cycle)) : null),
    },
});

const { config } = await import("../config.js");
Object.assign(config.delays, {
    between: 1, rateLimit: 20, caughtUp: 5, initialBackoff: 1, maxBackoff: 5,
    holeTtl: 200, stall: 40, resetCheck: 60, resetConfirm: 10,
});
const { Scraper } = await import("../src/scraper.js");

async function runFor(ms, during) {
    const scraper = new Scraper();
    const log = mock.method(console, "log", () => {});
    const warn = mock.method(console, "warn", () => {});
    const running = scraper.run();
    await during();
    await sleep(ms);
    scraper.stop("test");
    await running;
    log.mock.restore(); warn.mock.restore();
}

test("a wipe starts the next cycle and fetches it from replay 1", async () => {
    // A realistic old cycle: well past bonk.io's ~1,000-ID look-back.
    for (let id = 1; id <= 1060; id++) bonk.replays.add(id);
    db.stored.set(6, new Set(Array.from({ length: 1040 }, (_, i) => i + 1)));
    await runFor(400, async () => {
        await sleep(150);                              // catch up on cycle 6
        bonk.replays = new Set();                      // Chaz wipes the replays
        for (let i = 1; i <= 25; i++) { bonk.replays.add(i); if (i % 5 === 0) await sleep(10); }
    });
    assert.equal(db.newCycleCalls, 1, "switched to a new cycle exactly once");
    assert.equal(db.cycle, 7);
    assert.deepEqual([...storedIn(6)].sort((a, b) => a - b), Array.from({ length: 1060 }, (_, i) => i + 1));
    assert.deepEqual([...storedIn(7)].sort((a, b) => a - b), Array.from({ length: 25 }, (_, i) => i + 1));
});

test("bonk.io returning nothing at all is not mistaken for a wipe", async () => {
    const before = db.newCycleCalls;
    bonk.silent = true;
    await runFor(400, async () => {});
    bonk.silent = false;
    assert.equal(db.newCycleCalls, before, "no new cycle while bonk.io serves nothing");
});

test("a long quiet spell with replays still there is not a wipe", async () => {
    const before = db.newCycleCalls;
    const requestsBefore = bonk.requests;
    await runFor(400, async () => {});
    assert.equal(db.newCycleCalls, before);
    assert.ok(bonk.requests > requestsBefore, "it kept polling");
});
