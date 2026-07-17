"use strict";
/* pi-pretty: grep tool -- FFF-backed text search with SDK fallback. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGrepTool = registerGrepTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
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
            const text = ctx.lastComponent ?? new T("", 0, 0);
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
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new T("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText((0, render_js_1.renderToolError)((result.content ?? [])
                    .filter((c) => c.type === "text")
                    .map((c) => c.text)
                    .join("\n") || "Error", theme));
                return text;
            }
            const d = result.details;
            if (d?._type === "grepResult" && d.text && d.text.trim()) {
                kit.markDone(ctx, false);
                const tw = (0, config_js_1.termWidth)();
                const stats = (0, kit.grepStats)(d.text);
                const matches = stats.matches || d.matchCount || 0;
                const files = stats.files;
                // Drop "in N files" when the parse yielded no files (would read "in 0 files").
                const countStr = files > 0
                    ? `${matches} ${matches === 1 ? "match" : "matches"} in ${(0, kit.plural)(files, "file")}`
                    : `${matches} ${matches === 1 ? "match" : "matches"}`;
                const duration = (0, kit.durationSeg)(result);
                const SHOW_ALL_MAX = 8;
                // Many matches, collapsed → per-file count strip (where they cluster).
                if (!ctx.expanded && matches > SHOW_ALL_MAX) {
                    const strip = grepFileStrip(stats.perFile, Math.max(20, tw - 2), 6);
                    const body = strip.map((l) => `${config_js_1.TOOL_RESULT_INDENT}${l}`);
                    const mk = (0, kit.marker)([`… ${countStr}`, duration, "ctrl+o"]);
                    if (mk)
                        body.push(mk);
                    text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}\n`, undefined));
                    return text;
                }
                // Few matches (or expanded) → full grouped + highlighted (async regex).
                const mk = (0, kit.marker)([countStr, duration]);
                const withMarker = (lines) => {
                    const out = lines.slice();
                    if (mk)
                        out.push(mk);
                    return `${out.join("\n")}\n`;
                };
                // Cache the highlighted render by content key: a redraw reuses it
                // directly (no plain flash) and never re-invalidates identical content
                // (which would loop). Expanded → no line cap (Infinity).
                const hlKey = `grep:${ctx.expanded ? 1 : 0}`;
                const seq = (ctx.state.__seq = (ctx.state.__seq || 0) + 1);
                const owner = text;
                if (ctx.state.__hlKey === hlKey && ctx.state.__hlText) {
                    text.setText((0, render_js_1.fillToolBackground)(ctx.state.__hlText));
                    return text;
                }
                const plain = d.text.split("\n").filter((l) => l.trim());
                const plainShown = ctx.expanded ? plain : plain.slice(0, SHOW_ALL_MAX * 2);
                text.setText((0, render_js_1.fillToolBackground)(withMarker(plainShown.map((l) => `${config_js_1.TOOL_RESULT_INDENT}${l}`))));
                renderGrepGrouped(d.text, d.pattern, ctx.expanded ? Infinity : undefined)
                    .then((rendered) => {
                    if (ctx.state.__seq !== seq)
                        return;
                    if (ctx.lastComponent && ctx.lastComponent !== owner)
                        return;
                    ctx.state.__hlKey = hlKey;
                    ctx.state.__hlText = withMarker(rendered.split("\n"));
                    owner.setText((0, render_js_1.fillToolBackground)(ctx.state.__hlText));
                    ctx.invalidate?.();
                })
                    .catch(() => { });
                return text;
            }
            const fc = result.content?.[0];
            kit.markDone(ctx, false);
            const fallback = fc && "text" in fc ? String(fc.text).slice(0, 120) : "no matches";
            text.setText((0, render_js_1.fillToolBackground)(`${config_js_1.TOOL_RESULT_INDENT}${theme.fg("dim", fallback)}`, undefined));
            return text;
        },
    });
}
// Collapsed per-file strip: top-N files "path (n)", column-packed. Path via
// kit.pathSeg (dim dir + normal basename) so it matches the grouped headers.
// Mirrors the former kit.grepFileStrip but styles the path through pathSeg.
function grepFileStrip(perFile, width, topN = 6) {
    const entries = [...perFile.entries()].sort((a, b) => b[1] - a[1]);
    const cells = entries
        .slice(0, topN)
        .map(([file, n]) => `${kit.pathSeg(file)} ${config_js_1.FG_MUTED}(${n})${config_js_1.RST}`);
    return kit.columns(cells, width, 3);
}
// Grouped, pattern-highlighted matches (async to fit the highlight guard, though
// the work is synchronous). File headers render the path via kit.pathSeg and each
// match/context row via kit.gutterLine so the line-number gutter aligns with read.js.
// Context lines (rg "file-line-content") count toward the display limit exactly as
// before; grepStats still owns the match total shown in the marker.
async function renderGrepGrouped(text, pattern, limit = config_js_1.MAX_PREVIEW_LINES) {
    const lines = (0, helpers_js_1.normalizeLineEndings)(text).split("\n");
    if (!lines.length || (lines.length === 1 && !lines[0].trim()))
        return `${config_js_1.FG_DIM}(no matches)${config_js_1.RST}`;
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
            out.push(`${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}… more matches (ctrl+o)${config_js_1.RST}`);
            break;
        }
        const fileMatch = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
        if (fileMatch) {
            const [, file, lineNo, content] = fileMatch;
            if (file !== currentFile) {
                if (currentFile)
                    out.push("");
                out.push(`${config_js_1.TOOL_RESULT_INDENT}${(0, config_js_1.fileIcon)(file)}${kit.pathSeg(file)}`);
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
            out.push(`${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}  ···${config_js_1.RST}`);
        }
        else if (line.trim()) {
            out.push(line);
            count++;
        }
    }
    return out.join("\n");
}
//# sourceMappingURL=grep.js.map