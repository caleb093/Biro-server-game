import { randomUUID } from "crypto";
import { ArchetypeId, DEFAULT_ARCHETYPE } from "../game/archetypes";
import {
    Pen,
    Seat,
    Vec2,
    WORLD_TABLE,
    FLICK_IMPULSE_SCALE,
    FLICK_MAX_DRAG,
    FLICK_MIN_DRAG,
    PLAYBACK_FRAME_MS,
    clampToPenBody,
    placePens,
    pointOnPen,
    simulateFlick,
} from "../game/physics";
import { BiroMatch, BiroPlayer, RoundEndReason } from "../game/types";
import { MatchEndReason } from "../models/matchSchema";
import { recordMatchResult } from "../services/matchResults";
import { GameSocket, IO, MatchView, PenView, matchRoom, userRoom } from "../sockets/events";

// ── Rules & timings ─────────────────────────────────────────────────────────
export const ROUNDS_TO_WIN = 2;              // first to 2 round wins takes the match…
export const MAX_ROUNDS = 3;                 // …but at most 3 rounds (drawn rounds count)
export const SETUP_DURATION_MS = 30_000;     // pick a biro; defaults applied on expiry
export const TURN_DURATION_MS = 30_000;      // time to flick; turn passes on expiry
export const MAX_MISSED_TURNS = 3;           // consecutive timeouts → forfeit (AFK)
export const ROUND_DURATION_MS = 4 * 60_000; // round clock; drawn round on expiry
export const ROUND_INTERMISSION_MS = 3_500;  // pause to show the round result
export const RECONNECT_GRACE_MS = 30_000;    // disconnected player loses after this
const GRAB_SLACK = 12;                       // how far off the pen body a grab may land

export interface PlayerIdentity {
    userId: string;
    username: string;
}

export type Result<T extends object = {}> = ({ ok: true } & T) | { ok: false; error: string };

const other = (seat: Seat): Seat => (seat === 1 ? 2 : 1);

// Owns every live match, in memory. All state changes go through here, and
// every one of them is validated against the current phase/turn — clients only
// ever send intents (pick a biro, flick from here with this drag, forfeit).
//
// One timer per match (phaseTimer) drives the state machine, since only one
// phase deadline is ever live at a time:
//
//   setup ──(both ready / timeout)──▶ aim ◀──(no knockout)── settling
//                                      │                        ▲
//                                      └───────(flick)──────────┘
//   settling ──(knockout / time)──▶ round-over ──(intermission)──▶ aim (next round)
//                                      └──(match decided)──▶ complete
//
// Each player additionally gets a reconnect-grace timer while disconnected.
class MatchManager {
    private io: IO | null = null;
    private matches = new Map<string, BiroMatch>();
    private matchIdByUser = new Map<string, string>();
    private completedListeners: ((match: BiroMatch) => void)[] = [];

    init(io: IO) {
        this.io = io;
    }

    // Called after a match ends and its players are free again (e.g. challenge holds).
    onCompleted(listener: (match: BiroMatch) => void) {
        this.completedListeners.push(listener);
    }

    private get server(): IO {
        if (!this.io) throw new Error("MatchManager used before init(io)");
        return this.io;
    }

    // ── Lookups ─────────────────────────────────────────────────────────────

    getMatchForUser(userId: string): BiroMatch | undefined {
        const id = this.matchIdByUser.get(userId);
        return id ? this.matches.get(id) : undefined;
    }

    isInMatch(userId: string): boolean {
        return this.matchIdByUser.has(userId);
    }

    // Live matches (finished ones are removed from memory straight away).
    get activeCount(): number {
        return this.matches.size;
    }

    private playerOf(match: BiroMatch, userId: string): BiroPlayer | undefined {
        return match.players.find((p) => p.userId === userId);
    }

    // Resolve the match + the caller's seat, with the standard errors.
    private resolve(matchId: string, userId: string): Result<{ match: BiroMatch; player: BiroPlayer }> {
        const match = this.matches.get(matchId);
        if (!match) return { ok: false, error: "MATCH_NOT_FOUND" };
        const player = this.playerOf(match, userId);
        if (!player) return { ok: false, error: "NOT_IN_MATCH" };
        return { ok: true, match, player };
    }

