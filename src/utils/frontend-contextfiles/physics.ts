// Pen-fight physics — 2D rigid body simulation tuned for a tabletop pen fight.
// Each pen is treated as a capsule (oriented segment with radius) for fast,
// stable collision detection. Linear + angular friction model the real-world
// sliding-and-spinning of a pen on a table surface.

export type Vec2 = { x: number; y: number };

import type { ArchetypeId } from "./archetypes";

export interface Pen {
    pos: Vec2;          // center of mass
    vel: Vec2;          // px/sec
    angle: number;      // radians, 0 = pointing +x
    omega: number;      // rad/sec
    length: number;     // tip-to-tip length
    width: number;      // perpendicular thickness (capsule radius * 2)
    mass: number;
    inertia: number;    // moment of inertia about the center
    color: string;
    accent: string;     // brand / cap colour
    archetype: ArchetypeId; // which biro this pen is — picks its sprite in drawPen
    player: 1 | 2;
    offTable: boolean;  // set true once the center of mass crosses the table edge
}

export interface Table {
    x: number;
    y: number;
    w: number;
    h: number;
}

// Tuning constants — picked by feel to match a real pen on a wood/desk surface.
export const LINEAR_DAMPING = 2.25;     // higher = slows down faster
export const ANGULAR_DAMPING = 1.9;
export const SLEEP_VEL = 6;             // px/sec — below this we consider it stopped
export const SLEEP_OMEGA = 0.25;        // rad/sec
export const RESTITUTION = 0.32;        // collision bounciness
export const COLLISION_FRICTION = 0.28; // tangential friction at contact

export function createPen(
    pos: Vec2,
    angle: number,
    color: string,
    accent: string,
    player: 1 | 2,
    length = 90,
    width = 14,
    mass = 1,
    archetype: ArchetypeId = "bic",
): Pen {
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
        color,
        accent,
        archetype,
        player,
        offTable: false,
    };
}

// World-space endpoints of the pen's central axis.
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

// Find the closest pair of points between two line segments. Returns the
// points and the squared distance between them.
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

// In 2D the cross product of two vectors is a scalar; angular velocity is
// also a scalar, so v_at_point = v + omega × r becomes (vx - omega*ry, vy + omega*rx).
function velocityAtPoint(vel: Vec2, omega: number, r: Vec2): Vec2 {
    return { x: vel.x - omega * r.y, y: vel.y + omega * r.x };
}

// Detect capsule-capsule collision and resolve with impulse + positional split.
// Returns true if a collision was processed (useful for SFX triggers).
export function collidePens(a: Pen, b: Pen): boolean {
    const eA = penEndpoints(a);
    const eB = penEndpoints(b);
    const { c1, c2, distSq } = closestPointsOnSegments(eA.a, eA.b, eB.a, eB.b);

    const rA = penRadius(a);
    const rB = penRadius(b);
    const radSum = rA + rB;

    if (distSq >= radSum * radSum) return false;

    const dist = Math.sqrt(distSq);
    // Normal points from A's surface into B's surface.
    let nx: number, ny: number;
    if (dist > 1e-6) {
        nx = (c2.x - c1.x) / dist;
        ny = (c2.y - c1.y) / dist;
    } else {
        // Degenerate: pens exactly overlapping — push along an arbitrary axis.
        nx = 1; ny = 0;
    }

    const penetration = radSum - dist;

    // Mass-weighted positional correction so both pens share the separation.
    const invMassA = 1 / a.mass;
    const invMassB = 1 / b.mass;
    const totalInvMass = invMassA + invMassB;
    const correctA = penetration * (invMassA / totalInvMass);
    const correctB = penetration * (invMassB / totalInvMass);
    a.pos.x -= nx * correctA;
    a.pos.y -= ny * correctA;
    b.pos.x += nx * correctB;
    b.pos.y += ny * correctB;

    // Contact point sits halfway between the closest points.
    const contact = { x: (c1.x + c2.x) / 2, y: (c1.y + c2.y) / 2 };
    const rAvec = { x: contact.x - a.pos.x, y: contact.y - a.pos.y };
    const rBvec = { x: contact.x - b.pos.x, y: contact.y - b.pos.y };

    // Relative velocity at the contact point.
    const vA = velocityAtPoint(a.vel, a.omega, rAvec);
    const vB = velocityAtPoint(b.vel, b.omega, rBvec);
    const rvx = vB.x - vA.x;
    const rvy = vB.y - vA.y;

    const vRelN = rvx * nx + rvy * ny;
    if (vRelN > 0) return true; // already separating — positional fix above is enough

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

    // Friction impulse along the tangent — gives realistic grinding/spin transfer.
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

// Apply a single integration step + friction. dt in seconds.
// Off-table pens keep integrating so they slide off naturally (friction still
// brings them to rest) — the caller decides the round outcome from where they land.
export function stepPen(p: Pen, dt: number) {
    // Exponential decay is stable at any dt; tweak the constants above for feel.
    const linDecay = Math.exp(-LINEAR_DAMPING * dt);
    const angDecay = Math.exp(-ANGULAR_DAMPING * dt);
    p.vel.x *= linDecay;
    p.vel.y *= linDecay;
    p.omega *= angDecay;

    p.pos.x += p.vel.x * dt;
    p.pos.y += p.vel.y * dt;
    p.angle += p.omega * dt;

    // Snap to rest below threshold to stop drift.
    const speedSq = p.vel.x * p.vel.x + p.vel.y * p.vel.y;
    if (speedSq < SLEEP_VEL * SLEEP_VEL) { p.vel.x = 0; p.vel.y = 0; }
    if (Math.abs(p.omega) < SLEEP_OMEGA) p.omega = 0;
}

// How much of the pen's body has crossed the nearest table edge, as a fraction
// of the pen's extent in that direction. Treats the pen as its oriented bounding
// box (capsule silhouette), so it's consistent regardless of how the pen is
// rotated relative to the edge it's leaving over.
//   0.0  = fully on the table
//   0.5  = the pen's center sits exactly on the edge (half the body across)
//   1.0  = the entire body is past the edge
export function offTableFraction(p: Pen, t: Table): number {
    const r = penRadius(p);
    const halfL = p.length / 2;
    // Half-extent of the capsule projected onto each world axis.
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

// Apply a flick: impulse along `direction` with magnitude `strength`,
// applied at `worldContact`. Off-center contacts naturally induce spin.
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

// Project a world point onto the pen's local axis, clamped to its body.
// Used so the flick contact always sits on the pen itself, even if the
// player clicked slightly off it.
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

// Hit test for input — true if the world point lies within `slack` of the pen body.
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