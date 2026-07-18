// ---------------------------------------------------------------------------
// Token accounting
//
// Two token sources coexist and disagree: the provider's structured breakdown
// (input/output/cacheRead/cacheWrite) and a running scalar estimate (`total` at
// the run level, `tokens` per agent) that keeps ticking even when the provider
// stays silent. `tokenFigures` reconciles them into a single {fresh, cacheRead}
// pair that every surface renders.
// ---------------------------------------------------------------------------
/**
 * Reduce a usage breakdown and/or a scalar estimate to displayable fresh vs
 * cache-read figures.
 *
 * - "fresh" bundles input + output + cacheWrite. A cache write is a first-time
 *   ingestion billed at full (or premium) rates, so folding it into fresh keeps
 *   spend honest; only cacheRead — the genuinely cheap reuse — is shown apart.
 * - "fresh" never dips below what the scalar estimate implies once cache reads
 *   are removed, so estimate-only providers, cost-only providers (charged but
 *   reporting zero tokens), and mixed runs all keep the figure the display
 *   showed before this split existed instead of collapsing to a false "0 tok".
 */
export function tokenFigures(usage, scalarTokens) {
    const cacheRead = usage?.cacheRead ?? 0;
    const breakdown = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
    const estimate = Math.max(scalarTokens ?? 0, usage?.total ?? 0);
    return { fresh: Math.max(breakdown, estimate - cacheRead), cacheRead };
}
/** Fold a set of agents into combined fresh/cacheRead token totals plus real cost, via {@link tokenFigures}. */
export function aggregateAgentUsage(agents) {
    const totals = { fresh: 0, cacheRead: 0, cost: 0 };
    for (const agent of agents) {
        const { fresh, cacheRead } = tokenFigures(agent.tokenUsage, agent.tokens);
        totals.fresh += fresh;
        totals.cacheRead += cacheRead;
        totals.cost += agent.tokenUsage?.cost ?? 0;
    }
    return totals;
}
/**
 * Render a token figure for one surface: "12.4K tok" alone, or
 * "89K tok · 3.0M cached" once cache reads exist. The cache clause appears only
 * when `cacheRead > 0`, so a non-caching provider (or a single-turn agent that
 * never re-reads its cache) reads as plain "tok" rather than a bare "fresh".
 * `fmt` picks the number style per surface — compact inside panels, full-width
 * in the print view.
 */
export function fmtTokenCount(fresh, cacheRead, fmt) {
    const freshText = fmt(fresh) || "0";
    return cacheRead > 0 ? `${freshText} tok · ${fmt(cacheRead)} cached` : `${freshText} tok`;
}
/**
 * {@link fmtTokenCount} guarded for the "nothing known yet" case: returns "" when
 * both figures are 0, so a surface omits the clause entirely rather than printing
 * a misleading "0 tok" — e.g. a journal-replayed resume, or a run whose agents
 * were all skipped. Prefer this over hand-rolling the zero check per surface.
 */
export function fmtTokenSegment(figures, fmt) {
    if (figures.fresh + figures.cacheRead <= 0)
        return "";
    return fmtTokenCount(figures.fresh, figures.cacheRead, fmt);
}
/**
 * "$1.23" at a cent and above, four decimals below that, and "<$0.0001" for
 * anything tinier — a real cost must never round down to a zero-looking "$0.00".
 */
export function fmtCost(cost) {
    if (cost > 0 && cost < 0.0001)
        return "<$0.0001";
    return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}
/** Full (non-compact) number style for print/text surfaces: locale-grouped digits. */
export const fmtFull = (n) => n.toLocaleString();
/** Wall-clock elapsed as a compact stopwatch: "42s", "3m12s", "1h05m". */
export function fmtDuration(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    if (totalSeconds < 60)
        return `${totalSeconds}s`;
    const totalMinutes = Math.floor(totalSeconds / 60);
    if (totalMinutes < 60)
        return `${totalMinutes}m${totalSeconds % 60}s`;
    const hours = Math.floor(totalMinutes / 60);
    return `${hours}h${String(totalMinutes % 60).padStart(2, "0")}m`;
}
/** The smallest `startedAt` across the given agents, or undefined when none is stamped. */
function earliestAgentStart(agents) {
    let earliest;
    for (const { startedAt } of agents) {
        if (typeof startedAt === "number" && (earliest === undefined || startedAt < earliest)) {
            earliest = startedAt;
        }
    }
    return earliest;
}
// ---------------------------------------------------------------------------
// Snapshot construction / recomputation
// ---------------------------------------------------------------------------
export function createWorkflowSnapshot(meta) {
    return {
        name: meta.name,
        description: meta.description,
        phases: meta.phases?.map((phase) => phase.title) ?? [],
        logs: [],
        agents: [],
        agentCount: 0,
        runningCount: 0,
        doneCount: 0,
        errorCount: 0,
    };
}
export function recomputeWorkflowSnapshot(snapshot) {
    let runningCount = 0;
    let doneCount = 0;
    let errorCount = 0;
    for (const agent of snapshot.agents) {
        if (agent.status === "running")
            runningCount++;
        else if (agent.status === "done")
            doneCount++;
        else if (agent.status === "error")
            errorCount++;
    }
    return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}
