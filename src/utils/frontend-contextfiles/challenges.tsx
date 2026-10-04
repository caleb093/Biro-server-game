import { FC } from "react";
import Modal from "@/components/primary/modal";
import { PAPER_MODAL_CLASS } from "@/components/modals/how-to-play";
import { ARCHETYPE_MAP, ArchetypeId } from "./archetypes";
import { CARD_BG, INK, MUTED, NAIJA_GREEN, TEXT, bodyFont, markerFont, sticker } from "./theme";

export interface Challenge {
    id: string;
    from: string;
    biro: ArchetypeId; // the challenger's biro
    message: string;
    sentAgo: string;
}

// Dummy data until there's a backend — swap for the logged-in user's real challenges.
export const DUMMY_CHALLENGES: Challenge[] = [
    { id: "c1", from: "Lekan_Flicks", biro: "multi", message: "Your biro no fit my Multi Colour. Come and see.", sentAgo: "5 min ago" },
    { id: "c2", from: "Khadijat", biro: "bic", message: "Best of 3. Loser buys puff-puff.", sentAgo: "1 hr ago" },
];

const Challenges: FC<{
    isOpen: boolean;
    onClose: () => void;
    challenges: Challenge[];
    onAccept: (challenge: Challenge) => void;
    onReject: (challenge: Challenge) => void;
}> = ({ isOpen, onClose, challenges, onAccept, onReject }) => (
    <Modal isOpen={isOpen} onClose={onClose} containerClassname={PAPER_MODAL_CLASS}>
        <div className={bodyFont.className}>
            <h2 className={`${markerFont.className} text-3xl text-center`} style={{ color: INK[1] }}>
                ⚔️ Chal<span style={{ color: INK[2] }}>lenges</span>
            </h2>
            <p className="text-xs font-bold uppercase text-center mt-1 mb-4" style={{ color: MUTED }}>
                {challenges.length > 0 ? `${challenges.length} waiting for you` : "No challenges right now"}
            </p>

            {challenges.length === 0 ? (
                <p className="text-sm text-center py-6" style={{ color: MUTED }}>
                    Nobody has challenged you yet. Dem dey fear you. 😎
                </p>
            ) : (
                <ul className="flex flex-col gap-3">
                    {challenges.map(challenge => (
                        <li key={challenge.id} className="p-3 rounded-lg" style={{ background: CARD_BG, border: "2px solid rgba(31,42,68,0.18)" }}>
                            <div className="flex items-baseline justify-between gap-2">
                                <span className="font-extrabold truncate" style={{ color: TEXT }}>{challenge.from}</span>
                                <span className="text-[11px] shrink-0" style={{ color: MUTED }}>{challenge.sentAgo}</span>
                            </div>
                            <p className="text-[11px] font-bold uppercase" style={{ color: ARCHETYPE_MAP[challenge.biro].accent }}>
                                Playing with {ARCHETYPE_MAP[challenge.biro].name}
                            </p>
                            <p className="text-sm italic mt-1.5" style={{ color: TEXT }}>&ldquo;{challenge.message}&rdquo;</p>

                            <div className="flex gap-2 mt-3">
                                <button
                                    onClick={() => onAccept(challenge)}
                                    className="flex-1 px-4 py-1.5 rounded-md text-sm font-extrabold uppercase text-white cursor-pointer transition-transform hover:-translate-y-0.5"
                                    style={sticker(TEXT, NAIJA_GREEN)}
                                >
                                    Accept
                                </button>
                                <button
                                    onClick={() => onReject(challenge)}
                                    className="flex-1 px-4 py-1.5 rounded-md text-sm font-extrabold uppercase cursor-pointer transition-transform hover:-translate-y-0.5"
                                    style={{ ...sticker(TEXT), color: INK[2] }}
                                >
                                    Reject
                                </button>
                            </div>
                        </li>
                    ))}
                </ul>
            )}
        </div>
    </Modal>
);

export default Challenges;
