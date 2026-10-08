import { ArchetypeId } from "../game/archetypes";
import { BiroMatch } from "../game/types";
import { Challenge } from "../models/challengeSchema";
import { IO, userRoom } from "../sockets/events";
import { isOnline } from "./presence";
import { matchManager, PlayerIdentity } from "./matchManager";
import { matchmaker } from "./matchmaker";

// Challenges accepted while the challenger was busy in another match. Instead of
// failing, the accept "holds": the challengee waits, and when the challenger's
// match ends both get a short countdown and the new match starts by itself.
//
// The challenge document stays in MongoDB until the match actually starts, so a
// hold that falls through (someone went offline, a restart) just leaves a normal
// pending challenge behind. The hold itself is in memory, like live matches.
//
// At most one hold per challenger, and a player on either side of a hold is
// "reserved": no quick match, no accepting other challenges, no second hold.

export const HOLD_COUNTDOWN_MS = 5_000;

export type HoldEndReason = "challenger_offline" | "challengee_offline" | "gone";

interface Hold {
    challengeId: string;
    challenger: PlayerIdentity;
    challengee: PlayerIdentity;
    archetype: ArchetypeId;       // the challenger's biro, locked in when sending
    startsAt: number | null;      // set once the countdown runs (server ms)
    timer?: NodeJS.Timeout;
}

class ChallengeHolds {
    private io: IO | null = null;
    private byId = new Map<string, Hold>();
    private byChallenger = new Map<string, Hold>();
    private byChallengee = new Map<string, Hold>();

    init(io: IO) {
        this.io = io;
        matchManager.onCompleted((match) => this.onMatchCompleted(match));
    }

    private get server(): IO {
        if (!this.io) throw new Error("ChallengeHolds used before init(io)");
        return this.io;
    }

    isReserved(userId: string): boolean {
        return this.byChallenger.has(userId) || this.byChallengee.has(userId);
    }

    holdView(challengeId: string): { startsAt: number | null } | null {
        const hold = this.byId.get(challengeId);
        return hold ? { startsAt: hold.startsAt } : null;
    }

    isStarting(challengeId: string): boolean {
        return this.byId.get(challengeId)?.startsAt != null;
    }

    // Callers check isReserved() for both players first.
    create(challengeId: string, challenger: PlayerIdentity, challengee: PlayerIdentity, archetype: ArchetypeId) {
        const hold: Hold = { challengeId, challenger, challengee, archetype, startsAt: null };
        this.byId.set(challengeId, hold);
        this.byChallenger.set(challenger.userId, hold);
        this.byChallengee.set(challengee.userId, hold);
        this.emitHold(hold);
        console.log(`[hold] ${challengee.username} is waiting for ${challenger.username}'s match to end`);
    }

    // Drop a hold without telling anyone — for a decline/cancel, which send their own event.
    remove(challengeId: string) {
        const hold = this.byId.get(challengeId);
        if (hold) this.forget(hold);
    }

    // Called when a user's last socket goes away.
    handleOffline(userId: string) {
        const asChallengee = this.byChallengee.get(userId);
        if (asChallengee) this.end(asChallengee, "challengee_offline");

        // Mid-match, a disconnected challenger is still in their reconnect grace —
        // keep waiting; beginCountdown checks they're online when the match ends.
        const asChallenger = this.byChallenger.get(userId);
        if (asChallenger && asChallenger.startsAt !== null) this.end(asChallenger, "challenger_offline");
    }

    private onMatchCompleted(match: BiroMatch) {
        for (const p of match.players) {
            const hold = this.byChallenger.get(p.userId);
            if (hold && hold.startsAt === null) this.beginCountdown(hold);
        }
    }

    private beginCountdown(hold: Hold) {
        if (!isOnline(hold.challenger.userId)) return this.end(hold, "challenger_offline");
        if (!isOnline(hold.challengee.userId)) return this.end(hold, "challengee_offline");

        hold.startsAt = Date.now() + HOLD_COUNTDOWN_MS;
        hold.timer = setTimeout(() => {
            this.start(hold).catch((err) => {
                console.error(`[hold] starting ${hold.challengeId} failed:`, err);
                if (this.byId.get(hold.challengeId) === hold) this.end(hold, "gone");
            });
        }, HOLD_COUNTDOWN_MS);
        this.emitHold(hold);
    }

    private async start(hold: Hold) {
        if (this.byId.get(hold.challengeId) !== hold) return; // declined/cancelled meanwhile
        const { challenger, challengee } = hold;

        const blocked = () =>
            !isOnline(challenger.userId) ? "challenger_offline"
            : !isOnline(challengee.userId) ? "challengee_offline"
            : matchManager.isInMatch(challenger.userId) || matchManager.isInMatch(challengee.userId) ? "gone"
            : null;

        const early = blocked();
        if (early) return this.end(hold, early);

        // Claim the challenge atomically, the same way challenge_accept does.
        const claimed = await Challenge.findOneAndDelete({ _id: hold.challengeId, from: challenger.userId, to: challengee.userId });
        if (this.byId.get(hold.challengeId) !== hold) return;
        if (!claimed) return this.end(hold, "gone");

        // Things may have changed during the await; if so, put the challenge back.
        const late = blocked();
        if (late) {
            await Challenge.create(claimed.toObject()).catch(() => {});
            return this.end(hold, late);
        }

        this.forget(hold);
        matchmaker.leave(challenger.userId);
        matchmaker.leave(challengee.userId);
        matchManager.createMatch(challenger, challengee, {
            source: "challenge",
            presetArchetypes: { [challenger.userId]: hold.archetype },
        });
    }

    // Give up on a hold. The challenge stays pending unless it's gone.
    private end(hold: Hold, reason: HoldEndReason) {
        this.forget(hold);
        const payload = { challengeId: hold.challengeId, reason };
        this.server.to(userRoom(hold.challenger.userId)).emit("challenge_hold_ended", payload);
        this.server.to(userRoom(hold.challengee.userId)).emit("challenge_hold_ended", payload);
        console.log(`[hold] ${hold.challengeId} ended (${reason})`);
    }

    private forget(hold: Hold) {
        if (hold.timer) clearTimeout(hold.timer);
        hold.timer = undefined;
        if (this.byId.get(hold.challengeId) === hold) this.byId.delete(hold.challengeId);
        if (this.byChallenger.get(hold.challenger.userId) === hold) this.byChallenger.delete(hold.challenger.userId);
        if (this.byChallengee.get(hold.challengee.userId) === hold) this.byChallengee.delete(hold.challengee.userId);
    }

    private emitHold(hold: Hold) {
        const payload = { challengeId: hold.challengeId, startsAt: hold.startsAt };
        this.server.to(userRoom(hold.challenger.userId)).emit("challenge_hold", payload);
        this.server.to(userRoom(hold.challengee.userId)).emit("challenge_hold", payload);
    }
}

export const challengeHolds = new ChallengeHolds();
