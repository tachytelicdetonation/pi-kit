"use strict";
/* pi-pretty: ls tool -- directory listing with styled output. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerLsTool = registerLsTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const metrics_js_1 = require("./metrics.js");
function registerLsTool(pi, cwd, _fffService, sdkTool, TextComp) {
    const home = process.env.HOME ?? "";
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    pi.registerTool({
        name: "ls",
        label: "List",
        description: sdkTool.description ?? "List directory contents",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const result = (await sdkTool.execute(tid, params, sig, undefined, ctx));
            const tc = getText(result);
            result.details = {
                _type: "lsResult",
                text: tc,
                path: String(params.path ?? ""),
                entryCount: tc ? tc.trim().split("\n").filter(Boolean).length : 0,
            };
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const err = kit.statusOf(ctx) === "err";
            const rawPath = args.path;
            const path = rawPath === null || rawPath === undefined || String(rawPath).length === 0
                ? "."
                : (0, helpers_js_1.shortPath)(cwd, home, String(rawPath));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("ls"))} ${theme.fg("accent", path)}`;
            const annots = args.limit !== undefined && args.limit !== null ? theme.fg("dim", `(limit ${args.limit})`) : "";
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title, annots)}`, err ? config_js_1.BG_ERROR : undefined));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText((0, render_js_1.renderToolError)(getText(result) || "Error", theme));
                return text;
            }
            const d = result.details;
            if (d?._type === "lsResult" && d.text) {
                kit.markDone(ctx, false);
                const info = (0, render_js_1.buildEntryCells)(d.text);
                const duration = (0, kit.durationSeg)(result);
                const PREVIEW = 12;
                const limit = ctx.expanded ? -1 : PREVIEW;
                const hidden = ctx.expanded ? 0 : Math.max(0, info.total - PREVIEW);
                const rows = (0, render_js_1.renderTree)(d.text, d.path, limit).split("\n").map((l) => `${config_js_1.TOOL_RESULT_INDENT}${l}`);
                const mk = (0, kit.marker)([
                    `${info.total} ${info.total === 1 ? "entry" : "entries"}`,
                    info.dirs ? (0, kit.plural)(info.dirs, "dir") : "",
                    duration,
                    hidden > 0 ? "ctrl+o" : "",
                ]);
                const body = rows.slice();
                if (mk)
                    body.push(mk);
                text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}\n`));
                return text;
            }
            const fc = result.content?.[0];
            kit.markDone(ctx, false);
            text.setText((0, render_js_1.fillToolBackground)(`${config_js_1.TOOL_RESULT_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`));
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
//# sourceMappingURL=ls.js.map