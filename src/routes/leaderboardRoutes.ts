import { Router } from "express";
import { getLeaderboard, getMyStanding } from "../controllers/leaderboardController";
import { protect } from "../middleware/protect";

const router = Router();

router.get("/", getLeaderboard);
router.get("/me", protect, getMyStanding);

export default router;