    // ── Creation & setup ────────────────────────────────────────────────────

    // Pair two online players. Seats are assigned randomly; seat 1 flicks first.
    // `presetArchetypes` lets a challenger skip setup (they chose when sending).
    createMatch(
        a: PlayerIdentity,
        b: PlayerIdentity,
        opts: { source: BiroMatch["source"]; presetArchetypes?: Record<string, ArchetypeId> }
    ): BiroMatch {
        if (a.userId === b.userId) throw new Error("Cannot create a match against yourself");
        if (this.isInMatch(a.userId) || this.isInMatch(b.userId)) throw new Error("PLAYER_ALREADY_IN_MATCH");

        const [first, second] = Math.random() < 0.5 ? [a, b] : [b, a];
        const makePlayer = (p: PlayerIdentity, seat: Seat): BiroPlayer => {
            const preset = opts.presetArchetypes?.[p.userId] ?? null;
            return {
                userId: p.userId,
                username: p.username,
                seat,
                archetype: preset,
                ready: preset !== null,
                missedTurns: 0,
                disconnectedAt: null,
                reconnectBy: null,
            };
        };

        const now = Date.now();
        const match: BiroMatch = {
            id: randomUUID(),
            source: opts.source,
            createdAt: now,
            status: "active",
            phase: "setup",
            players: [makePlayer(first, 1), makePlayer(second, 2)],
            round: 1,
            scores: { p1: 0, p2: 0 },
            turn: 1,
            pens: [],
            phaseEndsAt: now + SETUP_DURATION_MS,
            roundEndsAt: null,
            pendingOutcome: null,
        };

        this.matches.set(match.id, match);
        for (const p of match.players) {
            this.matchIdByUser.set(p.userId, match.id);
            this.server.in(userRoom(p.userId)).socketsJoin(matchRoom(match.id));
        }

        this.schedule(match, SETUP_DURATION_MS, () => this.onSetupTimeout(match));
        for (const p of match.players) {
            this.server.to(userRoom(p.userId)).emit("biro_match_found", { match: this.view(match, p.userId) });
        }

        console.log(`[match] ${match.id} created (${match.source}): ${match.players[0].username} vs ${match.players[1].username}`);
        return match;
    }

    submitSetup(matchId: string, userId: string, archetype: ArchetypeId): Result {
        const r = this.resolve(matchId, userId);
        if (!r.ok) return r;
        const { match, player } = r;

        if (match.phase !== "setup") return { ok: false, error: "NOT_IN_SETUP" };
        if (player.ready) return { ok: false, error: "ALREADY_READY" };

        player.archetype = archetype;
        player.ready = true;
        this.server.to(matchRoom(match.id)).emit("biro_player_ready", { matchId: match.id, seat: player.seat });

        if (match.players.every((p) => p.ready)) this.startRound(match, 1);
        return { ok: true };
    }

    private onSetupTimeout(match: BiroMatch) {
        if (match.phase !== "setup") return;
        // Casual game: a slow picker gets the default biro rather than losing.
        for (const p of match.players) {
            if (!p.ready) {
                p.archetype = DEFAULT_ARCHETYPE;
                p.ready = true;
            }
        }
        this.startRound(match, 1);
    }

    // ── Rounds & turns ──────────────────────────────────────────────────────

    private startRound(match: BiroMatch, startingSeat: Seat) {
        if (match.status !== "active") return;
        const [p1, p2] = match.players;
        match.pens = placePens(p1.archetype ?? DEFAULT_ARCHETYPE, p2.archetype ?? DEFAULT_ARCHETYPE);
        match.turn = startingSeat;
        match.pendingOutcome = null;
        match.roundEndsAt = Date.now() + ROUND_DURATION_MS;
        this.beginTurn(match);

        for (const p of match.players) {
            this.server.to(userRoom(p.userId)).emit("biro_round_start", { match: this.view(match, p.userId) });
        }
    }

