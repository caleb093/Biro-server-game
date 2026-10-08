import { Router } from "express";
import { onlineCount } from "../managers/presence";
import { matchManager } from "../managers/matchManager";
import { matchmaker } from "../managers/matchmaker";

const router = Router();

// GET /api/stats/online  (public) — live counts, straight from memory (no database).
// "online" = logged-in players with the game open (a connected socket).
router.get("/online", (_req, res) => {
    res.set("Cache-Control", "public, max-age=10");
    res.json({
        online: onlineCount(),
        inMatch: matchManager.activeCount * 2,
        matches: matchManager.activeCount,
        searching: matchmaker.size,
    });
});

export default router;
