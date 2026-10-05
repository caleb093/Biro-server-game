import { Request, Response } from "express";
import User, { EMAIL_REGEX, USERNAME_REGEX, toPublicUser } from "../models/userSchema";
import { Limiter, tooManyRequests } from "../middleware/rateLimit";
import { DUMMY_PASSWORD_HASH, hashPassword, signToken, verifyPassword } from "../utils/auth";

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 128;
// 10 wrong passwords for one account → that account's logins pause for 15 minutes.
const failedLogins = new Limiter(10, 15 * 60_000);
const USERNAME_TAKEN = "Username is already taken";
const EMAIL_TAKEN = "That email is already in use. Leave it blank, or use another one.";

function readCredentials(body: unknown): { username: string; password: string } | null {
    if (typeof body !== "object" || body === null) return null;
    const { username, password } = body as Record<string, unknown>;
    if (typeof username !== "string" || typeof password !== "string") return null;
    return { username: username.trim(), password };
}

// Optional email on signup: undefined if omitted/blank, null if present but invalid.
function readEmail(body: unknown): string | null | undefined {
    const raw = (body as Record<string, unknown>)?.email;
    if (raw === undefined || raw === null) return undefined;
    if (typeof raw !== "string") return null;
    const email = raw.trim();
    if (!email) return undefined;
    return email.length <= 254 && EMAIL_REGEX.test(email) ? email : null;
}

// POST /api/auth/register  { username, password, email? }
export const register = async (req: Request, res: Response) => {
    const creds = readCredentials(req.body);
    if (!creds) {
        res.status(400).json({ message: "Username and password are required" });
        return;
    }
    const { username, password } = creds;
    const email = readEmail(req.body);
    if (email === null) {
        res.status(400).json({ message: "Please enter a valid email address, or leave it blank" });
        return;
    }

    if (!USERNAME_REGEX.test(username)) {
        res.status(400).json({ message: "Username must be 3–20 characters: letters, numbers or underscores" });
        return;
    }
    if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
        res.status(400).json({ message: `Password must be ${PASSWORD_MIN}–${PASSWORD_MAX} characters` });
        return;
    }

    if (await User.exists({ usernameLower: username.toLowerCase() })) {
        res.status(409).json({ message: USERNAME_TAKEN });
        return;
    }
    if (email && (await User.exists({ email: email.toLowerCase() }))) {
        res.status(409).json({ message: EMAIL_TAKEN });
        return;
    }

    try {
        const user = await User.create({ username, passwordHash: await hashPassword(password), ...(email ? { email } : {}) });
        res.status(201).json({ token: signToken(user._id.toString()), user: toPublicUser(user) });
    } catch (err: any) {
        // Lost a race with a simultaneous signup for the same name or email.
        if (err?.code === 11000) {
            res.status(409).json({ message: err.keyPattern?.email ? EMAIL_TAKEN : USERNAME_TAKEN });
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

    // Per account, so password guessing is capped however many IPs the guesser uses.
    const accountKey = creds.username.toLowerCase();
    const wait = failedLogins.blockedFor(accountKey);
    if (wait > 0) {
        tooManyRequests(res, wait);
        return;
    }

    const user = await User.findOne({ usernameLower: accountKey }).select("+passwordHash");
    // Always run a hash check, even for unknown usernames, so timing doesn't leak which exist.
    const valid = await verifyPassword(creds.password, user?.passwordHash ?? (await DUMMY_PASSWORD_HASH));

    if (!user || !valid) {
        failedLogins.hit(accountKey);
        res.status(401).json({ message: "Invalid username or password" });
        return;
    }

    failedLogins.reset(accountKey);
    res.json({ token: signToken(user._id.toString()), user: toPublicUser(user) });
};

// GET /api/auth/me  (protected)
export const me = async (req: Request, res: Response) => {
    res.json({ user: toPublicUser(req.user!) });
};