// ---------------------------------------------------------------------------
// Display factories (widget + tool-update surfaces)
// ---------------------------------------------------------------------------
export function createWidgetWorkflowDisplay(ctx, options = {}) {
    const key = options.key ?? "workflow";
    const placement = options.placement ?? "belowEditor";
    const showStatus = options.showStatus ?? false;
    // The factory closes over this mutable pair, so a re-register always renders
    // the newest snapshot even though the factory itself is built only once.
    let latest;
    let completed = false;
    const widgetFactory = (_tui, theme) => ({
        render: () => (latest ? renderWorkflowLines(latest, options, theme) : []),
        invalidate: () => { },
    });
    if (ctx.hasUI) {
        ctx.ui.setWidget(key, widgetFactory, { placement });
    }
    // Re-registering the same factory is how we ask the host to re-render.
    const publish = (snapshot, done) => {
        latest = snapshot;
        if (done)
            completed = true;
        if (!ctx.hasUI)
            return;
        if (showStatus)
            ctx.ui.setStatus(key, statusLine(snapshot, completed));
        ctx.ui.setWidget(key, widgetFactory, { placement });
    };
    return {
        update(snapshot) {
            publish(snapshot, false);
        },
        complete(snapshot) {
            publish(snapshot, true);
        },
        clear() {
            if (!ctx.hasUI)
                return;
            if (showStatus)
                ctx.ui.setStatus(key, undefined);
            ctx.ui.setWidget(key, undefined);
        },
    };
}
export function createToolUpdateWorkflowDisplay(onUpdate, ctx, options = {}) {
    const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
    // Default to streaming text only when there is no live UI to carry the widget.
    const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;
    const emit = (snapshot, completed) => {
        if (streamToolUpdates) {
            onUpdate?.({
                content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
                details: snapshot,
            });
        }
        if (completed)
            widget?.complete(snapshot);
        else
            widget?.update(snapshot);
    };
    return {
        update(snapshot) {
            emit(snapshot, false);
        },
        complete(snapshot) {
            emit(snapshot, true);
        },
        clear() {
            widget?.clear();
        },
    };
}
/** Passthrough theme for surfaces with no colors (plain tool text). */
const NO_THEME = { fg: (_color, text) => text, bold: (text) => text };
function tallyStatuses(agents) {
    const tally = { done: 0, running: 0, errors: 0, skipped: 0 };
    for (const agent of agents) {
        switch (agent.status) {
            case "done":
                tally.done++;
                break;
            case "running":
                tally.running++;
                break;
            case "error":
                tally.errors++;
                break;
            case "skipped":
                tally.skipped++;
                break;
        }
    }
    return tally;
}
/** The dim "3/5 · 1 running · 2 errors" rollup suffix shared by phase and unphased groups. */
function rollupSuffix(total, tally) {
    const running = tally.running ? ` · ${tally.running} running` : "";
    const errors = tally.errors ? ` · ${tally.errors} errors` : "";
    const skipped = tally.skipped ? ` · ${tally.skipped} skipped` : "";
    return ` ${tally.done}/${total}${running}${errors}${skipped}`;
}
/** The first failed agent's label + short reason, or "" when nothing has failed. */
function firstFailureText(agents) {
    const failed = agents.find((agent) => agent.status === "error");
    if (!failed)
        return "";
    const reason = shorten(failed.error ?? failed.errorCode ?? "failed", 60);
    return `"${shorten(failed.label, 40)}": ${reason}`;
}
/**
 * One collapsed row per failed agent. Healthy agents fold into the per-phase
 * rollup; only failures earn an individual line, so a failure is never silent.
 * `maxAgents` caps how many failure rows show (oldest overflow summarized), and
 * `showResultPreviews` appends the agent's preview when present.
 */
