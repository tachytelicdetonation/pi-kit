"use strict";
/* pi-pretty: grep tool -- FFF-backed text search with SDK fallback. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerGrepTool = registerGrepTool;
const config_js_1 = require("../config.js");
const fff_helpers_js_1 = require("../fff-helpers.js");
const helpers_js_1 = require("../helpers.js");
const notices_js_1 = require("../notices.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const metrics_js_1 = require("./metrics.js");
function registerGrepTool(pi, cwd, fffService, sdkTool, TextComp) {
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
            const path = p.path ? String(p.path) : undefined;
            const glob = p.glob ? String(p.glob) : undefined;
            const context = typeof p.context === "number" ? p.context : 0;
            const limit = typeof p.limit === "number" ? p.limit : 200;
            const literal = p.literal === true;
            if (fffService?.isAvailable && !path && !glob) {
                try {
                    const fff = fffService.getFinder();
                    if (!fff)
                        throw new Error("FFF finder not available");
                    const effectiveLimit = Math.max(1, limit);
                    const grepResult = fff.grep(pattern, {
                        pageSize: effectiveLimit,
                        mode: literal ? "plain" : "regex",
                        beforeContext: context,
                        afterContext: context,
                    });
                    if (grepResult.ok) {
                        const grep = grepResult.value;
                        const items = grep.items.slice(0, effectiveLimit);
                        const cursorStore = fffService.getCursorStore();
                        const notices = [];
                        if (fffService.partialIndex)
                            notices.push(notices_js_1.NOTICE_PARTIAL_FILE_INDEX);
                        if (items.length >= effectiveLimit)
                            notices.push(`${effectiveLimit} limit reached`);
                        if (grep.regexFallbackError)
                            notices.push(`Regex failed: ${grep.regexFallbackError}, used literal match`);
                        if (grep.nextCursor) {
                            const cursorId = cursorStore.store(grep.nextCursor);
                            notices.push(`More results available: cursor="${cursorId}"`);
                        }
                        const text = appendNotices((0, fff_helpers_js_1.fffFormatGrepText)(items, effectiveLimit), notices);
                        return {
                            content: [{ type: "text", text }],
                            details: {
                                _type: "grepResult",
                                text,
                                pattern,
                                matchCount: items.length,
                            },
                        };
                    }
                }
                catch {
                    /* fall through */
                }
            }
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
            const err = kit.statusOf(ctx) === "err";
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
                const countStr = `${matches} ${matches === 1 ? "match" : "matches"} in ${(0, kit.plural)(files, "file")}`;
                const duration = (0, kit.durationSeg)(result);
                const SHOW_ALL_MAX = 8;
                // Many matches, collapsed → per-file count strip (where they cluster).
                if (!ctx.expanded && matches > SHOW_ALL_MAX) {
                    const strip = (0, kit.grepFileStrip)(stats.perFile, Math.max(20, tw - 2), 6);
                    const body = strip.map((l) => `${config_js_1.TOOL_RESULT_INDENT}${l}`);
                    const mk = (0, kit.marker)([countStr, duration, "ctrl+o"]);
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
                // Immediate plain (indented); renderGrepResults self-indents when it swaps in.
                const plain = d.text.split("\n").filter((l) => l.trim());
                const plainShown = ctx.expanded ? plain : plain.slice(0, SHOW_ALL_MAX * 2);
                text.setText((0, render_js_1.fillToolBackground)(withMarker(plainShown.map((l) => `${config_js_1.TOOL_RESULT_INDENT}${l}`))));
                (0, render_js_1.renderGrepResults)(d.text, d.pattern)
                    .then((rendered) => {
                    text.setText((0, render_js_1.fillToolBackground)(withMarker(rendered.split("\n"))));
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
function appendNotices(text, notices) {
    return notices.length ? `${text}\n\n[${notices.join(". ")}]` : text;
}
//# sourceMappingURL=grep.js.map