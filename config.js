// ─── Bonk.io Replay Scraper — Config ─────────────────────────────────────────

export const config = {
    // ── Postgres ──────────────────────────────────────────────────────────────
    databaseUrl: process.env.DATABASE_URL,

    // ── Bonk API ──────────────────────────────────────────────────────────────
    apiUrl:     "https://bonk2.io/scripts/replay_get.php",
    apiVersion: 49,

    // ── Cycle tracking ────────────────────────────────────────────────────────
    //
    // The current known cycle number. Only used to seed scraper_state on the
    // very first run. After that the DB value is authoritative.
    //
    // A "cycle" is the period between Chaz wiping all replays. Each wipe resets
    // replay IDs back to a small number, so IDs alone are not globally unique —
    // (cycle, id) is the true primary key.
    currentCycle: parseInt(process.env.CURRENT_CYCLE ?? "6", 10),

    // ── Cycle-reset detection ─────────────────────────────────────────────────
    //
    // See wasWiped() in src/scraper.js. After delays.resetCheck with no new
    // replays, the scraper asks bonk.io for the newest replay it has stored.
    // If that's gone (and bonk.io is serving low IDs), the replays were wiped
    // and a new cycle has started.

    // ── Rate-limiting & delays (all in ms) ───────────────────────────────────
    delays: {
        between:        3_600,           // ~1 req / 3.6 s  →  ~1 000 req/hr  (limit: 10 000)
        rateLimit:      65 * 60_000,     // wait after a rate-limit response
        caughtUp:        2 * 60_000,     // poll interval when fully caught up
        initialBackoff: 30_000,          // first retry delay on network error
        maxBackoff:     30 * 60_000,     // cap for exponential back-off
        holeTtl:        30 * 60_000,     // keep re-checking a missed replay ID this long
        stall:          10 * 60_000,     // no new replays this long → look past missing IDs
        resetCheck:     30 * 60_000,     // no new replays this long → check for a wipe (at most this often)
        resetConfirm:   60_000,          // wait before re-checking a suspected wipe
    },

    // ── Scraper start position ────────────────────────────────────────────────
    // Only used the very first time (no row in scraper_state yet).
    defaultStartPosition: parseInt(process.env.START_POSITION ?? "1", 10),
};