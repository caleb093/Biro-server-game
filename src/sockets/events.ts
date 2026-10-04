import { Server, Socket } from "socket.io";
import { ArchetypeId } from "../game/archetypes";
import { Seat, Vec2 } from "../game/physics";
import { BiroPhase, RoundEndReason } from "../game/types";
import { MatchEndReason } from "../models/matchSchema";

// The socket protocol in one place. Copy these types to the frontend.
//
// Every client → server event takes (payload, ack). The ack always receives
//   { success: true, ...data }  or  { success: false, error: "ERROR_CODE" }.
// The server treats payloads as untrusted `unknown` and validates every field —
// the shapes in ClientPayloads are what a well-behaved client sends.

export interface ClientPayloads {
    ping_check: void;                                             // ack + pong_check: { serverTime } — for clock-offset estimation

    // Matchmaking + gameplay
    biro_find_match: void;
    biro_cancel_search: void;
    biro_get_state: void;                                         // ack: { match: MatchView | null, searching: boolean }
    biro_submit_setup: { matchId: string; archetype: ArchetypeId };
    biro_flick: { matchId: string; contact: Vec2; drag: Vec2 };   // contact = world point on your pen, drag = pointer end − start
    biro_forfeit: { matchId: string };

    // Challenges
    challenge_send: { username: string; archetype: ArchetypeId; message?: string }; // ack: { challenge }
    challenge_list: void;                                         // ack: { incoming: ChallengeView[], outgoing: ChallengeView[] }
    challenge_accept: { challengeId: string };                    // ack: { matchId }
    challenge_decline: { challengeId: string };
    challenge_cancel: { challengeId: string };
}

export type AckResponse = ({ success: true } & Record<string, unknown>) | { success: false; error: string };

export type ClientToServerEvents = {
    [K in keyof ClientPayloads]: (payload: unknown, ack?: (res: AckResponse) => void) => void;
};

// ── Views (what clients receive) ────────────────────────────────────────────

export interface PenView {
    player: Seat;
    archetype: ArchetypeId;
    x: number;
    y: number;
    angle: number;
    length: number;
    width: number;
    offTable: boolean;
}

export interface PlayerView {
    seat: Seat;
    userId: string;
    username: string;
    archetype: ArchetypeId | null; // opponent's pick stays hidden until setup ends
    ready: boolean;
    connected: boolean;
    reconnectBy: number | null;
}

export interface MatchView {
    id: string;
    phase: BiroPhase;
    you: Seat | null;
    players: [PlayerView, PlayerView];
    round: number;
    maxRounds: number;
    roundsToWin: number;
    scores: { p1: number; p2: number };
    turn: Seat;
    phaseEndsAt: number | null;  // epoch ms — setup deadline / turn deadline / playback end / next round
    roundEndsAt: number | null;  // epoch ms
    pens: PenView[];
}

export interface ChallengeView {
    id: string;
    from: { userId: string; username: string; online: boolean };
    to: { userId: string; username: string };
    archetype: ArchetypeId;
    message: string;
    createdAt: string;
    expiresAt: string;
}

export interface ServerToClientEvents {
    pong_check: (data: { serverTime: number }) => void;

    biro_match_found: (data: { match: MatchView }) => void;
    biro_player_ready: (data: { matchId: string; seat: Seat }) => void;
    biro_round_start: (data: { match: MatchView }) => void;
    biro_flick_resolved: (data: {
        matchId: string;
        seat: Seat;
        contact: Vec2;                 // where the server applied the flick (clamped onto the pen)
        drag: Vec2;                    // drag after the server's strength cap
        outcome: "none" | RoundEndReason;
        frames: number[][];            // [x1, y1, a1, x2, y2, a2] every frameMs — interpolate between them
        frameMs: number;
        durationMs: number;            // playback length incl. knockout reveal; hold the last frame after `frames` runs out
        pens: PenView[];               // final authoritative board — snap to this when playback ends
    }) => void;
    biro_turn: (data: { matchId: string; turn: Seat; phaseEndsAt: number; reason: "flick" | "timeout"; missedSeat?: Seat }) => void;
    biro_round_result: (data: {
        matchId: string;
        round: number;
        winnerSeat: Seat | null;       // null = drawn round
        reason: RoundEndReason;
        scores: { p1: number; p2: number };
        nextRoundAt: number | null;    // null when this was the last round
    }) => void;
    biro_match_completed: (data: {
        matchId: string;
        winnerSeat: Seat | null;       // null = drawn match
        winner: { userId: string; username: string } | null;
        reason: MatchEndReason;
        scores: { p1: number; p2: number };
    }) => void;
    biro_player_disconnected: (data: { matchId: string; seat: Seat; reconnectBy: number }) => void;
    biro_player_reconnected: (data: { matchId: string; seat: Seat }) => void;
    biro_resume: (data: { match: MatchView }) => void;

    challenge_received: (data: ChallengeView) => void;
    challenge_declined: (data: { challengeId: string; by: string }) => void;
    challenge_cancelled: (data: { challengeId: string }) => void;
}

export interface SocketData {
    user: { id: string; username: string };
}

export type IO = Server<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;
export type GameSocket = Socket<ClientToServerEvents, ServerToClientEvents, {}, SocketData>;

// Rooms
export const userRoom = (userId: string) => `user:${userId}`;
export const matchRoom = (matchId: string) => `match:${matchId}`;
