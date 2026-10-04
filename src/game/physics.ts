// Pen-fight physics — server port of the frontend's physics.ts + the simulation
// loop from game.tsx. The server is the single source of truth: it runs every
// flick to completion and sends clients the recorded frames to play back.
//
// The maths (capsule collision, impulses, damping, knockout rules) is copied
// unchanged from the frontend so the game feels identical. The one deliberate
// difference: the frontend steps physics by the browser's frame time, which
// varies per device. Here every frame is exactly FRAME_DT, so the same flick
// always produces the same result.

import { ARCHETYPES, ArchetypeId } from "./archetypes";

export type Vec2 = { x: number; y: number };
export type Seat = 1 | 2;

export interface Pen {
    pos: Vec2;          // center of mass
    vel: Vec2;          // world units/sec
    angle: number;      // radians, 0 = pointing +x
    omega: number;      // rad/sec
    length: number;     // tip-to-tip length
    width: number;      // perpendicular thickness (capsule radius * 2)
    mass: number;
    inertia: number;    // moment of inertia about the center
    archetype: ArchetypeId;
    player: Seat;
    offTable: boolean;  // set true once the center of mass crosses the table edge
}

export interface Table {
    x: number;
    y: number;
    w: number;
    h: number;
}

// ── World (fixed logical coordinates, shared with the frontend) ─────────────
export const WORLD_W = 1800;
export const WORLD_H = 860;
const TABLE_PAD = 38;
export const WORLD_TABLE: Table = {
    x: TABLE_PAD,
    y: TABLE_PAD,
    w: WORLD_W - TABLE_PAD * 2,
    h: WORLD_H - TABLE_PAD * 2,
};

// ── Physics tuning (identical to the frontend) ──────────────────────────────
export const LINEAR_DAMPING = 2.25;
export const ANGULAR_DAMPING = 1.9;
export const SLEEP_VEL = 6;
export const SLEEP_OMEGA = 0.25;
export const RESTITUTION = 0.32;
export const COLLISION_FRICTION = 0.28;

// ── Flick input ─────────────────────────────────────────────────────────────
export const FLICK_IMPULSE_SCALE = 9;  // drag (world units) → impulse magnitude
export const FLICK_MAX_DRAG = 180;     // drag is capped here — a bigger drag is not a stronger flick
export const FLICK_MIN_DRAG = 6;       // below this it's a tap, not a flick

// ── Simulation loop ─────────────────────────────────────────────────────────
export const FRAME_DT = 1 / 60;
const PHYSICS_SUBSTEPS = 4;            // baseline: 4 substeps per frame
const MAX_STEP_DIST = 3;               // anti-tunneling: max world units a pen moves per substep
const MAX_SUBSTEPS = 32;
const MAX_SIM_SECONDS = 20;            // hard stop; damping settles any flick in ~3s

// ── Knockout rules (identical to the frontend) ──────────────────────────────
export const FULL_OFF_FRACTION = 0.9;  // ≥90% of the body over the edge = clean fall
export const KNOCKOUT_REVEAL_MS = 900; // teetering pens are shown for a moment before the result

// Playback: one recorded frame every N simulated frames (2 → 30 fps; clients interpolate).
export const FRAME_SAMPLE_EVERY = 2;
export const PLAYBACK_FRAME_MS = 1000 * FRAME_DT * FRAME_SAMPLE_EVERY;

export function createPen(pos: Vec2, angle: number, player: Seat, archetype: ArchetypeId): Pen {
    const { length, width, mass } = ARCHETYPES[archetype];
    // Thin-rod inertia: I = (1/12) * m * L^2 — good enough for a capsule.
    const inertia = (1 / 12) * mass * length * length;
    return {
        pos: { ...pos },
        vel: { x: 0, y: 0 },
        angle,
        omega: 0,
        length,
        width,
        mass,
        inertia,
        archetype,
        player,
        offTable: false,
    };
}

