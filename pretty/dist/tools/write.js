"use strict";
/* pi-pretty: write tool -- renders a newly written file as an all-additions diff. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerWriteTool = registerWriteTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const diff = require("../diff.js");
const metrics_js_1 = require("./metrics.js");
function getText(result) {
    return ((result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "");
}
// Collapsed preview: a small head of the new content; the marker owns the rest.
const COLLAPSED_HEAD = 8;
function lineCountOf(content) {
    const lines = String(content ?? "").replace(/\r\n?/g, "\n").split("\n");
    while (lines.length && lines[lines.length - 1] === "")
        lines.pop();
    return lines.length;
}
function registerWriteTool(pi, cwd, _svc, sdkTool, TextComp) {
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    const home = process.env.HOME ?? "";
    pi.registerTool({
        name: "write",
        label: "Write",
        description: sdkTool.description ?? "Write a new file",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const p = params ?? {};
            const result = (await sdkTool.execute(tid, p, sig, undefined, ctx));
            const rd = result?.details ?? {};
            const filePath = String(p.filePath ?? p.path ?? rd.filePath ?? "");
            const content = p.content != null ? String(p.content)
                : (rd.content != null ? String(rd.content) : "");
            result.details = { _type: "writeResult", filePath, content };
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            // Non-fold-eligible: break any open fold run so adjacent read/grep
            // calls aren't coalesced across this write (see runs.js breakRun).
            require("../runs.js").breakRun();
            const a = args;
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const p2 = (0, helpers_js_1.shortPath)(cwd, home, String(a.filePath ?? a.path ?? ""));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("write"))} ${kit.pathSeg(p2)}`;
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title)}`, err ? config_js_1.BG_ERROR : config_js_1.BG_BASE));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                // Tier 2 (§4): centralized failure body — full text, BG_ERROR tint,
                // tail-biased above 30 lines. failLines wraps in BG_ERROR itself.
                text.setText(kit.failLines(getText(result) || "Error", theme));
                return text;
            }
            kit.markDone(ctx, false);
            const d = result.details;
            const content = d?._type === "writeResult" ? (d.content ?? "") : "";
            const duration = (0, kit.durationSeg)(result);
            const lineCount = lineCountOf(content);
            const width = (0, config_js_1.termWidth)();
            // All-additions diff ("" → content): green-tinted, line-numbered, no async.
            const lines = diff.renderDiff("", content, { expanded: true, width, theme });
            const hidden = ctx.expanded ? 0 : Math.max(0, lines.length - COLLAPSED_HEAD);
            const body = ctx.expanded ? lines : lines.slice(0, COLLAPSED_HEAD);
            const mk = (0, kit.marker)([
                "new file",
                (0, kit.plural)(lineCount, "line"),
                duration,
                hidden > 0 ? "ctrl+o" : "",
            ]);
            const out = mk ? [...body, mk] : body;
            // Diff lines already carry their own bg fill; don't re-wrap them. When the
            // file is empty the body is empty and only the marker shows.
            text.setText(`${out.join("\n")}\n`);
            return text;
        },
    });
}
//# sourceMappingURL=write.js.map
