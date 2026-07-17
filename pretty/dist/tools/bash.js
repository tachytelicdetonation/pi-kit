"use strict";
/* pi-pretty: bash tool -- command execution with styled output. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerBashTool = registerBashTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const verdicts_js_1 = require("./verdicts.js");
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
            // Non-fold-eligible: break any open fold run so an adjacent read/grep
            // before AND after this bash aren't coalesced across it (see runs.js).
            require("../runs.js").breakRun();
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const tw = (0, config_js_1.termWidth)() || 80;
            const rawCmd = String(args.command ?? "");
            const err = (0, kit.isErr)(ctx);
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
                const cleaned = (0, helpers_js_1.stripBashExitStatusLine)(d.text);
                // Render by CONSEQUENCE: parse a semantic verdict from the tail
                // (test/build totals) and promote it into the header. Null →
                // behavior is UNCHANGED from today. (round-4 §3)
                const verdict = (0, verdicts_js_1.extractVerdict)(cleaned, d.exitCode);
                // TIER 2 — failure (ctx.isError OR nonzero exit) routes through the
                // centralized kit.failLines: full body on BG_ERROR, default fg
                // (bash output is not prose to paint red), exit code as a dim
                // marker seg. Auto-full (no ctrl+o), tail-biased above 30 lines.
                if (isErr) {
                    kit.markDone(ctx, true);
                    // Header verdict on failure too: `✗ $ npm test · 3 failed`.
                    // Body stays full/tail-biased (failures need context); the
                    // "exit N" body marker below is left intact (additive).
                    if (verdict)
                        kit.setSummary(ctx, [verdict.seg, (0, kit.durationSeg)(result)]);
                    text.setText((0, kit.failLines)(cleaned, theme, {
                        fgError: false,
                        // Plain string: kit.marker dims the whole line already; a
                        // kit.dim()-wrapped seg would drop a trailing RST that
                        // breaks the dim run of the following "ctrl+o" seg.
                        extraSegs: d.exitCode ? [`exit ${d.exitCode}`] : [],
                    }));
                    return text;
                }
                // TIER 1 success — tail-biased evidence window (marker above tail).
                kit.markDone(ctx, false);
                // Colorize diff-shaped output (+/- lines, @@ hunks, git headers)
                // BEFORE windowing. Pure synchronous string coloring — this IS
                // licensed diff coloring (§1.3); line count / duration untouched.
                const displayLines = colorizeDiffLines(cleaned.split("\n"));
                const duration = (0, kit.durationSeg)(result); // "" when < 1s
                // Success verdict → promote [verdict · duration] into the header.
                // The header now answers "did it work / how long", so the tail
                // window shrinks 5→2 below. Null verdict → header/body unchanged.
                if (verdict)
                    kit.setSummary(ctx, [verdict.seg, duration]);
                const rw = (0, config_js_1.termWidth)();
                const renderFn = (w) => {
                    // Success: inline ≤6; else tail-biased head 0 / tail 5 (test &
                    // build totals live at the end), with the marker line ABOVE
                    // the tail. previewWindow supports head:0 (kit.js).
                    const win = ctx.expanded
                        ? (0, kit.previewWindow)(displayLines, { inlineMax: displayLines.length + 1 })
                        : (0, kit.previewWindow)(displayLines, { inlineMax: 6, head: 0, tail: verdict ? 2 : 5 });
                    const body = [];
                    for (const l of win.head)
                        body.push(`${kit.BODY_INDENT}${l}`);
                    const mk = (0, kit.marker)([
                        win.hidden > 0 ? `… +${(0, kit.plural)(win.hidden, "line")}` : "",
                        // Duration lives in the header once a verdict is promoted
                        // there — don't repeat it in the body marker.
                        verdict ? "" : duration,
                        win.hidden > 0 ? "ctrl+o" : "",
                    ]);
                    if (win.tail.length) {
                        if (mk)
                            body.push(mk);
                        for (const l of win.tail)
                            body.push(`${kit.BODY_INDENT}${l}`);
                    }
                    else if (mk) {
                        body.push(mk);
                    }
                    if (body.length === 0) {
                        // Empty-output success: the marker is bash's evidence floor
                        // (bash is Tier 1). Keep the "done" line.
                        const emptyMk = (0, kit.marker)(["done", duration]);
                        return (0, render_js_1.fillToolBackground)(`${emptyMk}\n`, undefined, w);
                    }
                    return (0, render_js_1.fillToolBackground)(`${body.join("\n")}\n`, undefined, w);
                };
                // Width-reactive re-render. Install the wrapper ONCE per component
                // (guard __kitWrapped) — re-wrapping every pass on a reused
                // lastComponent stacks layers that fight after a resize. Each pass
                // just swaps in the fresh renderFn + signature.
                text.__kitRenderFn = renderFn;
                text.__kitSig = `${ctx.expanded ? "1" : "0"}:${d.exitCode ?? "?"}:${cleaned.length}:${duration}`;
                text.__kitKey = undefined;
                text.setText(renderFn(rw));
                if (!text.__kitWrapped) {
                    text.__kitWrapped = true;
                    const base = text.render.bind(text);
                    text.render = (w) => {
                        const width = Math.max(1, Math.floor(w || (0, config_js_1.termWidth)()));
                        const key = `${width}|${text.__kitSig}`;
                        if (text.__kitKey !== key) {
                            text.setText(text.__kitRenderFn(width));
                            text.__kitKey = key;
                        }
                        return base(width);
                    };
                }
                return text;
            }
            if (ctx.isError) {
                // Generic (non-bashResult) failure — same centralized Tier-2 path.
                kit.markDone(ctx, true);
                text.setText((0, kit.failLines)(tc || "Error", theme, { fgError: false }));
                return text;
            }
            kit.markDone(ctx, false);
            const fc = result.content?.[0];
            text.setText((0, render_js_1.fillToolBackground)(`${kit.BODY_INDENT}${theme.fg("dim", fc && "text" in fc ? String(fc.text).slice(0, 120) : "done")}`));
            return text;
        },
    });
}
// Detect diff-shaped output and colorize its content lines. Detection triggers on
// any "@@ " hunk header, a "diff --git" line, or paired "--- "/"+++ " file headers.
// When it doesn't look like a diff the lines are returned unchanged. Coloring is
// width-safe (only wraps lines in FG_* SGR codes — no length change) and
// theme-adaptive (FG_* are palette-swapped live by resolveBaseBackground). A +/-
// prefix survives when truecolor degrades, so it stays readable without color.
function colorizeDiffLines(lines) {
    let isDiff = false;
    let hasMinusHdr = false;
    let hasPlusHdr = false;
    for (const l of lines) {
        if (l.startsWith("@@ ") || l.startsWith("diff --git")) {
            isDiff = true;
            break;
        }
        if (l.startsWith("--- "))
            hasMinusHdr = true;
        else if (l.startsWith("+++ "))
            hasPlusHdr = true;
    }
    if (!isDiff && !(hasMinusHdr && hasPlusHdr))
        return lines;
    return lines.map((l) => {
        // Headers first so "+++"/"---" aren't caught by the generic +/- branches.
        if (l.startsWith("diff --git") ||
            l.startsWith("index ") ||
            l.startsWith("@@") ||
            l.startsWith("+++") ||
            l.startsWith("---"))
            return `${config_js_1.FG_DIM}${l}${config_js_1.RST}`;
        if (l.startsWith("+"))
            return `${config_js_1.FG_GREEN}${l}${config_js_1.RST}`;
        if (l.startsWith("-"))
            return `${config_js_1.FG_RED}${l}${config_js_1.RST}`;
        return l;
    });
}
function getText(result) {
    return ((result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text)
        .join("\n") ?? "");
}
//# sourceMappingURL=bash.js.map