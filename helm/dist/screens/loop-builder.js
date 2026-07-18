/**
 * 7a — Loop builder. Loops are defined in conversation, then EARN their schedule via
 * a trial run. PURE render of
 *   1. the operator's prose description, echoed as a `❯` line;
 *   2. pi's STRUCTURED breakdown — `trigger / steps / skips / guardrails` rows
 *      (guardrails carry merge rights, a $/day cap, concurrency, and an optional
 *      per-step model rendered with a purple tag);
 *   3. the trial statement;
 *   4. the action line, which depends on the trial gate:
 *        - idle    → `t trial run · e edit · x discard`
 *        - trialing→ `running trial under full review …`
 *        - passed  → `s accept schedule · r revise · x discard`
 *        - failed  → a red failure line + the idle action line (the builder reopens;
 *                    a failed trial NEVER auto-retries).
 *
 * The app chrome supplies the header (`pi · new loop …spring… draft`) and the fleet
 * footer. Every line is ANSI-safe and clipped to at most `height` via windowLines.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { column, windowLines, wrapPlain } from "./../chrome.js";
import { GLYPH, paint, PALETTE } from "./../theme.js";
/** Left gutter (2 cells) so the card aligns with the other screens. */
const INDENT = "  ";
/** The `trigger / steps / skips / guardrails` label column width. */
const LABEL_COL = 11;
export function renderLoopBuilder(draft, theme, width, height, trial = "idle") {
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (w <= 0 || h <= 0)
        return [];
    const lines = [];
    // ── (1) the prose description, echoed ────────────────────────────────────
    const caret = paint(theme, PALETTE.inputBorder, GLYPH.prompt);
    lines.push(clip(`${caret} ${paint(theme, PALETTE.primary, draft.prompt)}`, w));
    lines.push("");
    // ── (2) the structured breakdown ─────────────────────────────────────────
    lines.push(clip(`${paint(theme, PALETTE.label, "loop")} ${paint(theme, PALETTE.dim, `· ${draft.name}`)}`, w));
    pushRow(lines, theme, "trigger", draft.trigger, w);
    pushRow(lines, theme, "steps", draft.steps, w);
    pushRow(lines, theme, "skips", draft.skips, w);
    pushGuardrails(lines, theme, draft, w);
    lines.push("");
    // ── (3) the trial statement ──────────────────────────────────────────────
    lines.push(clip(`${paint(theme, PALETTE.dim, "trial:")} ${paint(theme, PALETTE.mid, draft.trialStatement)}`, w));
    // ── (4) the trial-gate action line ───────────────────────────────────────
    if (trial === "failed") {
        lines.push(clip(`${paint(theme, PALETTE.error, "✕")} ${paint(theme, PALETTE.error, "trial failed under review — reported; builder reopened (never auto-retried)")}`, w));
    }
    lines.push(actionLine(theme, trial, w));
    return windowLines(theme, lines, 0, h, w);
}
/** `  <label>  <value>` — a structured breakdown row with a hanging indent. */
function pushRow(lines, theme, label, value, width) {
    const textWidth = Math.max(1, width - INDENT.length - LABEL_COL - 1);
    const segments = wrapPlain(value, textWidth);
    segments.forEach((segment, index) => {
        const left = index === 0
            ? `${paint(theme, PALETTE.dim, column(label, LABEL_COL))} `
            : column("", LABEL_COL + 1);
        lines.push(clip(`${left}${paint(theme, PALETTE.mid, segment)}`, width));
    });
}
/**
 * The guardrails row: chips joined by `·`, then an optional purple model tag.
 * Rendered on one painted line (keeping the purple tag) when it fits; otherwise
 * word-wrapped with a hanging indent so the per-step model guardrail is never
 * truncated away at narrow widths (the sibling rows wrap the same way).
 */
function pushGuardrails(lines, theme, draft, width) {
    const sep = ` ${paint(theme, PALETTE.dim, "·")} `;
    let painted = draft.guardrails.map((chip) => paint(theme, PALETTE.mid, chip)).join(sep);
    if (draft.guardrailModel) {
        painted += `${sep}${paint(theme, PALETTE.purple, draft.guardrailModel.model)} ${paint(theme, PALETTE.mid, draft.guardrailModel.note)}`;
    }
    const label = `${paint(theme, PALETTE.dim, column("guardrails", LABEL_COL))} `;
    if (visibleWidth(`${label}${painted}`) <= width) {
        lines.push(`${label}${painted}`);
        return;
    }
    // Too narrow for the painted single line: wrap the plain text (content
    // preserved; per-segment color simplified to `mid`) like the sibling rows.
    const plainSep = " · ";
    const plainChips = draft.guardrails.join(plainSep);
    const plainModel = draft.guardrailModel
        ? `${plainSep}${draft.guardrailModel.model} ${draft.guardrailModel.note}`
        : "";
    const textWidth = Math.max(1, width - INDENT.length - LABEL_COL - 1);
    wrapPlain(`${plainChips}${plainModel}`, textWidth).forEach((segment, index) => {
        const left = index === 0 ? label : column("", LABEL_COL + 1);
        lines.push(clip(`${left}${paint(theme, PALETTE.mid, segment)}`, width));
    });
}
/** The action line for the current trial-gate state. */
function actionLine(theme, trial, width) {
    const dot = ` ${paint(theme, PALETTE.dim, "·")} `;
    const key = (k, label) => `${paint(theme, PALETTE.brand, k)} ${paint(theme, PALETTE.dim, label)}`;
    let content;
    if (trial === "trialing") {
        content = paint(theme, PALETTE.warning, "running trial under full review …");
    }
    else if (trial === "passed") {
        content =
            `${paint(theme, PALETTE.success, "✓")} ${paint(theme, PALETTE.dim, "trial passed under review")}${dot}` +
                `${key("s", "accept schedule")}${dot}${key("r", "revise")}${dot}${key("x", "discard")}`;
    }
    else {
        // idle or failed (builder reopened) — the same primary action set.
        content = `${key("t", "trial run")}${dot}${key("e", "edit")}${dot}${key("x", "discard")}`;
    }
    return clip(content, width);
}
/** A left-indented, ANSI-safe line clipped to width. */
function clip(content, width) {
    return truncateToWidth(`${INDENT}${content}`, width, "");
}