function renderErrorRows(agents, maxAgents, showResultPreviews, theme, lines) {
    const failed = agents.filter((agent) => agent.status === "error");
    const shown = failed.slice(-maxAgents);
    for (const agent of shown) {
        const reason = agent.error ? ` — ${shorten(agent.error, 60)}` : "";
        const preview = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
        lines.push(theme.fg("error", `    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${reason}${preview}`));
    }
    const hidden = failed.length - shown.length;
    if (hidden > 0)
        lines.push(theme.fg("dim", `    … ${hidden} earlier failures`));
}
export function renderWorkflowLines(snapshot, options = {}, theme = NO_THEME, now = Date.now()) {
    const maxAgents = options.maxAgents ?? 8;
    const showResultPreviews = options.showResultPreviews ?? false;
    // Header suffix pieces: overall state, elapsed clock, tokens, cost.
    const state = snapshot.errorCount > 0
        ? `, ${snapshot.errorCount} errors`
        : snapshot.runningCount > 0
            ? `, ${snapshot.runningCount} running`
            : "";
    const usage = snapshot.tokenUsage;
    const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
    const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
    const tokenInfo = `${segment ? ` · ${segment}` : ""}${costInfo}`;
    // The snapshot carries no run-start stamp, so elapsed is measured from the
    // earliest agent start and stays hidden until an agent has actually begun.
    const start = earliestAgentStart(snapshot.agents);
    const elapsedInfo = start !== undefined ? ` · ${fmtDuration(now - start)}` : "";
    const lines = [
        `${theme.bold(`◆ Workflow: ${snapshot.name}`)} (${snapshot.doneCount}/${snapshot.agentCount} done${state}${elapsedInfo}${tokenInfo})`,
    ];
    // A failure is announced in red directly under the header, never left silent.
    if (snapshot.errorCount > 0) {
        lines.push(theme.fg("error", `  ✗ ${snapshot.errorCount} failed — ${firstFailureText(snapshot.agents)}`));
    }
    // Prefer the declared phase order; fall back to phases discovered on agents.
    const phaseNames = snapshot.phases.length
        ? snapshot.phases
        : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean));
    const rendered = new Set();
    for (const phase of phaseNames) {
        const agents = snapshot.agents.filter((agent) => agent.phase === phase);
        for (const agent of agents)
            rendered.add(agent);
        const tally = tallyStatuses(agents);
        const settled = tally.done + tally.errors + tally.skipped;
        const complete = agents.length > 0 && settled === agents.length;
        const active = tally.running > 0 || (!complete && snapshot.currentPhase === phase);
        const marker = active ? "▶" : complete ? "✓" : " ";
        lines.push(theme.fg("accent", `  ${marker} ${phase}`) + theme.fg("dim", rollupSuffix(agents.length, tally)));
        // Only failures break out of the rollup into their own rows.
        renderErrorRows(agents, maxAgents, showResultPreviews, theme, lines);
    }
    // Any agent not claimed by a named phase is grouped under "Unphased".
    const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
    if (unphased.length) {
        const tally = tallyStatuses(unphased);
        lines.push(theme.fg("accent", "  Unphased") + theme.fg("dim", rollupSuffix(unphased.length, tally)));
        renderErrorRows(unphased, maxAgents, showResultPreviews, theme, lines);
    }
    return lines;
}
export function renderWorkflowText(snapshot, completed = false) {
    const header = completed ? "Workflow completed" : "Workflow running";
    return [header, ...renderWorkflowLines(snapshot)].join("\n");
}
function statusLine(snapshot, completed) {
    const progress = `${snapshot.doneCount}/${snapshot.agentCount}`;
    if (completed)
        return `workflow ✓ ${snapshot.name}: ${progress}`;
    if (snapshot.runningCount > 0) {
        return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${progress} done`;
    }
    return `workflow ${snapshot.name}: ${progress} done`;
}
// ---------------------------------------------------------------------------
// Small formatting helpers
// ---------------------------------------------------------------------------
const STATUS_ICONS = {
    queued: "○",
    running: "●",
    done: "✓",
    error: "✗",
    skipped: "-",
};
export function statusIcon(status) {
    return STATUS_ICONS[status];
}
function unique(values) {
    return [...new Set(values)];
}
/** Collapse whitespace and truncate to `max`, appending "…" when clipped. */
export function shorten(value, max) {
    const text = value.replace(/\s+/g, " ").trim();
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
/** Stringify any value and truncate to `max` (default 80) with a trailing "…" when clipped. */
export function preview(value, max = 80) {
    const text = typeof value === "string" ? value : JSON.stringify(value);
    if (!text)
        return "";
    return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
