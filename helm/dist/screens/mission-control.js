/**
 * 6b — Mission control (home). PURE render of the three fixed strata:
 *   1. `▲ needs you (N)` — escalations awaiting an operator decision.
 *   2. `◆ goal <name>` + 8-cell progress bar, with tree-indented TOP-LEVEL
 *      workflows only (subagent trees never appear here).
 *   3. `∞ loops (N active)` — background loops.
 *
 * Strata always appear in this order. Every line is ANSI-safe (built via
 * chrome.spring/column + theme paint) and never wider than `width`; the whole
 * body is clipped to at most `height` lines, appending a "… N more" hint when it
 * would overflow. `selection` highlights the current selectable row via a subtle
 * left marker — the selectable order matches selectors.selectableRows exactly.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { column, spring, treePrefix, windowLines } from "./../chrome.js";
import { GLYPH, paint, PALETTE } from "./../theme.js";
import { activeLoopCount, needsYouCount, progressBar8, workflowsForGoal } from "./../state/selectors.js";
/** Left name-column widths per stratum (chosen to match the mock's alignment). */
const SOURCE_COL = 20;
const WORKFLOW_COL = 14;
const LOOP_COL = 12;
/** Left gutter (2 cells): a selection marker or blank, keeping all rows aligned. */
const GUTTER = 2;
/**
 * Render the home body into at most `height` lines. Fewer is fine — the app pads.
 * `selection` is the index into the flat selectable-row list (see selectableRows).
 */
