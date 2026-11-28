// Gap report: which replay IDs are missing from a cycle, when the gaps
// happened, and (optionally) whether bonk.io still has them.
//
//   DATABASE_URL=<Replay DB public URL> node scripts/gap_report.js [options]
//
// Options
//   --cycle N      cycle to check (default: the scraper's current cycle)
//   --min N        a gap is "big" when at least N IDs in a row are missing (default 10)
//   --top N        how many big gaps to list (default 40)
//   --csv FILE     also write every gap (any size) to a CSV file
//   --probe N      ask bonk.io about the N biggest gaps plus N random small
//                  ones: are those IDs still there? (one request every 4 s)
//   --recover      for gaps bonk.io still has, fetch and store the replays
//                  (same decoding and insert as the scraper). Implies probing.
//
// Read-only unless --recover is given. Probing uses bonk.io's replay API from
// the machine you run this on, so it doesn't use up the scraper's rate limit.

import pg from "pg";
import { writeFileSync } from "node:fs";
import { fetchReplays } from "../src/api.js";
import { buildReplayDoc } from "../src/replayDoc.js";
import { insertBatch, closeDb } from "../src/db.js";

// ─── Args ────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (name, fallback) => {
    const i = args.indexOf(`--${name}`);
    if (i === -1) return fallback;
    const v = args[i + 1];
    return v === undefined || v.startsWith("--") ? true : v;
};
const MIN_BIG = parseInt(opt("min", "10"), 10);
const TOP = parseInt(opt("top", "40"), 10);
const CSV = opt("csv", null);
const RECOVER = opt("recover", false) === true;
const PROBE = RECOVER ? parseInt(opt("probe", "1000000"), 10) || 1_000_000 : parseInt(opt("probe", "0"), 10) || 0;
const REQUEST_GAP_MS = Number(process.env.GAP_REQUEST_MS ?? 4_000);

if (!process.env.DATABASE_URL) {
    console.error("Set DATABASE_URL to the Replay DB's public URL (Railway → Replay DB → Variables → DATABASE_PUBLIC_URL).");
    process.exit(1);
}

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── Formatting ──────────────────────────────────────────────────────────────

