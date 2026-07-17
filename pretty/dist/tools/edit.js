"use strict";
/* pi-pretty: edit tool -- renders an oldText->newText change as a tinted unified diff. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerEditTool = registerEditTool;
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
// Collapsed body: just the first hunk. renderDiff separates hunks with a dim
// "···" line, so cut at the first one; then cap so a single huge hunk stays compact.
const COLLAPSED_CAP = 14;
function firstHunk(lines) {
    // Separator rows are the dim "···" line renderDiff inserts between hunks;
    // they lack a gutter "│", so guard against a literal "···" in edited content.
    const sepIdx = lines.findIndex((l) => l.includes("···") && !l.includes("│"));
    let body = sepIdx > 0 ? lines.slice(0, sepIdx) : lines;
    if (body.length > COLLAPSED_CAP)
        body = body.slice(0, COLLAPSED_CAP);
    return body;
}
function registerEditTool(pi, cwd, _svc, sdkTool, TextComp) {
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    const home = process.env.HOME ?? "";
    pi.registerTool({
        name: "edit",
        label: "Edit",
        description: sdkTool.description ?? "Edit a file by replacing text",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const p = params ?? {};
            const result = (await sdkTool.execute(tid, p, sig, undefined, ctx));
            // Capture the diff inputs straight from the params (no file read needed).
            const rd = result?.details ?? {};
            const filePath = String(p.filePath ?? p.path ?? rd.filePath ?? "");
            const oldText = p.oldText != null ? String(p.oldText)
                : (rd.oldText != null ? String(rd.oldText) : undefined);
            const newText = p.newText != null ? String(p.newText)
                : (rd.newText != null ? String(rd.newText) : undefined);
            result.details = { _type: "editResult", filePath, oldText, newText };
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const a = args;
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const p2 = (0, helpers_js_1.shortPath)(cwd, home, String(a.filePath ?? a.path ?? ""));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("edit"))} ${kit.pathSeg(p2)}`;
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title)}`, err ? config_js_1.BG_ERROR : config_js_1.BG_BASE));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText(kit.failLines(getText(result) || "Error", theme));
                return text;
            }
            kit.markDone(ctx, false);
            const d = result.details;
            const duration = (0, kit.durationSeg)(result);
            // Degrade gracefully if we never captured the diff inputs.
            if (!d || d._type !== "editResult" || (d.oldText == null && d.newText == null)) {
                const mk = (0, kit.marker)(["edited", "no diff available", duration]);
                text.setText((0, render_js_1.fillToolBackground)(`${mk || `${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}edited${config_js_1.RST}`}\n`, config_js_1.BG_BASE));
                return text;
            }
            const oldText = d.oldText ?? "";
            const newText = d.newText ?? "";
            const width = (0, config_js_1.termWidth)();
            const { added, removed, hunks } = diff.summarizeDiff(oldText, newText);
            // Full diff lines (expanded:true → no internal cap/marker; we own trimming).
            const context = ctx.expanded ? 3 : 4;
            const lines = diff.renderDiff(oldText, newText, { context, expanded: true, width, theme });
            const body = ctx.expanded ? lines : firstHunk(lines);
            const counts = `+${added} −${removed}`;
            const mk = ctx.expanded
                ? (0, kit.marker)([(0, kit.plural)(hunks, "hunk"), counts, duration])
                : (0, kit.marker)([`… ${(0, kit.plural)(hunks, "hunk")}`, counts, duration, "ctrl+o"]);
            const out = mk ? [...body, mk] : body;
            // Diff lines already carry their own bg fill; don't re-wrap them.
            text.setText(`${out.join("\n")}\n`);
            return text;
        },
    });
}
//# sourceMappingURL=edit.js.map
