// node --test: the skin form and hash (src/avatars.js) and what
// extractParticipants adds. No database needed.
import { test } from "node:test";
import assert from "node:assert/strict";

import { avatarHash, canonicalJson, distinctAvatars, hashedAvatar, normalizeAvatar } from "../src/avatars.js";
import { extractParticipants } from "../src/participants.js";

const layer = (over = {}) => ({ id: 13, scale: 0.15, angle: 0, x: 1.5, y: -2, flipX: false, flipY: true, color: 16448250, ...over });
const skin = (over = {}) => ({ layers: [layer(), null, layer({ id: 7 })], bc: 4492031, ...over });

test("normalizes to known fields, keeping empty slots", () => {
    const n = normalizeAvatar(skin({ junk: 1, layers: [{ ...layer(), extra: "x" }, null] }));
    assert.deepEqual(n, { layers: [layer(), null], bc: 4492031 });
});

test("rejects things that aren't avatars", () => {
    for (const bad of [null, undefined, "x", 3, {}, { layers: "nope" }, { layers: new Array(129).fill(null) }]) {
        assert.equal(normalizeAvatar(bad), null);
    }
});

test("bad layer values become safe defaults; a layer without an id is an empty slot", () => {
    const n = normalizeAvatar({ layers: [{ id: 4.9, scale: NaN, color: "red", flipX: 1 }, { scale: 1 }], bc: "?" });
    assert.deepEqual(n, {
        layers: [{ id: 4, scale: 0, angle: 0, x: 0, y: 0, flipX: false, flipY: false, color: 0 }, null],
        bc: 0,
    });
});

test("hash ignores key order and extra fields", () => {
    const a = hashedAvatar(skin());
    const shuffled = { bc: 4492031, layers: [{ color: 16448250, flipY: true, flipX: false, y: -2, x: 1.5, angle: 0, scale: 0.15, id: 13 }, null, layer({ id: 7 })], extra: true };
    assert.equal(hashedAvatar(shuffled).hash, a.hash);
    assert.match(a.hash, /^[0-9a-f]{32}$/);
});

test("different skins hash differently", () => {
    assert.notEqual(hashedAvatar(skin()).hash, hashedAvatar(skin({ bc: 1 })).hash);
    assert.notEqual(hashedAvatar(skin()).hash, hashedAvatar(skin({ layers: [layer()] })).hash);
});

test("canonical JSON is valid JSON of the normalized avatar", () => {
    const n = normalizeAvatar(skin());
    assert.deepEqual(JSON.parse(canonicalJson(n)), n);
    assert.equal(avatarHash(n), hashedAvatar(skin()).hash);
});

test("extractParticipants carries each player's skin hash", () => {
    const decoded = {
        playerArray: [
            { userName: "Alpha", guest: false, level: 9, avatar: skin() },
            null,
            { userName: "Guest1", guest: true, level: 0, avatar: skin() },
            { userName: "NoSkin", guest: false, level: 3 },
        ],
    };
    const ps = extractParticipants(decoded);
    assert.equal(ps.length, 3);
    assert.equal(ps[0].avatarHash, hashedAvatar(skin()).hash);
    assert.equal(ps[1].avatarHash, ps[0].avatarHash);
    assert.equal(ps[2].avatarHash, null);
    assert.deepEqual(distinctAvatars(ps).hashes, [ps[0].avatarHash]);
});
