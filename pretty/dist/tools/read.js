"use strict";
/* pi-pretty: read tool -- file reading with syntax highlighting and inline image support. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerReadTool = registerReadTool;
const pi_tui_1 = require("@earendil-works/pi-tui");
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const metrics_js_1 = require("./metrics.js");
function registerReadTool(pi, cwd, _fffService, sdkTool, TextComp) {
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    const home = process.env.HOME ?? "";
    pi.registerTool({
        name: "read",
        label: "Read",
        description: sdkTool.description ?? "Read file contents",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const p = params;
            const result = (await sdkTool.execute(tid, p, sig, undefined, ctx));
            const imageBlock = result.content?.find((c) => c.type === "image");
            if (imageBlock) {
                result.details = {
                    _type: "readImage",
                    filePath: String(p.path ?? ""),
                    data: imageBlock.data,
                    mimeType: imageBlock.mimeType ?? "image/png",
                };
                return result;
            }
            const tc = (0, helpers_js_1.normalizeLineEndings)(getText(result));
            result.details = {
                _type: "readFile",
                filePath: String(p.path ?? ""),
                content: tc,
                offset: typeof p.offset === "number" ? p.offset : 0,
                lineCount: tc ? tc.split("\n").length : 0,
            };
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const p2 = (0, helpers_js_1.shortPath)(cwd, home, String(args.path ?? ""));
            const off = typeof args.offset === "number" && args.offset > 0 ? `:${args.offset}` : "";
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("read"))} ${theme.fg("toolTitle", p2)}${theme.fg("dim", off)}`;
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title)}`, err ? config_js_1.BG_ERROR : config_js_1.BG_BASE));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText((0, render_js_1.fillToolBackground)((0, render_js_1.renderToolError)(getText(result) || "Error", theme), config_js_1.BG_ERROR));
                return text;
            }
            const d = result.details;
            // Image rendering — use pi-tui Image component
            if (d?._type === "readImage") {
                kit.markDone(ctx, false);
                const mimeType = d.mimeType.startsWith("image/svg") ? "image/svg+xml" : d.mimeType;
                return new pi_tui_1.Image(d.data, mimeType, {
                    fallbackColor: (text) => theme.fg("toolTitle", text),
                }, {
                    filename: d.filePath,
                });
            }
            // File content — peek (≤8 lines → whole file, else 4) with gutter + Shiki.
            if (d?._type === "readFile" && d.content) {
                kit.markDone(ctx, false);
                const tw = (0, config_js_1.termWidth)();
                const lines = d.content.split("\n");
                while (lines.length > 1 && lines[lines.length - 1] === "")
                    lines.pop(); // drop trailing newline's phantom line
                const total = lines.length;
                const bytes = Buffer.byteLength(d.content, "utf8");
                const INLINE = 8, PEEK = 4;
                const showCount = ctx.expanded ? total : total <= INLINE ? total : PEEK;
                const hidden = total - showCount;
                const offset = d.offset || 0;
                const nw = Math.max(3, String(offset + total).length);
                const cw = Math.max(8, tw - nw - 3 - config_js_1.TOOL_RESULT_INDENT.length);
                const gutter = (i, code) => {
                    const no = String(offset + i + 1);
                    const padNo = " ".repeat(Math.max(0, nw - no.length));
                    return `${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_LNUM}${padNo}${no}${config_js_1.RST} ${config_js_1.FG_RULE}│${config_js_1.RST} ${code}${config_js_1.RST}`;
                };
                // Zero-chrome: a fully-shown small file gets no marker; expanded shows size.
                const markerLine = () => (hidden > 0 || ctx.expanded)
                    ? (0, kit.marker)([
                        hidden > 0 ? `… +${(0, kit.plural)(hidden, "line")}` : "",
                        (0, helpers_js_1.humanSize)(bytes),
                        hidden > 0 ? "ctrl+o" : "",
                    ])
                    : "";
                const build = (codeLines) => {
                    const out = codeLines.slice(0, showCount).map((code, i) => gutter(i, code));
                    const m = markerLine();
                    if (m)
                        out.push(m);
                    return `${out.join("\n")}\n`;
                };
                // Highlight is async. Cache the rendered result by a content key so a
                // redraw reuses it directly (no plain flash) and — crucially — never
                // re-invalidates on identical content, which would be an infinite loop.
                const key = `${ctx.expanded ? 1 : 0}:${cw}:${showCount}`;
                const seq = (ctx.state.__seq = (ctx.state.__seq || 0) + 1);
                const owner = text;
                if (ctx.state.__hlKey === key && ctx.state.__hlText) {
                    text.setText((0, render_js_1.fillToolBackground)(ctx.state.__hlText, config_js_1.BG_BASE));
                    return text;
                }
                const plain = lines.slice(0, showCount).map((l) => (kit.vis(l) > cw ? (0, kit.trunc)(l, cw, `${config_js_1.FG_DIM}›`) : l));
                text.setText((0, render_js_1.fillToolBackground)(build(plain), config_js_1.BG_BASE));
                (0, render_js_1.renderFileContent)(d.content, d.filePath, offset, showCount, cw)
                    .then((hl) => {
                    if (ctx.state.__seq !== seq)
                        return; // superseded by a newer pass
                    if (ctx.lastComponent && ctx.lastComponent !== owner)
                        return; // component swapped
                    ctx.state.__hlKey = key;
                    ctx.state.__hlText = build(hl.split("\n"));
                    owner.setText((0, render_js_1.fillToolBackground)(ctx.state.__hlText, config_js_1.BG_BASE));
                    ctx.invalidate?.();
                })
                    .catch(() => { });
                return text;
            }
            const fc = result.content?.[0];
            kit.markDone(ctx, false);
            text.setText((0, render_js_1.fillToolBackground)(`${config_js_1.TOOL_RESULT_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`, config_js_1.BG_BASE));
            return text;
        },
    });
}
function getText(result) {
    return ((result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "");
}
//# sourceMappingURL=read.js.map