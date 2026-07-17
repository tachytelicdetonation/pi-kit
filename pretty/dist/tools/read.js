"use strict";
/* Read tool renderer: displays file contents; image files are left for the host to draw. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerReadTool = registerReadTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const runs = require("../runs.js");
const node_path_1 = require("node:path");
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
                // Leave the image block in result.content untouched: the host's
                // ToolExecutionComponent renders it as ONE pi-tui image (with proper
                // image IDs / row accounting / redraw / deletion). We only tag it so
                // renderResult shows an "image" summary — we do NOT copy the bytes or
                // render our own image (that double-rendered against the host's).
                result.details = {
                    _type: "readImage",
                    filePath: String(p.path ?? ""),
                    mimeType: imageBlock.mimeType ?? "image/png",
                };
                return result;
            }
            // Regular (non-image) read: normalize newlines, then record the body
            // and a line count so renderResult can fuse a summary into the header.
            const body = (0, helpers_js_1.normalizeLineEndings)(getText(result));
            const startOffset = typeof p.offset === "number" ? p.offset : 0;
            result.details = {
                _type: "readFile",
                filePath: String(p.path ?? ""),
                content: body,
                offset: startOffset,
                lineCount: body ? body.split("\n").length : 0,
            };
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            // Fold registry: consecutive reads of the SAME file collapse into the
            // newest header (§1). A folded predecessor renders zero-height here
            // (and in renderResult), which also drops the leading "\n" it prepends.
            runs.register("read", (0, node_path_1.resolve)(cwd, String(args.path ?? "")), ctx);
            if (ctx.state && ctx.state.__kitFolded && !ctx.expanded)
                return kit.zeroText(ctx);
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
            // A folded predecessor is zero-height in the result pass too.
            if (ctx.state && ctx.state.__kitFolded && !ctx.expanded)
                return kit.zeroText(ctx);
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
            // Image read — render ONLY the header (with an "image" summary) and let
            // the HOST append the single image from the preserved result.content.
            // Rendering our own pi-tui Image here double-rendered (two component
            // owners for one image); the older raw-sequence path bypassed pi-tui's
            // image IDs / row accounting and broke proxy terminals (e.g. Herdr).
            // Host-owned = exactly one image, correct redraw and deletion.
            if (d?._type === "readImage") {
                kit.setSummary(ctx, ["image"]);
                return kit.zeroText(ctx);
            }
            // File content — Tier 0. Collapsed: fuse a line-count summary into the
            // header and render zero body lines. Expanded: plain (unhighlighted)
            // gutter body for every line up to MAX_PREVIEW_LINES, width-truncated.
            if (d?._type === "readFile" && d.content) {
                const lines = d.content.split("\n");
                while (lines.length > 1 && lines[lines.length - 1] === "")
                    lines.pop(); // drop trailing newline's phantom line
                const total = lines.length;
                kit.setSummary(ctx, [runs.runSeg(ctx), (0, kit.plural)(total, "line"), kit.durationSeg(result)]);
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
// Gather the text of every text block in a tool result and join them with
// newlines. Non-text blocks and a missing content array both yield "".
function getText(result) {
    const texts = [];
    for (const block of result.content ?? []) {
        if (block.type === "text")
            texts.push(block.text);
    }
    return texts.join("\n");
}
//# sourceMappingURL=read.js.map