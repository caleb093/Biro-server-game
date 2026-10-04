import mongoose, { Schema, Types } from "mongoose";
import { ARCHETYPE_IDS, ArchetypeId } from "../game/archetypes";

// Record of a finished online match. Live matches are held in memory by the
// match manager; only the final result is written here.

export type MatchEndReason = "normal" | "forfeit" | "disconnect" | "afk" | "abandoned";

export interface IMatchPlayer {
    user: Types.ObjectId;
    username: string;
    seat: 1 | 2;
    archetype: ArchetypeId | null;
}

export interface IMatch {
    matchId: string;
    source: "matchmaking" | "challenge";
    players: IMatchPlayer[];
    winner: Types.ObjectId | null; // null = draw
    scores: { p1: number; p2: number };
    rounds: number;
    endReason: MatchEndReason;
    startedAt: Date;
    endedAt: Date;
}

const matchPlayerSchema = new Schema<IMatchPlayer>(
    {
        user: { type: Schema.Types.ObjectId, ref: "User", required: true },
        username: { type: String, required: true },
        seat: { type: Number, enum: [1, 2], required: true },
        archetype: { type: String, enum: [...ARCHETYPE_IDS, null], default: null },
    },
    { _id: false }
);

const matchSchema = new Schema<IMatch>({
    matchId: { type: String, required: true, unique: true },
    source: { type: String, enum: ["matchmaking", "challenge"], required: true },
    players: { type: [matchPlayerSchema], required: true },
    winner: { type: Schema.Types.ObjectId, ref: "User", default: null },
    scores: {
        p1: { type: Number, required: true },
        p2: { type: Number, required: true },
    },
    rounds: { type: Number, required: true },
    endReason: { type: String, enum: ["normal", "forfeit", "disconnect", "afk", "abandoned"], required: true },
    startedAt: { type: Date, required: true },
    endedAt: { type: Date, required: true },
});

matchSchema.index({ "players.user": 1, endedAt: -1 });

export const Match = mongoose.model<IMatch>("Match", matchSchema);
