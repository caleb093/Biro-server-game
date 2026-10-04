import { Request, Response, NextFunction } from "express";
import User, { UserDocument } from "../models/userSchema";
import { verifyToken } from "../utils/auth";

declare global {
    namespace Express {
        interface Request {
            user?: UserDocument;
        }
    }
}

// Requires "Authorization: Bearer <token>". Attaches the user (without the
// password hash) as req.user.
export const protect = async (req: Request, res: Response, next: NextFunction) => {
    const header = req.headers.authorization;
    if (!header?.startsWith("Bearer ")) {
        res.status(401).json({ message: "Not authorized, no token" });
        return;
    }

    let userId: string;
    try {
        userId = verifyToken(header.slice("Bearer ".length)).id;
    } catch {
        res.status(401).json({ message: "Not authorized, token failed" });
        return;
    }

    const user = await User.findById(userId);
    if (!user) {
        res.status(401).json({ message: "User not found" });
        return;
    }

    req.user = user;
    next();
};