export function renderMissionControl(state, theme, width, height, selection) {
    const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
    if (w <= 0 || h <= 0)
        return [];
    const lines = [];
    // `cursor` walks the SAME order as selectors.selectableRows so the highlight
    // index and the dispatcher's selection index always agree. `anchor` records the
    // body-line index of the selected row so windowing can keep it visible.
    let cursor = 0;
    let anchor = 0;
    const selected = () => cursor === selection;
    // ── Stratum 1: needs you ────────────────────────────────────────────────
    if (needsYouCount(state) > 0) {
        lines.push(headerLine(theme, `${paint(theme, PALETTE.warning, `${GLYPH.needsYou} needs you`)} ${paint(theme, PALETTE.dim, `(${state.escalations.length})`)}`, w));
        state.escalations.forEach((escalation, index) => {
            if (selected())
                anchor = lines.length;
            lines.push(escalationRow(theme, escalation, index + 1, selected(), w));
            cursor += 1;
        });
        lines.push("");
    }
    // ── Stratum 2: goals + top-level workflows ─────────────────────────────
    for (const goal of state.goals) {
        lines.push(goalHeaderRow(theme, goal, w));
        const workflows = workflowsForGoal(state, goal.id);
        workflows.forEach((workflow, index) => {
            const isLast = index === workflows.length - 1;
            if (selected())
                anchor = lines.length;
            lines.push(workflowRow(theme, workflow, isLast, state.mainModel, selected(), w));
            cursor += 1;
        });
    }
    if (state.goals.length > 0)
        lines.push("");
    // ── Stratum 3: loops ────────────────────────────────────────────────────
    if (state.loops.length > 0) {
        lines.push(headerLine(theme, `${paint(theme, PALETTE.success, `${GLYPH.loops} loops`)} ${paint(theme, PALETTE.dim, `(${activeLoopCount(state)} active)`)}`, w));
        for (const loop of state.loops) {
            if (selected())
                anchor = lines.length;
            lines.push(loopRow(theme, loop, selected(), w));
            cursor += 1;
        }
    }
    return windowLines(theme, lines, anchor, h, w);
}
/** A non-selectable section/goal header: 2-space gutter, then content. */
function headerLine(theme, content, width) {
    return truncateToWidth(`  ${content}`, width, "");
}
/** Compose a selectable row: [marker gutter][spring(left, right, width-gutter)]. */
function selectableRow(theme, left, right, isSelected, width) {
    const marker = isSelected ? `${paint(theme, PALETTE.brand, "▌")} ` : "  ";
    const inner = spring(theme, left, right, Math.max(0, width - GUTTER));
    return truncateToWidth(`${marker}${inner}`, width, "");
}
function escalationRow(theme, escalation, num, isSelected, width) {
    const left = `${paint(theme, PALETTE.label, column(escalation.source.label, SOURCE_COL))}  ${paint(theme, PALETTE.mid, escalation.question)}`;
    // Only the first 9 escalations get a number key — the act binding is 1–9.
    const key = num >= 1 && num <= 9 ? ` ${paint(theme, PALETTE.brand, String(num))}` : "";
    const right = `${paint(theme, PALETTE.label, escalation.verb)}${key}`;
    return selectableRow(theme, left, right, isSelected, width);
}
function goalHeaderRow(theme, goal, width) {
    const left = `${paint(theme, PALETTE.brand, GLYPH.goal)} ${paint(theme, PALETTE.dim, "goal")} ${paint(theme, PALETTE.bright, goal.name)}`;
    const { filled, empty } = progressBar8(goal.progress);
    const bar = paint(theme, PALETTE.brand, GLYPH.bar.repeat(filled)) + paint(theme, PALETTE.spent, GLYPH.bar.repeat(empty));
    const percent = Math.round(Math.min(1, Math.max(0, goal.progress)) * 100);
    const eta = goal.etaText ? ` ${paint(theme, PALETTE.dim, `· ${goal.etaText}`)}` : "";
    const right = `${bar} ${paint(theme, PALETTE.dim, `${percent}%`)}${eta}`;
    // Goal headers are not selectable, but share the 2-cell gutter for alignment.
    return truncateToWidth(`  ${spring(theme, left, right, Math.max(0, width - GUTTER))}`, width, "");
}
/** State glyph + color + word for a workflow lane. */
function workflowState(state) {
    switch (state) {
        case "running":
            return { glyph: GLYPH.running, text: "running", color: PALETTE.codex };
        case "verifying":
            return { glyph: GLYPH.verifying, text: "verifying", color: PALETTE.warning };
        case "queued":
            return { glyph: GLYPH.queued, text: "queued", color: PALETTE.dim };
        case "paused":
            return { glyph: GLYPH.queued, text: "paused", color: PALETTE.warning };
    }
}
function workflowRow(theme, workflow, isLast, mainModel, isSelected, width) {
    const tree = paint(theme, PALETTE.ghost, treePrefix(1, isLast));
    const left = `${tree}${paint(theme, PALETTE.primary, column(workflow.name, WORKFLOW_COL))}  ${paint(theme, PALETTE.mid, workflow.summary)}`;
    const { glyph, text, color } = workflowState(workflow.state);
    let right = `${paint(theme, color, glyph)} ${paint(theme, color, text)}`;
    // Purple model tag ONLY when the lane's model differs from the main session model.
    if (workflow.modelTag && workflow.modelTag !== mainModel) {
        right += ` ${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.purple, workflow.modelTag)}`;
    }
    return selectableRow(theme, left, right, isSelected, width);
}
/** Right-column text for a loop: yield·cost, else idle·last-fired, else next-run. */
function loopStatus(theme, loop) {
    if (loop.health === "paused") {
        const reason = loop.pausedReason ? ` ${loop.pausedReason}` : "";
        return `${paint(theme, PALETTE.warning, GLYPH.queued)} ${paint(theme, PALETTE.warning, `paused${reason}`)}`;
    }
    if (loop.yieldToday) {
        const cost = loop.costToday ? ` ${paint(theme, PALETTE.dim, `· ${loop.costToday}`)}` : "";
        return `${paint(theme, PALETTE.label, loop.yieldToday)}${cost}`;
    }
    if (loop.lastFired)
        return paint(theme, PALETTE.dim, `idle · last fired ${loop.lastFired}`);
    if (loop.nextRun)
        return paint(theme, PALETTE.dim, `next run ${loop.nextRun}`);
    return paint(theme, PALETTE.dim, "idle");
}
function loopRow(theme, loop, isSelected, width) {
    // Middle column is the "trigger → pipeline" summary per the 6b row shape.
    const summary = `${loop.trigger} → ${loop.pipelineSummary}`;
    const left = `${paint(theme, PALETTE.primary, column(loop.name, LOOP_COL))}  ${paint(theme, PALETTE.mid, summary)}`;
    return selectableRow(theme, left, loopStatus(theme, loop), isSelected, width);
}
