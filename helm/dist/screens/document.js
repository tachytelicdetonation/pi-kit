import { truncateToWidth } from "@earendil-works/pi-tui";
import { windowLines, wrapPlain } from "../chrome.js";
import { paint, PALETTE } from "../theme.js";
/** A small read-only detail surface used by reports, logs, and test receipts. */
export function renderDocument(lines, theme, width, height) {
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (!w || !h)
        return [];
    const body = lines.flatMap((line) => wrapPlain(line, Math.max(1, w - 4)).map((part) => truncateToWidth(`  ${paint(theme, PALETTE.mid, part)}`, w, "…")));
    return windowLines(theme, body.length ? body : [paint(theme, PALETTE.dim, "  No details available.")], 0, h, w);
}
