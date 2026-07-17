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
const liveness = require("./liveness.js"); // shared spinner/elapsed heartbeat (no external deps)
const tui = require("@earendil-works/pi-tui"); // top-level require — jiti-aliased (see tui-text.js)
// Re-export the zero-height result component (defined in tui-text.js per §1.1's
// exact signatures) so tools can call kit.zeroText(ctx) as the tiering pseudocode
// writes it. No require cycle: tui-text.js requires only pi-tui.
const _tt = require("./tui-text.js");
exports.zeroText = _tt.zeroText;
exports.ZeroText = _tt.ZeroText;

// Duration as a marker segment: only ≥1s is worth showing (sub-second is noise).
function durationSeg(result) {
    const ms = result?.details?.[h.ELAPSED_KEY];
    return typeof ms === "number" && ms >= 1000 ? h.formatElapsedMs(ms) : "";
}
exports.durationSeg = durationSeg;

// --- fixed-column spine (Round 3 §1.2) -----------------------------------
// The header glyph (✓/✗/·) occupies column index 1 (after TOOL_RESULT_INDENT).
// Body lines start at column index 3 so the glyph column stays a clean spine.
// Applied centrally: gutterLine, marker default indent, failLines, diff.js.
exports.BODY_INDENT = "   "; // 3 spaces — the body column
// Tier-2 failure window: full body inline up to inlineMax; above it, head + a
// hidden-count marker + a tail-biased window (never hide why it broke).
exports.ERROR_WINDOW = { inlineMax: 30, head: 3, tail: 20 };

// --- width (ANSI / wide-char aware) --------------------------------------
const vis = (s) => tui.visibleWidth(String(s ?? ""));
const trunc = (s, w, ell = "…") => tui.truncateToWidth(String(s ?? ""), Math.max(1, w), ell);
exports.vis = vis;
exports.trunc = trunc;

// --- status glyph --------------------------------------------------------
// renderResult knows success/error (it only runs once there's a result) and
// stashes it on the SHARED ctx.state; renderCall reads it on the next pass.
const GLYPHS = { ok: "✓", err: "✗", run: "·" };
// Status resolves from shared ctx.state.__kit (set by renderResult), falling back
// to the host-authoritative ctx.isError, then "running". Reading ctx.isError here
// means error headers/glyphs turn red on the FIRST pass without waiting for a redraw.
function statusOf(ctx) {
    const s = ctx.state && ctx.state.__kit;
    if (s)
        return s;
    return ctx.isError ? "err" : "run";
}
function glyph(ctx) {
    const s = statusOf(ctx);
    if (ctx.state)
        ctx.state.__kitDrawn = s; // record what actually rendered
    if (s === "run") {
        // Live: enroll in the shared heartbeat and draw the spinner frame. The
        // frame index comes from liveness.currentFrame() — a TICK-DRIVEN counter,
        // never Date.now() — so repeated renders within one settle return the
        // SAME char and converge (see liveness.js convergence invariant).
        liveness.markRunning(ctx);
        if (ctx.state && !ctx.state.__runStart)
            ctx.state.__runStart = Date.now(); // stamp once for the elapsed seg
        const F = liveness.FRAMES;
        return `${c.FG_CYAN}${F[liveness.currentFrame() % F.length]}${c.RST}`;
    }
    const col = s === "err" ? c.FG_RED : s === "ok" ? c.FG_GREEN : c.FG_DIM;
    return `${col}${GLYPHS[s]}${c.RST}`;
}
// Live elapsed seg: dim `· 47s`, shown only while running and past 3s. The
// second count is stamped by liveness.tick() (constant between ticks) so the
// header converges within a settle exactly like the spinner does.
function elapsedSeg(ctx) {
    if (statusOf(ctx) !== "run")
        return "";
    const st = ctx.state;
    if (!st || !st.__runStart)
        return "";
    const sec = st.__elapsedSec || 0;
    return sec * 1000 >= liveness.ELAPSED_FLOOR_MS ? `${dim(SEP)}${dim(`${sec}s`)}` : "";
}
// renderResult marks completion. Because renderCall (the header) already ran THIS
// pass with the stale "running" glyph, we schedule exactly one deferred redraw so
// the ✓/✗ appears. Deferred (microtask) because ctx.invalidate() re-enters
// updateDisplay synchronously — calling it mid-pass would duplicate children. It
// self-terminates: after the redraw, glyph() records __kitDrawn === __kit → no reschedule.
function markDone(ctx, isError) {
    if (!ctx.state)
        return;
    const next = isError ? "err" : "ok";
    ctx.state.__kit = next;
    liveness.markStopped(ctx); // run→settled: leave the heartbeat, clear if idle
    // Schedule ONE deferred settle repaint when either (a) the glyph transitions
    // (run→ok/err — the normal case), OR (b) this is the row's first completion.
    // Case (b) covers a host-flagged error: glyph eager-draws "err" from
    // ctx.isError during renderCall, so __kitDrawn already === "err" and there is
    // no transition — yet renderResult may have just set a summary (e.g. a bash
    // verdict) that would otherwise never paint. Guarded by __kitScheduled +
    // __kitSettledOnce so it fires at most once per row and self-terminates: after
    // the repaint the glyph is settled AND __kitSettledOnce is set, so a re-entrant
    // markDone finds neither condition true and schedules nothing.
    const needsPaint = ctx.state.__kitDrawn !== next || !ctx.state.__kitSettledOnce;
    if (needsPaint && !ctx.state.__kitScheduled) {
        ctx.state.__kitScheduled = true;
        queueMicrotask(() => {
            ctx.state.__kitScheduled = false;
            ctx.state.__kitSettledOnce = true;
            ctx.invalidate?.();
        });
    }
}
function isErr(ctx) {
    return !!ctx.isError || statusOf(ctx) === "err";
}
exports.markDone = markDone;
exports.statusOf = statusOf;
exports.glyph = glyph;
exports.isErr = isErr;

