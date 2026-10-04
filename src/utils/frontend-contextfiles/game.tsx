import React, { FC, useCallback, useContext, useEffect, useRef, useState } from "react";
import { appContext } from "@/contexts/appContext";
import {
    Pen,
    Table,
    Vec2,
    applyFlick,
    clampToPenBody,
    collidePens,
    createPen,
    isResting,
    offTableFraction,
    penRadius,
    pointOnPen,
    stepPen,
} from "./physics";
import type { PenFightMode, Setups } from "./index";
import {
    FREEZE_STRENGTH_MULT,
    POWER_SHOT_MULT,
    POWER_UP_MAP,
    PowerUpId,
    SPIN_KICK,
} from "./power-ups";
import { ARCHETYPE_MAP, ArchetypeId } from "./archetypes";
import { BiroSprite, loadBiroSprite } from "./biro-sprites";
import { buildDeskTexture } from "./desk-texture";
import { CARD_BG, INK, MUTED, NAIJA_GREEN, PAPER, PAPER_LINE, MARGIN_RED, TEXT, markerFont, sticker } from "./theme";

const FREEZE_BLUE = "#2b8fcf";
const DRAW_AMBER = "#d98f00";

const ROUNDS_TO_WIN = 2;       // first to 2 wins the best-of-3
const FLICK_IMPULSE_SCALE = 9; // converts drag (world units) into impulse magnitude
const FLICK_MAX_DRAG = 180;    // world units — cap so the flick can't get silly
const PHYSICS_SUBSTEPS = 4;    // baseline floor: run physics at 4x render rate
const MAX_STEP_DIST = 3;       // world units a pen may move per substep before we add more (anti-tunneling)
const MAX_SUBSTEPS = 32;       // hard cap so an extreme flick can't stall the frame

// The whole simulation lives in a FIXED logical coordinate space ("world units")
// that never changes with screen size. The canvas merely scales this world to fit
// (aspect-preserved + letterboxed), so a flick covers the exact same fraction of
// the table on a phone, a laptop or a 4K monitor. Crucially this also keeps game
// state device-independent — a prerequisite for online PvP where two screens must
// agree on positions, velocities and flick strengths.
const WORLD_W = 1800;
const WORLD_H = 860;
const TABLE_PAD = 38; // world-unit frame around the table so a pen can slide visibly off
const WORLD_TABLE: Table = {
    x: TABLE_PAD,
    y: TABLE_PAD,
    w: WORLD_W - TABLE_PAD * 2,
    h: WORLD_H - TABLE_PAD * 2,
};

// Knockout tuning. A pen is knocked out when its center of mass crosses the edge.
// offTableFraction() then reports how much of the body has gone over (0.5 = center
// on the edge, 1.0 = entirely off) so we can tell a clean fall from a teeter.
const FULL_OFF_FRACTION = 0.9;   // ≥90% across = clean fall → show the result immediately
const KNOCKOUT_REVEAL_MS = 900;  // teetering over the edge → pause so everyone sees it first

type Phase = "aim" | "settling" | "round-over" | "match-over";

type RoundResult =
    | { kind: "win"; winner: 1 | 2; loser: 1 | 2 }
    | { kind: "draw" };

// While a round is settling we may know the outcome but hold it back briefly so
// players can clearly see a pen hanging over the edge (the "reveal" delay).
type PendingOutcome =
    | { kind: "loss"; winner: 1 | 2; loser: 1 | 2; concludeAt: number }
    | { kind: "draw"; concludeAt: number };

