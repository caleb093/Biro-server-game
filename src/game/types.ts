import { ArchetypeId } from "./archetypes";
import { Pen, Seat } from "./physics";
import { MatchEndReason } from "../models/matchSchema";

// Phases of a live match:
//   setup      — both players pick a biro (countdown; defaults applied on expiry)
//   aim        — `turn` player may flick (turn countdown)
//   settling   — a flick was simulated; clients are playing it back
//   round-over — round decided; short intermission before the next placement
//   complete   — match over (the match is removed from memory right after)
export type BiroPhase = "setup" | "aim" | "settling" | "round-over" | "complete";

export interface BiroPlayer {
    userId: string;
    username: string;
    seat: Seat;
    archetype: ArchetypeId | null;
    ready: boolean;              // setup submitted
    missedTurns: number;         // consecutive turn timeouts (AFK detection)
    disconnectedAt: number | null;
    reconnectBy: number | null;  // grace deadline while disconnected

    // runtime only — never sent to clients
    graceTimer?: NodeJS.Timeout;
}

export interface BiroMatch {
    id: string;
    source: "matchmaking" | "challenge";
    createdAt: number;
    status: "active" | "complete";
    phase: BiroPhase;

    players: [BiroPlayer, BiroPlayer]; // index 0 = seat 1, index 1 = seat 2
    round: number;
    scores: { p1: number; p2: number };
    turn: Seat;                  // whose flick it is (or was, while settling)
    pens: Pen[];                 // authoritative board; empty during setup

    phaseEndsAt: number | null;  // deadline of the current phase (setup / turn / playback / intermission)
    roundEndsAt: number | null;  // per-round clock; drawn round when it runs out
    pendingOutcome: { winnerSeat: Seat | null; reason: RoundEndReason } | null; // decided while settling

    endReason?: MatchEndReason;

    // runtime only — never sent to clients
    phaseTimer?: NodeJS.Timeout;
}

export type RoundEndReason = "knockout" | "double_knockout" | "time";
