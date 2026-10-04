// Biro characters. Each is just a different set of the physics knobs createPen
// already exposes (length / width / mass), so the tradeoffs come straight out of
// the simulation:
//   • mass   → flick speed (lighter = faster) vs knockback resistance (heavier = harder to shove off)
//   • length → reach + moment of inertia (longer = steadier aim, harder to spin)
//   • width  → mostly look, with a slightly fatter collision profile
//
// `image` is optional: a biro without one is drawn on the canvas instead. Drop the
// PNG in public/biro images/ (upright, cap at the top) and point `image` at it.
// The picture is always fitted onto the physics capsule, never used for collision.

export type ArchetypeId = "bic" | "lucky" | "racer" | "leo" | "multi";

export interface ArchetypeDef {
    id: ArchetypeId;
    name: string;
    style: string;    // one-word play style shown under the name
    accent: string;   // brand / cap colour — used for card highlights and the drawn fallback
    image?: string;
    length: number;
    width: number;
    mass: number;
    blurb: string;
    // 1–5 ratings shown as bars on the select screen.
    stats: { power: number; speed: number; reach: number; defense: number };
}

export const ARCHETYPES: ArchetypeDef[] = [
    {
        id: "bic",
        name: "Bic",
        style: "All-rounder",
        accent: "#1d6fd1",
        image: "/biro images/bic-biro.png",
        length: 128,
        width: 10,
        mass: 0.9,
        blurb: "The classroom standard. Even in everything, no real weakness. E no get wahala.",
        stats: { power: 3, speed: 4, reach: 3, defense: 3 },
    },
    {
        id: "lucky",
        name: "Lucky",
        style: "Heavy hitter",
        accent: "#1730b5",
        image: "/biro images/Lucky-biro.png",
        length: 120,
        width: 12,
        mass: 1.15,
        blurb: "Solid and steady. Hits harder than it looks and doesn't shake easily.",
        stats: { power: 4, speed: 3, reach: 3, defense: 4 },
    },
    {
        id: "racer",
        name: "Lucky Racer",
        style: "Speedster",
        accent: "#d32020",
        image: "/biro images/luckyracer-biro.png",
        length: 124,
        width: 9,
        mass: 0.62,
        blurb: "Slim and feather-light. E go fly across the desk. But one solid knock and e don comot.",
        stats: { power: 2, speed: 5, reach: 3, defense: 1 },
    },
    {
        id: "leo",
        name: "Leo Smart",
        style: "Steady aim",
        accent: "#222222",
        image: "/biro images/leosmart-biro-cutout.png",
        length: 126,
        width: 10,
        mass: 1.15,
        blurb: "Sleek and solid. Its long body spins less than most, so your flicks stay on target.",
        stats: { power: 4, speed: 3, reach: 3, defense: 4 },
    },
    {
        id: "multi",
        name: "Multi Colour",
        style: "Tank",
        accent: "#e0337a",
        image: "/biro images/multicolor-biro.png",
        length: 112,
        width: 14,
        mass: 1.9,
        blurb: "The chunkiest biro in class, four refills packed inside. Slow off the mark, but almost impossible to push off.",
        stats: { power: 5, speed: 2, reach: 2, defense: 5 },
    },
];

export const ARCHETYPE_MAP: Record<ArchetypeId, ArchetypeDef> = ARCHETYPES.reduce(
    (acc, def) => {
        acc[def.id] = def;
        return acc;
    },
    {} as Record<ArchetypeId, ArchetypeDef>,
);

export const DEFAULT_ARCHETYPE: ArchetypeId = "bic";
