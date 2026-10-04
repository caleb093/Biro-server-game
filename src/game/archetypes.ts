// Server copy of the biro characters. Only the physics knobs live here
// (length / width / mass) — names, colours, images and stat bars are purely
// presentational and stay on the frontend. Keep these numbers in sync with the
// frontend's archetypes.ts, or the two will disagree about pen sizes.

export const ARCHETYPE_IDS = ["bic", "lucky", "racer", "leo", "multi"] as const;
export type ArchetypeId = (typeof ARCHETYPE_IDS)[number];

export interface ArchetypePhysics {
    length: number;
    width: number;
    mass: number;
}

export const ARCHETYPES: Record<ArchetypeId, ArchetypePhysics> = {
    bic:   { length: 128, width: 10, mass: 0.9 },
    lucky: { length: 120, width: 12, mass: 1.15 },
    racer: { length: 124, width: 9,  mass: 0.62 },
    leo:   { length: 126, width: 10, mass: 1.15 },
    multi: { length: 112, width: 14, mass: 1.9 },
};

export const DEFAULT_ARCHETYPE: ArchetypeId = "bic";

export const isArchetypeId = (v: unknown): v is ArchetypeId =>
    typeof v === "string" && (ARCHETYPE_IDS as readonly string[]).includes(v);
