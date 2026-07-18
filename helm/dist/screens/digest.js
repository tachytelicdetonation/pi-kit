/**
 * 7c — Catch-up digest. "While you were away" in 10 seconds. PURE render of the
 * activity journal rolled up into EXACTLY four line types, IN THIS ORDER:
 *   1. `✓` shipped        — goals shipped (PALETTE.success)
 *   2. `✓` shipped        — shipped by loops (PALETTE.success)
 *   3. `▲` decisions      — decisions queued, nothing hard-blocked (PALETTE.warning)
 *   4. `✕` failed-handled — self-caught, auto-reverted (PALETTE.error)
 *
 * Each section may hold multiple rows; an EMPTY section is omitted but the relative
 * order is preserved. Long rows wrap with a hanging indent (the glyph column). The
 * screen owns its footer line — `d decisions first · enter mission control · l full
 * log …spring… usage overnight: <per-provider drain>` — rendered as the last body
 * line; the app chrome supplies the header (span · $ spent) and the fleet footer.
 * Every line is ANSI-safe and clipped to at most `height` via windowLines.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { spring, windowLines, wrapPlain } from "./../chrome.js";
import { paint, PALETTE } from "./../theme.js";
/** Left gutter (2 cells) so the digest aligns with the other screens. */
const INDENT = "  ";
/** Glyph column width: the glyph + one space; wrapped continuations hang under text. */
const HANG = 2;
/** Provider name → its palette color for the overnight drain readout. */
function providerColor(provider) {
    switch (provider) {
        case "codex":
            return PALETTE.codex;
        case "claude":
            return PALETTE.claude;
        case "kimi":
            return PALETTE.kimi;
        default:
            return PALETTE.mid;
    }
}
export function renderDigest(data, theme, width, height) {
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (w <= 0 || h <= 0)
        return [];
    const lines = [];
    // ── The four line types, in fixed order (empty sections omitted) ─────────
    pushRows(lines, theme, data.shippedGoals, "✓", PALETTE.success, w);
    pushRows(lines, theme, data.shippedByLoops, "✓", PALETTE.success, w);
    pushRows(lines, theme, data.decisionsQueued, "▲", PALETTE.warning, w);
    pushRows(lines, theme, data.failedHandled, "✕", PALETTE.error, w);
    // ── The digest's own footer line ─────────────────────────────────────────
    lines.push("");
    lines.push(footerLine(theme, data.quotaDrain, w));
    return windowLines(theme, lines, 0, h, w);
}
/** Push one section's rows (glyph + wrapped text with a hanging indent). */
function pushRows(lines, theme, rows, glyph, color, width) {
    const textWidth = Math.max(1, width - INDENT.length - HANG);
    for (const row of rows) {
        const segments = wrapPlain(row, textWidth);
        segments.forEach((segment, index) => {
            const lead = index === 0
                ? `${paint(theme, color, glyph)} `
                : " ".repeat(HANG);
            lines.push(truncateToWidth(`${INDENT}${lead}${paint(theme, PALETTE.primary, segment)}`, width, ""));
        });
    }
}
/**
 * `d decisions first · enter mission control · l full log …spring… usage
 * overnight: codex −N% · claude −N% · kimi untouched`.
 */
function footerLine(theme, drain, width) {
    const left = `${paint(theme, PALETTE.brand, "d")} ${paint(theme, PALETTE.dim, "decisions first")}` +
        ` ${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.brand, "enter")} ${paint(theme, PALETTE.dim, "mission control")}` +
        ` ${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.brand, "l")} ${paint(theme, PALETTE.dim, "full log")}`;
    const parts = drain.map((entry) => {
        const value = entry.deltaPercent === 0
            ? paint(theme, PALETTE.dim, "untouched")
            : paint(theme, PALETTE.dim, `${entry.deltaPercent < 0 ? "−" : "+"}${Math.abs(entry.deltaPercent)}%`);
        return `${paint(theme, providerColor(entry.provider), entry.provider)} ${value}`;
    });
    const right = parts.length > 0 ? `${paint(theme, PALETTE.dim, "usage overnight:")} ${parts.join(paint(theme, PALETTE.dim, " · "))}` : "";
    return truncateToWidth(`${INDENT}${spring(theme, left, right, Math.max(0, width - INDENT.length))}`, width, "");
}
