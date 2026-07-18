/**
 * 4a — Session view (per-worktree transcript). PURE render of ACTIVITY LINES,
 * not tool logs. Each action is ONE aligned line:
 *   `▸/▾ | verb (9-char col) | target | …spring… | result/timing`
 *
 * Verbs (fixed 9-char left column):
 *   - `context`  — all reads/greps/bash that only GATHER context collapse to ONE line.
 *   - `parallel` — {@link GLYPH.parallel} marker + joined summaries of parallel work.
 *   - `edit`     — target file on the left, right side `+N −N`.
 *   - `verify`   — tests/build/lint, FIRST-CLASS (never shown as bash).
 *
 * An expanded `edit` shows a 3-line peek (line numbers + `+`/`−` signs) plus a
 * "… N more · d full diff" hint; an expanded `verify` shows its 1-line receipt.
 * Full file contents are NEVER streamed. The turn ends with a claim sentence and
 * right-aligned one-key actions (`review diff d · merge m`). `selection` (index
 * into `session.lines`) highlights the current line; `expanded` holds the indices
 * currently expanded (toggled by `o`).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { spring, windowLines } from "./../chrome.js";
import { GLYPH, paint, PALETTE } from "./../theme.js";
/** Fixed left column widths. */
const VERB_COL = 9;
/** Left gutter (2 cells): a selection marker or blank, keeping rows aligned. */
const GUTTER = 2;
/** Header right-side verification receipts for the app chrome: `✓ build ✓ lint ✓ N tests`. */
export function renderReceipts(theme, receipts) {
    const parts = [];
    if (receipts.build)
        parts.push("✓ build");
    if (receipts.lint)
        parts.push("✓ lint");
    parts.push(`✓ ${receipts.tests} tests`);
    return paint(theme, PALETTE.success, parts.join(" "));
}
export function renderSession(session, theme, width, height, selection, expanded) {
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (w <= 0 || h <= 0)
        return [];
    const lines = [];
    // The turn's request, echoed at the top of the transcript.
    lines.push(truncateToWidth(`${paint(theme, PALETTE.inputBorder, GLYPH.prompt)} ${paint(theme, PALETTE.bright, session.prompt)}`, w, ""));
    // Activity transcript. `anchor` records the body-line index of the selected
    // activity row so windowing keeps it visible on a short terminal.
    let anchor = 0;
    session.lines.forEach((line, index) => {
        if (index === selection)
            anchor = lines.length;
        lines.push(activityRow(theme, line, index === selection, expanded.has(index), w));
        if (line.expandable && expanded.has(index))
            lines.push(...peekRows(theme, line, w));
    });
    // Closing claim + right-aligned one-key actions.
    lines.push("");
    lines.push(claimRow(theme, session.claim, w));
    return windowLines(theme, lines, anchor, h, w);
}
/** Verb → left-column color. */
function verbColor(verb) {
    switch (verb) {
        case "context":
            return PALETTE.label;
        case "parallel":
            return PALETTE.purple;
        case "edit":
            return PALETTE.primary;
        case "verify":
            return PALETTE.success;
    }
}
/** One activity line: `[gutter][marker] verb(9)  target …spring… result`. */
function activityRow(theme, line, isSelected, isExpanded, width) {
    const gutter = isSelected ? `${paint(theme, PALETTE.brand, "▌")} ` : "  ";
    // Marker: parallel → ⣿; expandable → ▸/▾; otherwise a static collapsed glyph.
    const marker = line.verb === "parallel"
        ? paint(theme, PALETTE.purple, GLYPH.parallel)
        : line.expandable
            ? paint(theme, PALETTE.dim, isExpanded ? GLYPH.expanded : GLYPH.collapsed)
            : paint(theme, PALETTE.faint, GLYPH.collapsed);
    const verb = paint(theme, verbColor(line.verb), padTo(line.verb, VERB_COL));
    const target = paint(theme, line.verb === "edit" || line.verb === "verify" ? PALETTE.primary : PALETTE.mid, line.target);
    const left = `${marker} ${verb}  ${target}`;
    const right = resultText(theme, line);
    const inner = spring(theme, left, right, Math.max(0, width - GUTTER));
    return truncateToWidth(`${gutter}${inner}`, width, "");
}
/** Right column: `+N −N` for edits, else the pre-rendered result string. */
function resultText(theme, line) {
    if (line.verb === "edit") {
        const added = paint(theme, PALETTE.success, `+${line.added ?? 0}`);
        const removed = line.removed ? paint(theme, PALETTE.error, `−${line.removed}`) : paint(theme, PALETTE.dim, "−0");
        return `${added} ${removed}`;
    }
    if (line.verb === "verify")
        return paint(theme, PALETTE.success, line.result);
    return paint(theme, PALETTE.dim, line.result);
}
/** Expanded peek rows: an aligned 3-line diff peek (or 1-line receipt) + hint. */
function peekRows(theme, line, width) {
    const rows = [];
    const indent = " ".repeat(GUTTER + 2 + VERB_COL + 2); // gutter + marker + verb col + gap
    for (const peek of line.peek ?? [])
        rows.push(truncateToWidth(`${indent}${paintPeek(theme, peek)}`, width, ""));
    if (line.moreCount && line.moreCount > 0) {
        const hint = `${paint(theme, PALETTE.dim, `… ${line.moreCount} more · `)}${paint(theme, PALETTE.brand, "d")}${paint(theme, PALETTE.dim, " full diff")}`;
        rows.push(truncateToWidth(`${indent}${hint}`, width, ""));
    }
    return rows;
}
/**
 * Paint one peek line. A diff line (`<n> +/− <code>`) gets a dim line number, a
 * success/error sign, and primary code; anything else renders dim.
 */
function paintPeek(theme, peek) {
    const match = peek.match(/^(\s*\d+)\s+([+−-])\s(.*)$/);
    if (!match)
        return paint(theme, PALETTE.dim, peek);
    const [, lineNo, sign, code] = match;
    const signColor = sign === "+" ? PALETTE.success : PALETTE.error;
    return `${paint(theme, PALETTE.faint, lineNo)} ${paint(theme, signColor, sign)} ${paint(theme, PALETTE.primary, code)}`;
}
/** Claim sentence + right-aligned one-key actions (`review diff d · merge m`). */
function claimRow(theme, claim, width) {
    const left = paint(theme, PALETTE.primary, claim);
    const right = `${paint(theme, PALETTE.dim, "review diff ")}${paint(theme, PALETTE.brand, "d")}` +
        ` ${paint(theme, PALETTE.dim, "·")} ` +
        `${paint(theme, PALETTE.dim, "merge ")}${paint(theme, PALETTE.brand, "m")}`;
    return truncateToWidth(`  ${spring(theme, left, right, Math.max(0, width - GUTTER))}`, width, "");
}
/** Left-pad/truncate to exactly `n` cells (verbs are short ASCII, safe to measure raw). */
function padTo(text, n) {
    if (text.length >= n)
        return text.slice(0, n);
    return text + " ".repeat(n - text.length);
}