// --- header grammar: {glyph} {title+primary} {dim annots} {dim summary} ---
// The summary (set by renderResult via setSummary) is fused onto the RIGHT of
// the header on the deferred markDone redraw. The whole line is width-truncated
// (never wrapped) with a dim › marker; because the summary is rightmost it
// truncates first when a long title + summary overflow the terminal.
function header(ctx, titledPrimary, annots) {
    const g = glyph(ctx); // resolve first — stamps __runStart / enrolls in heartbeat
    const a = annots ? ` ${annots}` : "";
    const elapsed = elapsedSeg(ctx); // dim `· 47s` while running >3s, else ""
    const summaryInner = ctx.state && ctx.state.__kitSummary;
    const summary = summaryInner ? `${dim(SEP)}${summaryInner}` : "";
    return trunc(`${c.TOOL_RESULT_INDENT}${g} ${titledPrimary}${a}${elapsed}${summary}`, c.termWidth(), `${c.FG_DIM}›${c.RST}`);
}
exports.header = header;
// setSummary — stash a dim summary string on the SHARED ctx.state; kit.header
// (called by renderCall on the next/same deferred pass) appends it. NEVER
// invalidates: the header repaints via markDone's existing single microtask
// (see markDone above). Rewriting identical content on later passes is a no-op.
function setSummary(ctx, segs) {
    if (!ctx.state)
        return;
    ctx.state.__kitSummary = markerInner(segs);
}
exports.setSummary = setSummary;

// --- separators / dim segments -------------------------------------------
const SEP = " · ";
const plural = (n, unit) => `${n} ${unit}${n === 1 ? "" : "s"}`;
const dim = (s) => `${c.FG_DIM}${s}${c.RST}`;
// A colored marker segment that returns to dim afterwards (so joinDim keeps flowing).
const redSeg = (s) => `${c.RST}${c.FG_RED}${s}${c.RST}${c.FG_DIM}`;
const greenSeg = (s) => `${c.RST}${c.FG_GREEN}${s}${c.RST}${c.FG_DIM}`;
exports.SEP = SEP;
exports.plural = plural;
exports.dim = dim;
exports.redSeg = redSeg;
exports.greenSeg = greenSeg;

// --- path segment: dim dirname + normal basename -------------------------
// Renders "dir/" dimmed (FG_DIM) followed by the basename in the default weight/
// color. With a `budget` (column width), the MIDDLE of the dirname is elided —
// leading segment + "…/" + trailing dir — so the basename is never truncated.
// Width math is column-aware (vis/trunc), never string .length.
function truncMidDir(dir, budget) {
    // dir keeps its trailing "/". Preserve a leading "/" for absolute paths.
    const lead = dir.startsWith("/") ? "/" : "";
    const segs = (lead ? dir.slice(1) : dir).split("/").filter(Boolean);
    if (segs.length <= 1)
        return trunc(dir, Math.max(1, budget)); // nothing to elide in the middle
    const first = segs[0];
    const last = segs[segs.length - 1];
    let out = `${lead}${first}/…/${last}/`;
    if (vis(out) <= budget)
        return out;
    out = `…/${last}/`; // drop the leading segment too
    if (vis(out) <= budget)
        return out;
    return trunc(out, Math.max(1, budget)); // last resort: hard clip
}
function pathSeg(path, budget) {
    const p = String(path ?? "");
    const slash = p.lastIndexOf("/");
    const base = slash >= 0 ? p.slice(slash + 1) : p;
    let dir = slash >= 0 ? p.slice(0, slash + 1) : ""; // trailing slash kept
    if (budget && dir && vis(dir) + vis(base) > budget) {
        dir = truncMidDir(dir, Math.max(0, budget - vis(base)));
    }
    return dir ? `${c.FG_DIM}${dir}${c.RST}${base}` : base;
}
exports.pathSeg = pathSeg;