// Starting positions for a round: seat 1 on the left pointing up, seat 2 on the
// right pointing down (same as the frontend's placePensForRound).
export function placePens(a1: ArchetypeId, a2: ArchetypeId, t: Table = WORLD_TABLE): [Pen, Pen] {
    const cy = t.y + t.h / 2;
    const margin = Math.min(t.w * 0.18, 90);
    return [
        createPen({ x: t.x + margin, y: cy }, -Math.PI / 2, 1, a1),
        createPen({ x: t.x + t.w - margin, y: cy }, Math.PI / 2, 2, a2),
    ];
}

export function penEndpoints(p: Pen): { a: Vec2; b: Vec2 } {
    const dx = (Math.cos(p.angle) * p.length) / 2;
    const dy = (Math.sin(p.angle) * p.length) / 2;
    return {
        a: { x: p.pos.x - dx, y: p.pos.y - dy },
        b: { x: p.pos.x + dx, y: p.pos.y + dy },
    };
}

export function penRadius(p: Pen): number {
    return p.width / 2;
}

// Closest pair of points between two line segments, plus their squared distance.
function closestPointsOnSegments(
    p1: Vec2, p2: Vec2,
    p3: Vec2, p4: Vec2,
): { c1: Vec2; c2: Vec2; distSq: number } {
    const d1 = { x: p2.x - p1.x, y: p2.y - p1.y };
    const d2 = { x: p4.x - p3.x, y: p4.y - p3.y };
    const r = { x: p1.x - p3.x, y: p1.y - p3.y };

    const a = d1.x * d1.x + d1.y * d1.y;
    const e = d2.x * d2.x + d2.y * d2.y;
    const f = d2.x * r.x + d2.y * r.y;

    let s: number, t: number;
    const EPS = 1e-8;

    if (a <= EPS && e <= EPS) {
        s = 0; t = 0;
    } else if (a <= EPS) {
        s = 0;
        t = Math.max(0, Math.min(1, f / e));
    } else {
        const c = d1.x * r.x + d1.y * r.y;
        if (e <= EPS) {
            t = 0;
            s = Math.max(0, Math.min(1, -c / a));
        } else {
            const b = d1.x * d2.x + d1.y * d2.y;
            const denom = a * e - b * b;
            s = denom !== 0 ? Math.max(0, Math.min(1, (b * f - c * e) / denom)) : 0;
            t = (b * s + f) / e;
            if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
            else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); }
        }
    }

    const c1 = { x: p1.x + d1.x * s, y: p1.y + d1.y * s };
    const c2 = { x: p3.x + d2.x * t, y: p3.y + d2.y * t };
    const dx = c2.x - c1.x;
    const dy = c2.y - c1.y;
    return { c1, c2, distSq: dx * dx + dy * dy };
}

// v_at_point = v + omega × r  →  (vx - omega*ry, vy + omega*rx) in 2D.
function velocityAtPoint(vel: Vec2, omega: number, r: Vec2): Vec2 {
    return { x: vel.x - omega * r.y, y: vel.y + omega * r.x };
}

