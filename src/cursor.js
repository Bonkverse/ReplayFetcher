// How the scraper walks bonk.io's replay IDs.
//
// bonk.io's replay_get does NOT return "the 10 replays from startingFrom up".
// It returns up to 10 replays with id <= startingFrom, newest first, and only
// from roughly the 1,000 IDs below it. Checked on Nov 24, 2026:
//
//   startingFrom=308274 → 308274 308273 … 308265
//   startingFrom=385900 → nothing (newest replay was ~1,000 lower)
//
// The old scraper advanced its position by how many replays came back. Once
// more than 10 new replays were waiting (after every 65-min rate-limit pause,
// and in busy moments), it only ever got the newest 10, then kept re-asking
// for those same 10 while its position ran ahead. Everything older in that
// stretch was skipped: ~56k of cycle 6's ~60k missing IDs.
//
// Now the scraper keeps a cursor: the highest replay ID it has stored. It asks
// for cursor + 10, which returns cursor+1 … cursor+10 (whichever exist), and
// keeps going while those come back full. An ID inside that range that wasn't
// there yet (still being saved on bonk's side) is a "hole", re-checked for a
// while before we give up on it.

export const BATCH = 10;

/** The startingFrom to ask for to get the IDs just above `cursor`. */
export function requestFor(cursor) {
    return cursor + BATCH;
}

/**
 * Given the cursor and the IDs one request returned, works out what's new.
 *
 * @returns {{ cursor: number, fresh: number[], holes: number[], more: boolean }}
 *   cursor  the new cursor (highest ID now seen)
 *   fresh   IDs above the old cursor, ascending
 *   holes   IDs between the old cursor and the new one that didn't come back
 *   more    true when the whole range came back, so newer replays may be waiting
 */
export function advance(cursor, returnedIds) {
    const fresh = [...new Set(returnedIds.filter((id) => id > cursor))].sort((a, b) => a - b);
    if (!fresh.length) return { cursor, fresh, holes: [], more: false };

    const top = fresh[fresh.length - 1];
    const have = new Set(fresh);
    const holes = [];
    for (let id = cursor + 1; id < top; id++) if (!have.has(id)) holes.push(id);

    return { cursor: top, fresh, holes, more: top >= cursor + BATCH };
}

/**
 * Groups hole IDs into as few requests as possible: each request (its
 * startingFrom) covers the 10 IDs at or below it.
 *
 * @param {number[]} holes
 * @returns {{ startingFrom: number, ids: number[] }[]}
 */
export function holeRequests(holes) {
    const sorted = [...new Set(holes)].sort((a, b) => a - b);
    const out = [];
    for (const id of sorted) {
        const last = out[out.length - 1];
        if (last && id <= last.ids[0] + BATCH - 1) {
            last.ids.push(id);
            last.startingFrom = id;
        } else {
            out.push({ startingFrom: id, ids: [id] });
        }
    }
    return out;
}
