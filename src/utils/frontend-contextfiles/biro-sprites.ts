// Turns a biro PNG into something the canvas can draw exactly over the physics capsule.
//
// The PNGs carry lots of transparent padding plus a pocket clip that sticks out to one
// side. Drawn raw, the visible pen would disagree with its hitbox ("it never touched me!").
// So we never collide with the image at all — physics stays a capsule — and instead:
//   1. trim the transparent padding (faint halo pixels count as empty), and
//   2. measure the barrel: the median opaque span over the lower body, below the clip,
// so game.tsx can stretch the barrel to exactly the capsule's width and the trimmed
// length to the capsule's full tip-to-tip length. Only the thin clip overhangs.
//
// PNG convention: upright, with the writing end (cap) at the TOP.

export interface BiroSprite {
    canvas: HTMLCanvasElement; // trimmed image
    barrelCenter: number;      // x of the barrel's centre line, in trimmed px
    barrelWidth: number;       // barrel thickness, in trimmed px
}

const ALPHA_THRESHOLD = 16;
const cache = new Map<string, Promise<BiroSprite | null>>();

export function loadBiroSprite(src: string): Promise<BiroSprite | null> {
    let sprite = cache.get(src);
    if (!sprite) {
        sprite = new Promise(resolve => {
            const img = new Image();
            img.onload = () => resolve(buildSprite(img));
            img.onerror = () => resolve(null);
            img.src = src;
        });
        cache.set(src, sprite);
    }
    return sprite;
}

function median(values: number[]): number {
    const sorted = [...values].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
}

function buildSprite(img: HTMLImageElement): BiroSprite | null {
    const w = img.naturalWidth;
    const h = img.naturalHeight;
    const src = document.createElement("canvas");
    src.width = w;
    src.height = h;
    const sctx = src.getContext("2d", { willReadFrequently: true });
    if (!sctx) return null;
    sctx.drawImage(img, 0, 0);
    const alpha = sctx.getImageData(0, 0, w, h).data;
    const solid = (x: number, y: number) => alpha[(y * w + x) * 4 + 3] > ALPHA_THRESHOLD;

    // Opaque extent of every row.
    const rowL = new Int32Array(h).fill(-1);
    const rowR = new Int32Array(h).fill(-1);
    let top = -1, bottom = -1, left = w, right = -1;
    for (let y = 0; y < h; y++) {
        let l = 0;
        while (l < w && !solid(l, y)) l++;
        if (l === w) continue;
        let r = w - 1;
        while (r > l && !solid(r, y)) r--;
        rowL[y] = l;
        rowR[y] = r;
        if (top < 0) top = y;
        bottom = y;
        if (l < left) left = l;
        if (r > right) right = r;
    }
    if (top < 0) return null;

    // Rows 55%–90% down sit below the clip and above the end plug: pure barrel.
    const th = bottom - top + 1;
    const tw = right - left + 1;
    const widths: number[] = [];
    const centers: number[] = [];
    for (let y = top + Math.floor(th * 0.55); y <= top + Math.floor(th * 0.9); y++) {
        if (rowL[y] < 0) continue;
        widths.push(rowR[y] - rowL[y] + 1);
        centers.push((rowL[y] + rowR[y] + 1) / 2);
    }
    if (widths.length === 0) return null;

    const out = document.createElement("canvas");
    out.width = tw;
    out.height = th;
    out.getContext("2d")?.drawImage(src, left, top, tw, th, 0, 0, tw, th);

    return { canvas: out, barrelCenter: median(centers) - left, barrelWidth: median(widths) };
}
