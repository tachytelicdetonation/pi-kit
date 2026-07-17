"use strict";
/* pi-pretty: grep tool -- FFF-backed text search with SDK fallback. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGrepTool = registerGrepTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const runs = require("../runs.js");
const metrics_js_1 = require("./metrics.js");
function registerGrepTool(pi, cwd, _fffService, sdkTool, TextComp) {
    const T = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    const home = process.env.HOME ?? "";
    pi.registerTool({
        name: "grep",
        label: "Grep",
        description: sdkTool.description ?? "Search file contents by pattern",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const p = params;
            const pattern = String(p.pattern ?? "");
            const result = (await sdkTool.execute(tid, p, sig, undefined, ctx));
            for (const c of (result.content ?? [])) {
                if (c.type === "text")
                    c.text = (0, helpers_js_1.normalizeLineEndings)(c.text);
            }
            const tc = (result.content ?? [])
                .filter((c) => c.type === "text")
                .map((c) => c.text)
                .join("\n") ?? "";
            result.details = {
                _type: "grepResult",
                text: tc,
                pattern,
                matchCount: tc ? tc.trim().split("\n").filter(Boolean).length : 0,
            };
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            // Fold registry: consecutive greps for the SAME term collapse (§1).
            runs.register("grep", String(args.pattern ?? ""), ctx);
            if (ctx.state && ctx.state.__kitFolded && !ctx.expanded)
                return kit.zeroText(ctx);
            const prev = ctx.lastComponent;
            const text = prev && !(prev instanceof kit.ZeroText) ? prev : new T("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const pattern = args.pattern == null ? "" : String(args.pattern);
            const path = args.path == null || String(args.path).length === 0 ? "." : (0, helpers_js_1.shortPath)(cwd, home, String(args.path));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("grep"))} ${theme.fg("toolTitle", `/${pattern}/`)}${theme.fg("dim", ` in ${path}`)}`;
            const a = [];
            if (args.glob)
                a.push(`(${String(args.glob)})`);
            if (args.literal === true)
                a.push("(literal)");
            if (args.caseInsensitive === true || args.ignoreCase === true)
                a.push("(i)");
            if (args.limit !== undefined && args.limit !== null)
                a.push(`limit ${args.limit}`);
            const annots = a.length ? theme.fg("dim", a.join(" ")) : "";
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title, annots)}`, err ? config_js_1.BG_ERROR : undefined));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            if (ctx.state && ctx.state.__kitFolded && !ctx.expanded)
                return kit.zeroText(ctx);
            (0, config_js_1.resolveBaseBackground)(theme);
            const prev = ctx.lastComponent;
            const text = prev && !(prev instanceof kit.ZeroText) ? prev : new T("", 0, 0);
            // Tier 2 — failure: full red-tinted body via the centralized helper.
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText(kit.failLines((result.content ?? [])
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n") || "Error", theme));
                return text;
            }
            const d = result.details;
            if (d?._type === "grepResult") {
                kit.markDone(ctx, false);
                const hasText = !!(d.text && d.text.trim());
                const stats = hasText
                    ? (0, kit.grepStats)(d.text)
                    : { perFile: new Map(), matches: 0, files: 0 };
                const matches = stats.matches || (hasText ? d.matchCount : 0) || 0;
                const files = stats.files;
                const duration = (0, kit.durationSeg)(result);
                // Tier 0 collapsed → fuse the summary into the header, render zero lines.
                // No "in 0 files": drop the file count when the parse yielded none
                // (empty/no-match branch reads a plain "0 matches").
                if (!ctx.expanded) {
                    const countSeg = files > 0
                        ? `${matches} in ${(0, kit.plural)(files, "file")}`
                        : `${matches} ${matches === 1 ? "match" : "matches"}`;
                    const topSeg = topFileSeg(stats.perFile);
                    kit.setSummary(ctx, [runs.runSeg(ctx), countSeg, topSeg, duration]);
                    return kit.zeroText(ctx);
                }
                // Tier 0 expanded → grouped body: pathSeg headers, gutterLine rows,
                // yellow-bold term highlight. Marker carries the full count string.
                const countStr = files > 0
                    ? `${matches} ${matches === 1 ? "match" : "matches"} in ${(0, kit.plural)(files, "file")}`
                    : `${matches} ${matches === 1 ? "match" : "matches"}`;
                const bodyLines = renderGrepGrouped(d.text || "", d.pattern, Infinity).split("\n");
                const mk = (0, kit.marker)([countStr, duration]);
                if (mk)
                    bodyLines.push(mk);
                text.setText((0, render_js_1.fillToolBackground)(`${bodyLines.join("\n")}\n`, undefined));
                return text;
            }
            // Degenerate path (details is not a grepResult) — should not occur since
            // execute always stamps _type:"grepResult". Keep a minimal dim line.
            kit.markDone(ctx, false);
            const fc = result.content?.[0];
            const fallback = fc && "text" in fc ? String(fc.text).slice(0, 120) : "no matches";
            text.setText((0, render_js_1.fillToolBackground)(`${kit.BODY_INDENT}${theme.fg("dim", fallback)}`, undefined));
            return text;
        },
    });
}
// Top file for the collapsed summary: "path (n)" for the file with the most
// matches. Plain text — the summary is uniformly dim (styled by markerInner),
// so no pathSeg color here. "" when there are no per-file counts.
function topFileSeg(perFile) {
    let topFile = "";
    let topN = 0;
    for (const [file, n] of perFile) {
        if (n > topN) {
            topN = n;
            topFile = file;
        }
    }
    return topFile ? `${topFile} (${topN})` : "";
}
// Grouped, pattern-highlighted matches (synchronous — Shiki removed in round 3).
// File headers render the path via kit.pathSeg and each match/context row via
// kit.gutterLine so the line-number gutter aligns with read.js. All body lines
// start at kit.BODY_INDENT (column 3) to keep the glyph spine clean (§1.2).
// Context lines (rg "file-line-content") count toward the display limit exactly
// as before; grepStats still owns the match total shown in the marker.
function renderGrepGrouped(text, pattern, limit = config_js_1.MAX_PREVIEW_LINES) {
    const lines = (0, helpers_js_1.normalizeLineEndings)(text).split("\n");
    if (!lines.length || (lines.length === 1 && !lines[0].trim()))
        return `${kit.BODY_INDENT}${config_js_1.FG_DIM}(no matches)${config_js_1.RST}`;
    const out = [];
    let currentFile = "";
    let count = 0;
    let re = null;
    try {
        re = new RegExp(`(${pattern})`, "gi");
    }
    catch {
        /* skip highlighting */
    }
    for (const line of lines) {
        if (count >= limit) {
            out.push(`${kit.BODY_INDENT}${config_js_1.FG_DIM}… more matches (ctrl+o)${config_js_1.RST}`);
            break;
        }
        const fileMatch = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
        if (fileMatch) {
            const [, file, lineNo, content] = fileMatch;
            if (file !== currentFile) {
                if (currentFile)
                    out.push("");
                out.push(`${kit.BODY_INDENT}${kit.pathSeg(file)}`);
                currentFile = file;
            }
            const nw = Math.max(3, lineNo.length);
            let display = content;
            if (re)
                display = content.replace(re, `${config_js_1.RST}${config_js_1.FG_YELLOW}\x1b[1m$1${config_js_1.RST}`);
            out.push(kit.gutterLine(Number(lineNo), nw, display));
            count++;
        }
        else if (line.trim() === "--") {
            out.push(`${kit.BODY_INDENT}${config_js_1.FG_DIM}···${config_js_1.RST}`);
        }
        else if (line.trim()) {
            out.push(`${kit.BODY_INDENT}${line}`);
            count++;
        }
    }
    return out.join("\n");
}
//# sourceMappingURL=grep.js.map
