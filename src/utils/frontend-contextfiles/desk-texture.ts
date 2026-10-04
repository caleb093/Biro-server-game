import { markerFont } from "./theme";

// Paints the wooden school-desk top once so the render loop just blits it. Real
// classroom desks are never clean, so on top of the planks and grain we pile up
// years of abuse: grime, scratches, carved gouges, ink blots, tea rings, Tipp-Ex,
// biro-testing scribbles and a lot of writing. Seeded, so the desk is the same
// every match.
const HAND_FONT = `"Segoe Print", "Bradley Hand", "Comic Sans MS", cursive`;
const BIRO_INKS = ["28,52,150", "25,25,30", "180,30,30"]; // blue, black, red (rgb)

export function buildDeskTexture(w: number, h: number): HTMLCanvasElement {
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const g = c.getContext("2d", { willReadFrequently: true });
    if (!g) return c;

    let seed = 20240917;
    const rand = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const between = (a: number, b: number) => a + rand() * (b - a);
    const pick = <T,>(xs: T[]) => xs[Math.floor(rand() * xs.length)];

    // ---- Wood ----
    const base = g.createLinearGradient(0, 0, 0, h);
    base.addColorStop(0, "#b47c47");
    base.addColorStop(1, "#9c6637");
    g.fillStyle = base;
    g.fillRect(0, 0, w, h);

    // Three planks, alternately tinted, with dark seams between them.
    const planks = 3;
    const ph = h / planks;
    for (let i = 0; i < planks; i++) {
        g.fillStyle = i % 2 === 0 ? "rgba(255,235,200,0.05)" : "rgba(60,30,10,0.06)";
        g.fillRect(0, i * ph, w, ph);
        if (i > 0) {
            g.fillStyle = "rgba(55,28,10,0.55)";
            g.fillRect(0, i * ph - 2, w, 4);
            // Dirt packed into the seam.
            g.fillStyle = "rgba(30,15,5,0.35)";
            for (let x = 0; x < w; x += between(4, 30)) g.fillRect(x, i * ph - 3, between(3, 18), between(5, 8));
        }
    }

    // Grain: long wavy lines running along the planks.
    for (let i = 0; i < 160; i++) {
        const y0 = rand() * h;
        const amp = 2 + rand() * 6;
        const freq = 0.002 + rand() * 0.004;
        const phase = rand() * Math.PI * 2;
        g.strokeStyle = `rgba(70,38,14,${0.05 + rand() * 0.12})`;
        g.lineWidth = 0.6 + rand() * 1.6;
        g.beginPath();
        for (let x = 0; x <= w; x += 12) {
            const y = y0 + Math.sin(x * freq + phase) * amp;
            if (x === 0) g.moveTo(x, y); else g.lineTo(x, y);
        }
        g.stroke();
    }

    // Knots.
    for (let i = 0; i < 5; i++) {
        const kx = rand() * w;
        const ky = rand() * h;
        const rx = 10 + rand() * 14;
        for (let ring = 0; ring < 3; ring++) {
            g.strokeStyle = `rgba(70,38,14,${0.3 - ring * 0.08})`;
            g.lineWidth = 1.5;
            g.beginPath();
            g.ellipse(kx, ky, rx + ring * 7, (rx + ring * 7) * 0.4, 0, 0, Math.PI * 2);
            g.stroke();
        }
    }

    // ---- Grime ----
    const blotch = (x: number, y: number, r: number, rgba: string, a: number) => {
        const grad = g.createRadialGradient(x, y, 0, x, y, r);
        grad.addColorStop(0, `rgba(${rgba},${a})`);
        grad.addColorStop(1, `rgba(${rgba},0)`);
        g.fillStyle = grad;
        g.fillRect(x - r, y - r, r * 2, r * 2);
    };
    for (let i = 0; i < 30; i++) blotch(rand() * w, rand() * h, between(60, 230), "45,22,6", between(0.08, 0.22));
    // Lighter, polished patches where elbows and exercise books rub.
    for (let i = 0; i < 9; i++) blotch(rand() * w, rand() * h, between(80, 200), "255,225,185", between(0.05, 0.12));
    // The edges collect the most dirt.
    const EDGE = 80;
    const edges: [number, number, number, number][] = [[0, 0, 0, EDGE], [0, h, 0, h - EDGE], [0, 0, EDGE, 0], [w, 0, w - EDGE, 0]];
    for (const [x0, y0, x1, y1] of edges) {
        const grad = g.createLinearGradient(x0, y0, x1, y1);
        grad.addColorStop(0, "rgba(35,18,5,0.4)");
        grad.addColorStop(1, "rgba(35,18,5,0)");
        g.fillStyle = grad;
        g.fillRect(0, 0, w, h);
    }

    // ---- Stains ----
    // Irregular blob: a jagged polygon around (x, y).
    const blob = (x: number, y: number, r: number) => {
        g.beginPath();
        const pts = 16;
        for (let i = 0; i <= pts; i++) {
            const a = (i / pts) * Math.PI * 2;
            const rr = r * between(0.65, 1.2);
            if (i === 0) g.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
            else g.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
        }
        g.closePath();
    };
    // Tea / water rings left by cups, usually broken.
    for (let i = 0; i < 6; i++) {
        const x = rand() * w, y = rand() * h, r = between(28, 46);
        g.fillStyle = "rgba(70,35,10,0.06)";
        g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
        g.strokeStyle = `rgba(70,35,10,${between(0.2, 0.35)})`;
        g.lineWidth = between(2.5, 5);
        const start = rand() * Math.PI * 2;
        g.beginPath(); g.arc(x, y, r, start, start + between(Math.PI * 1.2, Math.PI * 2)); g.stroke();
    }
    // Ink blots with splatter.
    for (let i = 0; i < 14; i++) {
        const x = rand() * w, y = rand() * h, r = between(4, 20);
        const ink = pick(BIRO_INKS);
        g.fillStyle = `rgba(${ink},${between(0.45, 0.8)})`;
        blob(x, y, r);
        g.fill();
        const dots = Math.floor(between(3, 10));
        for (let d = 0; d < dots; d++) {
            const a = rand() * Math.PI * 2, dist = r * between(1.3, 3);
            g.beginPath(); g.arc(x + Math.cos(a) * dist, y + Math.sin(a) * dist, between(0.8, 3), 0, Math.PI * 2); g.fill();
        }
    }
    // Tipp-Ex: chalky correction-fluid smears, some with a drip.
    for (let i = 0; i < 6; i++) {
        const x = rand() * w, y = rand() * h, r = between(12, 30);
        g.fillStyle = `rgba(246,244,236,${between(0.65, 0.9)})`;
        blob(x, y, r);
        g.fill();
        if (rand() < 0.5) g.fillRect(x - 2, y, between(3, 5), r + between(10, 30));
    }

    // ---- Scratches ----
    // Fresh scratches show pale wood; old ones have gone dark with dirt.
    const scratch = (x: number, y: number, len: number, ang: number) => {
        const fresh = rand() < 0.45;
        g.strokeStyle = fresh ? `rgba(255,225,185,${between(0.1, 0.32)})` : `rgba(40,20,5,${between(0.1, 0.3)})`;
        g.lineWidth = between(0.4, 1.5);
        g.beginPath();
        g.moveTo(x, y);
        g.quadraticCurveTo(
            x + Math.cos(ang) * len * 0.5 + between(-3, 3), y + Math.sin(ang) * len * 0.5 + between(-3, 3),
            x + Math.cos(ang) * len, y + Math.sin(ang) * len,
        );
        g.stroke();
    };
    for (let i = 0; i < 1100; i++) scratch(rand() * w, rand() * h, between(5, 70), rand() * Math.PI * 2);
    // Clusters of near-parallel scratches (someone dragging a compass across).
    for (let i = 0; i < 25; i++) {
        const x = rand() * w, y = rand() * h, ang = rand() * Math.PI * 2, n = Math.floor(between(3, 9));
        for (let k = 0; k < n; k++) scratch(x + k * between(2, 6), y + k * between(1, 5), between(30, 120), ang + between(-0.08, 0.08));
    }

    // ---- Gouges ----
    // Deep jagged cuts: a dark groove with a pale lit lip.
    for (let i = 0; i < 45; i++) {
        let x = rand() * w, y = rand() * h, ang = rand() * Math.PI * 2;
        const pts: [number, number][] = [[x, y]];
        const segs = Math.floor(between(2, 6));
        for (let s = 0; s < segs; s++) {
            ang += between(-0.6, 0.6);
            const len = between(8, 40);
            x += Math.cos(ang) * len;
            y += Math.sin(ang) * len;
            pts.push([x, y]);
        }
        const width = between(1.5, 4);
        for (const [dx, col, lw] of [[1.4, "rgba(255,225,185,0.18)", width * 0.6], [0, `rgba(35,16,4,${between(0.35, 0.6)})`, width]] as const) {
            g.strokeStyle = col;
            g.lineWidth = lw;
            g.lineCap = "round";
            g.beginPath();
            pts.forEach(([px, py], k) => (k === 0 ? g.moveTo(px + dx, py + dx) : g.lineTo(px + dx, py + dx)));
            g.stroke();
        }
    }

    // ---- Writing ----
    // Carved with a compass point: drawn a few times with jitter so the strokes look hacked in.
    const carve = (text: string, x: number, y: number, size: number, ang: number) => {
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        g.font = `${size}px ${markerFont.style.fontFamily}, cursive`;
        g.textAlign = "center";
        g.fillStyle = "rgba(255,230,190,0.14)"; // lit lower lip of the groove
        g.fillText(text, 2, 2);
        for (let k = 0; k < 3; k++) {
            g.fillStyle = `rgba(45,22,6,${between(0.12, 0.22)})`;
            g.fillText(text, between(-1.5, 1.5), between(-1.5, 1.5));
        }
        g.restore();
    };
    // Written in biro, soaked into the wood. Returns the text width for inline layout.
    const scrawl = (text: string, x: number, y: number, size: number, ang: number, ink = pick(BIRO_INKS), align: CanvasTextAlign = "center") => {
        g.save();
        g.translate(x, y);
        g.rotate(ang);
        g.font = `${size}px ${HAND_FONT}`;
        g.textAlign = align;
        g.fillStyle = `rgba(${ink},${between(0.55, 0.8)})`;
        g.fillText(text, 0, 0);
        g.fillText(text, 0.6, 0.3); // pen pressed twice
        const width = g.measureText(text).width;
        g.restore();
        return width;
    };
    const heartPath = (x: number, y: number, s: number) => {
        g.beginPath();
        g.moveTo(x, y + s * 0.35);
        g.bezierCurveTo(x - s * 1.1, y - s * 0.35, x - s * 0.5, y - s * 1.1, x, y - s * 0.45);
        g.bezierCurveTo(x + s * 0.5, y - s * 1.1, x + s * 1.1, y - s * 0.35, x, y + s * 0.35);
        g.closePath();
    };

    // The headline pieces, placed by hand so they stay readable.
    carve("No school go home", w * 0.3, h * 0.3, 70, -0.08);
    scrawl("Lekan was here", w * 0.83, h * 0.12, 26, 0.05, BIRO_INKS[1]);

    // "Khadijat ❤ John" inside a big red heart with an arrow through it.
    {
        const hx = w * 0.66, hy = h * 0.72;
        g.save();
        g.translate(hx, hy);
        g.rotate(0.06);
        g.strokeStyle = `rgba(${BIRO_INKS[2]},0.7)`;
        g.lineWidth = 3;
        heartPath(0, 70, 200);
        g.stroke();
        // Arrow through the top of the heart, clear of the names.
        g.beginPath(); g.moveTo(-240, -40); g.lineTo(240, -110); g.stroke();
        g.beginPath(); g.moveTo(240, -110); g.lineTo(218, -116); g.moveTo(240, -110); g.lineTo(226, -92); g.stroke();
        g.font = `34px ${HAND_FONT}`;
        const left = g.measureText("Khadijat ").width;
        const right = g.measureText(" John").width;
        const heart = 28;
        const total = left + heart + right;
        scrawl("Khadijat ", -total / 2, 10, 34, 0, BIRO_INKS[0], "left");
        g.fillStyle = `rgba(${BIRO_INKS[2]},0.85)`;
        heartPath(-total / 2 + left + heart / 2, 6, 18);
        g.fill();
        scrawl(" John", -total / 2 + left + heart, 10, 34, 0, BIRO_INKS[0], "left");
        g.restore();
    }

    const carvings = ["JSS 2B", "Messsi", "Chidi was here", "No noise!", "Class Captain", "SS1 C", "2 - 1", "Emeka", "WAEC loading..."];
    const scrawls = [
        "Maths na wa o", "Names of noice makers", "Mr Adeyemi is smelling", "Tunde give my money", "Arsenal 4 life",
        "Who took my biro?", "Kemi + Seyi", "Jollof > Fried rice", "Samuel Alajo", "Home work??", "I don tire",
        "1 + 1 = 11", "Bola is a goat", "Prefect", "no talking",
    ];
    for (const text of carvings) carve(text, between(0.05, 0.95) * w, between(0.08, 0.95) * h, between(34, 56), between(-0.4, 0.4));
    for (const text of scrawls) scrawl(text, between(0.06, 0.94) * w, between(0.06, 0.96) * h, between(18, 30), between(-0.5, 0.5));

    // ---- Doodles ----
    const inkStroke = (ink: string, lw = 2) => {
        g.strokeStyle = `rgba(${ink},${between(0.5, 0.75)})`;
        g.lineWidth = lw;
        g.lineCap = "round";
    };
    // Biro-testing scribbles: tight tangled loops from making a dry pen write.
    for (let i = 0; i < 16; i++) {
        let x = rand() * w, y = rand() * h;
        inkStroke(pick(BIRO_INKS), between(1, 2));
        g.beginPath();
        g.moveTo(x, y);
        for (let k = 0; k < 40; k++) {
            const nx = x + between(-14, 14), ny = y + between(-9, 9);
            g.quadraticCurveTo((x + nx) / 2 + between(-10, 10), (y + ny) / 2 + between(-10, 10), nx, ny);
            x = nx; y = ny;
        }
        g.stroke();
    }
    // Tally marks.
    for (let i = 0; i < 5; i++) {
        const x = rand() * w, y = rand() * h, groups = Math.floor(between(1, 4));
        inkStroke(pick(BIRO_INKS));
        for (let gi = 0; gi < groups; gi++) {
            const gx = x + gi * 34;
            g.beginPath();
            for (let k = 0; k < 4; k++) { g.moveTo(gx + k * 6, y); g.lineTo(gx + k * 6 + between(-2, 2), y + 26); }
            g.moveTo(gx - 4, y + 20); g.lineTo(gx + 24, y + 4);
            g.stroke();
        }
    }
    // Abandoned games of X and O.
    for (let i = 0; i < 3; i++) {
        const x = rand() * w, y = rand() * h, s = between(18, 26);
        inkStroke(pick(BIRO_INKS));
        g.beginPath();
        for (const k of [1, 2]) {
            g.moveTo(x + k * s, y); g.lineTo(x + k * s, y + 3 * s);
            g.moveTo(x, y + k * s); g.lineTo(x + 3 * s, y + k * s);
        }
        g.stroke();
        for (let cell = 0; cell < 9; cell++) {
            if (rand() < 0.4) continue;
            const cx = x + (cell % 3 + 0.5) * s, cy = y + (Math.floor(cell / 3) + 0.5) * s, q = s * 0.28;
            g.beginPath();
            if (rand() < 0.5) { g.moveTo(cx - q, cy - q); g.lineTo(cx + q, cy + q); g.moveTo(cx + q, cy - q); g.lineTo(cx - q, cy + q); }
            else g.arc(cx, cy, q, 0, Math.PI * 2);
            g.stroke();
        }
    }
    // Stars, smileys and little hearts.
    for (let i = 0; i < 14; i++) {
        const x = rand() * w, y = rand() * h, s = between(8, 18), kind = Math.floor(rand() * 3);
        inkStroke(pick(BIRO_INKS), 1.6);
        g.beginPath();
        if (kind === 0) {
            for (let k = 0; k <= 5; k++) {
                const a = -Math.PI / 2 + k * (Math.PI * 4 / 5);
                if (k === 0) g.moveTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
                else g.lineTo(x + Math.cos(a) * s, y + Math.sin(a) * s);
            }
            g.stroke();
        } else if (kind === 1) {
            g.arc(x, y, s, 0, Math.PI * 2);
            g.moveTo(x + s * 0.55, y + s * 0.2);
            g.arc(x, y + s * 0.2, s * 0.55, 0, Math.PI);
            g.stroke();
            g.fillStyle = g.strokeStyle;
            g.fillRect(x - s * 0.4, y - s * 0.35, 2.5, 2.5);
            g.fillRect(x + s * 0.3, y - s * 0.35, 2.5, 2.5);
        } else {
            heartPath(x, y, s);
            g.stroke();
        }
    }
    // Pencil shading patches.
    for (let i = 0; i < 6; i++) {
        const x = rand() * w, y = rand() * h, size = between(30, 80);
        g.strokeStyle = "rgba(60,60,65,0.18)";
        g.lineWidth = 1;
        g.beginPath();
        for (let k = 0; k < size; k += 3) { g.moveTo(x + k, y); g.lineTo(x + k - size * 0.4, y + size * 0.6); }
        g.stroke();
    }

    // ---- Fine noise ----
    // Per-pixel speckle so nothing reads as a flat digital fill.
    const img = g.getImageData(0, 0, w, h);
    const px = img.data;
    for (let i = 0; i < px.length; i += 4) {
        const n = (rand() - 0.5) * 26;
        px[i] += n;
        px[i + 1] += n;
        px[i + 2] += n;
    }
    g.putImageData(img, 0, 0);

    return c;
}
