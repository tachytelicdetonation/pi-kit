"use strict";
/* pi-pretty: bash tool -- command execution with styled output. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBashTool = registerBashTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const metrics_js_1 = require("./metrics.js");
function registerBashTool(pi, _cwd, _fffService, sdkTool, TextComp) {
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    pi.registerTool({
        name: "bash",
        label: "Bash",
        description: sdkTool.description
            ? `${sdkTool.description} For text search: \`rg -n\`.`
            : "Execute shell commands. For text search: `rg -n`.",
        promptSnippet: "Execute commands via bash. For text search: `rg -n`.",
        promptGuidelines: [
            "For text search: `rg -n`. If no results, try `rg -u` (respects .gitignore by default).",
            "In rg: | means alternation, \\| means literal pipe. Opposite of GNU grep. Never use \\| for alternation.",
        ],
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            try {
                return (await sdkTool.execute(tid, params, sig, undefined, ctx));
            }
            catch (error) {
                const msg = error instanceof Error ? error.message : String(error);
                return {
                    content: [{ type: "text", text: msg }],
                    isError: true,
                    details: {
                        _type: "bashResult",
                        text: msg,
                        exitCode: 1,
                        command: String(params.command ?? ""),
                    },
                };
            }
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const tw = (0, config_js_1.termWidth)() || 80;
            const rawCmd = String(args.command ?? "");
            const err = kit.statusOf(ctx) === "err";
            const budget = ctx.expanded ? tw : Math.max(8, tw - 24);
            const cmd = rawCmd.length === 0
                ? "…"
                : (!ctx.expanded && kit.vis(rawCmd) > budget ? kit.trunc(rawCmd, budget) : rawCmd);
            const title = theme.fg(err ? "error" : "toolTitle", theme.bold(`$ ${cmd}`));
            const annots = typeof args.timeout === "number" ? theme.fg("dim", `(timeout ${args.timeout}s)`) : "";
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title, annots)}`, err ? config_js_1.BG_ERROR : undefined, ctx.expanded ? undefined : tw));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const details = result.details;
            const tc = getText(result);
            const d = details?._type === "bashResult"
                ? details
                : tc || ctx.isError
                    ? { _type: "bashResult", text: tc || "Error", exitCode: ctx.isError ? 1 : 0, command: "" }
                    : undefined;
            if (d?._type === "bashResult") {
                // Trust the reported exit code; no substring guessing (craft fix).
                const isErr = ctx.isError || (d.exitCode !== null && d.exitCode !== 0);
                kit.markDone(ctx, isErr);
                const cleaned = (0, helpers_js_1.stripBashExitStatusLine)(d.text);
                const output = isErr ? (0, helpers_js_1.compactErrorLines)(cleaned).join("\n") : cleaned;
                const allLines = output.split("\n");
                const duration = (0, kit.durationSeg)(result); // "" when < 1s
                const exitSeg = isErr && d.exitCode ? kit.redSeg(`exit ${d.exitCode}`) : "";
                const rw = (0, config_js_1.termWidth)();
                const renderFn = (w) => {
                    // Success: inline ≤6, else head 4 / tail 2 (tail = test/build totals).
                    // Error: inline ≤8, else head 2 / tail 6 (stderr ends matter most).
                    const win = ctx.expanded
                        ? (0, kit.previewWindow)(allLines, { inlineMax: allLines.length + 1 })
                        : (0, kit.previewWindow)(allLines, isErr ? { inlineMax: 8, head: 2, tail: 6 } : { inlineMax: 6, head: 4, tail: 2 });
                    const body = [];
                    for (const l of win.head)
                        body.push(`${config_js_1.TOOL_RESULT_INDENT}${l}`);
                    const mk = (0, kit.marker)([
                        win.hidden > 0 ? `… +${(0, kit.plural)(win.hidden, "line")}` : "",
                        exitSeg,
                        duration,
                        win.hidden > 0 ? "ctrl+o" : "",
                    ]);
                    if (win.tail.length) {
                        if (mk)
                            body.push(mk);
                        for (const l of win.tail)
                            body.push(`${config_js_1.TOOL_RESULT_INDENT}${l}`);
                    }
                    else if (mk) {
                        body.push(mk);
                    }
                    if (body.length === 0) {
                        const emptyMk = (0, kit.marker)([isErr ? (exitSeg || "failed") : "done", duration]);
                        return (0, render_js_1.fillToolBackground)(`${emptyMk}\n`, isErr ? config_js_1.BG_ERROR : undefined, w);
                    }
                    return (0, render_js_1.fillToolBackground)(`${body.join("\n")}\n`, isErr ? config_js_1.BG_ERROR : undefined, w);
                };
                text.setText(renderFn(rw));
                const baseRender = typeof text.render === "function" ? text.render.bind(text) : null;
                if (baseRender) {
                    let key;
                    text.render = (w) => {
                        const width = Math.max(1, Math.floor(w || (0, config_js_1.termWidth)()));
                        const k = `bash:${ctx.expanded ? "1" : "0"}:${width}:${d.exitCode ?? "?"}:${output.length}:${duration}`;
                        if (key !== k) {
                            text.setText(renderFn(width));
                            key = k;
                        }
                        return baseRender(width);
                    };
                }
                return text;
            }
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText((0, render_js_1.renderToolError)(tc || "Error", theme));
                return text;
            }
            kit.markDone(ctx, false);
            const fc = result.content?.[0];
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
//# sourceMappingURL=bash.js.map