// Capsule-capsule collision, resolved with an impulse + positional split.
export function collidePens(a: Pen, b: Pen): boolean {
    const eA = penEndpoints(a);
    const eB = penEndpoints(b);
    const { c1, c2, distSq } = closestPointsOnSegments(eA.a, eA.b, eB.a, eB.b);

    const radSum = penRadius(a) + penRadius(b);
    if (distSq >= radSum * radSum) return false;

    const dist = Math.sqrt(distSq);
    let nx: number, ny: number;
    if (dist > 1e-6) {
        nx = (c2.x - c1.x) / dist;
        ny = (c2.y - c1.y) / dist;
    } else {
        nx = 1; ny = 0;
    }

    const penetration = radSum - dist;

    const invMassA = 1 / a.mass;
    const invMassB = 1 / b.mass;
    const totalInvMass = invMassA + invMassB;
    const correctA = penetration * (invMassA / totalInvMass);
    const correctB = penetration * (invMassB / totalInvMass);
    a.pos.x -= nx * correctA;
    a.pos.y -= ny * correctA;
    b.pos.x += nx * correctB;
    b.pos.y += ny * correctB;

    const contact = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
    const rAvec = { x: contact.x - a.pos.x, y: contact.y - a.pos.y };
    const rBvec = { x: contact.x - b.pos.x, y: contact.y - b.pos.y };

    const vA = velocityAtPoint(a.vel, a.omega, rAvec);
    const vB = velocityAtPoint(b.vel, b.omega, rBvec);
    const rvx = vB.x - vA.x;
    const rvy = vB.y - vA.y;

    const vRelN = rvx * nx + rvy * ny;
    if (vRelN > 0) return true;

    const invIA = 1 / a.inertia;
    const invIB = 1 / b.inertia;
    const rAcrossN = rAvec.x * ny - rAvec.y * nx;
    const rBcrossN = rBvec.x * ny - rBvec.y * nx;

    const denom = totalInvMass + rAcrossN * rAcrossN * invIA + rBcrossN * rBcrossN * invIB;
    const j = (-(1 + RESTITUTION) * vRelN) / denom;

    const impulseX = j * nx;
    const impulseY = j * ny;

    a.vel.x -= impulseX * invMassA;
    a.vel.y -= impulseY * invMassA;
    a.omega -= (rAvec.x * impulseY - rAvec.y * impulseX) * invIA;

    b.vel.x += impulseX * invMassB;
    b.vel.y += impulseY * invMassB;
    b.omega += (rBvec.x * impulseY - rBvec.y * impulseX) * invIB;

    // Friction impulse along the tangent.
    const tx = -ny;
    const ty = nx;
    const vRelT = rvx * tx + rvy * ty;
    const rAcrossT = rAvec.x * ty - rAvec.y * tx;
    const rBcrossT = rBvec.x * ty - rBvec.y * tx;
    const denomT = totalInvMass + rAcrossT * rAcrossT * invIA + rBcrossT * rBcrossT * invIB;
    let jt = -vRelT / denomT;

    const maxFriction = COLLISION_FRICTION * Math.abs(j);
    if (jt > maxFriction) jt = maxFriction;
    else if (jt < -maxFriction) jt = -maxFriction;

    const fricX = jt * tx;
    const fricY = jt * ty;

    a.vel.x -= fricX * invMassA;
    a.vel.y -= fricY * invMassA;
    a.omega -= (rAvec.x * fricY - rAvec.y * fricX) * invIA;

    b.vel.x += fricX * invMassB;
    b.vel.y += fricY * invMassB;
    b.omega += (rBvec.x * fricY - rBvec.y * fricX) * invIB;

    return true;
}

// One integration step + friction. dt in seconds.
export function stepPen(p: Pen, dt: number) {
    const linDecay = Math.exp(-LINEAR_DAMPING * dt);
    const angDecay = Math.exp(-ANGULAR_DAMPING * dt);
    p.vel.x *= linDecay;
    p.vel.y *= linDecay;
    p.omega *= angDecay;

    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.angle += p.omega * dt;

    const speedSq = p.vel.x * p.vel.x + p.vel.y * p.vel.y;
    if (speedSq < SLEEP_VEL * SLEEP_VEL) { p.vel.x = 0; p.vel.y = 0; }
    if (Math.abs(p.omega) < SLEEP_OMEGA) p.omega = 0;
}

// How much of the pen's body has crossed the nearest table edge (0 = on, 1 = fully off).
export function offTableFraction(p: Pen, t: Table): number {
    const r = penRadius(p);
    const halfL = p.length / 2;
    const exX = halfL * Math.abs(Math.cos(p.angle)) + r;
    const exY = halfL * Math.abs(Math.sin(p.angle)) + r;

    const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);
    const left = (t.x - (p.pos.x - exX)) / (2 * exX);
    const right = ((p.pos.x + exX) - (t.x + t.w)) / (2 * exX);
    const top = (t.y - (p.pos.y - exY)) / (2 * exY);
    const bottom = ((p.pos.y + exY) - (t.y + t.h)) / (2 * exY);

    return Math.max(clamp01(left), clamp01(right), clamp01(top), clamp01(bottom));
}

export function isResting(p: Pen): boolean {
    return p.vel.x === 0 && p.vel.y === 0 && p.omega === 0;
}

