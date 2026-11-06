/**
 * Images for the moments when Discord can't draw them: no person picked yet,
 * Discord closed, or the first image not there yet. Plain SVG (no embedded
 * bitmaps), which Stream Deck renders for keys and touch-strip pixmaps alike.
 */

const esc = (s: string) => s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&apos;" })[c]!);
const svgUrl = (svg: string) => `data:image/svg+xml;charset=utf8,${encodeURIComponent(svg)}`;
const FONT = "font-family=\"Segoe UI, Helvetica Neue, Arial, sans-serif\"";

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Speaker + person glyph, centred on (x, y), size ≈ s. */
function glyph(x: number, y: number, s: number, color: string): string {
    const k = s / 48;
    return `<g transform="translate(${x - 24 * k} ${y - 24 * k}) scale(${k})" fill="none" stroke="${color}" stroke-width="3.2" stroke-linecap="round" stroke-linejoin="round">
<circle cx="18" cy="15" r="7"/><path d="M5 40c0-8 6-13 13-13s13 5 13 13"/>
<path d="M36 18c2.6 2 2.6 8 0 10"/><path d="M40.5 13.5c5 4.5 5 14.5 0 19"/></g>`;
}

function key(lines: { text: string; color: string; size: number; weight?: number; }[], color: string): string {
    const n = lines.length;
    const top = 84 + (n === 1 ? 18 : 6);
    const text = lines.map((l, i) =>
        `<text x="72" y="${top + i * 24}" ${FONT} font-size="${l.size}" font-weight="${l.weight ?? 600}" fill="${l.color}" text-anchor="middle">${esc(l.text)}</text>`
    ).join("");
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="144" height="144" viewBox="0 0 144 144"><rect width="144" height="144" fill="#0e0f12"/>${glyph(72, 46, 62, color)}${text}</svg>`);
}

function strip(title: string, sub: string, color: string): string {
    return svgUrl(`<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100" viewBox="0 0 200 100"><rect width="200" height="100" fill="#0e0f12"/>${glyph(40, 50, 52, color)}
<text x="82" y="46" ${FONT} font-size="16" font-weight="700" fill="#f2f3f5">${esc(clip(title, 14))}</text>
<text x="82" y="68" ${FONT} font-size="12" font-weight="600" fill="#949ba4">${esc(clip(sub, 18))}</text></svg>`);
}

export function pickUserImage(dial: boolean): string {
    return dial
        ? strip("User Volume", "Pick a person", "#5865f2")
        : key([{ text: "Pick a", color: "#b5bac1", size: 18 }, { text: "person", color: "#b5bac1", size: 18 }], "#5865f2");
}

export function offlineImage(name: string | undefined, dial: boolean): string {
    const who = clip(name || "User Volume", dial ? 14 : 11);
    return dial
        ? strip(who, "Discord not running", "#80848e")
        : key([{ text: who, color: "#b5bac1", size: 17 }, { text: "Discord off", color: "#ed4245", size: 16, weight: 700 }], "#80848e");
}

export function loadingImage(name: string | undefined, dial: boolean): string {
    const who = clip(name || "User Volume", dial ? 14 : 11);
    return dial
        ? strip(who, "Loading…", "#5865f2")
        : key([{ text: who, color: "#b5bac1", size: 17 }, { text: "Loading…", color: "#80848e", size: 15 }], "#5865f2");
}
