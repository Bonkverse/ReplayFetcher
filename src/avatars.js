/**
 * The skin each player wore in a replay.
 *
 * A replay's playerArray[i].avatar is the player's skin as bonk.io draws it:
 *   { layers: [{ id, scale, angle, x, y, flipX, flipY, color } | null, ...], bc }
 * (the same form public/skin-render.js draws). Layer 0 is the top layer;
 * null entries are empty slots and are kept so the order survives.
 *
 * Why a separate table keyed by hash
 * ──────────────────────────────────
 * There are millions of participant rows but only a few hundred thousand
 * distinct skins, and a skin is up to ~16+ layers of JSON. Storing it once
 * in `avatars` and pointing each participant at it (replay_participants
 * .avatar_hash) keeps the table small and makes "which skin did this
 * player wear last" a plain index lookup.
 *
 * The hash is SHA-256 of a canonical JSON form (fixed key order, known
 * fields only), so the same skin always gets the same hash whichever replay
 * or code path it came from. Changing normalizeAvatar() or canonicalJson()
 * changes hashes: don't, without a migration plan.
 */

import { createHash } from "node:crypto";

const LAYER_KEYS = ["id", "scale", "angle", "x", "y", "flipX", "flipY", "color"];
// A sanity bound, well above any real skin (bonk.io's editor stops at 16,
// older tools allow more; Bonkverse's skin code check allows 128).
const MAX_LAYERS = 128;

const finite = (v) => (typeof v === "number" && Number.isFinite(v) ? v : null);

function normalizeLayer(layer) {
    if (!layer || typeof layer !== "object") return null;
    const id = finite(layer.id);
    if (id == null) return null;
    return {
        id: Math.trunc(id),
        scale: finite(layer.scale) ?? 0,
        angle: finite(layer.angle) ?? 0,
        x: finite(layer.x) ?? 0,
        y: finite(layer.y) ?? 0,
        flipX: layer.flipX === true,
        flipY: layer.flipY === true,
        color: Math.trunc(finite(layer.color) ?? 0),
    };
}

/**
 * The avatar in the stored form, or null if it isn't one (missing, not an
 * object, no layers array, too many layers).
 *
 * @param {unknown} avatar  playerArray[i].avatar from a decoded replay
 * @returns {{ layers: Array<object|null>, bc: number } | null}
 */
export function normalizeAvatar(avatar) {
    if (!avatar || typeof avatar !== "object" || !Array.isArray(avatar.layers)) return null;
    if (avatar.layers.length > MAX_LAYERS) return null;
    return {
        layers: avatar.layers.map(normalizeLayer),
        bc: Math.trunc(finite(avatar.bc) ?? 0),
    };
}

/** JSON with a fixed key order, so equal avatars serialize identically. */
export function canonicalJson(avatar) {
    const layers = avatar.layers.map((l) =>
        l == null ? "null" : `{${LAYER_KEYS.map((k) => `${JSON.stringify(k)}:${JSON.stringify(l[k])}`).join(",")}}`
    );
    return `{"layers":[${layers.join(",")}],"bc":${JSON.stringify(avatar.bc)}}`;
}

/** 32 hex characters (128 bits of SHA-256) of the canonical JSON. */
export function avatarHash(avatar) {
    return createHash("sha256").update(canonicalJson(avatar)).digest("hex").slice(0, 32);
}

/**
 * Normalizes and hashes an avatar in one step.
 *
 * @returns {{ hash: string, avatar: object } | null}
 */
export function hashedAvatar(raw) {
    const avatar = normalizeAvatar(raw);
    return avatar ? { hash: avatarHash(avatar), avatar } : null;
}

/**
 * The distinct avatars among `participants` (each with `.avatarHash` and
 * `.avatarJson` set by extractParticipants), as parallel arrays for one
 * UNNEST insert.
 */
export function distinctAvatars(participants) {
    const byHash = new Map();
    for (const p of participants) {
        if (p.avatarHash && !byHash.has(p.avatarHash)) byHash.set(p.avatarHash, p.avatarJson);
    }
    return { hashes: [...byHash.keys()], json: [...byHash.values()] };
}
