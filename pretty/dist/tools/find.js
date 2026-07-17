"use strict";
/* pi-pretty: find tool -- FFF-backed file search with SDK (fd) fallback. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFindTool = registerFindTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const metrics_js_1 = require("./metrics.js");
function getText(result) {
    return (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
}
async function sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, extraNotices) {
    const result = (await sdkTool.execute(tid, params, sig, undefined, ctx));
    const tc = getText(result);
    const prev = result.details?.notices ?? [];
    const notices = [...(Array.isArray(prev) ? prev : []), ...extraNotices];
    result.details = {
        _type: "findResult",
        text: tc,
        pattern,
        matchCount: tc ? tc.trim().split("\n").filter(Boolean).length : 0,
        notices,
    };
    return result;
}
function registerFindTool(pi, cwd, _fffService, sdkTool, TextComp) {
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    const home = process.env.HOME ?? "";
    pi.registerTool({
        name: "find",
        label: "Find",
        description: sdkTool.description ?? "Find files matching a glob pattern",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const pattern = String(params.pattern ?? "");
            return sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, [
                "Search engine: SDK find (fd).",
            ]);
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const a = args;
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const pattern = a.pattern == null ? "" : String(a.pattern);
            const path = a.path == null || String(a.path).length === 0 ? "." : (0, helpers_js_1.shortPath)(cwd, home, String(a.path));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("find"))} ${theme.fg("toolTitle", pattern)}${theme.fg("dim", ` in ${path}`)}`;
            const annots = a.limit !== undefined && a.limit !== null ? theme.fg("dim", `(limit ${a.limit})`) : "";
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title, annots)}`, err ? config_js_1.BG_ERROR : undefined));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const r = result;
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText((0, render_js_1.renderToolError)(getText(r) || "Error", theme));
                return text;
            }
            const d = r.details;
            if (d?._type === "findResult") {
                kit.markDone(ctx, false);
                const noticeStr = d.notices?.length
                    ? `\n${config_js_1.TOOL_RESULT_INDENT}${theme.fg("warning", `[${d.notices.join(". ")}]`)}`
                    : "";
                const duration = (0, kit.durationSeg)(r);
                const paths = d.text.split("\n").map((s) => s.trim()).filter(Boolean);
                const count = d.matchCount || paths.length;
                const fileSeg = `${count} ${count === 1 ? "file" : "files"}`;
                if (!paths.length) {
                    const mk = (0, kit.marker)([fileSeg, duration]);
                    text.setText((0, render_js_1.fillToolBackground)(`${mk}${noticeStr}\n`));
                    return text;
                }
                if (!ctx.expanded) {
                    // Collapsed → dir histogram (where the files cluster).
                    const hist = (0, kit.dirHistogram)(paths, 3);
                    const body = [`${config_js_1.TOOL_RESULT_INDENT}${hist.line}`];
                    const mk = (0, kit.marker)([`… ${fileSeg}`, (0, kit.plural)(hist.dirs, "dir"), duration, "ctrl+o"]);
                    if (mk)
                        body.push(mk);
                    text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}${noticeStr}\n`));
                    return text;
                }
                const rendered = (0, render_js_1.renderFindResults)(d.text, theme)
                    .split("\n")
                    .map((l) => `${config_js_1.TOOL_RESULT_INDENT}${l}`);
                const mk = (0, kit.marker)([fileSeg, duration]);
                const body = mk ? [...rendered, mk] : rendered;
                text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}${noticeStr}\n`));
                return text;
            }
            const fc = r.content?.[0];
            kit.markDone(ctx, false);
            text.setText((0, render_js_1.fillToolBackground)(`${config_js_1.TOOL_RESULT_INDENT}${theme.fg("dim", fc?.text?.slice(0, 120) ?? "0 files")}\n`));
            return text;
        },
    });
}
//# sourceMappingURL=find.js.map