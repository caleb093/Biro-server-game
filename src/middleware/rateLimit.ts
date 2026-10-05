import { NextFunction, Request, Response } from "express";

// Fixed-window counters kept in memory. Fine for a single server instance; with
// several instances each keeps its own counts (move this to Redis if you scale out).
export class Limiter {
    private hits = new Map<string, { count: number; resetAt: number }>();

    constructor(private max: number, private windowMs: number) {
        // Drop expired windows now and then so the map can't grow forever.
        setInterval(() => {
            const now = Date.now();
            for (const [key, entry] of this.hits) if (entry.resetAt <= now) this.hits.delete(key);
        }, windowMs).unref();
    }

    // Seconds until `key` may try again, or 0 if it isn't blocked.
    blockedFor(key: string): number {
        const entry = this.hits.get(key);
        if (!entry || entry.resetAt <= Date.now() || entry.count < this.max) return 0;
        return Math.ceil((entry.resetAt - Date.now()) / 1000);
    }

    hit(key: string) {
        const now = Date.now();
        const entry = this.hits.get(key);
        if (!entry || entry.resetAt <= now) this.hits.set(key, { count: 1, resetAt: now + this.windowMs });
        else entry.count += 1;
    }

    reset(key: string) {
        this.hits.delete(key);
    }
}

export function tooManyRequests(res: Response, retryAfterSec: number) {
    const minutes = Math.max(1, Math.ceil(retryAfterSec / 60));
    res.set("Retry-After", String(retryAfterSec));
    res.status(429).json({ message: `Too many attempts. Please try again in ${minutes} minute${minutes === 1 ? "" : "s"}.` });
}

// Counts every request from one IP. Relies on `trust proxy` being set correctly
// (see index.ts), otherwise every player shares the proxy's IP.
export function limitByIp(limiter: Limiter) {
    return (req: Request, res: Response, next: NextFunction) => {
        const key = req.ip ?? "unknown";
        const wait = limiter.blockedFor(key);
        if (wait > 0) {
            console.warn(`[rate-limit] ${req.method} ${req.path} blocked for ip=${key}`);
            tooManyRequests(res, wait);
            return;
        }
        limiter.hit(key);
        next();
    };
}
