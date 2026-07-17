"use strict";
/**
 * pi-kit design system — the shared vocabulary every tool renders through.
 *
 * Goal (per the redesign spec): the collapsed/default view must answer
 * "did it work · how big · do I care" at a glance, with ONE fused marker line
 * as the only expand affordance. Everything here serves that.
 *
 * All color/width goes through here so the five tools stay visually identical.
 */
Object.defineProperty(exports, "__esModule", { value: true });
const c = require("./config.js");
const h = require("./helpers.js");
const tui = require("@earendil-works/pi-tui"); // top-level require — jiti-aliased (see tui-text.js)

// Duration as a marker segment: only ≥1s is worth showing (sub-second is noise).
function durationSeg(result) {
    const ms = result?.details?.[h.ELAPSED_KEY];
    return typeof ms === "number" && ms >= 1000 ? h.formatElapsedMs(ms) : "";
}
exports.durationSeg = durationSeg;

// --- width (ANSI / wide-char aware) --------------------------------------
const vis = (s) => tui.visibleWidth(String(s ?? ""));
const trunc = (s, w, ell = "…") => tui.truncateToWidth(String(s ?? ""), Math.max(1, w), ell);
exports.vis = vis;
exports.trunc = trunc;

// --- status glyph --------------------------------------------------------
// renderResult knows success/error (it only runs once there's a result) and
// stashes it on the SHARED ctx.state; renderCall reads it on the next pass.
const GLYPHS = { ok: "✓", err: "✗", run: "·" };
function markDone(ctx, isError) {
    if (ctx.state)
        ctx.state.__kit = isError ? "err" : "ok";
}
function statusOf(ctx) {
    return (ctx.state && ctx.state.__kit) || "run";
}
function glyph(ctx) {
    const s = statusOf(ctx);
    const col = s === "err" ? c.FG_RED : s === "ok" ? c.FG_GREEN : c.FG_DIM;
    return `${col}${GLYPHS[s]}${c.RST}`;
}
exports.markDone = markDone;
exports.statusOf = statusOf;
exports.glyph = glyph;

// --- header grammar: {glyph} {title+primary} {dim annots} ----------------
function header(ctx, titledPrimary, annots) {
    const a = annots ? ` ${annots}` : "";
    return `${c.TOOL_RESULT_INDENT}${glyph(ctx)} ${titledPrimary}${a}`;
}
exports.header = header;

// --- separators / dim segments -------------------------------------------
const SEP = " · ";
const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const dim = (s) => `${c.FG_DIM}${s}${c.RST}`;
// A colored marker segment that returns to dim afterwards (so joinDim keeps flowing).
const redSeg = (s) => `${c.RST}${c.FG_RED}${s}${c.RST}${c.FG_DIM}`;
const warnSeg = (s) => `${c.RST}${c.FG_YELLOW}${s}${c.RST}${c.FG_DIM}`;
exports.SEP = SEP;
exports.plural = plural;
exports.dim = dim;
exports.redSeg = redSeg;
exports.warnSeg = warnSeg;

// --- the fused marker line ----------------------------------------------
// segs: plain (dimmed) or pre-colored (redSeg/warnSeg) strings; empties dropped.
// Returns "" when there is nothing worth saying (→ zero chrome).
function markerInner(segs) {
    const f = segs.filter(Boolean);
    return f.length ? `${c.FG_DIM}${f.join(SEP)}${c.RST}` : "";
}
function marker(segs, indent = c.TOOL_RESULT_INDENT) {
    const inner = markerInner(segs);
    return inner ? `${indent}${inner}` : "";
}
exports.markerInner = markerInner;
exports.marker = marker;

// --- preview window: inline-if-small, else head + tail -------------------
// Returns { head:[…], tail:[…], hidden:N }. Caller inserts the marker between
// head and tail. Trailing blank lines are trimmed first (terminal output noise).
function previewWindow(lines, opts = {}) {
    const { inlineMax = 6, head = 4, tail = 2 } = opts;
    const out = lines.slice();
    while (out.length && out[out.length - 1].trim() === "")
        out.pop();
    const n = out.length;
    if (n <= inlineMax)
        return { head: out, tail: [], hidden: 0 };
    const h = out.slice(0, head);
    const t = tail > 0 ? out.slice(n - tail) : [];
    return { head: h, tail: t, hidden: n - head - tail };
}
exports.previewWindow = previewWindow;

// --- multi-column layout (ls) -------------------------------------------
// cells: array of styled strings, each with a known visible width (measured
// here). Packs them into rows that fit `width`, column-major like `ls -C`.
function columns(cells, width, gap = 2) {
    if (!cells.length)
        return [];
    const widths = cells.map(vis);
    const colW = Math.max(...widths) + gap;
    const cols = Math.max(1, Math.min(cells.length, Math.floor(width / colW) || 1));
    const rows = Math.ceil(cells.length / cols);
    const lines = [];
    for (let r = 0; r < rows; r++) {
        let line = "";
        for (let col = 0; col < cols; col++) {
            const i = col * rows + r; // column-major
            if (i >= cells.length)
                continue;
            const pad = colW - widths[i];
            line += cells[i] + (col === cols - 1 ? "" : " ".repeat(Math.max(gap, pad)));
        }
        lines.push(line.replace(/\s+$/, ""));
    }
    return lines;
}
exports.columns = columns;

// --- grep: per-file match strip (collapsed) ------------------------------
// Parses ripgrep-style "file:line:content" (or "file-line-content" context)
// lines into per-file match counts. Returns { perFile:Map, matches, files }.
function grepStats(text) {
    const perFile = new Map();
    let matches = 0;
    for (const line of String(text ?? "").split("\n")) {
        const m = line.match(/^(.+?)[:-](\d+)[:-]/);
        if (!m)
            continue;
        const file = m[1];
        perFile.set(file, (perFile.get(file) || 0) + 1);
        matches++;
    }
    return { perFile, matches, files: perFile.size };
}
exports.grepStats = grepStats;

// Styled strip: top-N files "path (n)", column-packed, dim path + normal count.
function grepFileStrip(perFile, width, topN = 6) {
    const entries = [...perFile.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, topN);
    const cells = top.map(([file, n]) => `${dim(file)} ${c.FG_MUTED}(${n})${c.RST}`);
    return columns(cells, width, 3);
}
exports.grepFileStrip = grepFileStrip;

// --- find: directory histogram (collapsed) -------------------------------
function dirHistogram(paths, topN = 3) {
    const perDir = new Map();
    for (const p of paths) {
        const t = p.trim();
        if (!t)
            continue;
        const slash = t.lastIndexOf("/");
        const dir = slash > 0 ? t.slice(0, slash) : ".";
        perDir.set(dir, (perDir.get(dir) || 0) + 1);
    }
    const entries = [...perDir.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, topN);
    const segs = top.map(([d, n]) => `${dim(d)} ${c.FG_MUTED}(${n})${c.RST}`);
    const rest = entries.length - top.length;
    if (rest > 0)
        segs.push(dim(`… ${plural(rest, "more dir")}`));
    return { line: segs.join(dim(SEP)), dirs: perDir.size };
}
exports.dirHistogram = dirHistogram;
//# sourceMappingURL=kit.js.map