// --- gutter line: right-aligned line number │ code -----------------------
// The shared line-numbered content row (read/grep/diff render through this).
// `no` is the line number, `nw` the number field width, `code` the styled body.
// Mirrors the gutter idiom inlined in tools/read.js. No trailing newline.
function gutterLine(no, nw, code) {
    const s = String(no);
    const pad = " ".repeat(Math.max(0, nw - s.length));
    return `${exports.BODY_INDENT}${c.FG_LNUM}${pad}${s}${c.RST} ${c.FG_RULE}│${c.RST} ${code}${c.RST}`;
}
exports.gutterLine = gutterLine;

// --- the fused marker line ----------------------------------------------
// segs: plain (dimmed) or pre-colored (redSeg/greenSeg) strings; empties dropped.
// Returns "" when there is nothing worth saying (→ zero chrome).
function markerInner(segs) {
    const f = segs.filter(Boolean);
    return f.length ? `${c.FG_DIM}${f.join(SEP)}${c.RST}` : "";
}
function marker(segs, indent = exports.BODY_INDENT) {
    const inner = markerInner(segs);
    return inner ? `${indent}${inner}` : "";
}
exports.markerInner = markerInner;
exports.marker = marker;

// --- Tier-2 failure body (centralized) -----------------------------------
// The single failure renderer every tool's ctx.isError branch (and bash's
// nonzero-exit branch) routes through. Full body on BG_ERROR, BODY_INDENT-
// prefixed; theme.fg("error", …) unless opts.fgError === false (bash output is
// not prose to paint red). Above ERROR_WINDOW.inlineMax lines: head 3 + a
// hidden-count marker + tail 20 (tail-biased so the verdict line survives).
// ≤inlineMax: full body, extraSegs marker appended only when extraSegs nonempty.
// opts = { fgError?: boolean /*default true*/, extraSegs?: string[] }
function failLines(rawText, theme, opts = {}) {
    const render = require("./render.js"); // lazy — avoids a require cycle
    const { fgError = true, extraSegs = [] } = opts;
    const paint = (line) => !line ? "" : (fgError && theme && theme.fg ? theme.fg("error", line) : line);
    const prefixed = (line) => `${exports.BODY_INDENT}${paint(line)}`;
    const all = h.compactErrorLines(rawText);
    const W = exports.ERROR_WINDOW;
    let bodyLines;
    if (all.length > W.inlineMax) {
        const head = all.slice(0, W.head).map(prefixed);
        const tail = all.slice(all.length - W.tail).map(prefixed);
        const hidden = all.length - W.head - W.tail;
        const mk = marker([`… +${plural(hidden, "line")}`, ...extraSegs, "ctrl+o"]);
        bodyLines = [...head, mk, ...tail];
    }
    else {
        bodyLines = all.map(prefixed);
        if (extraSegs.length)
            bodyLines.push(marker([...extraSegs]));
    }
    return render.fillToolBackground(bodyLines.join("\n"), c.BG_ERROR);
}
exports.failLines = failLines;

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
    // Guard: never let tail overlap head (matters if a caller passes head+tail > inlineMax).
    const t = tail > 0 ? out.slice(Math.max(head, n - tail)) : [];
    return { head: h, tail: t, hidden: Math.max(0, n - head - t.length) };
}
exports.previewWindow = previewWindow;

// --- multi-column layout (ls) -------------------------------------------
// cells: array of styled strings, each with a known visible width (measured
// here). Packs them into rows that fit `width`, column-major like `ls -C`.
function columns(cells, width, gap = 2) {
    if (!cells.length)
        return [];
    // Truncate any cell wider than the whole width so a single long name can't
    // produce an over-wide row.
    cells = cells.map((s) => (vis(s) > width ? trunc(s, width) : s));
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
        // Match lines only ("file:line:content"). rg CONTEXT lines use dashes
        // ("file-line-content") — counting those inflates the match total.
        const m = line.match(/^(.+?):(\d+):/);
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
        const dir = slash > 0 ? t.slice(0, slash) : slash === 0 ? "/" : ".";
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