// Impulse along `direction` with magnitude `strength`, applied at `worldContact`.
// Off-center contacts induce spin.
export function applyFlick(p: Pen, worldContact: Vec2, direction: Vec2, strength: number) {
    const mag = Math.hypot(direction.x, direction.y);
    if (mag < 1e-6 || strength < 1e-6) return;

    const adjustedStrength = strength * 0.8;
    const ix = (direction.x / mag) * adjustedStrength;
    const iy = (direction.y / mag) * adjustedStrength;

    const rx = worldContact.x - p.pos.x;
    const ry = worldContact.y - p.pos.y;

    p.vel.x += ix / p.mass;
    p.vel.y += iy / p.mass;
    p.omega += (rx * iy - ry * ix) / p.inertia;
}

// Project a world point onto the pen's axis, clamped to its body.
export function clampToPenBody(p: Pen, world: Vec2): Vec2 {
    const dx = world.x - p.pos.x;
    const dy = world.y - p.pos.y;
    const ax = Math.cos(p.angle);
    const ay = Math.sin(p.angle);
    let along = dx * ax + dy * ay;
    const half = p.length / 2;
    if (along > half) along = half;
    else if (along < -half) along = -half;
    return { x: p.pos.x + ax * along, y: p.pos.y + ay * along };
}

// True if the world point lies within `slack` of the pen body.
export function pointOnPen(p: Pen, world: Vec2, slack = 6): boolean {
    const dx = world.x - p.pos.x;
    const dy = world.y - p.pos.y;
    const ax = Math.cos(p.angle);
    const ay = Math.sin(p.angle);
    const along = dx * ax + dy * ay;
    const perp = dx * -ay + dy * ax;
    const halfL = p.length / 2;
    const halfW = p.width / 2 + slack;
    if (Math.abs(perp) > halfW) return false;
    if (Math.abs(along) > halfL + halfW) return false;
    return true;
}

// ── Turn simulation ─────────────────────────────────────────────────────────

export interface FlickInput {
    seat: Seat;
    contact: Vec2;    // world point on the actor's pen (already clamped to its body)
    direction: Vec2;  // flick direction (opposite the drag — slingshot)
    strength: number;
}

export type FlickOutcome =
    | { kind: "none" }                     // nobody fell → next turn
    | { kind: "knockout"; loser: Seat }    // one pen off → the other wins the round
    | { kind: "double_knockout" };         // both off → drawn round

export interface FlickSimulation {
    outcome: FlickOutcome;
    // Recorded pen poses for client playback, one entry every PLAYBACK_FRAME_MS.
    // Each frame is [x1, y1, angle1, x2, y2, angle2] (seat 1 pen, then seat 2).
    frames: number[][];
    // How long clients should spend on this turn: the motion plus, for a pen
    // left teetering on the edge, the reveal pause. Frames may end earlier —
    // clients hold the last frame for the remainder.
    durationMs: number;
}

const q1 = (v: number) => Math.round(v * 10) / 10;
const q3 = (v: number) => Math.round(v * 1000) / 1000;

function recordFrame(pens: Pen[]): number[] {
    const [p1, p2] = seatOrder(pens);
    return [q1(p1.pos.x), q1(p1.pos.y), q3(p1.angle), q1(p2.pos.x), q1(p2.pos.y), q3(p2.angle)];
}

function seatOrder(pens: Pen[]): [Pen, Pen] {
    return pens[0].player === 1 ? [pens[0], pens[1]] : [pens[1], pens[0]];
}

// Advance one fixed frame. Mirrors the frontend game loop body, including its
// adaptive substepping (more substeps for fast pens so nothing tunnels).
function stepFrame(pens: Pen[], table: Table) {
    if (!pens.some((p) => !isResting(p))) return;

    let maxSpeed = 0;
    for (const p of pens) {
        if (p.offTable) continue;
        const tipSpeed = Math.abs(p.omega) * (p.length / 2);
        const eff = Math.hypot(p.vel.x, p.vel.y) + tipSpeed;
        if (eff > maxSpeed) maxSpeed = eff;
    }
    const distSubsteps = Math.ceil((maxSpeed * FRAME_DT) / MAX_STEP_DIST);
    const substeps = Math.min(MAX_SUBSTEPS, Math.max(1, PHYSICS_SUBSTEPS, distSubsteps));
    const dt = FRAME_DT / substeps;

    for (let s = 0; s < substeps; s++) {
        for (const p of pens) stepPen(p, dt);
        // Off-table pens are sliding away — they no longer collide.
        if (pens.length === 2 && !pens[0].offTable && !pens[1].offTable) {
            collidePens(pens[0], pens[1]);
        }
        // Knockout = center of mass crosses the table edge.
        for (const p of pens) {
            if (p.offTable) continue;
            if (p.pos.x < table.x || p.pos.x > table.x + table.w || p.pos.y < table.y || p.pos.y > table.y + table.h) {
                p.offTable = true;
            }
        }
    }
}

