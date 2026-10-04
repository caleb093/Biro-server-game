import { randomBytes, scrypt, timingSafeEqual } from "crypto";
import { promisify } from "util";
import jwt, { SignOptions } from "jsonwebtoken";
import { env } from "../config/env";

const scryptAsync = promisify(scrypt) as (password: string, salt: Buffer, keylen: number) => Promise<Buffer>;
const KEY_LENGTH = 64;

// Stored as "salt:hash" (hex). scrypt is memory-hard and ships with Node.
export async function hashPassword(password: string): Promise<string> {
    const salt = randomBytes(16);
    const hash = await scryptAsync(password, salt, KEY_LENGTH);
    return `${salt.toString("hex")}:${hash.toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string): Promise<boolean> {
    const [saltHex, hashHex] = stored.split(":");
    if (!saltHex || !hashHex) return false;
    const expected = Buffer.from(hashHex, "hex");
    const actual = await scryptAsync(password, Buffer.from(saltHex, "hex"), expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// A real hash of a throwaway password: login runs verifyPassword against it
// when the username doesn't exist, so response time doesn't reveal which
// usernames are taken.
export const DUMMY_PASSWORD_HASH = hashPassword(randomBytes(16).toString("hex"));

export interface TokenPayload {
    id: string;
}

export function signToken(userId: string): string {
    return jwt.sign({ id: userId } satisfies TokenPayload, env.jwtSecret, {
        expiresIn: env.jwtExpiresIn as SignOptions["expiresIn"],
    });
}

// Throws if the token is invalid or expired.
export function verifyToken(token: string): TokenPayload {
    const decoded = jwt.verify(token, env.jwtSecret);
    if (typeof decoded !== "object" || typeof decoded.id !== "string") throw new Error("Malformed token");
    return { id: decoded.id };
}
