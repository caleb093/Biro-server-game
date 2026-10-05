import mongoose, { Schema, HydratedDocument } from "mongoose";

export interface IUserStats {
    played: number;
    wins: number;
    losses: number;
    draws: number;
}

export interface IUser {
    username: string;       // display casing, as the player typed it
    usernameLower: string;  // unique key — usernames are case-insensitive
    passwordHash: string;   // scrypt hash, never selected by default
    stats: IUserStats;      // online PvP results only
    appliedMatchIds: string[]; // last few match ids already counted in stats (makes result writes retry-safe)
    createdAt: Date;
    updatedAt: Date;
}

export type UserDocument = HydratedDocument<IUser>;

// 3–20 chars, letters / digits / underscore.
export const USERNAME_REGEX = /^[a-zA-Z0-9_]{3,20}$/;

const statsSchema = new Schema<IUserStats>(
    {
        played: { type: Number, default: 0 },
        wins: { type: Number, default: 0 },
        losses: { type: Number, default: 0 },
        draws: { type: Number, default: 0 },
    },
    { _id: false }
);

const userSchema = new Schema<IUser>(
    {
        username: { type: String, required: true, trim: true, match: USERNAME_REGEX },
        usernameLower: { type: String, required: true, unique: true },
        passwordHash: { type: String, required: true, select: false },
        stats: { type: statsSchema, default: () => ({}) },
        appliedMatchIds: { type: [String], select: false, default: undefined },
    },
    { timestamps: true }
);

// Leaderboard: rank by wins (ties broken by fewer losses, then a stable _id).
// Partial — only players with at least one win are on the board, so the index
// stays small however many accounts exist. Queries must include
// `stats.wins > 0` (or a stricter bound) to use it.
export const LEADERBOARD_SORT = { "stats.wins": -1, "stats.losses": 1, _id: 1 } as const;
userSchema.index(LEADERBOARD_SORT, {
    name: "leaderboard",
    partialFilterExpression: { "stats.wins": { $gt: 0 } },
});

// Keep the lookup key in sync with the display name.
userSchema.pre("validate", function () {
    if (this.username) this.usernameLower = this.username.toLowerCase();
});

// Public shape sent to clients — never includes the password hash.
export function toPublicUser(user: Pick<UserDocument, "_id" | "username" | "stats" | "createdAt">) {
    return {
        id: user._id.toString(),
        username: user.username,
        stats: user.stats,
        createdAt: user.createdAt,
    };
}

const User = mongoose.model<IUser>("User", userSchema);

export default User;