    // Open the aim phase for match.turn. The single timer fires at whichever
    // comes first: the turn deadline or the round clock.
    private beginTurn(match: BiroMatch) {
        const now = Date.now();
        match.phase = "aim";
        match.phaseEndsAt = now + TURN_DURATION_MS;
        const fireAt = Math.min(match.phaseEndsAt, match.roundEndsAt ?? Infinity);
        this.schedule(match, fireAt - now, () => this.onAimTimeout(match));
    }

    private onAimTimeout(match: BiroMatch) {
        if (match.phase !== "aim") return;

        if (match.roundEndsAt !== null && match.roundEndsAt <= (match.phaseEndsAt ?? Infinity)) {
            this.concludeRound(match, null, "time");
            return;
        }

        const missedSeat = match.turn;
        const player = match.players[missedSeat - 1];
        player.missedTurns += 1;
        if (player.missedTurns >= MAX_MISSED_TURNS) {
            this.completeMatch(match, other(missedSeat), "afk");
            return;
        }

        match.turn = other(missedSeat);
        this.beginTurn(match);
        this.server.to(matchRoom(match.id)).emit("biro_turn", {
            matchId: match.id,
            turn: match.turn,
            phaseEndsAt: match.phaseEndsAt!,
            reason: "timeout",
            missedSeat,
        });
    }

    // The authoritative turn. The client only says where it grabbed its pen and
    // how far it dragged; the server checks the grab, derives + caps the
    // strength itself, simulates to rest, and broadcasts the result.
    flick(matchId: string, userId: string, contact: Vec2, drag: Vec2): Result {
        const r = this.resolve(matchId, userId);
        if (!r.ok) return r;
        const { match, player } = r;

        if (match.phase !== "aim") return { ok: false, error: "NOT_AIMING" };
        if (match.turn !== player.seat) return { ok: false, error: "NOT_YOUR_TURN" };

        const actor = match.pens.find((p) => p.player === player.seat);
        if (!actor) return { ok: false, error: "NO_BOARD" };
        if (!pointOnPen(actor, contact, GRAB_SLACK)) return { ok: false, error: "GRAB_OFF_PEN" };

        const rawMag = Math.hypot(drag.x, drag.y);
        if (rawMag < FLICK_MIN_DRAG) return { ok: false, error: "FLICK_TOO_SMALL" };
        const mag = Math.min(rawMag, FLICK_MAX_DRAG);
        const cappedDrag = { x: (drag.x / rawMag) * mag, y: (drag.y / rawMag) * mag };

        const clampedContact = clampToPenBody(actor, contact);
        const sim = simulateFlick(match.pens, WORLD_TABLE, {
            seat: player.seat,
            contact: clampedContact,
            direction: { x: -drag.x, y: -drag.y }, // slingshot: fire opposite the drag
            strength: mag * FLICK_IMPULSE_SCALE,
        });

        player.missedTurns = 0;
        match.pendingOutcome =
            sim.outcome.kind === "knockout" ? { winnerSeat: other(sim.outcome.loser), reason: "knockout" }
            : sim.outcome.kind === "double_knockout" ? { winnerSeat: null, reason: "double_knockout" }
            : null;
        match.phase = "settling";
        match.phaseEndsAt = Date.now() + sim.durationMs;

        this.server.to(matchRoom(match.id)).emit("biro_flick_resolved", {
            matchId: match.id,
            seat: player.seat,
            contact: clampedContact,
            drag: cappedDrag,
            outcome: sim.outcome.kind === "none" ? "none" : match.pendingOutcome!.reason,
            frames: sim.frames,
            frameMs: PLAYBACK_FRAME_MS,
            durationMs: sim.durationMs,
            pens: match.pens.map(penView),
        });

        // Wait for clients to finish the playback before moving on.
        this.schedule(match, sim.durationMs, () => this.onSettled(match));
        return { ok: true };
    }

