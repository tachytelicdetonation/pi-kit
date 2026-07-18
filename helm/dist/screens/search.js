/**
 * `/` search. Search everything — goals, workflows, loops, PRs, decisions,
 * precedents, loop runs — ARCHIVED included (search is forever). PURE render of a
 * query echo, a hit count, and the result list: `<kind>  <label> …spring…
 * <sublabel>`, one selectable row each, the current selection marked. `enter` on a
 * result navigates to its target screen (handled by the app); a kind with no
 * screen yet falls back sensibly.
 *
 * The app chrome supplies the header and the fleet footer; the app owns the query
 * (typing filters it). Every line is ANSI-safe and clipped to at most `height` via
 * windowLines, anchored on the selected row so it stays visible.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { column, spring, windowLines } from "./../chrome.js";
import { GLYPH, paint, PALETTE } from "./../theme.js";
/** Left gutter (2 cells): a selection marker or blank, keeping rows aligned. */
const GUTTER = 2;
/** The kind-badge column width (widest kind is "precedent"). */
const KIND_COL = 10;
/** A color per result kind so the badge reads at a glance. */
function kindColor(kind) {
    switch (kind) {
        case "goal":
            return PALETTE.brand;
        case "workflow":
            return PALETTE.codex;
        case "loop":
            return PALETTE.success;
        case "pr":
            return PALETTE.claude;
        case "decision":
        case "precedent":
            return PALETTE.purple;
        default:
            return PALETTE.mid;
    }
}
export function renderSearch(query, results, theme, width, height, selection) {
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (w <= 0 || h <= 0)
        return [];
    const lines = [];
    // ── The query echo + hit count ───────────────────────────────────────────
    const caret = paint(theme, PALETTE.inputBorder, GLYPH.prompt);
    const shown = query
        ? paint(theme, PALETTE.primary, query)
        : paint(theme, PALETTE.faint, "search everything — goals, PRs, decisions, precedents · archived too");
    lines.push(truncateToWidth(`  ${caret} ${shown}`, w, ""));
    const count = query ? `${results.length} ${results.length === 1 ? "match" : "matches"}` : "";
    if (count)
        lines.push(truncateToWidth(`  ${paint(theme, PALETTE.dim, count)}`, w, ""));
    lines.push("");
    // ── The result list ──────────────────────────────────────────────────────
    let anchor = 0;
    if (results.length === 0) {
        if (query)
            lines.push(truncateToWidth(`  ${paint(theme, PALETTE.dim, "no matches")}`, w, ""));
    }
    else {
        results.forEach((result, index) => {
            if (index === selection)
                anchor = lines.length;
            lines.push(resultRow(theme, result, index === selection, w));
        });
    }
    return windowLines(theme, lines, anchor, h, w);
}
/** `[marker] <kind>  <label> …spring… <sublabel>` — one selectable result row. */
function resultRow(theme, result, isSelected, width) {
    const marker = isSelected ? `${paint(theme, PALETTE.brand, "▌")} ` : "  ";
    const badge = paint(theme, kindColor(result.kind), column(result.kind, KIND_COL));
    const left = `${badge}${paint(theme, PALETTE.primary, result.label)}`;
    const right = result.sublabel ? paint(theme, PALETTE.dim, result.sublabel) : "";
    const inner = spring(theme, left, right, Math.max(0, width - GUTTER));
    return truncateToWidth(`${marker}${inner}`, width, "");
}
