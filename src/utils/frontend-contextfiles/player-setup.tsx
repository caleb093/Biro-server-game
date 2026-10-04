import { FC, useContext, useState } from "react";
import Image from "next/image";
import { appContext } from "@/contexts/appContext";
import type { PowerUpId } from "./power-ups";
// Power-ups are switched off for now. To bring them back, uncomment this and every
// block marked POWER-UPS DISABLED below (and in game.tsx).
// import { MAX_LOADOUT, POWER_UPS } from "./power-ups";
import { ARCHETYPES, ArchetypeDef, ArchetypeId } from "./archetypes";
import type { PenFightMode } from "./index";
import { CARD_BG, INK, INK_NAME, MUTED, NAIJA_GREEN, TEXT, markerFont, sticker } from "./theme";

export interface PlayerSetup {
    archetype: ArchetypeId;
    loadout: PowerUpId[];
}

// Upright picture of the biro. Biros whose PNG hasn't been added yet get a simple
// drawn stand-in in their brand colour (same shape the canvas draws in-game).
const BiroPreview: FC<{ def: ArchetypeDef }> = ({ def }) => {
    if (def.image) {
        return (
            <div className="relative h-[120px] w-[40px] shrink-0">
                <Image src={def.image} alt={def.name} fill unoptimized sizes="40px" className="object-contain" />
            </div>
        );
    }
    return (
        <svg viewBox="0 0 24 120" className="h-[120px] w-[24px] shrink-0 mx-2" aria-label={def.name}>
            <rect x={5} y={4} width={14} height={112} rx={6} fill="#eef2f6" stroke="#8d99a6" strokeWidth={1} />
            <rect x={11} y={40} width={2} height={64} fill="#2a2a2a" />
            <rect x={5} y={4} width={14} height={36} rx={6} fill={def.accent} />
            <rect x={17} y={10} width={3.5} height={34} rx={1.5} fill={def.accent} stroke="rgba(0,0,0,0.25)" strokeWidth={0.6} />
            <rect x={6} y={108} width={12} height={8} rx={3} fill={def.accent} />
        </svg>
    );
};

const StatBar: FC<{ label: string; value: number; color: string }> = ({ label, value, color }) => (
    <div className="flex items-center gap-1.5">
        <span className="text-[9px] font-bold w-7" style={{ color: MUTED }}>{label}</span>
        <div className="flex gap-0.5 flex-1">
            {Array.from({ length: 5 }).map((_, i) => (
                <span
                    key={i}
                    className="h-1.5 flex-1 rounded-sm"
                    style={{ background: i < value ? color : "rgba(31,42,68,0.12)" }}
                />
            ))}
        </div>
    </div>
);

const CheckBadge: FC<{ color: string }> = ({ color }) => (
    <span className="ml-auto text-[10px] font-black px-1.5 py-0.5 rounded text-white" style={{ background: color }}>✓</span>
);

