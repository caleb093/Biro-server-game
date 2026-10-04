import { AckResponse, ClientPayloads, GameSocket } from "./events";
import { Vec2 } from "../game/physics";

// Flood guard: at most RATE_LIMIT calls of one event per socket per RATE_WINDOW_MS.
// Normal play is a handful of events per turn; this only bites on spam.
const RATE_LIMIT = 30;
const RATE_WINDOW_MS = 5_000;

// Register a client → server event. Handlers get the raw (untrusted) payload
// and return an AckResponse; this wrapper delivers it to the client's ack
// (if they sent one), and turns thrown errors into INTERNAL_ERROR instead of
// unhandled rejections.
export function on(
    socket: GameSocket,
    event: keyof ClientPayloads,
    handler: (payload: unknown) => AckResponse | Promise<AckResponse>
) {
    let windowStart = 0;
    let count = 0;

    socket.on(event, async (payload: unknown, ack?: unknown) => {
        const reply = typeof ack === "function" ? (ack as (res: AckResponse) => void) : () => {};

        const now = Date.now();
        if (now - windowStart > RATE_WINDOW_MS) {
            windowStart = now;
            count = 0;
        }
        if (++count > RATE_LIMIT) return reply(fail("RATE_LIMITED"));

        try {
            reply(await handler(payload));
        } catch (err) {
            console.error(`[socket] "${event}" failed for ${socket.data.user.username}:`, err);
            reply(fail("INTERNAL_ERROR"));
        }
    });
}

export const ok = (data: Record<string, unknown> = {}): AckResponse => ({ success: true, ...data });
export const fail = (error: string): AckResponse => ({ success: false, error });

// Turn a manager Result into an ack.
export const toAck = (r: { ok: true } | { ok: false; error: string }, data: Record<string, unknown> = {}): AckResponse =>
    r.ok ? ok(data) : fail(r.error);

// ── Validators — payloads are untrusted ─────────────────────────────────────

export const isObject = (v: unknown): v is Record<string, unknown> =>
    typeof v === "object" && v !== null && !Array.isArray(v);

export const isNonEmptyString = (v: unknown, max = 200): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max;

// Finite numbers within a sane range (the world is 1800×860; anything far
// outside is garbage, and huge values could overflow the maths).
export const isVec2 = (v: unknown): v is Vec2 =>
    isObject(v) &&
    typeof v.x === "number" && typeof v.y === "number" &&
    Number.isFinite(v.x) && Number.isFinite(v.y) &&
    Math.abs(v.x) < 10_000 && Math.abs(v.y) < 10_000;