const ET = "America/New_York";
const fmtTime = (d) =>
    d ? new Date(d).toLocaleString("en-US", { timeZone: ET, month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "—";
const fmtMins = (m) => (m == null ? "—" : m < 90 ? `${Math.round(m)} min` : `${(m / 60).toFixed(1)} h`);
const n = (x) => Number(x).toLocaleString("en-US");

function table(rows, cols) {
    const widths = cols.map((c) => Math.max(c.label.length, ...rows.map((r) => String(c.get(r)).length)));
    const line = (vals) => vals.map((v, i) => String(v).padStart(widths[i])).join("  ");
    console.log(line(cols.map((c) => c.label)));
    for (const r of rows) console.log(line(cols.map((c) => c.get(r))));
}

/**
 * Best guess at why a gap happened, from when its neighbours were fetched.
 * `fetched_at` is when the scraper stored a replay, not when it was uploaded.
 * The first two are the old scraper bug (it only got the newest 10 replays
 * whenever more were waiting), fixed in the scraper's cursor rewrite.
 */
function likelyCause(g) {
    const m = g.mins_between;
    if (m == null) return "";
    if (m >= 55) return "missed after a rate-limit pause / outage";
    if (m <= 3) return "bonk.io didn't have these IDs (often normal)";
    return "missed between polls (10+ new at once)";
}

// ─── Queries ─────────────────────────────────────────────────────────────────

// Every run of missing IDs between two stored replays, with when the replay
// on each side was fetched.
const GAPS_SQL = `
    WITH r AS (
        SELECT id, fetched_at,
               LEAD(id)         OVER (ORDER BY id) AS next_id,
               LEAD(fetched_at) OVER (ORDER BY id) AS next_fetched
        FROM replays WHERE cycle = $1
    )
    SELECT id + 1 AS gap_start, next_id - 1 AS gap_end, next_id - id - 1 AS missing,
           fetched_at AS before_fetched, next_fetched AS after_fetched,
           EXTRACT(EPOCH FROM (next_fetched - fetched_at)) / 60 AS mins_between
    FROM r WHERE next_id - id > 1
    ORDER BY id`;

async function main() {
    let cycle = opt("cycle", null);
    if (cycle === null) {
        const st = await pool.query("SELECT cycle FROM scraper_state WHERE id = 1");
        cycle = st.rows[0]?.cycle ?? 6;
    }
    cycle = parseInt(cycle, 10);

    const sum = (await pool.query(
        `SELECT COUNT(*)::bigint AS stored, MIN(id) AS lo, MAX(id) AS hi,
                MIN(fetched_at) AS first_fetch, MAX(fetched_at) AS last_fetch
         FROM replays WHERE cycle = $1`, [cycle])).rows[0];
    if (!Number(sum.stored)) {
        console.log(`No replays stored for cycle ${cycle}.`);
        return;
    }

    const gaps = (await pool.query(GAPS_SQL, [cycle])).rows.map((g) => ({
        ...g,
        gap_start: Number(g.gap_start), gap_end: Number(g.gap_end), missing: Number(g.missing),
        mins_between: g.mins_between == null ? null : Number(g.mins_between),
    }));

    const span = Number(sum.hi) - Number(sum.lo) + 1;
    const missingTotal = gaps.reduce((a, g) => a + g.missing, 0);
    const leading = Number(sum.lo) - 1; // IDs before the first stored one

    console.log(`\n=== Cycle ${cycle} ===`);
    console.log(`Stored ${n(sum.stored)} replays, IDs ${n(sum.lo)}–${n(sum.hi)} (${n(span)} IDs).`);
    console.log(`Missing ${n(missingTotal)} IDs in ${n(gaps.length)} gaps → ${(100 * Number(sum.stored) / span).toFixed(1)}% coverage.`);
    if (leading > 0) console.log(`Also missing IDs 1–${n(leading)} before the first stored replay.`);
    console.log(`Fetched ${fmtTime(sum.first_fetch)} → ${fmtTime(sum.last_fetch)} (Eastern).`);

    // ── Gap size histogram: what's "normal" ─────────────────────────────────
    const buckets = [[1, 1], [2, 2], [3, 5], [6, 9], [10, 49], [50, 199], [200, 999], [1000, Infinity]];
    console.log(`\n--- Gap sizes ---`);
    table(
        buckets.map(([lo, hi]) => {
            const gs = gaps.filter((g) => g.missing >= lo && g.missing <= hi);
            const ids = gs.reduce((a, g) => a + g.missing, 0);
            return { label: hi === Infinity ? `${n(lo)}+` : lo === hi ? `${lo}` : `${lo}–${hi}`, gaps: gs.length, ids, share: missingTotal ? ((100 * ids) / missingTotal).toFixed(1) + "%" : "—" };
        }),
        [
            { label: "missing in a row", get: (r) => r.label },
            { label: "gaps", get: (r) => n(r.gaps) },
            { label: "IDs missing", get: (r) => n(r.ids) },
            { label: "% of missing", get: (r) => r.share },
        ]
    );

    // ── Per day: where the losses are ───────────────────────────────────────
    const days = (await pool.query(
        `SELECT (fetched_at AT TIME ZONE '${ET}')::date AS d, COUNT(*)::int AS stored,
                MIN(id) AS lo, MAX(id) AS hi
         FROM replays WHERE cycle = $1 GROUP BY 1 ORDER BY 1`, [cycle])).rows;
    console.log(`\n--- Per day (by fetch date, Eastern) ---`);
    table(
        days.map((d) => {
            const s = Number(d.hi) - Number(d.lo) + 1;
            return { d: d.d.toISOString().slice(0, 10), stored: d.stored, span: s, cov: ((100 * d.stored) / s).toFixed(1) + "%" };
        }),
        [
            { label: "day", get: (r) => r.d },
            { label: "stored", get: (r) => n(r.stored) },
            { label: "ID span", get: (r) => n(r.span) },
            { label: "coverage", get: (r) => r.cov },
        ]
    );
    console.log("(Bulk-fetch days overlap other days' ID ranges, so read coverage there loosely.)");

    // ── Cause of the missing IDs ────────────────────────────────────────────
    const byCause = {};
    for (const g of gaps) {
        const c = likelyCause(g) || "unknown";
        byCause[c] ??= { gaps: 0, ids: 0 };
        byCause[c].gaps++; byCause[c].ids += g.missing;
    }
    console.log(`\n--- Likely cause (from fetch times either side of each gap) ---`);
    table(
        Object.entries(byCause).sort((a, b) => b[1].ids - a[1].ids).map(([c, v]) => ({ c, ...v })),
        [
            { label: "cause", get: (r) => r.c },
            { label: "gaps", get: (r) => n(r.gaps) },
            { label: "IDs", get: (r) => n(r.ids) },
        ]
    );

    // ── Big gaps ────────────────────────────────────────────────────────────
    const big = gaps.filter((g) => g.missing >= MIN_BIG).sort((a, b) => b.missing - a.missing);
    console.log(`\n--- ${n(big.length)} gaps of ${MIN_BIG}+ IDs (${n(big.reduce((a, g) => a + g.missing, 0))} IDs); biggest ${Math.min(TOP, big.length)} ---`);
    table(big.slice(0, TOP), [
        { label: "first missing", get: (g) => g.gap_start },
        { label: "last missing", get: (g) => g.gap_end },
        { label: "missing", get: (g) => n(g.missing) },
        { label: "fetched before", get: (g) => fmtTime(g.before_fetched) },
        { label: "fetched after", get: (g) => fmtTime(g.after_fetched) },
        { label: "time between", get: (g) => fmtMins(g.mins_between) },
        { label: "likely cause", get: likelyCause },
    ]);

    if (CSV) {
        const head = "gap_start,gap_end,missing,before_fetched,after_fetched,mins_between,likely_cause";
        const lines = gaps.map((g) =>
            [g.gap_start, g.gap_end, g.missing, g.before_fetched?.toISOString(), g.after_fetched?.toISOString(),
             g.mins_between?.toFixed(1) ?? "", `"${likelyCause(g)}"`].join(","));
        writeFileSync(CSV, [head, ...lines].join("\n") + "\n");
        console.log(`\nWrote all ${n(gaps.length)} gaps to ${CSV}`);
    }

    if (PROBE > 0) await probeGaps(cycle, gaps, big);
}

// ─── Probe / recover ─────────────────────────────────────────────────────────

/** One request to bonk.io, retried once after a network error. */
// Progress: requests made and time spent on them (rate-limit waits excluded),
// for the time-left estimate. A dot per request shows a long gap is moving.
const stats = { requests: 0, ms: 0, dots: 0 };

async function ask(from) {
    const t = Date.now();
    let res = await fetchReplays(from);
    if (res.status === "network_error") { await sleep(10_000); res = await fetchReplays(from); }
    await sleep(REQUEST_GAP_MS);
    stats.requests++;
    stats.ms += Date.now() - t;
    process.stdout.write(".");
    stats.dots++;
    return res;
}

/** Ends a line of progress dots so the next message starts cleanly. */
function endDots() {
    if (stats.dots) process.stdout.write("\n");
    stats.dots = 0;
}

const requestsFor = (g, all) => (all ? Math.ceil(g.missing / 10) : 1);

function fmtDuration(ms) {
    const m = Math.round(ms / 60_000);
    return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

/**
 * Walks one gap through bonk.io's API. Asking for N returns up to 10 replays
 * with id <= N (newest first), so a gap is read in windows ending at
 * start+9, start+19, … A probe only reads the first window.
 * Returns the replays bonk.io still has inside the gap; stops early if
 * bonk.io rate-limits us.
 */
async function walkGap(g, { all, onWindow }) {
    const found = new Map();
    for (let end = Math.min(g.gap_start + 9, g.gap_end); ; end = Math.min(end + 10, g.gap_end)) {
        const res = await ask(end);
        if (res.status === "ratelimit") return { found: [...found.values()], ratelimited: true, resumeFrom: Math.max(g.gap_start, end - 9) };
        if (res.status === "ok") {
            // The last window can overlap the one before it; keep each replay once.
            const fresh = res.replays.filter((r) => r.id >= g.gap_start && r.id <= g.gap_end && !found.has(r.id));
            for (const r of fresh) found.set(r.id, r);
            // Save as we go, so stopping mid-gap keeps what was fetched.
            if (fresh.length && onWindow) await onWindow(fresh);
        }
        if (!all || end >= g.gap_end) break;
    }
    return { found: [...found.values()], ratelimited: false };
}

/**
 * When a recovered replay would have been fetched: spread evenly by ID between
 * the fetch times of the stored replays either side of its gap. Replays are
 * uploaded in ID order, so this lands within the gap's window (usually about
 * an hour), close to what the scraper would have recorded.
 */
function estimateFetchedAt(g, id) {
    const before = new Date(g.before_fetched).getTime();
    const after = Math.max(before, new Date(g.after_fetched).getTime());
    const frac = (id - (g.gap_start - 1)) / (g.gap_end + 1 - (g.gap_start - 1));
    return new Date(before + frac * (after - before));
}

async function probeGaps(cycle, gaps, big) {
    // The biggest gaps, plus a random sample of small ones for comparison.
    const small = gaps.filter((g) => g.missing < MIN_BIG);
    const sample = [...small].sort(() => Math.random() - 0.5).slice(0, Math.min(PROBE, small.length));
    const targets = RECOVER ? [...big, ...small] : [...big.slice(0, PROBE), ...sample];

    let requestsLeft = targets.reduce((a, g) => a + requestsFor(g, RECOVER), 0);
    console.log(`\n--- ${RECOVER ? "Recovering" : "Probing"} ${n(targets.length)} gaps on bonk.io (about ${n(requestsLeft)} requests, one every ${REQUEST_GAP_MS / 1000}s) ---`);
    if (RECOVER) {
        console.log(`Roughly ${fmtDuration(requestsLeft * (REQUEST_GAP_MS + 300))} plus any rate-limit waits. Replays are saved as they come in, so Ctrl-C is safe; rerun to continue.`);
        console.log("Each dot is one request. Time left below doesn't count rate-limit waits.");
        console.log("Recovered replays get a fetched_at between the replays either side of their gap.");
    }

    let stillThere = 0, gone = 0, recovered = 0;
    for (let i = 0; i < targets.length; i++) {
        const g = targets[i];
        const store = async (replays) => {
            const docs = [];
            for (const r of replays) {
                try { docs.push({ ...(await buildReplayDoc(r)), fetchedAt: estimateFetchedAt(g, r.id) }); }
                catch (e) { endDots(); console.warn(`  decode failed for ${r.id}: ${e.message}`); }
            }
            await insertBatch(cycle, docs);
            recovered += docs.length;
        };
        const { found, ratelimited, resumeFrom } = await walkGap(g, { all: RECOVER, onWindow: RECOVER ? store : null });
        if (found.length) {
            stillThere++;
        } else if (!ratelimited) {
            gone++;
        }
        if (!ratelimited) requestsLeft -= requestsFor(g, RECOVER);
        const perRequest = stats.requests ? stats.ms / stats.requests : REQUEST_GAP_MS;
        const progress = `[${n(i + 1)}/${n(targets.length)}]` +
            (RECOVER ? ` ${n(recovered)} recovered · ~${fmtDuration(requestsLeft * perRequest)} left ·` : "");
        endDots();
        const ids = found.map((r) => r.id);
        console.log(
            `${progress} ${g.gap_start}–${g.gap_end} (${g.missing} missing): ` +
            (found.length ? `bonk.io still has ${found.length}${RECOVER ? "" : ` of the first ${Math.min(10, g.missing)}`}${ids.length <= 6 ? ` [${ids.join(", ")}]` : ""}${RECOVER ? " → stored" : ""}` : ratelimited ? "rate-limited" : "gone from bonk.io")
        );
        if (ratelimited) {
            if (!RECOVER) {
                console.log(`\nbonk.io rate-limited us at ID ${resumeFrom}. Wait about an hour and run again.`);
                break;
            }
            // Recovery is long; wait it out and carry on. Rerunning also resumes,
            // since the gaps are re-read from the database.
            console.log(`  rate-limited at ID ${resumeFrom}; waiting 65 min, then retrying this gap (Ctrl-C is safe)…`);
            await sleep(65 * 60_000);
            i--;
        }
    }

    endDots();
    console.log(`\nGaps where bonk.io still had replays: ${stillThere}. Gone: ${gone}.` + (RECOVER ? ` Replays recovered: ${recovered}.` : ""));
    if (!RECOVER && stillThere) console.log("Those can be recovered: rerun with --recover.");
}

main()
    .catch((err) => { console.error(err); process.exitCode = 1; })
    .finally(async () => { await pool.end(); await closeDb(); });
