"use strict";
/**
 * pretty: unified-diff renderer.
 *
 * Turns (oldText, newText) into ANSI diff lines that render through the shared
 * design system (kit.gutterLine for the new-side gutter, config BG_ADD/BG_DEL
 * for the row tint, render.fillToolBackground so the tint fills to width).
 *
 * The line diff is an inline LCS with common prefix/suffix trimming — no new
 * npm dep, and the trimming keeps the common "small edit in a big file" case
 * cheap (LCS only runs on the changed middle). Word-level highlighting inside a
 * paired del/add uses a plain char prefix/suffix (no LCS needed).
 *
 * v1 ships PLAIN tinted diff (no Shiki syntax highlight). The async highlight
 * merge would have to survive both the per-row base tint and the word-level
 * strong-bg span, but render.preserveBoxBackground (used by fillToolBackground)
 * strips every bg SGR — so a tint-preserving, provably loop-safe Shiki merge is
 * not worth the risk here. Correctness over flourish.
 * TODO(v2): progressive Shiki highlight of the NEW side, merged via the
 * read.js seq + content-key guard (ctx.state.__seq / __hlKey), only if it can be
 * made to preserve the diff bg tints AND never invalidate unconditionally.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.computeDiff = computeDiff;
exports.toHunks = toHunks;
exports.renderDiff = renderDiff;
exports.summarizeDiff = summarizeDiff;
const c = require("./config.js");
const kit = require("./kit.js");
const render = require("./render.js");
const tui = require("@earendil-works/pi-tui"); // top-level require — jiti-aliased (see render.js / read.js)

// --- config knobs --------------------------------------------------------
const BAR = "▎"; // ▎ left one-quarter block — the colored change bar
// LCS is O(n·m). Above this product fall back to a dumb del-all/add-all diff of
// the changed middle so a pathological input can't hang the render.
const LCS_CELL_CAP = 4_000_000;

// Word-level STRONG bg tints (a shade past BG_ADD/BG_DEL) for the differing
// middle span of a paired del/add. Theme-aware; picked once per render.
const STRONG_ADD_DARK = "\x1b[48;2;40;90;55m";
const STRONG_DEL_DARK = "\x1b[48;2;110;45;45m";
const STRONG_ADD_LIGHT = "\x1b[48;2;150;214;170m";
const STRONG_DEL_LIGHT = "\x1b[48;2;240;180;180m";
// Explicit code-text fg so contrast never rides the terminal DEFAULT fg, which
// can disagree with the theme-chosen row tint when detectDark misjudges the
// surface (dark text on a dark tint = unreadable). Picked by the same `dark`.
const FG_TEXT_DARK = "\x1b[38;2;222;222;222m";
const FG_TEXT_LIGHT = "\x1b[38;2;40;40;40m";
// Strip raw ANSI/ESC from edited file content: a literal escape byte in a line
// would otherwise reset or bleed the row tint (word-level spans are spliced by
// hand, bypassing the preserveBoxBackground sanitization whole-line rows get).
// v1 diff is plain text, so removing content ANSI is always correct here.
const stripAnsi = (s) => String(s ?? "").replace(/\x1b\[[0-9;]*m/g, "").replace(/\x1b/g, "");

// --- width helpers (ANSI / wide-char aware) ------------------------------
function truncPad(s, w, ell) {
    return tui.truncateToWidth(s, Math.max(1, w), ell, true);
}

// --- line splitting ------------------------------------------------------
// Normalize CRLF/CR → LF and drop the phantom trailing "" a final newline
// leaves. "" → [] so an empty oldText is an all-add (new file) diff.
function splitLines(text) {
    const t = String(text ?? "");
    if (t === "")
        return [];
    const lines = t.replace(/\r\n?/g, "\n").split("\n");
    if (lines.length && lines[lines.length - 1] === "")
        lines.pop();
    return lines;
}

// --- line diff -----------------------------------------------------------
// Diff the changed MIDDLE (prefix/suffix already trimmed by computeDiff).
function diffMiddle(a, b) {
    const n = a.length, m = b.length;
    if (n === 0)
        return b.map((text) => ({ type: "add", text }));
    if (m === 0)
        return a.map((text) => ({ type: "del", text }));
    if (n * m > LCS_CELL_CAP) {
        // Too large for the LCS table — degrade to a block replace.
        return [
            ...a.map((text) => ({ type: "del", text })),
            ...b.map((text) => ({ type: "add", text })),
        ];
    }
    // LCS length DP (bottom-up), then backtrack top-down.
    const dp = Array.from({ length: n + 1 }, () => new Uint32Array(m + 1));
    for (let i = n - 1; i >= 0; i--) {
        const row = dp[i], next = dp[i + 1];
        for (let j = m - 1; j >= 0; j--) {
            row[j] = a[i] === b[j] ? next[j + 1] + 1 : Math.max(next[j], row[j + 1]);
        }
    }
    const ops = [];
    let i = 0, j = 0;
    while (i < n && j < m) {
        if (a[i] === b[j]) {
            ops.push({ type: "ctx", text: a[i] });
            i++; j++;
        }
        else if (dp[i + 1][j] >= dp[i][j + 1]) {
            // Prefer del first so a replace comes out as del* then add* — exactly
            // the shape the word-level pairing below wants.
            ops.push({ type: "del", text: a[i] });
            i++;
        }
        else {
            ops.push({ type: "add", text: b[j] });
            j++;
        }
    }
    while (i < n) {
        ops.push({ type: "del", text: a[i] });
        i++;
    }
    while (j < m) {
        ops.push({ type: "add", text: b[j] });
        j++;
    }
    return ops;
}

// computeDiff — line-level diff → ops {type:'ctx'|'add'|'del', oldNo, newNo, text}.
// del has newNo:0 (no new-side line); add has oldNo:0. Numbers are 1-based.
function computeDiff(oldText, newText) {
    const a = splitLines(oldText);
    const b = splitLines(newText);
    const ops = [];
    let oldNo = 1, newNo = 1;
    // Common prefix (identical leading lines).
    let start = 0;
    while (start < a.length && start < b.length && a[start] === b[start])
        start++;
    for (let i = 0; i < start; i++)
        ops.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: a[i] });
    // Common suffix (identical trailing lines), not overlapping the prefix.
    let endA = a.length, endB = b.length;
    while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
        endA--; endB--;
    }
    // Diff the changed middle.
    for (const op of diffMiddle(a.slice(start, endA), b.slice(start, endB))) {
        if (op.type === "ctx")
            ops.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: op.text });
        else if (op.type === "del")
            ops.push({ type: "del", oldNo: oldNo++, newNo: 0, text: op.text });
        else
            ops.push({ type: "add", oldNo: 0, newNo: newNo++, text: op.text });
    }
    // Trailing common suffix as context.
    for (let i = endA; i < a.length; i++)
        ops.push({ type: "ctx", oldNo: oldNo++, newNo: newNo++, text: a[i] });
    return ops;
}

// toHunks — group changes with `context` surrounding ctx lines into hunks.
// Adjacent change groups whose context windows touch are merged. Returns
// {hunks: Op[][], added, removed}.
function toHunks(ops, context = 3) {
    let added = 0, removed = 0;
    for (const o of ops) {
        if (o.type === "add")
            added++;
        else if (o.type === "del")
            removed++;
    }
    const changed = [];
    for (let i = 0; i < ops.length; i++)
        if (ops[i].type !== "ctx")
            changed.push(i);
    if (!changed.length)
        return { hunks: [], added: 0, removed: 0 };
    const last = ops.length - 1;
    const hunks = [];
    let gStart = Math.max(0, changed[0] - context);
    let gEnd = Math.min(last, changed[0] + context);
    for (let k = 1; k < changed.length; k++) {
        const idx = changed[k];
        if (idx - context <= gEnd + 1) {
            gEnd = Math.min(last, idx + context); // window touches → extend
        }
        else {
            hunks.push(ops.slice(gStart, gEnd + 1));
            gStart = Math.max(0, idx - context);
            gEnd = Math.min(last, idx + context);
        }
    }
    hunks.push(ops.slice(gStart, gEnd + 1));
    return { hunks, added, removed };
}

// --- word-level span diff (char prefix/suffix, code-point safe) ----------
// Returns {pre, mid, suf} for each side. Operates on code points (Array.from)
// so a surrogate pair / wide char is never split mid-unit.
function wordSpans(delText, addText) {
    const a = Array.from(delText);
    const b = Array.from(addText);
    let p = 0;
    const maxP = Math.min(a.length, b.length);
    while (p < maxP && a[p] === b[p])
        p++;
    let s = 0;
    const maxS = Math.min(a.length - p, b.length - p);
    while (s < maxS && a[a.length - 1 - s] === b[b.length - 1 - s])
        s++;
    return {
        del: { pre: a.slice(0, p).join(""), mid: a.slice(p, a.length - s).join(""), suf: a.slice(a.length - s).join("") },
        add: { pre: b.slice(0, p).join(""), mid: b.slice(p, b.length - s).join(""), suf: b.slice(b.length - s).join("") },
    };
}

// --- rendering -----------------------------------------------------------
// The code column sits after "N │ ". For a changed row it is
// `{sign}{bar} {text}` (sign+bar+space = 3 cols); context rows pad 3 cols so
// the text column stays aligned.
function renderDiff(oldText, newText, opts = {}) {
    const { context = 3, expanded = false, theme } = opts;
    if (theme)
        c.resolveBaseBackground(theme); // theme-swaps the palette incl. BG_ADD/BG_DEL
    const width = Math.max(20, opts.width ?? c.termWidth());
    const dark = theme ? c.detectDark(theme) : true;
    const strongAdd = dark ? STRONG_ADD_DARK : STRONG_ADD_LIGHT;
    const strongDel = dark ? STRONG_DEL_DARK : STRONG_DEL_LIGHT;
    const codeFg = dark ? FG_TEXT_DARK : FG_TEXT_LIGHT;
    const RWB = render.RESET_WITHOUT_BG; // reset attrs but KEEP the active bg tint
    // Round 3 (F6): body lines start at the col-3 spine, shared with read/bash/
    // grep bodies. gutterLine (used by ctx/changed rows) already uses BODY_INDENT;
    // wordLine and sep build lines by hand, so route them through it too.
    const INDENT = kit.BODY_INDENT;
    const ELL = `${c.FG_DIM}›`; // › truncation marker (matches read/grep)

    const ops = computeDiff(oldText, newText);
    const { hunks } = toHunks(ops, context);
    if (!hunks.length)
        return [];

    // New-side gutter field width from the largest new-side line number.
    let maxNo = 0;
    for (const o of ops)
        if (o.newNo && o.newNo > maxNo)
            maxNo = o.newNo;
    const nw = Math.max(3, String(maxNo).length);

    const barCol = (kind) => (kind === "add" ? c.FG_GREEN : c.FG_RED);
    const baseBgOf = (kind) => (kind === "add" ? c.BG_ADD : c.BG_DEL);
    const signOf = (kind) => (kind === "add" ? "+" : "-");
    // The "{sign}{bar} " prefix (dim sign = the no-truecolor fallback).
    const changePrefix = (kind) =>
        `${c.FG_DIM}${signOf(kind)}${RWB}${barCol(kind)}${BAR}${RWB} `;

    // A context row: normal gutter, base bg, 3-space code indent for alignment.
    const ctxLine = (op) => {
        const line = kit.gutterLine(op.newNo, nw, `   ${codeFg}${stripAnsi(op.text)}`);
        return render.fillToolBackground(line, c.BG_BASE, width);
    };
    // A changed row without word-level highlighting (whole-line tint).
    const changedLine = (op, kind) => {
        const no = kind === "del" ? "" : op.newNo;
        const line = kit.gutterLine(no, nw, `${changePrefix(kind)}${codeFg}${stripAnsi(op.text)}`);
        return render.fillToolBackground(line, baseBgOf(kind), width);
    };
    // A changed row WITH a word-level strong-bg middle span. Built by hand
    // because fillToolBackground → preserveBoxBackground would strip the inner
    // strong bg. The whole line rides one base bg; the strong span switches bg
    // and switches back, so padding stays on the base tint. Span styling is
    // applied BEFORE truncation so the ANSI stays balanced.
    const wordLine = (op, kind, span) => {
        const no = kind === "del" ? "" : String(op.newNo);
        const baseBg = baseBgOf(kind);
        const strongBg = kind === "add" ? strongAdd : strongDel;
        const padNo = " ".repeat(Math.max(0, nw - no.length));
        // Sanitize content so an embedded ESC can't reset/bleed the row tint.
        const pre = stripAnsi(span.pre), mid = stripAnsi(span.mid), suf = stripAnsi(span.suf);
        let s = baseBg + INDENT + c.FG_LNUM + padNo + no + RWB + " " + c.FG_RULE + "│" + RWB + " ";
        s += changePrefix(kind);
        s += codeFg + pre; // explicit fg on base tint
        if (mid)
            s += strongBg + mid + baseBg; // strong span (bg only; fg stays codeFg), back to base
        s += suf;
        return truncPad(s, width, ELL) + c.RST;
    };

    const sep = () => render.fillToolBackground(`${INDENT}${c.FG_DIM}···${c.RST}`, c.BG_BASE, width);

    // Render each hunk; pair consecutive del*/add* blocks 1:1 for word-level.
    const out = [];
    for (let hi = 0; hi < hunks.length; hi++) {
        if (hi > 0)
            out.push(sep());
        const h = hunks[hi];
        let i = 0;
        while (i < h.length) {
            const op = h[i];
            if (op.type === "ctx") {
                out.push(ctxLine(op));
                i++;
                continue;
            }
            // Collect a maximal del block then a maximal add block.
            const dels = [];
            while (i < h.length && h[i].type === "del")
                dels.push(h[i++]);
            const adds = [];
            while (i < h.length && h[i].type === "add")
                adds.push(h[i++]);
            if (dels.length && adds.length && dels.length === adds.length) {
                // Equal counts → pair greedily 1:1 and word-highlight each pair.
                for (let k = 0; k < dels.length; k++) {
                    const sp = wordSpans(dels[k].text, adds[k].text);
                    // Only bother with strong spans when there's shared context
                    // (a common prefix or suffix); otherwise it's a full-line
                    // change and the row tint already says everything.
                    const meaningful = (sp.del.pre || sp.del.suf || sp.add.pre || sp.add.suf) &&
                        (sp.del.mid || sp.add.mid);
                    if (meaningful) {
                        out.push(wordLine(dels[k], "del", sp.del));
                        out.push(wordLine(adds[k], "add", sp.add));
                    }
                    else {
                        out.push(changedLine(dels[k], "del"));
                        out.push(changedLine(adds[k], "add"));
                    }
                }
            }
            else {
                for (const d of dels)
                    out.push(changedLine(d, "del"));
                for (const ad of adds)
                    out.push(changedLine(ad, "add"));
            }
        }
    }

    // Collapsed cap: the caller passes expanded; when collapsed, cap the body
    // and let a marker own the hidden count.
    if (!expanded && out.length > c.MAX_PREVIEW_LINES) {
        const hidden = out.length - c.MAX_PREVIEW_LINES;
        out.length = c.MAX_PREVIEW_LINES;
        out.push(kit.marker([`… +${kit.plural(hidden, "line")}`, "ctrl+o"]));
    }
    return out;
}

// summarizeDiff — counts for the caller's marker line.
function summarizeDiff(oldText, newText) {
    const ops = computeDiff(oldText, newText);
    const { hunks, added, removed } = toHunks(ops);
    return { added, removed, hunks: hunks.length };
}
//# sourceMappingURL=diff.js.map
