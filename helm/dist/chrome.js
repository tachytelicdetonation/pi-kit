/**
 * ANSI-safe layout primitives — the handoff's "Layout rules (all screens)"
 * encoded once and reused by every screen.
 *
 * Every function here treats painted strings as opaque: width is measured with
 * {@link visibleWidth} and truncation goes through {@link truncateToWidth}, never
 * raw `.length` / `.slice`, so embedded ANSI color codes never corrupt layout.
 * Post-condition for all of them: `visibleWidth(result) <= width` (and `=== width`
 * for {@link column}).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH, paint, PALETTE } from "./theme.js";
/** Clamp an arbitrary width argument to a safe non-negative integer. */
function safeWidth(width) {
    return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}
/**
 * Header row: `pi · <context>` on the left (pi in brand color, context in
 * label), `right` right-aligned via the spring. Segments are atomic — the
 * spring truncates the left group, never the middle of a painted segment.
 */
export function header(theme, context, right, width) {
    const left = `${paint(theme, PALETTE.brand, "pi")} ${paint(theme, PALETTE.faint, "·")} ${paint(theme, PALETTE.label, context)}`;
    return spring(theme, left, right, width);
}
/** Full-width horizontal rule in the divider color. */
export function divider(theme, width) {
    const w = safeWidth(width);
    if (w <= 0)
        return "";
    return paint(theme, PALETTE.divider, "─".repeat(w));
}
/**
 * Core spring primitive: `left`, a flexible gap (min 1 cell), then `right`
 * right-aligned so the whole line is exactly `width` wide when both sides are
 * present. If left + right + the minimum gap overflow, the LEFT group is
 * ANSI-safe-truncated; `right` is preserved (it carries status/counts). With no
 * `right`, `left` is returned truncated to width.
 */
export function spring(theme, left, right, width) {
    const w = safeWidth(width);
    if (w <= 0)
        return "";
    const rightWidth = visibleWidth(right);
    if (!right)
        return truncateToWidth(left, w, "…");
    // Right group cannot fit at all: keep as much of it as the width allows.
    if (rightWidth >= w)
        return truncateToWidth(right, w, "…");
    // Budget for the left group is whatever remains after the right group and a
    // one-cell minimum gap.
    const leftBudget = w - rightWidth - 1;
    const leftFitted = truncateToWidth(left, leftBudget, "…");
    const gap = w - visibleWidth(leftFitted) - rightWidth;
    return `${leftFitted}${" ".repeat(Math.max(1, gap))}${right}`;
}
/**
 * Fixed-width cell: pad (with spaces) or ANSI-safe-truncate `text` to exactly
 * `width` visible cells. `align` controls which side is padded ("left" pads the
 * right edge, "right" pads the left edge). Result always satisfies
 * `visibleWidth(result) === width` for a non-negative width.
 */
export function column(text, width, align = "left") {
    const w = safeWidth(width);
    if (w <= 0)
        return "";
    const current = visibleWidth(text);
    if (current > w)
        return truncateToWidth(text, w, "…");
    const padding = " ".repeat(w - current);
    return align === "right" ? `${padding}${text}` : `${text}${padding}`;
}
/**
 * Window `lines` to at most `height`, keeping the line at `anchor` visible.
 * When taller than height, shows a dim "↑ N" hint at the top and/or "↓ N" hint
 * at the bottom for the hidden lines, and scrolls so the anchor line stays in
 * the visible content band. Returns <= height lines (all ANSI-safe, <= width).
 */
export function windowLines(theme, lines, anchor, height, width) {
    const h = safeWidth(height);
    if (h <= 0)
        return [];
    const n = lines.length;
    if (n <= h)
        return lines;
    // Clamp the anchor defensively — callers may pass a stale/unknown index.
    const a = Math.max(0, Math.min(n - 1, Number.isFinite(anchor) ? Math.floor(anchor) : 0));
    // Settle on the hint flags and window start together: adding a hint shrinks the
    // content band, which can move `start`, which can change whether a hint is
    // needed. A few passes reach a fixed point for every height.
    let topHint = false;
    let bottomHint = false;
    let start = 0;
    let band = h;
    for (let i = 0; i < 4; i++) {
        band = Math.max(1, h - (topHint ? 1 : 0) - (bottomHint ? 1 : 0));
        // Centre the anchor in the band, then clamp so the band stays inside `lines`.
        start = Math.min(Math.max(0, a - Math.floor((band - 1) / 2)), n - band);
        const nextTop = start > 0;
        const nextBottom = start + band < n;
        if (nextTop === topHint && nextBottom === bottomHint)
            break;
        topHint = nextTop;
        bottomHint = nextBottom;
    }
    const hiddenAbove = start;
    const hiddenBelow = n - (start + band);
    const hint = (arrow, count) => truncateToWidth(`  ${paint(theme, PALETTE.dim, `${arrow} ${count}`)}`, width, "");
    const out = [];
    if (topHint)
        out.push(hint("↑", hiddenAbove));
    for (let i = start; i < start + band; i++)
        out.push(lines[i]);
    if (bottomHint)
        out.push(hint("↓", hiddenBelow));
    // Tiny heights (1–2 rows) can't fit content + both hints; drop hints (never the
    // anchor, which lives in the content band) until the result fits within height.
    while (out.length > h) {
        if (bottomHint) {
            out.pop();
            bottomHint = false;
        }
        else if (topHint) {
            out.shift();
            topHint = false;
        }
        else
            break;
    }
    return out;
}
/**
 * Greedy word-wrap of PLAIN (un-painted) text to at most `width` cells per line.
 * A word longer than `width` is hard-split. Returns `[]` for non-positive width
 * and `[""]` for empty text. Callers paint each returned line uniformly, so no
 * ANSI ever spans a wrap boundary. Whitespace is collapsed to single spaces.
 */
export function wrapPlain(text, width) {
    const w = safeWidth(width);
    if (w <= 0)
        return [];
    const words = text.split(/\s+/).filter((word) => word.length > 0);
    if (words.length === 0)
        return [""];
    const lines = [];
    let current = "";
    for (const word of words) {
        // Hard-split a word wider than the whole line.
        let token = word;
        while (visibleWidth(token) > w) {
            const head = truncateToWidth(token, w, "");
            if (current) {
                lines.push(current);
                current = "";
            }
            lines.push(head);
            token = token.slice(head.length);
        }
        if (!token)
            continue;
        const candidate = current ? `${current} ${token}` : token;
        if (visibleWidth(candidate) <= w) {
            current = candidate;
        }
        else {
            if (current)
                lines.push(current);
            current = token;
        }
    }
    if (current)
        lines.push(current);
    return lines.length > 0 ? lines : [""];
}
/**
 * Tree indentation prefix for a depth-`depth` row: `(depth-1)` levels of
 * vertical connector, then a mid (`├ `) or end (`└ `) branch. Depth 0 yields ""
 * (the root renders with no prefix). Pure and uncolored — callers paint it in
 * the ghost tier when composing a row.
 */
export function treePrefix(depth, isLast) {
    const levels = Math.max(0, Math.floor(depth));
    if (levels === 0)
        return "";
    const stem = `${GLYPH.treeVert} `.repeat(levels - 1);
    const branch = `${isLast ? GLYPH.treeEnd : GLYPH.treeMid} `;
    return `${stem}${branch}`;
}
