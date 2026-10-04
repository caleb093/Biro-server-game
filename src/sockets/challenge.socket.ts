import { isValidObjectId, Types } from "mongoose";
import { ChallengeView, GameSocket, IO, userRoom } from "./events";
import { on, ok, fail, isObject, isNonEmptyString } from "./handler";
import { Challenge, IChallenge, CHALLENGE_MESSAGE_MAX, CHALLENGE_TTL_MS } from "../models/challengeSchema";
import User from "../models/userSchema";
import { isArchetypeId } from "../game/archetypes";
import { isOnline } from "../managers/presence";
import { matchManager } from "../managers/matchManager";
import { matchmaker } from "../managers/matchmaker";

// Direct challenges: "@Khadijat, best of 3 — loser buys puff-puff".
// Stored in MongoDB so they wait for an offline player; accepting needs the
// challenger to be online, since a match starts immediately.

const MAX_OUTGOING_CHALLENGES = 10;

type ChallengeLike = IChallenge & { _id: Types.ObjectId };

function toChallengeView(c: ChallengeLike): ChallengeView {
    const fromId = c.from.toString();
    return {
        id: c._id.toString(),
        from: { userId: fromId, username: c.fromUsername, online: isOnline(fromId) },
        to: { userId: c.to.toString(), username: c.toUsername },
        archetype: c.archetype,
        message: c.message,
        createdAt: c.createdAt.toISOString(),
        expiresAt: c.expiresAt.toISOString(),
    };
}

const readChallengeId = (payload: unknown): string | null =>
    isObject(payload) && typeof payload.challengeId === "string" && isValidObjectId(payload.challengeId)
        ? payload.challengeId
        : null;

export const registerChallengeHandlers = (io: IO, socket: GameSocket) => {
    const { id: userId, username } = socket.data.user;

    on(socket, "challenge_send", async (payload) => {
        if (!isObject(payload) || !isNonEmptyString(payload.username, 40)) return fail("USERNAME_REQUIRED");
        if (!isArchetypeId(payload.archetype)) return fail("INVALID_ARCHETYPE");

        let message = "";
        if (payload.message !== undefined && payload.message !== null) {
            if (typeof payload.message !== "string") return fail("INVALID_MESSAGE");
            message = payload.message.trim();
            if (message.length > CHALLENGE_MESSAGE_MAX) return fail("MESSAGE_TOO_LONG");
        }

        const target = await User.findOne({ usernameLower: payload.username.toLowerCase() }).select("_id username").lean();
        if (!target) return fail("USER_NOT_FOUND");
        const targetId = target._id.toString();
        if (targetId === userId) return fail("CANNOT_CHALLENGE_SELF");

        const now = new Date();
        const outgoing = await Challenge.countDocuments({ from: userId, expiresAt: { $gt: now } });
        if (outgoing >= MAX_OUTGOING_CHALLENGES) return fail("TOO_MANY_CHALLENGES");

        // An expired challenge the TTL sweep hasn't removed yet would trip the
        // one-per-pair unique index — clear it first.
        await Challenge.deleteOne({ from: userId, to: targetId, expiresAt: { $lte: now } });

        let doc;
        try {
            doc = await Challenge.create({
                from: userId,
                fromUsername: username,
                to: targetId,
                toUsername: target.username,
                archetype: payload.archetype,
                message,
                expiresAt: new Date(now.getTime() + CHALLENGE_TTL_MS),
            });
        } catch (err: any) {
            if (err?.code === 11000) return fail("CHALLENGE_ALREADY_PENDING");
            throw err;
        }

        const view = toChallengeView(doc);
        io.to(userRoom(targetId)).emit("challenge_received", view);
        return ok({ challenge: view });
    });

    on(socket, "challenge_list", async () => {
        const now = new Date();
        const [incoming, outgoing] = await Promise.all([
            Challenge.find({ to: userId, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(50).lean(),
            Challenge.find({ from: userId, expiresAt: { $gt: now } }).sort({ createdAt: -1 }).limit(50).lean(),
        ]);
        return ok({ incoming: incoming.map(toChallengeView), outgoing: outgoing.map(toChallengeView) });
    });

    on(socket, "challenge_decline", async (payload) => {
        const challengeId = readChallengeId(payload);
        if (!challengeId) return fail("INVALID_CHALLENGE_ID");

        const doc = await Challenge.findOneAndDelete({ _id: challengeId, to: userId });
        if (!doc) return fail("CHALLENGE_NOT_FOUND");

        io.to(userRoom(doc.from.toString())).emit("challenge_declined", { challengeId, by: username });
        return ok();
    });

    on(socket, "challenge_cancel", async (payload) => {
        const challengeId = readChallengeId(payload);
        if (!challengeId) return fail("INVALID_CHALLENGE_ID");

        const doc = await Challenge.findOneAndDelete({ _id: challengeId, from: userId });
        if (!doc) return fail("CHALLENGE_NOT_FOUND");

        io.to(userRoom(doc.to.toString())).emit("challenge_cancelled", { challengeId });
        return ok();
    });

    on(socket, "challenge_accept", async (payload) => {
        const challengeId = readChallengeId(payload);
        if (!challengeId) return fail("INVALID_CHALLENGE_ID");

        const challenge = await Challenge.findOne({ _id: challengeId, to: userId, expiresAt: { $gt: new Date() } }).lean();
        if (!challenge) return fail("CHALLENGE_NOT_FOUND");
        const challengerId = challenge.from.toString();

        const blocker = () =>
            matchManager.isInMatch(userId) ? "ALREADY_IN_MATCH"
            : !isOnline(challengerId) ? "CHALLENGER_OFFLINE"
            : matchManager.isInMatch(challengerId) ? "CHALLENGER_BUSY"
            : null;

        // Check first so a failed accept leaves the challenge in place.
        const early = blocker();
        if (early) return fail(early);

        // Claim it atomically — a double click or a second tab can't accept twice.
        const claimed = await Challenge.findOneAndDelete({ _id: challengeId, to: userId });
        if (!claimed) return fail("CHALLENGE_NOT_FOUND");

        // Things may have changed during the await; if so, put the challenge back.
        const late = blocker();
        if (late) {
            await Challenge.create(claimed.toObject()).catch(() => {});
            return fail(late);
        }

        matchmaker.leave(userId);
        matchmaker.leave(challengerId);
        const match = matchManager.createMatch(
            { userId: challengerId, username: challenge.fromUsername },
            { userId, username },
            { source: "challenge", presetArchetypes: { [challengerId]: challenge.archetype } }
        );
        return ok({ matchId: match.id });
    });
};
