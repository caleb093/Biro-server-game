import { GameSocket } from "./events";
import { on, ok, fail, toAck, isObject, isNonEmptyString, isVec2 } from "./handler";
import { matchManager } from "../managers/matchManager";
import { matchmaker } from "../managers/matchmaker";
import { challengeHolds } from "../managers/challengeHolds";
import { isArchetypeId } from "../game/archetypes";

// Biro matchmaking + gameplay events. Handlers only validate the payload shape
// and identify the caller (always from the authenticated socket, never from the
// payload); all game rules are enforced in matchManager.

export const registerBiroHandlers = (socket: GameSocket) => {
    const { id: userId, username } = socket.data.user;

    on(socket, "biro_find_match", () => {
        // Waiting on (or for) a held challenge — that match starts on its own.
        if (challengeHolds.isReserved(userId)) return fail("WAITING_FOR_CHALLENGE");
        const r = matchmaker.join({ userId, username });
        if (!r.ok) return fail(r.error);
        // When paired, biro_match_found is emitted to both players.
        return ok({ searching: r.searching, matchId: r.matchId ?? null });
    });

    on(socket, "biro_cancel_search", () => {
        return ok({ wasSearching: matchmaker.leave(userId) });
    });

    // Current match snapshot (e.g. the game page mounted after the socket was
    // already connected, so it missed biro_resume).
    on(socket, "biro_get_state", () => {
        return ok({ match: matchManager.viewForUser(userId), searching: matchmaker.isQueued(userId) });
    });

    on(socket, "biro_submit_setup", (payload) => {
        if (!isObject(payload) || !isNonEmptyString(payload.matchId)) return fail("MATCH_ID_REQUIRED");
        if (!isArchetypeId(payload.archetype)) return fail("INVALID_ARCHETYPE");
        return toAck(matchManager.submitSetup(payload.matchId, userId, payload.archetype));
    });

    on(socket, "biro_flick", (payload) => {
        if (!isObject(payload) || !isNonEmptyString(payload.matchId)) return fail("MATCH_ID_REQUIRED");
        if (!isVec2(payload.contact) || !isVec2(payload.drag)) return fail("INVALID_FLICK");
        // The resolved flick is broadcast to the room via biro_flick_resolved.
        return toAck(matchManager.flick(payload.matchId, userId, payload.contact, payload.drag));
    });

    on(socket, "biro_forfeit", (payload) => {
        if (!isObject(payload) || !isNonEmptyString(payload.matchId)) return fail("MATCH_ID_REQUIRED");
        return toAck(matchManager.forfeit(payload.matchId, userId));
    });
};
