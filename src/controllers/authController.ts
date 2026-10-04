import { Request, Response } from "express";
import User, { USERNAME_REGEX, toPublicUser } from "../models/userSchema";
import { DUMMY_PASSWORD_HASH, hashPassword, signToken, verifyPassword } from "../utils/auth";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;

function readCredentials(body: unknown): { username: string; password: string } | null {
    if (typeof body !== "object" || body === null) return null;
    const { username, password } = body as Record<string, unknown>;
    if (typeof username !== "string" || typeof password !== "string") return null;
    return { username: username.trim(), password };
}

// POST /api/auth/register  { username, password }
export const register = async (req: Request, res: Response) => {
    const creds = readCredentials(req.body);
    if (!creds) {
        res.status(400).json({ message: "Username and password are required" });
        return;
    }
    const { username, password } = creds;

    if (!USERNAME_REGEX.test(username)) {
        res.status(400).json({ message: "Username must be 3–20 characters: letters, numbers or underscores" });
        return;
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        res.status(400).json({ message: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters` });
        return;
    }

    if (await User.exists({ usernameLower: username.toLowerCase() })) {
        res.status(409).json({ message: "Username is already taken" });
        return;
    }

    try {
        const user = await User.create({ username, passwordHash: await hashPassword(password) });
        res.status(201).json({ token: signToken(user._id.toString()), user: toPublicUser(user) });
    } catch (err: any) {
        // Lost a race with a simultaneous signup for the same name.
        if (err?.code === 11000) {
            res.status(409).json({ message: "Username is already taken" });
            return;
        }
        throw err;
    }
};

// POST /api/auth/login  { username, password }
export const login = async (req: Request, res: Response) => {
    const creds = readCredentials(req.body);
    if (!creds || creds.password.length > PASSWORD_MAX) {
        res.status(400).json({ message: "Username and password are required" });
        return;
    }

    const user = await User.findOne({ usernameLower: creds.username.toLowerCase() }).select("+passwordHash");
    // Always run a hash check, even for unknown usernames, so timing doesn't leak which exist.
    const valid = await verifyPassword(creds.password, user?.passwordHash ?? (await DUMMY_PASSWORD_HASH));

    if (!user || !valid) {
        res.status(401).json({ message: "Invalid username or password" });
        return;
    }

    res.json({ token: signToken(user._id.toString()), user: toPublicUser(user) });
};

// GET /api/auth/me  (protected)
export const me = async (req: Request, res: Response) => {
    res.json({ user: toPublicUser(req.user!) });
};