// Pre-match setup for one player: pick a biro (+ 3 power-ups, currently disabled).
// index.tsx runs this once (AI match: P1 only) or twice (PvP: P1 then P2).
const PlayerSetup: FC<{
    player: 1 | 2;
    mode: PenFightMode;
    onConfirm: (setup: PlayerSetup) => void;
    onBack: () => void;
}> = ({ player, mode, onConfirm, onBack }) => {
    const { playSfx } = useContext(appContext);
    const [archetype, setArchetype] = useState<ArchetypeId | null>(null);
    // POWER-UPS DISABLED
    // const [loadout, setLoadout] = useState<PowerUpId[]>([]);

    const ink = INK[player];
    const who = mode === "ai" ? "YOU" : `PLAYER ${player}`;

    const pickArchetype = (id: ArchetypeId) => {
        playSfx?.("beamInteraction");
        setArchetype(id);
    };

    // POWER-UPS DISABLED
    // const togglePower = (id: PowerUpId) => {
    //     playSfx?.("beamInteraction");
    //     setLoadout(prev => {
    //         if (prev.includes(id)) return prev.filter(x => x !== id);
    //         if (prev.length >= MAX_LOADOUT) return prev;
    //         return [...prev, id];
    //     });
    // };
    //
    // const loadoutFull = loadout.length === MAX_LOADOUT;
    // const ready = archetype !== null && loadoutFull;
    const ready = archetype !== null;

    return (
        <div className="relative h-full w-full flex flex-col items-center px-4 py-6 overflow-y-auto">
            <button
                onClick={onBack}
                className="absolute top-4 sm:top-5 left-4 sm:left-5 px-3 py-1 text-xs sm:text-sm font-extrabold uppercase rounded-md cursor-pointer transition-transform hover:-translate-y-0.5 z-10"
                style={sticker(TEXT)}
            >
                ◂ Back
            </button>

            <p className="text-xs sm:text-sm font-extrabold uppercase tracking-widest mt-2" style={{ color: ink }}>
                {who} · {INK_NAME[player]}
            </p>

            {/* ---- BIRO PICKER ---- */}
            <h2 className={`${markerFont.className} text-[1.7em] sm:text-[2.2em] leading-none text-center mt-2`} style={{ color: TEXT }}>
                Select your <span style={{ color: ink }}>Biro</span>
            </h2>

            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 mt-4 w-full max-w-5xl">
                {ARCHETYPES.map(def => {
                    const isSel = archetype === def.id;
                    return (
                        <button
                            key={def.id}
                            onClick={() => pickArchetype(def.id)}
                            className="relative text-left p-3 rounded-lg transition-transform duration-150 cursor-pointer hover:-translate-y-0.5"
                            style={isSel ? sticker(ink, CARD_BG) : { background: CARD_BG, border: "2px solid rgba(31,42,68,0.18)" }}
                        >
                            <div className="flex items-center gap-1.5">
                                <span className="text-sm font-extrabold uppercase leading-tight" style={{ color: TEXT }}>
                                    {def.name}
                                </span>
                                {isSel && <CheckBadge color={ink} />}
                            </div>
                            <p className="text-[10px] font-bold uppercase" style={{ color: def.accent }}>{def.style}</p>

                            <div className="flex items-center gap-2 my-2">
                                <BiroPreview def={def} />
                                <div className="flex flex-col gap-1.5 flex-1">
                                    <StatBar label="PWR" value={def.stats.power} color={ink} />
                                    <StatBar label="SPD" value={def.stats.speed} color={ink} />
                                    <StatBar label="RCH" value={def.stats.reach} color={ink} />
                                    <StatBar label="DEF" value={def.stats.defense} color={ink} />
                                </div>
                            </div>

                            <p className="text-[11px] leading-snug" style={{ color: MUTED }}>{def.blurb}</p>
                        </button>
                    );
                })}
            </div>

            {/* ---- POWER-UP PICKER ---- POWER-UPS DISABLED
            <div className="flex items-center gap-3 mt-7">
                <h2 className={`${markerFont.className} text-[1.7em] sm:text-[2.2em] leading-none text-center`} style={{ color: TEXT }}>
                    2 · Pick <span style={{ color: ink }}>3</span> power-ups
                </h2>
                <div className="flex items-center gap-1">
                    {Array.from({ length: MAX_LOADOUT }).map((_, i) => (
                        <span
                            key={i}
                            className="h-2 w-6 rounded-full"
                            style={{ background: i < loadout.length ? ink : "rgba(31,42,68,0.15)" }}
                        />
                    ))}
                </div>
            </div>

            <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 mt-4 w-full max-w-5xl">
                {POWER_UPS.map(def => {
                    const isSel = loadout.includes(def.id);
                    const dim = !isSel && loadoutFull;
                    return (
                        <button
                            key={def.id}
                            onClick={() => togglePower(def.id)}
                            disabled={dim}
                            className="relative text-left p-3 rounded-lg transition-transform duration-150 cursor-pointer enabled:hover:-translate-y-0.5 disabled:cursor-not-allowed"
                            style={{
                                ...(isSel ? sticker(def.color, CARD_BG) : { background: CARD_BG, border: "2px solid rgba(31,42,68,0.18)" }),
                                opacity: dim ? 0.4 : 1,
                            }}
                        >
                            <div className="flex items-center gap-2">
                                <span className="text-2xl">{def.icon}</span>
                                <span className="text-sm font-extrabold uppercase" style={{ color: def.color }}>
                                    {def.name}
                                </span>
                                {isSel && <CheckBadge color={def.color} />}
                            </div>
                            <p className="text-[12px] leading-snug mt-2" style={{ color: MUTED }}>{def.blurb}</p>
                        </button>
                    );
                })}
            </div>
            */}

            <button
                onClick={() => { if (ready) { playSfx?.("beamInteraction"); onConfirm({ archetype: archetype!, loadout: [] /* power-ups disabled */ }); } }}
                disabled={!ready}
                className="mt-7 mb-2 px-12 py-3 rounded-lg font-extrabold text-base uppercase transition-transform duration-200 enabled:hover:-translate-y-0.5 enabled:cursor-pointer disabled:cursor-not-allowed"
                style={ready
                    ? { ...sticker(TEXT, NAIJA_GREEN), color: "#fff" }
                    : { background: "rgba(31,42,68,0.06)", border: "2px solid rgba(31,42,68,0.2)", color: "rgba(31,42,68,0.35)" }}
            >
                {mode === "pvp" && player === 1 ? "Next ▶" : "Let's play ▶"}
            </button>
        </div>
    );
};

export default PlayerSetup;