    private onSettled(match: BiroMatch) {
        if (match.phase !== "settling") return;

        const pending = match.pendingOutcome;
        match.pendingOutcome = null;
        if (pending) {
            this.concludeRound(match, pending.winnerSeat, pending.reason);
            return;
        }
        if (match.roundEndsAt !== null && Date.now() >= match.roundEndsAt) {
            this.concludeRound(match, null, "time");
            return;
        }

        match.turn = other(match.turn);
        this.beginTurn(match);
        this.server.to(matchRoom(match.id)).emit("biro_turn", {
            matchId: match.id,
            turn: match.turn,
            phaseEndsAt: match.phaseEndsAt!,
            reason: "flick",
        });
    }

    private concludeRound(match: BiroMatch, winnerSeat: Seat | null, reason: RoundEndReason) {
        if (winnerSeat === 1) match.scores.p1 += 1;
        else if (winnerSeat === 2) match.scores.p2 += 1;

        const { p1, p2 } = match.scores;
        const matchOver = p1 >= ROUNDS_TO_WIN || p2 >= ROUNDS_TO_WIN || match.round >= MAX_ROUNDS;

        match.phase = "round-over";
        match.roundEndsAt = null;
        match.phaseEndsAt = matchOver ? null : Date.now() + ROUND_INTERMISSION_MS;

        this.server.to(matchRoom(match.id)).emit("biro_round_result", {
            matchId: match.id,
            round: match.round,
            winnerSeat,
            reason,
            scores: { ...match.scores },
            nextRoundAt: match.phaseEndsAt,
        });

        if (matchOver) {
            this.completeMatch(match, p1 > p2 ? 1 : p2 > p1 ? 2 : null, "normal");
            return;
        }

        // Loser starts the next round (as on the frontend); after a draw, the
        // other player from whoever acted last.
        const nextStarter = winnerSeat ? other(winnerSeat) : other(match.turn);
        match.round += 1;
        this.schedule(match, ROUND_INTERMISSION_MS, () => this.startRound(match, nextStarter));
    }

    // ── Ending ──────────────────────────────────────────────────────────────

    forfeit(matchId: string, userId: string): Result {
        const r = this.resolve(matchId, userId);
        if (!r.ok) return r;
        this.completeMatch(r.match, other(r.player.seat), "forfeit");
        return { ok: true };
    }

    private completeMatch(match: BiroMatch, winnerSeat: Seat | null, reason: MatchEndReason) {
        if (match.status === "complete") return;

        this.clearPhaseTimer(match);
        for (const p of match.players) {
            if (p.graceTimer) clearTimeout(p.graceTimer);
            p.graceTimer = undefined;
        }

        match.status = "complete";
        match.phase = "complete";
        match.endReason = reason;
        match.phaseEndsAt = null;
        match.roundEndsAt = null;

        const winner = winnerSeat ? match.players[winnerSeat - 1] : null;
        const room = matchRoom(match.id);
        this.server.to(room).emit("biro_match_completed", {
            matchId: match.id,
            winnerSeat,
            winner: winner ? { userId: winner.userId, username: winner.username } : null,
            reason,
            scores: { ...match.scores },
        });

        this.matches.delete(match.id);
        for (const p of match.players) {
            if (this.matchIdByUser.get(p.userId) === match.id) this.matchIdByUser.delete(p.userId);
        }
        this.server.in(room).socketsLeave(room);

        console.log(`[match] ${match.id} complete (${reason}) — ${winner ? `${winner.username} wins` : "draw"} ${match.scores.p1}-${match.scores.p2}`);
        void recordMatchResult({
            matchId: match.id,
            source: match.source,
            players: match.players.map((p) => ({ userId: p.userId, username: p.username, seat: p.seat, archetype: p.archetype })),
            winnerUserId: winner?.userId ?? null,
            scores: { ...match.scores },
            rounds: match.round,
            endReason: reason,
            startedAt: new Date(match.createdAt),
            endedAt: new Date(),
        }).catch((err) => console.error(`[match] gave up saving the result for ${match.id}:`, err));

        for (const listener of this.completedListeners) {
            try {
                listener(match);
            } catch (err) {
                console.error(`[match] completion listener failed for ${match.id}:`, err);
            }
        }
    }

    // ── Connection lifecycle (called from sockets/index.ts) ─────────────────

