import { encodeForStorage, compressJsonForStorage } from "./codec.js";
import { extractParticipants, extractMatchMeta,
         registeredPlayers }                         from "./participants.js";

/**
 * Turns one replay from bonk.io's API into the row shape insertBatch() stores.
 * Shared by the scraper and scripts/gap_report.js (gap recovery), so both
 * store a replay exactly the same way. Throws if the replay can't be decoded.
 *
 * @param {{ id: number, mapid?: number, replaydata: string }} r
 */
export async function buildReplayDoc(r) {
    const { replayBytes, decoded } = await encodeForStorage(r.replaydata);

    // Slot-based participants with bonk.io's guest flag
    // (see participants.js for why). `players` feeds the
    // cross-replay identity table, so registered only.
    const participants = extractParticipants(decoded);
    const players = registeredPlayers(participants);
    const meta = extractMatchMeta(decoded);

    // Pull map metadata + geometry, matching output.json's confirmed shape
    const ss = decoded?.startingState ?? {};
    const mm = ss.mm ?? {};

    let map = null;
    if (Number.isFinite(mm.dbid) && Number.isFinite(mm.dbv)) {
        const mapBytes = await compressJsonForStorage({
            physics:  ss.physics ?? null,
            capZones: ss.capZones ?? null,
        });
        map = {
            mapid:     mm.dbid,
            version:   mm.dbv,
            name:      mm.n ?? decoded.mn ?? null,
            author:    mm.a ?? decoded.ma ?? null,
            authorId:  Number.isFinite(mm.authid) ? mm.authid : null,
            published: typeof mm.pub === "boolean" ? mm.pub : null,
            votesUp:   Number.isFinite(mm.vu) ? mm.vu : null,
            votesDown: Number.isFinite(mm.vd) ? mm.vd : null,
            remixOf:   Number.isFinite(mm.rxid) && mm.rxid > 0 ? mm.rxid : null,
            mapBytes,
        };
    }

    return {
        id: r.id,
        mapid: r.mapid ?? null,
        replayBytes,
        players,
        participants,
        meta,
        map,
    };
}
