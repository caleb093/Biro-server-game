import { Router } from "express";
import { login, me, register } from "../controllers/authController";
import { protect } from "../middleware/protect";
import { Limiter, limitByIp } from "../middleware/rateLimit";

const router = Router();

// Per IP. Generous on purpose: players behind one school or office network
// share an IP, so these only stop scripted floods.
const registerLimit = limitByIp(new Limiter(10, 60 * 60_000)); // 10 accounts / hour
const loginLimit = limitByIp(new Limiter(50, 15 * 60_000));    // 50 attempts / 15 min

router.post("/register", registerLimit, register);
router.post("/login", loginLimit, login);
router.get("/me", protect, me);

export default router;
