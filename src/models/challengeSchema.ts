import mongoose, { Schema, Types, HydratedDocument } from "mongoose";
import { ARCHETYPE_IDS, ArchetypeId } from "../game/archetypes";

// A direct invite from one player to another. Lives in MongoDB (not memory)
// because the invited player may be offline — they see it next time they open
// the challenges list. Accepting/declining/cancelling deletes the document;
// unanswered ones are purged by the TTL index on expiresAt.

export const CHALLENGE_TTL_MS = 24 * 60 * 60 * 1000;
export const CHALLENGE_MESSAGE_MAX = 140;

export interface IChallenge {
    from: Types.ObjectId;
    fromUsername: string;
    to: Types.ObjectId;
    toUsername: string;
    archetype: ArchetypeId; // the challenger's biro, locked in when sending
    message: string;
    expiresAt: Date;
    createdAt: Date;
}

export type ChallengeDocument = HydratedDocument<IChallenge>;

const challengeSchema = new Schema<IChallenge>(
    {
        from: { type: Schema.Types.ObjectId, ref: "User", required: true },
        fromUsername: { type: String, required: true },
        to: { type: Schema.Types.ObjectId, ref: "User", required: true },
        toUsername: { type: String, required: true },
        archetype: { type: String, enum: ARCHETYPE_IDS, required: true },
        message: { type: String, default: "", maxlength: CHALLENGE_MESSAGE_MAX },
        expiresAt: { type: Date, required: true },
    },
    { timestamps: { createdAt: true, updatedAt: false } }
);

// One pending challenge per direction between two players.
challengeSchema.index({ from: 1, to: 1 }, { unique: true });
challengeSchema.index({ to: 1, createdAt: -1 });
// TTL: MongoDB deletes the doc once expiresAt passes (sweeps ~every 60s, so
// queries still filter on expiresAt to hide the stragglers).
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Challenge = mongoose.model<IChallenge>("Challenge", challengeSchema);
