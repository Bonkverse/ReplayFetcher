/**
 * Per-replay participant + match metadata extraction.
 *
 * Shared by the live scraper (scraper.js), the bulk importer
 * (migrate_mongo_cycle5.js via db.js) and the one-off backfill
 * (backfill_participants.js) so every path reads a decoded replay the same
 * way.
 *
 * Why slots, not usernames
 * ────────────────────────
 * decoded.playerArray is indexed by slot: startingState.scores[i] is the
 * score of the player in slot i, and empty slots are null. The old
 * extraction did .filter(Boolean) before mapping, which threw the slot
 * number away, and keyed replay_players on (cycle, replay_id, username),
 * which collapses two players with the same name in one replay (a guest and
 * a registered account can both be called "Chaz").
 *
 * Why the guest flag matters
 * ──────────────────────────
 * bonk.io usernames of registered accounts are unique and permanent, so a
 * registered username is a real identity. Guest names are not: anyone can
 * play as a guest called "New Player". Treating every name as an account
 * merges unrelated guests into one "player" and lets guest appearances
 * contaminate a registered account's history. Each playerArray entry has an
 * explicit `guest` boolean, so we store it instead of guessing (level 0 is
 * a strong hint but the flag is the source of truth).
 *
 * Skins
 * ─────
 * Each participant also carries the skin worn in that replay, normalized and
 * hashed by avatars.js (`avatarHash`, `avatarJson`); db.js stores it once in
 * `avatars` and points the participant row at it.
 */

import { canonicalJson, hashedAvatar } from "./avatars.js";

// Generous relative to bonk.io's real client-side name limit. A corrupted
// decode can produce a "username" thousands of characters long without the
// decoder throwing; anything this long is not a real name. Same value the
// scraper and the cycle 5 migration already used.
export const MAX_USERNAME_LENGTH = 100;

// Postgres INT is 32-bit. bonk.io uses huge sentinel values in some fields
// (e.g. a win limit of 1e308 for "no limit"), which Postgres rejects, so
// anything outside the INT range is stored as null (unknown / unlimited).
const INT_MAX = 2147483647;
const finiteInt = (v) =>
    typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= INT_MAX
        ? Math.trunc(v)
        : null;
// team is a SMALLINT column (-32768..32767)
const smallInt = (v) => {
    const n = finiteInt(v);
    return n != null && Math.abs(n) <= 32767 ? n : null;
};

/**
 * Scores are the scoreboard as recorded when the replay starts (a bonk.io
 * replay is the last few seconds of a round), which is what the game shows.
 *
 * @param {object} decoded  A decoded replay (PSON → JS object).
 * @returns {Array<{
 *   slot: number, username: string, guest: boolean, level: number,
 *   team: number|null, ping: number|null, score: number|null,
 *   avatar: object|null, avatarHash: string|null, avatarJson: string|null
 * }>}
 */
export function extractParticipants(decoded) {
    const scores = decoded?.startingState?.scores;
    const teamsMode = decoded?.gameSettings?.tea === true;
    const arr = Array.isArray(decoded?.playerArray) ? decoded.playerArray : [];
    const out = [];

    arr.forEach((p, slot) => {
        if (!p || typeof p.userName !== "string" || p.userName.length === 0) return;
        if (p.userName.length > MAX_USERNAME_LENGTH) return;
        const skin = hashedAvatar(p.avatar);

        out.push({
            slot,
            username: p.userName,
            guest: !!p.guest,
            level: finiteInt(p.level) ?? 0,
            team: smallInt(p.team),
            ping: finiteInt(p.ping),
            // startingState.scores is indexed by slot in free-for-all but by
            // team number in team modes (red = 2, blue = 3, ...), so in team
            // games a player's score is their team's score.
            score: !Array.isArray(scores)
                ? null
                : teamsMode
                    ? finiteInt(scores[p.team])
                    : finiteInt(scores[slot]),
            avatar: p.avatar ?? null,
            avatarHash: skin ? skin.hash : null,
            avatarJson: skin ? canonicalJson(skin.avatar) : null,
        });
    });

    return out;
}

/**
 * Match-level fields the search UI shows and filters on, so result pages
 * never have to decode replays.
 */
export function extractMatchMeta(decoded) {
    const ss = decoded?.startingState ?? {};
    const mm = ss.mm ?? {};
    const gs = decoded?.gameSettings ?? {};
    const participants = extractParticipants(decoded);

    return {
        mode: typeof gs.mo === "string" ? gs.mo.slice(0, 16) : null,
        teams: typeof gs.tea === "boolean" ? gs.tea : null,
        quickplay: typeof gs.q === "boolean" ? gs.q : null,
        winLimit: finiteInt(gs.wl),
        rounds: finiteInt(ss.rc),
        frames: finiteInt(decoded?.es),
        mapVersion: finiteInt(mm.dbv),
        playerCount: participants.length,
        guestCount: participants.filter((p) => p.guest).length,
    };
}

/**
 * Players to merge into the cross-replay `players` table. Registered only:
 * that table is an identity table (one row per account), and guests are not
 * identities.
 */
export function registeredPlayers(participants) {
    return participants
        .filter((p) => !p.guest)
        .map((p) => ({ username: p.username, level: p.level, avatar: p.avatar }));
}
