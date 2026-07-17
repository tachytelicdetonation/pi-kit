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
            const prev = ctx.lastComponent;
            const text = prev && !(prev instanceof kit.ZeroText) ? prev : new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const p2 = (0, helpers_js_1.shortPath)(cwd, home, String(args.path ?? ""));
            const off = typeof args.offset === "number" && args.offset > 0 ? `:${args.offset}` : "";
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("read"))} ${kit.pathSeg(p2)}${theme.fg("dim", off)}`;
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title)}`, err ? config_js_1.BG_ERROR : config_js_1.BG_BASE));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const prev = ctx.lastComponent;
            const text = prev && !(prev instanceof kit.ZeroText) ? prev : new TC("", 0, 0);
            // TIER 2 — failure: full, red-tinted body via the centralized failLines
            // (auto-expanded, tail-biased above 30 lines). Glyph is already red
            // this pass because statusOf reads host-authoritative ctx.isError.
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText(kit.failLines(getText(result) || "Error", theme));
                return text;
            }
            kit.markDone(ctx, false);
            const d = result.details;
            // Image rendering — use pi-tui Image component. Set an "image" summary
            // first so the header still reads complete.
            if (d?._type === "readImage") {
                kit.setSummary(ctx, ["image"]);
                const mimeType = d.mimeType.startsWith("image/svg") ? "image/svg+xml" : d.mimeType;
                return new pi_tui_1.Image(d.data, mimeType, {
                    fallbackColor: (text) => theme.fg("toolTitle", text),
                }, {
                    filename: d.filePath,
                });
            }
            // File content — Tier 0. Collapsed: fuse a line-count summary into the
            // header and render zero body lines. Expanded: plain (unhighlighted)
            // gutter body for every line up to MAX_PREVIEW_LINES, width-truncated.
            if (d?._type === "readFile" && d.content) {
                const lines = d.content.split("\n");
                while (lines.length > 1 && lines[lines.length - 1] === "")
                    lines.pop(); // drop trailing newline's phantom line
                const total = lines.length;
                kit.setSummary(ctx, [(0, kit.plural)(total, "line"), kit.durationSeg(result)]);
                if (!ctx.expanded)
                    return kit.zeroText(ctx);
                const tw = (0, config_js_1.termWidth)();
                const offset = d.offset || 0;
                const nw = Math.max(3, String(offset + total).length);
                const cw = Math.max(8, tw - nw - 3 - kit.BODY_INDENT.length);
                const showCount = Math.min(total, config_js_1.MAX_PREVIEW_LINES);
                const hidden = total - showCount;
                const out = lines.slice(0, showCount).map((l, i) => {
                    const code = kit.vis(l) > cw ? (0, kit.trunc)(l, cw, `${config_js_1.FG_DIM}›`) : l;
                    return kit.gutterLine(offset + i + 1, nw, code);
                });
                if (hidden > 0)
                    out.push((0, kit.marker)([`… +${(0, kit.plural)(hidden, "line")}`]));
                text.setText((0, render_js_1.fillToolBackground)(`${out.join("\n")}\n`, config_js_1.BG_BASE));
                return text;
            }
            const fc = result.content?.[0];
            text.setText((0, render_js_1.fillToolBackground)(`${kit.BODY_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`, config_js_1.BG_BASE));
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