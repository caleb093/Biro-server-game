import { Request, Response } from "express";
import { getLeaderboardPage, getPlayerStanding } from "../services/leaderboard";

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;
const MAX_OFFSET = 10_000; // skip() cost grows with offset — cap deep paging

function readInt(value: unknown, fallback: number, min: number, max: number): number | null {
    if (value === undefined) return fallback;
    if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
    const n = Number(value);
    return n >= min && n <= max ? n : null;
}

// GET /api/leaderboard?limit=50&offset=0  (public)
export const getLeaderboard = async (req: Request, res: Response) => {
    const limit = readInt(req.query.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
    const offset = readInt(req.query.offset, 0, 0, MAX_OFFSET);
    if (limit === null || offset === null) {
        res.status(400).json({ message: `limit must be 1–${MAX_LIMIT} and offset 0–${MAX_OFFSET}` });
        return;
    }
    res.json(await getLeaderboardPage(limit, offset));
};

// GET /api/leaderboard/me  (protected) — your rank, even if you're not on the requested page.
export const getMyStanding = async (req: Request, res: Response) => {
    const user = req.user!;
    res.json({ userId: user._id.toString(), username: user.username, ...(await getPlayerStanding(user.stats)) });
};