    // Any new socket for a user in a match joins its room and gets a snapshot.
    handleConnect(socket: GameSocket, userId: string) {
        const match = this.getMatchForUser(userId);
        if (!match) return;
        const player = this.playerOf(match, userId)!;

        socket.join(matchRoom(match.id));

        if (player.disconnectedAt !== null) {
            if (player.graceTimer) clearTimeout(player.graceTimer);
            player.graceTimer = undefined;
            player.disconnectedAt = null;
            player.reconnectBy = null;
            this.server.to(matchRoom(match.id)).emit("biro_player_reconnected", { matchId: match.id, seat: player.seat });
        }

        socket.emit("biro_resume", { match: this.view(match, userId) });
    }

    // Called when a user's LAST socket goes away. Game timers keep running —
    // a disconnected player's turns time out like anyone else's.
    handleDisconnect(userId: string) {
        const match = this.getMatchForUser(userId);
        if (!match) return;
        const player = this.playerOf(match, userId)!;
        if (player.disconnectedAt !== null) return;

        const now = Date.now();
        player.disconnectedAt = now;
        player.reconnectBy = now + RECONNECT_GRACE_MS;
        player.graceTimer = setTimeout(() => this.onGraceExpired(match, player), RECONNECT_GRACE_MS);

        this.server.to(matchRoom(match.id)).emit("biro_player_disconnected", {
            matchId: match.id,
            seat: player.seat,
            reconnectBy: player.reconnectBy,
        });
    }

    private onGraceExpired(match: BiroMatch, player: BiroPlayer) {
        player.graceTimer = undefined;
        if (match.status !== "active" || player.disconnectedAt === null) return;
        const opponent = match.players[other(player.seat) - 1];
        if (opponent.disconnectedAt !== null) this.completeMatch(match, null, "abandoned");
        else this.completeMatch(match, opponent.seat, "disconnect");
    }

    // ── Views ───────────────────────────────────────────────────────────────

    viewForUser(userId: string): MatchView | null {
        const match = this.getMatchForUser(userId);
        return match ? this.view(match, userId) : null;
    }

    // Client-safe snapshot. No timer handles; the opponent's biro stays hidden
    // until setup is over.
    private view(match: BiroMatch, viewerId: string): MatchView {
        const you = this.playerOf(match, viewerId)?.seat ?? null;
        const playerView = (p: BiroPlayer) => ({
            seat: p.seat,
            userId: p.userId,
            username: p.username,
            archetype: match.phase === "setup" && p.seat !== you ? null : p.archetype,
            ready: p.ready,
            connected: p.disconnectedAt === null,
            reconnectBy: p.reconnectBy,
        });
        return {
            id: match.id,
            phase: match.phase,
            you,
            players: [playerView(match.players[0]), playerView(match.players[1])],
            round: match.round,
            maxRounds: MAX_ROUNDS,
            roundsToWin: ROUNDS_TO_WIN,
            scores: { ...match.scores },
            turn: match.turn,
            phaseEndsAt: match.phaseEndsAt,
            roundEndsAt: match.roundEndsAt,
            pens: match.pens.map(penView),
        };
    }

    // ── Timer plumbing ──────────────────────────────────────────────────────

    private schedule(match: BiroMatch, delayMs: number, fn: () => void) {
        this.clearPhaseTimer(match);
        match.phaseTimer = setTimeout(() => {
            match.phaseTimer = undefined;
            if (match.status !== "active") return;
            try {
                fn();
            } catch (err) {
                console.error(`[match] timer handler failed for ${match.id}:`, err);
            }
        }, Math.max(0, delayMs));
    }

    private clearPhaseTimer(match: BiroMatch) {
        if (match.phaseTimer) clearTimeout(match.phaseTimer);
        match.phaseTimer = undefined;
    }
}

function penView(p: Pen): PenView {
    return {
        player: p.player,
        archetype: p.archetype,
        x: p.pos.x,
        y: p.pos.y,
        angle: p.angle,
        length: p.length,
        width: p.width,
        offTable: p.offTable,
    };
}

export const matchManager = new MatchManager();
