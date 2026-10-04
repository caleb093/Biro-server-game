import { matchManager, PlayerIdentity, Result } from "./matchManager";

// In-memory "quick match" queue: first come, first paired. Pairing is fully
// synchronous (no awaits between the check and the createMatch), so two
// players can never be paired with the same opponent.

class Matchmaker {
    // Map keeps insertion order → oldest waiting player first.
    private queue = new Map<string, PlayerIdentity & { queuedAt: number }>();

    join(user: PlayerIdentity): Result<{ searching: boolean; matchId?: string }> {
        if (matchManager.isInMatch(user.userId)) return { ok: false, error: "ALREADY_IN_MATCH" };
        if (this.queue.has(user.userId)) return { ok: true, searching: true };

        for (const [waitingId, waiting] of this.queue) {
            this.queue.delete(waitingId);
            // Defensive: they may have entered a match some other way meanwhile.
            if (matchManager.isInMatch(waitingId)) continue;
            const match = matchManager.createMatch(waiting, user, { source: "matchmaking" });
            return { ok: true, searching: false, matchId: match.id };
        }

        this.queue.set(user.userId, { ...user, queuedAt: Date.now() });
        return { ok: true, searching: true };
    }

    leave(userId: string): boolean {
        return this.queue.delete(userId);
    }

    isQueued(userId: string): boolean {
        return this.queue.has(userId);
    }
}

export const matchmaker = new Matchmaker();