// Round-end detection, same rules as the frontend. Returns null while the
// outcome is still undecided (something is moving that could change it).
function detectOutcome(pens: Pen[], table: Table): { outcome: FlickOutcome; revealMs: number } | null {
    const offPens = pens.filter((p) => p.offTable);
    const othersMoving = pens.some((p) => !p.offTable && !isResting(p));
    const fully = (p: Pen) => offTableFraction(p, table) >= FULL_OFF_FRACTION;

    if (offPens.length >= 2) {
        return { outcome: { kind: "double_knockout" }, revealMs: offPens.every(fully) ? 0 : KNOCKOUT_REVEAL_MS };
    }
    if (offPens.length === 1 && !othersMoving) {
        const loser = offPens[0];
        const cleanFall = fully(loser);
        if (cleanFall || isResting(loser)) {
            return { outcome: { kind: "knockout", loser: loser.player }, revealMs: cleanFall ? 0 : KNOCKOUT_REVEAL_MS };
        }
        return null; // still sliding — wait for it to stop or coast fully off
    }
    if (offPens.length === 0 && pens.every(isResting)) {
        return { outcome: { kind: "none" }, revealMs: 0 };
    }
    return null;
}

// Apply a flick and run the world until the turn is decided. Mutates `pens`
// into their final state.
export function simulateFlick(pens: Pen[], table: Table, flick: FlickInput): FlickSimulation {
    const actor = pens.find((p) => p.player === flick.seat);
    if (!actor) throw new Error(`No pen for seat ${flick.seat}`);
    applyFlick(actor, flick.contact, flick.direction, flick.strength);

    const frames: number[][] = [recordFrame(pens)];
    const maxFrames = Math.ceil(MAX_SIM_SECONDS / FRAME_DT);

    let decided: { outcome: FlickOutcome; revealMs: number } | null = null;
    let concludeAtFrame = 0;
    let frame = 0;
    let lastRecorded = 0;

    while (frame < maxFrames) {
        frame++;
        stepFrame(pens, table);
        if (frame % FRAME_SAMPLE_EVERY === 0) {
            frames.push(recordFrame(pens));
            lastRecorded = frame;
        }

        if (!decided) {
            decided = detectOutcome(pens, table);
            if (decided) concludeAtFrame = frame + Math.ceil(decided.revealMs / 1000 / FRAME_DT);
        }
        // Keep simulating through the reveal so clients see the pen teeter/slide,
        // but stop early once nothing is moving any more.
        if (decided && (frame >= concludeAtFrame || pens.every(isResting))) break;
    }

    if (lastRecorded !== frame) frames.push(recordFrame(pens));

    // Safety net: if the cap was hit undecided, freeze everything and judge as-is.
    if (!decided) {
        for (const p of pens) { p.vel = { x: 0, y: 0 }; p.omega = 0; }
        const off = pens.filter((p) => p.offTable);
        decided = {
            outcome: off.length === 0 ? { kind: "none" }
                : off.length === 1 ? { kind: "knockout", loser: off[0].player }
                : { kind: "double_knockout" },
            revealMs: 0,
        };
        concludeAtFrame = frame;
    }

    // Snap the authoritative state to the precision clients receive, so server
    // and clients hold exactly the same numbers for the next turn.
    for (const p of pens) {
        p.pos = { x: q1(p.pos.x), y: q1(p.pos.y) };
        p.angle = q3(p.angle);
    }

    return {
        outcome: decided.outcome,
        frames,
        durationMs: Math.round(Math.max(frame, concludeAtFrame) * FRAME_DT * 1000),
    };
}
