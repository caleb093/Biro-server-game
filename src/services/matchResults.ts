import { Match, IMatch } from "../models/matchSchema";
import User from "../models/userSchema";
import { ArchetypeId } from "../game/archetypes";
import { invalidateLeaderboard } from "./leaderboard";

// Writes a finished match: the history record + both players' stats (which
// the leaderboard reads). Retried with backoff so a short database blip
// doesn't lose a result, and idempotent so a retry never double-counts:
//   • the Match record has a unique matchId → a repeat insert is a no-op;
//   • each user's stats only change if this matchId isn't already in their
//     appliedMatchIds (kept to the last 20), in the same atomic update.

export interface MatchResult {
    matchId: string;
    source: IMatch["source"];
    players: { userId: string; username: string; seat: 1 | 2; archetype: ArchetypeId | null }[];
    winnerUserId: string | null; // null = draw
    scores: { p1: number; p2: number };
    rounds: number;
    endReason: IMatch["endReason"];
    startedAt: Date;
    endedAt: Date;
}

const RETRY_DELAYS_MS = [1_000, 5_000, 15_000];
const APPLIED_IDS_KEPT = 20;

export async function recordMatchResult(result: MatchResult): Promise<void> {
    for (let attempt = 0; ; attempt++) {
        try {
            await writeResult(result);
            return;
        } catch (err: any) {
            if (attempt >= RETRY_DELAYS_MS.length) throw err;
            console.warn(`[results] saving ${result.matchId} failed (attempt ${attempt + 1}), retrying: ${err?.message}`);
            await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
        }
    }
}

async function writeResult(r: MatchResult) {
    try {
        await Match.create({
            matchId: r.matchId,
            source: r.source,
            players: r.players.map((p) => ({ user: p.userId, username: p.username, seat: p.seat, archetype: p.archetype })),
            winner: r.winnerUserId,
            scores: r.scores,
            rounds: r.rounds,
            endReason: r.endReason,
            startedAt: r.startedAt,
            endedAt: r.endedAt,
        });
    } catch (err: any) {
        if (err?.code !== 11000) throw err; // already saved by an earlier attempt
    }

    // Nobody played it out — keep the record, but leave stats alone.
    if (r.endReason === "abandoned") return;

    await User.bulkWrite(
        r.players.map((p) => {
            const outcome = r.winnerUserId === null ? "draws" : r.winnerUserId === p.userId ? "wins" : "losses";
            return {
                updateOne: {
                    filter: { _id: p.userId, appliedMatchIds: { $ne: r.matchId } },
                    update: {
                        $inc: { "stats.played": 1, [`stats.${outcome}`]: 1 },
                        $push: { appliedMatchIds: { $each: [r.matchId], $slice: -APPLIED_IDS_KEPT } },
                    },
                },
            };
        }),
        { ordered: false }
    );

    invalidateLeaderboard();
}