const PenFightGame: FC<{ onExit: () => void; mode: PenFightMode; setups: Setups }> = ({ onExit, mode, setups }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);
    const { playSfx } = useContext(appContext);

    // The chosen power-ups per player (derived from the pre-match setup) feed the rails.
    // POWER-UPS DISABLED
    // const loadouts = { 1: setups[1].loadout, 2: setups[2].loadout };

    // Render state — drives UI overlays.
    const [phase, setPhase] = useState<Phase>("aim");
    const [turn, setTurn] = useState<1 | 2>(1);
    const [scores, setScores] = useState<{ p1: number; p2: number }>({ p1: 0, p2: 0 });
    const [round, setRound] = useState(1);
    const [lastResult, setLastResult] = useState<RoundResult | null>(null);
    const [matchWinner, setMatchWinner] = useState<1 | 2 | null>(null);

    // Hot-path mutable state — anything updated per-frame lives in refs so React
    // doesn't re-render the canvas while physics is running.
    const pensRef = useRef<Pen[]>([]);
    // The table is fixed in world units and never changes — only the viewport that
    // maps world → canvas does (recomputed on resize).
    const tableRef = useRef<Table>({ ...WORLD_TABLE });
    const canvasSizeRef = useRef<{ w: number; h: number }>({ w: 800, h: 560 });
    const viewportRef = useRef<{ scale: number; ox: number; oy: number }>({ scale: 1, ox: 0, oy: 0 });
    const turnRef = useRef<1 | 2>(1);
    const phaseRef = useRef<Phase>("aim");
    const rafRef = useRef<number | null>(null);
    const lastTsRef = useRef<number>(0);
    const pendingRef = useRef<PendingOutcome | null>(null);

    // Drag/aim state
    const dragStartRef = useRef<Vec2 | null>(null);
    const dragCurrentRef = useRef<Vec2 | null>(null);
    const dragLocalContactRef = useRef<Vec2 | null>(null); // world point on the pen body
    const draggingPenRef = useRef<Pen | null>(null);

    // -------- POWER-UP STATE --------
    // Refs are the source of truth for the hot path (flick + knockout); the
    // mirrored React state drives the rail UI. Each power-up can be spent once
    // per match, so `used` persists across rounds (reset only on Play Again).
    const usedRef = useRef<{ 1: Set<PowerUpId>; 2: Set<PowerUpId> }>({ 1: new Set(), 2: new Set() });
    const armedRef = useRef<Set<PowerUpId>>(new Set());          // current player's self-buffs queued for their flick
    const shieldRef = useRef<{ 1: boolean; 2: boolean }>({ 1: false, 2: false }); // shield up, awaiting a save
    const shieldSavedRef = useRef<{ player: 1 | 2; at: number } | null>(null);     // drives a brief on-canvas save flash
    const flickScaleRef = useRef<{ 1: number; 2: number }>({ 1: 1, 2: 1 });        // freeze debuff on a player's next flick

    const [usedState, setUsedState] = useState<{ 1: PowerUpId[]; 2: PowerUpId[] }>({ 1: [], 2: [] });
    const [armedState, setArmedState] = useState<PowerUpId[]>([]);
    const [shieldState, setShieldState] = useState<{ 1: boolean; 2: boolean }>({ 1: false, 2: false });

    // Biro pictures (trimmed + measured), keyed by biro. Until one loads — or if a
    // biro has no PNG yet — drawPen falls back to a drawn biro.
    const spritesRef = useRef<Partial<Record<ArchetypeId, BiroSprite | null>>>({});
    // Wooden desk texture, generated on first render — and once more after the
    // marker font loads, so the carvings never get baked in with a fallback font.
    const deskRef = useRef<HTMLCanvasElement | null>(null);

    useEffect(() => {
        document.fonts.load(`48px ${markerFont.style.fontFamily}`).then(() => { deskRef.current = null; });
    }, []);

    useEffect(() => {
        for (const id of [setups[1].archetype, setups[2].archetype]) {
            const src = ARCHETYPE_MAP[id].image;
            if (!src) continue;
            loadBiroSprite(src).then(sprite => { spritesRef.current[id] = sprite; });
        }
    }, [setups]);

    useEffect(() => { turnRef.current = turn; }, [turn]);
    useEffect(() => { phaseRef.current = phase; }, [phase]);

    // -------- INITIALIZATION --------

    const placePensForRound = useCallback((startingPlayer: 1 | 2) => {
        const t = tableRef.current;
        const cy = t.y + t.h / 2;
        const margin = Math.min(t.w * 0.18, 90);

        const a1 = ARCHETYPE_MAP[setups[1].archetype];
        const a2 = ARCHETYPE_MAP[setups[2].archetype];

        // Colour = player identity (blue ink / red ink, drawn as the hitbox outline);
        // the biro supplies its brand colour plus length/width/mass so each plays distinctly.
        const p1 = createPen(
            { x: t.x + margin, y: cy },
            -Math.PI / 2,   // pointing up
            INK[1],
            a1.accent,
            1,
            a1.length, a1.width, a1.mass, a1.id,
        );
        const p2 = createPen(
            { x: t.x + t.w - margin, y: cy },
            Math.PI / 2,    // pointing down
            INK[2],
            a2.accent,
            2,
            a2.length, a2.width, a2.mass, a2.id,
        );
        pensRef.current = [p1, p2];
        pendingRef.current = null;
        // A fresh round clears every *active* effect — power-ups never carry their
        // effect across rounds (a shield raised in round 1 is gone by round 2).
        // The once-per-match `used` tally is intentionally left untouched.
        armedRef.current.clear();
        setArmedState([]);
        shieldRef.current = { 1: false, 2: false };
        setShieldState({ 1: false, 2: false });
        flickScaleRef.current = { 1: 1, 2: 1 };
        shieldSavedRef.current = null;
        turnRef.current = startingPlayer;
        setTurn(startingPlayer);
        phaseRef.current = "aim";
        setPhase("aim");
        setLastResult(null);
    }, [setups]);

    // -------- POWER-UP HELPERS --------

    const markUsed = useCallback((player: 1 | 2, id: PowerUpId) => {
        usedRef.current[player].add(id);
        setUsedState(prev => ({ ...prev, [player]: [...prev[player], id] }));
    }, []);

    // Spend a power-up. Self-buffs queue onto the next flick (toggleable until you
    // flick); control/defense power-ups fire instantly.
    const activatePowerUp = useCallback((player: 1 | 2, id: PowerUpId) => {
        // Only the player whose turn it is, while aiming, may spend power-ups.
        if (phaseRef.current !== "aim" || turnRef.current !== player) return;
        if (mode === "ai" && player === 2) return; // AI has no power-ups
        if (usedRef.current[player].has(id)) return;

        const def = POWER_UP_MAP[id];
        if (def.kind === "self") {
            // Toggle the buff on/off ahead of the flick — not consumed until release.
            const armed = armedRef.current;
            if (armed.has(id)) armed.delete(id); else armed.add(id);
            setArmedState([...armed]);
            playSfx?.("beamInteraction");
            return;
        }

        if (def.kind === "control") {
            // Freeze: weaken the opponent's next flick.
            const opp: 1 | 2 = player === 1 ? 2 : 1;
            flickScaleRef.current[opp] = FREEZE_STRENGTH_MULT;
            markUsed(player, id);
            playSfx?.("beamInteraction");
            return;
        }

        // Defense: raise the shield; it stays up until it saves you once.
        shieldRef.current[player] = true;
        setShieldState(prev => ({ ...prev, [player]: true }));
        markUsed(player, id);
        playSfx?.("beamInteraction");
    }, [mode, playSfx, markUsed]);

    // Resolve a flick with any active power-ups folded in. Shared by the human
    // pointer release and the AI release so a Freeze cast on the AI still applies.
    const performFlick = useCallback((
        pen: Pen,
        player: 1 | 2,
        contact: Vec2,
        direction: Vec2,
        baseStrength: number,
    ) => {
        let strength = baseStrength * flickScaleRef.current[player];
        flickScaleRef.current[player] = 1; // consume any Freeze on this player

        const armed = armedRef.current;
        const spent: PowerUpId[] = [];
        if (armed.has("power")) { strength *= POWER_SHOT_MULT; spent.push("power"); }

        applyFlick(pen, contact, direction, strength);

        if (armed.has("spin")) {
            // Amplify whatever spin the off-centre contact produced.
            const s = pen.omega >= 0 ? 1 : -1;
            pen.omega += s * SPIN_KICK;
            spent.push("spin");
        }

        armed.clear();
        setArmedState([]);
        for (const id of spent) markUsed(player, id);
    }, [markUsed]);

    const resizeCanvas = useCallback(() => {
        const canvas = canvasRef.current;
        const container = containerRef.current;
        if (!canvas || !container) return;
        const rect = container.getBoundingClientRect();
        // Match the canvas to its CSS box. DPR handled below.
        const cssW = Math.max(320, Math.floor(rect.width));
        const cssH = Math.max(320, Math.floor(rect.height));
        const dpr = Math.min(window.devicePixelRatio || 1, 2);
        canvas.width = cssW * dpr;
        canvas.height = cssH * dpr;
        canvas.style.width = `${cssW}px`;
        canvas.style.height = `${cssH}px`;
        const ctx = canvas.getContext("2d");
        if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        canvasSizeRef.current = { w: cssW, h: cssH };

        // Fit the fixed-size world into the canvas, preserving aspect ratio (the
        // smaller axis decides the scale; the extra space becomes letterbox void).
        // The table itself never moves — only this scale/offset changes per device.
        const scale = Math.min(cssW / WORLD_W, cssH / WORLD_H);
        viewportRef.current = {
            scale,
            ox: (cssW - WORLD_W * scale) / 2,
            oy: (cssH - WORLD_H * scale) / 2,
        };
    }, []);

    useEffect(() => {
        resizeCanvas();
        placePensForRound(1);
        // The table lives in fixed world units, so a resize only re-fits the
        // viewport — pen positions/velocities are untouched and stay valid.
        const onResize = () => resizeCanvas();
        window.addEventListener("resize", onResize);
        return () => window.removeEventListener("resize", onResize);
        // resizeCanvas + placePensForRound are stable callbacks, intentionally only running on mount.
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // -------- INPUT HANDLING --------

    const canvasToWorld = (clientX: number, clientY: number): Vec2 => {
        const canvas = canvasRef.current!;
        const r = canvas.getBoundingClientRect();
        const vp = viewportRef.current;
        // Screen (CSS px) → world units: inverse of the render viewport transform.
        return {
            x: (clientX - r.left - vp.ox) / vp.scale,
            y: (clientY - r.top - vp.oy) / vp.scale,
        };
    };

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;

        const onPointerDown = (e: PointerEvent) => {
            if (phaseRef.current !== "aim") return;
            if (mode === "ai" && turnRef.current === 2) return; // AI is taking its turn — no input.
            const world = canvasToWorld(e.clientX, e.clientY);
            const pens = pensRef.current;
            const me = pens.find(p => p.player === turnRef.current);
            if (!me) return;
            if (!pointOnPen(me, world, 10)) return;
            try { canvas.setPointerCapture(e.pointerId); } catch {}
            const contact = clampToPenBody(me, world);
            dragStartRef.current = world;
            dragCurrentRef.current = world;
            dragLocalContactRef.current = contact;
            draggingPenRef.current = me;
        };

        const onPointerMove = (e: PointerEvent) => {
            if (!dragStartRef.current) return;
            dragCurrentRef.current = canvasToWorld(e.clientX, e.clientY);
        };

        const onPointerUp = (e: PointerEvent) => {
            if (!dragStartRef.current || !dragLocalContactRef.current || !draggingPenRef.current) {
                dragStartRef.current = null;
                dragCurrentRef.current = null;
                dragLocalContactRef.current = null;
                draggingPenRef.current = null;
                return;
            }
            try { canvas.releasePointerCapture(e.pointerId); } catch {}

            const start = dragStartRef.current;
            const end = canvasToWorld(e.clientX, e.clientY);
            const dx = end.x - start.x;
            const dy = end.y - start.y;
            const dragMag = Math.min(Math.hypot(dx, dy), FLICK_MAX_DRAG);

            if (dragMag < 6) {
                // Treat as a cancelled drag — no flick.
                dragStartRef.current = null;
                dragCurrentRef.current = null;
                dragLocalContactRef.current = null;
                draggingPenRef.current = null;
                return;
            }

            // Slingshot: pen flicks in the OPPOSITE direction of the drag (pull back to fire).
            const direction = { x: -dx, y: -dy };
            const strength = dragMag * FLICK_IMPULSE_SCALE;
            performFlick(draggingPenRef.current, turnRef.current, dragLocalContactRef.current, direction, strength);

            playSfx?.("beamInteraction");

            phaseRef.current = "settling";
            setPhase("settling");

            dragStartRef.current = null;
            dragCurrentRef.current = null;
            dragLocalContactRef.current = null;
            draggingPenRef.current = null;
        };

        canvas.addEventListener("pointerdown", onPointerDown);
        canvas.addEventListener("pointermove", onPointerMove);
        canvas.addEventListener("pointerup", onPointerUp);
        canvas.addEventListener("pointercancel", onPointerUp);

        return () => {
            canvas.removeEventListener("pointerdown", onPointerDown);
            canvas.removeEventListener("pointermove", onPointerMove);
            canvas.removeEventListener("pointerup", onPointerUp);
            canvas.removeEventListener("pointercancel", onPointerUp);
        };
    }, [playSfx, mode, performFlick]);

    // -------- AI OPPONENT --------
    // When it's the AI's turn (P2 in "ai" mode), aim at the human pen with a touch of
    // noise, then animate a slingshot pullback so it visually matches a human flick
    // before releasing the impulse.
    useEffect(() => {
        if (mode !== "ai") return;
        if (phase !== "aim") return;
        if (turn !== 2) return;
        if (matchWinner !== null) return;

        const aiPen = pensRef.current.find(p => p.player === 2);
        const humanPen = pensRef.current.find(p => p.player === 1);
        if (!aiPen || !humanPen) return;

        // Aim: from AI toward human, biased outward so the impact pushes the
        // human pen toward the nearer edge. Then add jitter so the AI is beatable.
        const t = tableRef.current;
        const cx = t.x + t.w / 2;
        const cy = t.y + t.h / 2;
        const edgeBiasX = (humanPen.pos.x - cx) * 0.18;
        const edgeBiasY = (humanPen.pos.y - cy) * 0.18;
        const noise = 36;
        const targetX = humanPen.pos.x + edgeBiasX + (Math.random() - 0.5) * noise;
        const targetY = humanPen.pos.y + edgeBiasY + (Math.random() - 0.5) * noise;

        const flickAngle = Math.atan2(targetY - aiPen.pos.y, targetX - aiPen.pos.x);
        const dist = Math.hypot(humanPen.pos.x - aiPen.pos.x, humanPen.pos.y - aiPen.pos.y);
        const intendedDragMag = Math.min(
            FLICK_MAX_DRAG,
            Math.max(85, dist * 0.7) * (0.85 + Math.random() * 0.2),
        );

        // Contact slightly behind the AI pen's center (rear half relative to the flick
        // direction), giving a clean directional push with a hint of spin.
        const rearOffset = aiPen.length * 0.22;
        const contact: Vec2 = {
            x: aiPen.pos.x - Math.cos(flickAngle) * rearOffset,
            y: aiPen.pos.y - Math.sin(flickAngle) * rearOffset,
        };
        // Visual drag end = opposite of flick direction (slingshot pullback).
        const dragEnd: Vec2 = {
            x: contact.x - Math.cos(flickAngle) * intendedDragMag,
            y: contact.y - Math.sin(flickAngle) * intendedDragMag,
        };

        const THINK_MS = 450;
        const PULL_MS = 600;
        const start = performance.now();
        let cancelled = false;
        let frameId: number | null = null;

        const animate = () => {
            if (cancelled) return;
            const elapsed = performance.now() - start;

            if (elapsed < THINK_MS) {
                frameId = requestAnimationFrame(animate);
                return;
            }

            if (elapsed < THINK_MS + PULL_MS) {
                const k = (elapsed - THINK_MS) / PULL_MS;
                const eased = 1 - Math.pow(1 - k, 2);
                dragStartRef.current = contact;
                dragCurrentRef.current = {
                    x: contact.x + (dragEnd.x - contact.x) * eased,
                    y: contact.y + (dragEnd.y - contact.y) * eased,
                };
                dragLocalContactRef.current = contact;
                draggingPenRef.current = aiPen;
                frameId = requestAnimationFrame(animate);
                return;
            }

            // Release: apply the flick along the intended direction. Routed through
            // performFlick so a human-cast Freeze still saps the AI's flick.
            const direction: Vec2 = { x: Math.cos(flickAngle), y: Math.sin(flickAngle) };
            performFlick(aiPen, 2, contact, direction, intendedDragMag * FLICK_IMPULSE_SCALE);
            playSfx?.("beamInteraction");

            dragStartRef.current = null;
            dragCurrentRef.current = null;
            dragLocalContactRef.current = null;
            draggingPenRef.current = null;

            phaseRef.current = "settling";
            setPhase("settling");
        };

        frameId = requestAnimationFrame(animate);

        return () => {
            cancelled = true;
            if (frameId !== null) cancelAnimationFrame(frameId);
            // If we're tearing down mid-pullback (e.g. round ended), wipe the drag refs
            // so the indicator doesn't linger.
            if (draggingPenRef.current === aiPen) {
                dragStartRef.current = null;
                dragCurrentRef.current = null;
                dragLocalContactRef.current = null;
                draggingPenRef.current = null;
            }
        };
    }, [mode, phase, turn, matchWinner, playSfx, performFlick]);

    // -------- ROUND / MATCH STATE --------

    const concludeRound = useCallback((winner: 1 | 2, loser: 1 | 2) => {
        phaseRef.current = "round-over";
        setPhase("round-over");
        setLastResult({ kind: "win", winner, loser });

        setScores(prev => {
            const next = { ...prev };
            if (winner === 1) next.p1 += 1; else next.p2 += 1;
            const reached = winner === 1 ? next.p1 : next.p2;
            if (reached >= ROUNDS_TO_WIN) {
                setMatchWinner(winner);
                phaseRef.current = "match-over";
                setPhase("match-over");
            }
            return next;
        });
    }, []);

    // Both pens crossed the edge in the same exchange — nobody scores, replay the round.
    const concludeDraw = useCallback(() => {
        phaseRef.current = "round-over";
        setPhase("round-over");
        setLastResult({ kind: "draw" });
    }, []);

    // After a round ends, give the player a moment to see the result then reset.
    useEffect(() => {
        if (phase !== "round-over") return;
        if (matchWinner !== null) return;
        const timer = setTimeout(() => {
            setRound(r => r + 1);
            // Loser starts the next round; on a draw just alternate from whoever flicked last.
            const nextStarter: 1 | 2 = lastResult && lastResult.kind === "win"
                ? lastResult.loser
                : (turnRef.current === 1 ? 2 : 1);
            placePensForRound(nextStarter);
        }, 1700);
        return () => clearTimeout(timer);
    }, [phase, matchWinner, lastResult, placePensForRound]);

    // -------- GAME LOOP --------

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const ctx = canvas.getContext("2d");
        if (!ctx) return;

        const FIXED_DT = 1 / 60 / PHYSICS_SUBSTEPS;
        const MAX_FRAME_DT = 1 / 30; // clamp huge frames (tab switch) to avoid tunneling

        const step = (ts: number) => {
            const last = lastTsRef.current || ts;
            let frameDt = (ts - last) / 1000;
            if (frameDt > MAX_FRAME_DT) frameDt = MAX_FRAME_DT;
            lastTsRef.current = ts;

            const pens = pensRef.current;
            const table = tableRef.current;

            // Only step physics when something is actually moving (during settling/aim with held drag).
            const anyMoving = pens.some(p => !isResting(p));
            if (anyMoving) {
                // Adaptive sub-stepping. A frame-time-only substep count fixes dt at
                // ~1/240s, which lets a full-power light pen (e.g. a Power-Shot Lance,
                // ~1700 u/s) jump ~7 units per step — more than the thinnest pen's
                // collision radius — so it tunnels clean through a close opponent
                // without ever registering a hit. Instead we scale the step count by
                // the fastest pen's *effective* speed (linear motion + its spinning
                // tip) so nothing ever advances more than MAX_STEP_DIST per step.
                let maxSpeed = 0;
                for (const p of pens) {
                    if (p.offTable) continue;
                    const tipSpeed = Math.abs(p.omega) * (p.length / 2); // fastest point on a spinning pen
                    const eff = Math.hypot(p.vel.x, p.vel.y) + tipSpeed;
                    if (eff > maxSpeed) maxSpeed = eff;
                }
                const timeSubsteps = Math.round(frameDt / FIXED_DT);
                const distSubsteps = Math.ceil((maxSpeed * frameDt) / MAX_STEP_DIST);
                const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, timeSubsteps, distSubsteps));
                const dt = frameDt / substeps;
                for (let s = 0; s < substeps; s++) {
                    for (const p of pens) stepPen(p, dt);
                    // Off-table pens are sliding away — they no longer collide.
                    if (pens.length === 2 && !pens[0].offTable && !pens[1].offTable) {
                        collidePens(pens[0], pens[1]);
                    }
                    // Knockout = center of mass crosses the edge. The pen keeps sliding
                    // afterwards so it either coasts fully off (clean fall) or comes to
                    // rest teetering over the edge — the outcome logic reads that below.
                    for (const p of pens) {
                        if (p.offTable) continue;
                        const crossed =
                            p.pos.x < table.x || p.pos.x > table.x + table.w ||
                            p.pos.y < table.y || p.pos.y > table.y + table.h;
                        if (!crossed) continue;
                        if (shieldRef.current[p.player]) {
                            // Shield save: snap back just inside the edge, kill momentum,
                            // and consume the shield (one save per match).
                            const inset = 6;
                            p.pos.x = Math.max(table.x + inset, Math.min(table.x + table.w - inset, p.pos.x));
                            p.pos.y = Math.max(table.y + inset, Math.min(table.y + table.h - inset, p.pos.y));
                            p.vel.x = 0; p.vel.y = 0; p.omega = 0;
                            shieldRef.current[p.player] = false;
                            setShieldState(prev => ({ ...prev, [p.player]: false }));
                            shieldSavedRef.current = { player: p.player, at: ts }; // flag a flash for the render
                            playSfx?.("beamInteraction");
                            continue;
                        }
                        p.offTable = true;
                    }
                }
            }

            // Detect round-end conditions after physics.
            if (phaseRef.current === "settling") {
                if (!pendingRef.current) {
                    const offPens = pens.filter(p => p.offTable);
                    const othersMoving = pens.some(p => !p.offTable && !isResting(p));
                    const fully = (p: Pen) => offTableFraction(p, table) >= FULL_OFF_FRACTION;

                    if (offPens.length >= 2) {
                        // Both knocked out → draw. Reveal unless both cleanly fell off.
                        const reveal = offPens.every(fully) ? 0 : KNOCKOUT_REVEAL_MS;
                        pendingRef.current = { kind: "draw", concludeAt: ts + reveal };
                    } else if (offPens.length === 1 && !othersMoving) {
                        // One pen out, the other settled on the table. A clean fall
                        // (whole body off) resolves immediately; a pen still teetering
                        // is held until it stops so we can show it before the result.
                        const loser = offPens[0];
                        const cleanFall = fully(loser);
                        if (cleanFall || isResting(loser)) {
                            const winner: 1 | 2 = loser.player === 1 ? 2 : 1;
                            const reveal = cleanFall ? 0 : KNOCKOUT_REVEAL_MS;
                            pendingRef.current = { kind: "loss", winner, loser: loser.player, concludeAt: ts + reveal };
                        }
                        // else: still sliding — wait for it to stop or coast fully off.
                    } else if (offPens.length === 0 && pens.every(isResting)) {
                        // No one fell off → switch turns.
                        const nextTurn: 1 | 2 = turnRef.current === 1 ? 2 : 1;
                        turnRef.current = nextTurn;
                        setTurn(nextTurn);
                        phaseRef.current = "aim";
                        setPhase("aim");
                    }
                    // else: one pen is out while the other is still sliding —
                    // wait for it to settle (it may also go off → draw).
                }

                // Resolve a held-back outcome once its reveal delay has elapsed.
                const pending = pendingRef.current;
                if (pending && ts >= pending.concludeAt) {
                    pendingRef.current = null;
                    if (pending.kind === "draw") concludeDraw();
                    else concludeRound(pending.winner, pending.loser);
                }
            }

            render(ctx);

            rafRef.current = requestAnimationFrame(step);
        };

        rafRef.current = requestAnimationFrame(step);
        return () => {
            if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
            rafRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [concludeRound, concludeDraw]);

    // -------- RENDER --------

    const render = (ctx: CanvasRenderingContext2D) => {
        const { w, h } = canvasSizeRef.current;
        const table = tableRef.current;
        const pens = pensRef.current;

        // Background: the same ruled exercise-book page as the menus.
        ctx.fillStyle = PAPER;
        ctx.fillRect(0, 0, w, h);
        ctx.fillStyle = PAPER_LINE;
        for (let y = 31; y < h; y += 32) ctx.fillRect(0, y, w, 1);
        ctx.fillStyle = MARGIN_RED;
        ctx.fillRect(47, 0, 2, h);

        // From here on everything is drawn in fixed world units. This viewport
        // transform maps the world into the canvas (aspect-preserved, centred), so
        // the table and pens look identical at any resolution.
        const vp = viewportRef.current;
        ctx.save();
        ctx.transform(vp.scale, 0, 0, vp.scale, vp.ox, vp.oy);

        // Wooden school desk: soft drop shadow, textured top, darker worn edge.
        ctx.fillStyle = "rgba(60,35,15,0.22)";
        ctx.fillRect(table.x + 8, table.y + 12, table.w, table.h);
        if (!deskRef.current) deskRef.current = buildDeskTexture(table.w, table.h);
        ctx.drawImage(deskRef.current, table.x, table.y, table.w, table.h);
        ctx.strokeStyle = "#5b3a1e";
        ctx.lineWidth = 8;
        ctx.strokeRect(table.x - 4, table.y - 4, table.w + 8, table.h + 8);
        ctx.strokeStyle = "rgba(255,225,180,0.25)";
        ctx.lineWidth = 1.5;
        ctx.strokeRect(table.x + 1, table.y + 1, table.w - 2, table.h - 2);

        // Pens (off-table pens still render slightly outside the table so the player can see them fall).
        for (const p of pens) drawPen(ctx, p, p.player === turnRef.current && phaseRef.current === "aim");

        // Knockout marker — a pulsing red ring on any pen that has crossed the edge,
        // so the "you're out" moment is obvious during the reveal delay.
        for (const p of pens) {
            if (!p.offTable) continue;
            const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 150);
            ctx.save();
            ctx.strokeStyle = `rgba(198,40,40,${0.55 + 0.45 * pulse})`;
            ctx.lineWidth = 3;
            ctx.setLineDash([8, 6]);
            ctx.beginPath();
            ctx.arc(p.pos.x, p.pos.y, p.length * 0.5 + 10, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Shield-up halo — a steady green ring around any pen with an armed shield.
        for (const p of pens) {
            if (p.offTable || !shieldRef.current[p.player]) continue;
            const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 300);
            ctx.save();
            ctx.strokeStyle = `rgba(0,135,81,${0.5 + 0.35 * pulse})`;
            ctx.lineWidth = 3;
            ctx.beginPath();
            ctx.arc(p.pos.x, p.pos.y, p.length * 0.5 + 14, 0, Math.PI * 2);
            ctx.stroke();
            ctx.restore();
        }

        // Shield-save flash — a brief expanding ring at the pen that was just saved.
        const saved = shieldSavedRef.current;
        if (saved) {
            const age = performance.now() - saved.at;
            if (age > 600) {
                shieldSavedRef.current = null;
            } else {
                const sp = pens.find(p => p.player === saved.player);
                if (sp) {
                    const k = age / 600;
                    ctx.save();
                    ctx.globalAlpha = 1 - k;
                    ctx.strokeStyle = NAIJA_GREEN;
                    ctx.lineWidth = 4;
                    ctx.beginPath();
                    ctx.arc(sp.pos.x, sp.pos.y, (p => p.length * 0.5 + 14)(sp) + k * 40, 0, Math.PI * 2);
                    ctx.stroke();
                    ctx.restore();
                }
            }
        }

        // Aim indicator — slingshot pull. Drag AWAY from the target; the pen
        // flicks in the opposite direction (toward the solid arrow).
        const start = dragStartRef.current;
        const cur = dragCurrentRef.current;
        const contact = dragLocalContactRef.current;
        if (start && cur && contact) {
            const dx = cur.x - start.x;
            const dy = cur.y - start.y;
            const rawMag = Math.hypot(dx, dy);
            const mag = Math.min(rawMag, FLICK_MAX_DRAG);
            if (mag > 4) {
                // Drag direction (towards finger).
                const nx = dx / rawMag;
                const ny = dy / rawMag;
                // Flick direction = opposite.
                const fx = -nx;
                const fy = -ny;

                // Strength color: green → amber → red as you pull harder.
                const t = mag / FLICK_MAX_DRAG;
                const col = `hsl(${Math.round(135 - 135 * t)}, 75%, 36%)`;

                ctx.save();

                // Faint "pullback" trail along the drag direction — slingshot tension.
                ctx.strokeStyle = "rgba(31,42,68,0.45)";
                ctx.lineWidth = 1.5;
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(contact.x, contact.y);
                ctx.lineTo(contact.x + nx * mag, contact.y + ny * mag);
                ctx.stroke();
                ctx.setLineDash([]);

                // Main flick arrow — kept short so players rely on judgment.
                const arrowLen = mag * 0.35;
                const endX = contact.x + fx * arrowLen;
                const endY = contact.y + fy * arrowLen;

                ctx.strokeStyle = col;
                ctx.lineWidth = 3;
                ctx.setLineDash([6, 6]);
                ctx.beginPath();
                ctx.moveTo(contact.x, contact.y);
                ctx.lineTo(endX, endY);
                ctx.stroke();
                ctx.setLineDash([]);

                // Arrow head on the flick side.
                const ang = Math.atan2(fy, fx);
                const ah = 10;
                ctx.beginPath();
                ctx.moveTo(endX, endY);
                ctx.lineTo(endX - Math.cos(ang - 0.5) * ah, endY - Math.sin(ang - 0.5) * ah);
                ctx.lineTo(endX - Math.cos(ang + 0.5) * ah, endY - Math.sin(ang + 0.5) * ah);
                ctx.closePath();
                ctx.fillStyle = col;
                ctx.fill();

                // Strength meter under the contact point.
                ctx.fillStyle = "rgba(31,42,68,0.25)";
                ctx.fillRect(contact.x - 30, contact.y + 22, 60, 5);
                ctx.fillStyle = col;
                ctx.fillRect(contact.x - 30, contact.y + 22, 60 * t, 5);
                ctx.restore();
            }
        }

        // Active-pen indicator dot (subtle "your turn" hint near current pen).
        if (phaseRef.current === "aim" && !start) {
            const me = pens.find(p => p.player === turnRef.current);
            if (me) {
                ctx.save();
                ctx.fillStyle = me.color;
                ctx.strokeStyle = "#fff";
                ctx.lineWidth = 1.5;
                const pulse = 4 + 2 * Math.sin(performance.now() / 240);
                ctx.beginPath();
                ctx.arc(me.pos.x, me.pos.y, pulse, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.restore();
            }
        }

        // Frozen warning — if the player about to flick has been hit by Freeze, make
        // it unmistakable so a suddenly-weak flick doesn't confuse them.
        if (phaseRef.current === "aim" && flickScaleRef.current[turnRef.current] < 1) {
            const me = pens.find(p => p.player === turnRef.current);
            if (me) {
                const pulse = 0.5 + 0.5 * Math.sin(performance.now() / 220);
                ctx.save();
                // Icy ring around the pen.
                ctx.strokeStyle = `rgba(43,143,207,${0.5 + 0.4 * pulse})`;
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(me.pos.x, me.pos.y, me.length * 0.5 + 14, 0, Math.PI * 2);
                ctx.stroke();
                // Label above the pen.
                ctx.font = "900 14px sans-serif";
                ctx.textAlign = "center";
                ctx.fillStyle = FREEZE_BLUE;
                ctx.fillText("❄ FROZEN", me.pos.x, me.pos.y - (me.length * 0.5 + 22));
                ctx.restore();
            }
        }

        ctx.restore(); // end world-space viewport transform
    };

    const drawPen = (ctx: CanvasRenderingContext2D, p: Pen, isActive: boolean) => {
        const r = penRadius(p);
        const halfL = p.length / 2;

        // The physics body is a capsule spanning [-halfL - r, halfL + r] along the
        // pen axis. Everything below is drawn onto exactly that shape, so what players
        // see is what collides.
        const capsule = () => roundedRect(ctx, -halfL - r, -r, p.length + p.width, p.width, r);

        // Drop shadow on the desk (offset in world space, so it doesn't spin with the pen).
        ctx.save();
        ctx.translate(p.pos.x + 4, p.pos.y + 6);
        ctx.rotate(p.angle);
        ctx.fillStyle = "rgba(40,20,5,0.3)";
        capsule();
        ctx.fill();
        ctx.restore();

        ctx.save();
        ctx.translate(p.pos.x, p.pos.y);
        ctx.rotate(p.angle);

        // Ink outline = the exact hitbox, and the player's colour (both players may
        // pick the same biro). Drawn under the biro so only its rim shows.
        capsule();
        ctx.lineWidth = isActive ? 5 : 3;
        ctx.strokeStyle = p.color;
        ctx.stroke();

        const sprite = spritesRef.current[p.archetype];
        if (sprite) {
            // PNG is upright with the cap at the top; rotate so "up" points along +x
            // (the pen's tip), then stretch the measured barrel to the capsule width
            // and the trimmed length to the capsule length.
            ctx.save();
            ctx.rotate(Math.PI / 2);
            ctx.scale(p.width / sprite.barrelWidth, (p.length + p.width) / sprite.canvas.height);
            ctx.drawImage(sprite.canvas, -sprite.barrelCenter, -sprite.canvas.height / 2);
            ctx.restore();
        } else {
            drawFallbackBiro(ctx, p);
        }

        ctx.restore();
    };

    // Stand-in for biros whose PNG hasn't been added (or hasn't loaded yet): a clear
    // barrel with an ink tube, a cap + clip in the brand colour and an end plug.
    const drawFallbackBiro = (ctx: CanvasRenderingContext2D, p: Pen) => {
        const r = penRadius(p);
        const halfL = p.length / 2;
        const front = halfL + r;
        const back = -halfL - r;
        const capLen = (p.length + p.width) * 0.3;

        ctx.fillStyle = "rgba(238,242,246,0.96)";
        roundedRect(ctx, back, -r, p.length + p.width, p.width, r);
        ctx.fill();
        ctx.strokeStyle = "#8d99a6";
        ctx.lineWidth = 1;
        ctx.stroke();

        ctx.fillStyle = "#2a2a2a";
        ctx.fillRect(back + 10, -p.width * 0.1, front - capLen - back - 10, p.width * 0.2);

        ctx.fillStyle = p.accent;
        roundedRect(ctx, front - capLen, -r, capLen, p.width, r);
        ctx.fill();
        ctx.fillRect(front - capLen - 2, r - 2, capLen * 0.85, 4); // clip
        roundedRect(ctx, back, -r + 1, 7, p.width - 2, Math.min(3, r)); // end plug
        ctx.fill();
    };

    const roundedRect = (ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) => {
        ctx.beginPath();
        ctx.moveTo(x + r, y);
        ctx.lineTo(x + w - r, y);
        ctx.quadraticCurveTo(x + w, y, x + w, y + r);
        ctx.lineTo(x + w, y + h - r);
        ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
        ctx.lineTo(x + r, y + h);
        ctx.quadraticCurveTo(x, y + h, x, y + h - r);
        ctx.lineTo(x, y + r);
        ctx.quadraticCurveTo(x, y, x + r, y);
        ctx.closePath();
    };

    // -------- ACTIONS --------

    const playAgain = () => {
        setScores({ p1: 0, p2: 0 });
        setRound(1);
        setMatchWinner(null);
        setLastResult(null);
        // New match → everyone gets their loadout back.
        usedRef.current = { 1: new Set(), 2: new Set() };
        shieldRef.current = { 1: false, 2: false };
        flickScaleRef.current = { 1: 1, 2: 1 };
        shieldSavedRef.current = null;
        setUsedState({ 1: [], 2: [] });
        setShieldState({ 1: false, 2: false });
        placePensForRound(1);
    };

    // -------- JSX --------

    const playerColor = (player: 1 | 2) => INK[player];
    const playerLabel = (player: 1 | 2) => {
        if (mode === "ai") return player === 1 ? "YOU" : "CPU";
        return player === 1 ? "P1" : "P2";
    };
    const winnerLine = (winner: 1 | 2) => {
        if (mode === "ai") return winner === 1 ? "Na you be the champion!" : "Computer don beat you. Try again!";
        return `${playerLabel(winner)} na the champion!`;
    };

    return (
        <div className="relative h-full w-full flex flex-col">
            {/* Top HUD */}
            <div className="absolute top-3 left-3 right-3 z-10 flex items-center justify-between pointer-events-none">
                <button
                    onClick={onExit}
                    className="pointer-events-auto px-3 py-1 rounded-md text-xs font-extrabold uppercase cursor-pointer transition-transform hover:-translate-y-0.5"
                    style={sticker(TEXT)}
                >
                    ◂ Exit
                </button>

                {/* Scoreboard */}
                <div className="flex items-center gap-3 sm:gap-5">
                    <ScoreCell label={playerLabel(1)} color={INK[1]} score={scores.p1} active={turn === 1 && phase === "aim"} />
                    <div className="px-2 py-0.5 rounded text-xs font-extrabold uppercase" style={{ background: CARD_BG, color: TEXT }}>
                        Round {round}
                    </div>
                    <ScoreCell label={playerLabel(2)} color={INK[2]} score={scores.p2} active={turn === 2 && phase === "aim"} />
                </div>

                <div className="w-[60px]" />
            </div>

            {/* Turn label */}
            {phase === "aim" && (
                <div className="absolute top-16 left-0 right-0 flex flex-col items-center gap-1 z-10 pointer-events-none">
                    <p
                        className="px-3 py-0.5 rounded-full text-xs sm:text-sm font-extrabold uppercase"
                        style={{ background: CARD_BG, color: playerColor(turn), border: `2px solid ${playerColor(turn)}` }}
                    >
                        {mode === "ai" && turn === 2
                            ? "Computer dey think…"
                            : mode === "ai" ? "Your flick" : `${playerLabel(turn)}'s flick`}
                    </p>
                    {flickScaleRef.current[turn] < 1 && (
                        <p
                            className="px-2 py-0.5 rounded text-[10px] sm:text-xs font-extrabold uppercase animate-pulse"
                            style={{ background: CARD_BG, color: FREEZE_BLUE }}
                        >
                            ❄ Frozen · weak flick
                        </p>
                    )}
                </div>
            )}

            {/* Play area — the canvas keeps its full size; the rails overlay the very
                edges (absolutely positioned) so they never shrink the playable table. */}
            <div ref={containerRef} className="flex-1 relative">
                <p className={`${markerFont.className} absolute z-[10] w-full opacity-[0.18] pointer-events-none text-[4em] h-full flex gap-3 items-center justify-center`}><span style={{ color: INK[1] }}>Chain</span> <span style={{ color: INK[2] }}>Play</span></p>
                <canvas
                    ref={canvasRef}
                    className="absolute inset-0 touch-none select-none"
                    style={{ cursor: phase === "aim" ? "crosshair" : "default" }}
                />

                {/* POWER-UPS DISABLED — the in-match power-up rails. Uncomment (along with
                    the `loadouts` line near the top) when power-ups launch.
                <PowerRail
                    player={1}
                    side="left"
                    archetypeName={ARCHETYPE_MAP[setups[1].archetype].name}
                    loadout={loadouts[1]}
                    used={usedState[1]}
                    armed={turn === 1 ? armedState : []}
                    shieldActive={shieldState[1]}
                    myTurn={phase === "aim" && turn === 1}
                    onActivate={(id) => activatePowerUp(1, id)}
                />

                <PowerRail
                    player={2}
                    side="right"
                    archetypeName={mode === "ai" ? "CPU" : ARCHETYPE_MAP[setups[2].archetype].name}
                    loadout={loadouts[2]}
                    used={usedState[2]}
                    armed={turn === 2 ? armedState : []}
                    shieldActive={shieldState[2]}
                    myTurn={phase === "aim" && turn === 2 && mode !== "ai"}
                    onActivate={(id) => activatePowerUp(2, id)}
                />
                */}
            </div>

            {/* Round result overlay */}
            {phase === "round-over" && lastResult && !matchWinner && (
                <div className="absolute inset-0 flex items-center justify-center z-20 pointer-events-none">
                    {lastResult.kind === "draw" ? (
                        <div className="px-8 py-5 rounded-lg text-center" style={sticker(DRAW_AMBER)}>
                            <p className="text-xs font-bold uppercase mb-1" style={{ color: MUTED }}>Double Knockout</p>
                            <p className={`${markerFont.className} text-[2.2em] leading-none`} style={{ color: DRAW_AMBER }}>
                                Draw
                            </p>
                        </div>
                    ) : (
                        <div className="px-8 py-5 rounded-lg text-center" style={sticker(playerColor(lastResult.winner))}>
                            <p className="text-xs font-bold uppercase mb-1" style={{ color: MUTED }}>Round Won</p>
                            <p className={`${markerFont.className} text-[2.2em] leading-none`} style={{ color: playerColor(lastResult.winner) }}>
                                {playerLabel(lastResult.winner)}
                            </p>
                        </div>
                    )}
                </div>
            )}

            {/* Match over overlay */}
            {phase === "match-over" && matchWinner && (
                <div className="absolute inset-0 flex items-center justify-center z-30" style={{ background: "rgba(31,42,68,0.45)" }}>
                    <div className="px-10 py-8 rounded-xl text-center max-w-[90%]" style={sticker(playerColor(matchWinner))}>
                        <p className="text-xs font-bold uppercase mb-2" style={{ color: MUTED }}>Match Winner</p>
                        <p className={`${markerFont.className} text-[3em] leading-none`} style={{ color: playerColor(matchWinner) }}>
                            {playerLabel(matchWinner)}
                        </p>
                        <p className="text-sm font-semibold mt-2" style={{ color: TEXT }}>{winnerLine(matchWinner)}</p>
                        <div className="flex gap-3 justify-center mt-6">
                            <button
                                onClick={playAgain}
                                className="px-6 py-2 rounded-lg text-sm font-extrabold uppercase cursor-pointer transition-transform hover:-translate-y-0.5 text-white"
                                style={sticker(TEXT, NAIJA_GREEN)}
                            >
                                Play Again
                            </button>
                            <button
                                onClick={onExit}
                                className="px-6 py-2 rounded-lg text-sm font-extrabold uppercase cursor-pointer transition-transform hover:-translate-y-0.5"
                                style={sticker(TEXT)}
                            >
                                Main Menu
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

// Vertical power-up rail shown outside a player's side of the board. Chips are
// only interactive on that player's aim turn; spent ones grey out, an armed
// self-buff is highlighted in its colour, and a raised shield shows green.
const PowerRail: FC<{
    player: 1 | 2;
    side: "left" | "right";
    archetypeName: string;
    loadout: PowerUpId[];
    used: PowerUpId[];
    armed: PowerUpId[];
    shieldActive: boolean;
    myTurn: boolean;
    onActivate: (id: PowerUpId) => void;
}> = ({ player, side, archetypeName, loadout, used, armed, shieldActive, myTurn, onActivate }) => {
    const accent = INK[player];
    const [isHidden, setIsHidden] = useState(false);

    return (
        <div
            className={`absolute px-1 py-2 rounded-[70px] top-1/2 -translate-y-1/2 z-20 ${ !isHidden && "w-[50px] sm:w-[62px]" } flex flex-col items-center gap-2 select-none pointer-events-auto ${side === "left" ? "left-0.5 sm:left-1" : "right-0.5 sm:right-1"}`}
            style={{ background: "rgba(255,253,246,0.92)", border: `2px solid ${accent}` }}
        >
            {
                isHidden ? (
                    <button onClick={() => setIsHidden(false)} className="h-4 w-4 cursor-pointer rounded-full" style={{ background: accent }} />
                ) : (
                    <>
                        <button onClick={() => setIsHidden(true)} className="underline text-[0.8em] font-bold cursor-pointer" style={{ color: MUTED }}>
                            Hide
                        </button>
                        <span className="text-[9px] sm:text-[10px] font-black uppercase" style={{ color: accent }}>
                            {player === 1 ? "P1" : "P2"}
                        </span>
                        <span className="text-[7px] sm:text-[8px] font-extrabold uppercase text-center leading-tight -mt-1" style={{ color: MUTED }}>
                            {archetypeName}
                        </span>

                        {loadout.length === 0 ? (
                            <span className="text-[7px] font-bold text-center mt-2 leading-tight" style={{ color: MUTED }}>
                                NO<br />POWER-UPS
                            </span>
                        ) : (
                            loadout.map(id => {
                                const def = POWER_UP_MAP[id];
                                const isUsed = used.includes(id);
                                const isArmed = armed.includes(id);
                                const isShieldUp = id === "shield" && shieldActive;
                                const clickable = myTurn && !isUsed;

                                const ringColor = isShieldUp ? NAIJA_GREEN : def.color;
                                const lit = isArmed || isShieldUp || clickable;
                                const label = isShieldUp ? "UP" : isArmed ? "SET" : isUsed ? "USED" : def.tag;

                                return (
                                    <button
                                        key={id}
                                        onClick={() => clickable && onActivate(id)}
                                        disabled={!clickable}
                                        title={`${def.name} — ${def.blurb}`}
                                        className={`relative w-full aspect-square rounded-md flex flex-col items-center justify-center gap-0.5 transition-transform duration-150 ${clickable ? "cursor-pointer hover:scale-[1.08]" : "cursor-default"} ${isArmed ? "animate-pulse" : ""}`}
                                        style={{
                                            background: isArmed || isShieldUp ? `${ringColor}22` : CARD_BG,
                                            border: `2px solid ${lit ? ringColor : "rgba(31,42,68,0.15)"}`,
                                            opacity: isUsed && !isShieldUp ? 0.35 : !lit ? 0.6 : 1,
                                        }}
                                    >
                                        <span className="text-base sm:text-lg leading-none">
                                            {def.icon}
                                        </span>
                                        <span
                                            className="text-[6px] sm:text-[7px] font-black"
                                            style={{ color: isUsed && !isShieldUp ? MUTED : ringColor }}
                                        >
                                            {label}
                                        </span>
                                    </button>
                                );
                            })
                        )}
                    </>
                )
            }

        </div>
    );
};

const ScoreCell: FC<{ label: string; color: string; score: number; active: boolean }> = ({ label, color, score, active }) => (
    <div
        className="flex flex-col items-center px-3 py-1 rounded-md"
        style={{
            ...(active ? sticker(color) : { background: CARD_BG, border: "2px solid rgba(31,42,68,0.15)" }),
            minWidth: 56,
        }}
    >
        <span className="text-[10px] font-extrabold" style={{ color }}>{label}</span>
        <span className="text-xl font-black leading-none" style={{ color }}>
            {score}
        </span>
    </div>
);

export default PenFightGame;
