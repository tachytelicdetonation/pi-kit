import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AgentUsage } from "./agent.js";
import type { AgentHistoryEntry } from "./agent-history.js";
import type { WorkflowErrorCode } from "./errors.js";
import type { WorkflowMeta } from "./workflow.js";

export type WorkflowAgentStatus = "queued" | "running" | "done" | "error" | "skipped";

export interface WorkflowAgentSnapshot {
  id: number;
  label: string;
  phase?: string;
  prompt: string;
  status: WorkflowAgentStatus;
  resultPreview?: string;
  error?: string;
  errorCode?: WorkflowErrorCode;
  recoverable?: boolean;
  history?: AgentHistoryEntry[];
  /** Tokens used by this agent (a scalar estimate when the provider reports no usage). */
  tokens?: number;
  /** Per-agent token usage breakdown (fresh input+output vs cached), when known. */
  tokenUsage?: AgentUsage;
  /** The model this agent ran on (provider/id), when known. */
  model?: string;
  /** Epoch ms when this agent first transitioned to "running" (liveness/elapsed). */
  startedAt?: number;
  /** Epoch ms of the last observed event for this agent (per-agent stall signal). */
  lastEventAt?: number;
}

export interface WorkflowSnapshot {
  name: string;
  description?: string;
  phases: string[];
  currentPhase?: string;
  logs: string[];
  agents: WorkflowAgentSnapshot[];
  agentCount: number;
  runningCount: number;
  doneCount: number;
  errorCount: number;
  durationMs?: number;
  result?: unknown;
  tokenUsage?: {
    input: number;
    output: number;
    total: number;
    cost?: number;
    cacheRead?: number;
    cacheWrite?: number;
  };
  runId?: string;
  /** checkpoint() gates auto-approved headlessly so far (no human was asked). */
  autoCheckpointCount?: number;
}

export interface WorkflowDisplay {
  update(snapshot: WorkflowSnapshot): void;
  complete(snapshot: WorkflowSnapshot): void;
  clear(): void;
}

export interface WorkflowDisplayOptions {
  key?: string;
  placement?: "aboveEditor" | "belowEditor";
  maxAgents?: number;
  showStatus?: boolean;
  showResultPreviews?: boolean;
}

/**
 * Displayable fresh/cached figures from a usage breakdown and/or a scalar
 * estimate. The token pipeline has two sources that don't always agree: the
 * provider-reported breakdown (input/output/cacheRead/cacheWrite) and a scalar
 * estimate (`total` at run level, `tokens` per agent) that keeps accruing even
 * when the provider reports nothing. Two rules:
 * - `fresh` counts input+output+cacheWrite: cache writes are first-time
 *   ingestion billed at full (or premium) price, so hiding them would
 *   under-report real spend; only cacheRead is the cheap reuse shown apart.
 * - `fresh` is never less than what the estimate can account for after
 *   removing cache reads, so estimate-only providers, cost-only providers
 *   (billed but zero token counts), and mixed runs keep the count the display
 *   showed before the split existed, instead of a false "0 tok".
 */
export function tokenFigures(
  usage: Partial<AgentUsage> | undefined,
  scalarTokens?: number,
): { fresh: number; cacheRead: number } {
  const cacheRead = usage?.cacheRead ?? 0;
  const reported = (usage?.input ?? 0) + (usage?.output ?? 0) + (usage?.cacheWrite ?? 0);
  const estimate = Math.max(scalarTokens ?? 0, usage?.total ?? 0);
  return { fresh: Math.max(reported, estimate - cacheRead), cacheRead };
}

/** Sum a set of agents into fresh vs cacheRead token totals plus real cost, via {@link tokenFigures}. */
export function aggregateAgentUsage(agents: ReadonlyArray<Pick<WorkflowAgentSnapshot, "tokens" | "tokenUsage">>): {
  fresh: number;
  cacheRead: number;
  cost: number;
} {
  let fresh = 0;
  let cacheRead = 0;
  let cost = 0;
  for (const a of agents) {
    const f = tokenFigures(a.tokenUsage, a.tokens);
    fresh += f.fresh;
    cacheRead += f.cacheRead;
    cost += a.tokenUsage?.cost ?? 0;
  }
  return { fresh, cacheRead, cost };
}

/**
 * Format a token count for a display surface: "12.4K tok" on its own, or
 * "89K tok · 3.0M cached" when there were cache reads. The cache segment is shown
 * only when `cacheRead > 0`, so a non-caching provider (or a single-turn agent that
 * never re-reads its cache) reads as a plain "tok" rather than a bare, contextless
 * "fresh". `fmt` adapts the number style per surface (compact in panels, full in
 * the print view).
 */
export function fmtTokenCount(fresh: number, cacheRead: number, fmt: (n: number) => string): string {
  const f = fmt(fresh) || "0";
  return cacheRead > 0 ? `${f} tok · ${fmt(cacheRead)} cached` : `${f} tok`;
}

/**
 * Like {@link fmtTokenCount}, but "" when nothing is known yet (both figures 0),
 * so surfaces omit the segment instead of rendering a false "0 tok" — e.g. for a
 * journal-replayed resume or a run whose agents were all skipped. Every surface
 * should use this rather than re-implementing the zero guard.
 */
export function fmtTokenSegment(figures: { fresh: number; cacheRead: number }, fmt: (n: number) => string): string {
  return figures.fresh + figures.cacheRead > 0 ? fmtTokenCount(figures.fresh, figures.cacheRead, fmt) : "";
}

/**
 * "$1.23" from one cent up, four decimals below it, and "<$0.0001" for
 * anything smaller — a real cost never rounds to a zero-looking "$0.00".
 */
export function fmtCost(cost: number): string {
  if (cost > 0 && cost < 0.0001) return "<$0.0001";
  return `$${cost.toFixed(cost >= 0.01 ? 2 : 4)}`;
}

/** Full (non-compact) number style for print/text surfaces: locale-grouped digits. */
export const fmtFull = (n: number): string => n.toLocaleString();

/** Wall-clock elapsed as a compact stopwatch: "42s", "3m12s", "1h05m". */
export function fmtDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h${String(m % 60).padStart(2, "0")}m`;
}

/** Earliest per-agent start time in a snapshot, or undefined when none stamped. */
function earliestAgentStart(agents: ReadonlyArray<Pick<WorkflowAgentSnapshot, "startedAt">>): number | undefined {
  let min: number | undefined;
  for (const a of agents) {
    if (typeof a.startedAt === "number" && (min === undefined || a.startedAt < min)) min = a.startedAt;
  }
  return min;
}

export function createWorkflowSnapshot(meta: WorkflowMeta): WorkflowSnapshot {
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

export function recomputeWorkflowSnapshot(snapshot: WorkflowSnapshot): WorkflowSnapshot {
  const runningCount = snapshot.agents.filter((agent) => agent.status === "running").length;
  const doneCount = snapshot.agents.filter((agent) => agent.status === "done").length;
  const errorCount = snapshot.agents.filter((agent) => agent.status === "error").length;
  return { ...snapshot, agentCount: snapshot.agents.length, runningCount, doneCount, errorCount };
}

export function createWidgetWorkflowDisplay(
  ctx: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions = {},
): WorkflowDisplay {
  const key = options.key ?? "workflow";
  const placement = options.placement ?? "belowEditor";
  const showStatus = options.showStatus ?? false;

  // Mutable state captured by the component closure so re-renders
  // always read the latest snapshot even though the factory ran once.
  let snapshot: WorkflowSnapshot | undefined;
  let completed = false;

  // Store the factory so update()/complete() can re-register it to trigger re-render.
  const widgetFactory = (_tui: unknown, theme: Theme) => ({
    render: () => (snapshot ? renderWorkflowLines(snapshot, options, theme) : []),
    invalidate: () => {},
  });

  if (ctx.hasUI) {
    ctx.ui.setWidget(key, widgetFactory, { placement });
  }

  return {
    update(s) {
      snapshot = s;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, completed));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    complete(s) {
      snapshot = s;
      completed = true;
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, statusLine(s, true));
      ctx.ui.setWidget(key, widgetFactory, { placement });
    },
    clear() {
      if (!ctx.hasUI) return;
      if (showStatus) ctx.ui.setStatus(key, undefined);
      ctx.ui.setWidget(key, undefined);
    },
  };
}

export function createToolUpdateWorkflowDisplay(
  onUpdate: ((result: { content: Array<{ type: "text"; text: string }>; details: unknown }) => void) | undefined,
  ctx?: Pick<ExtensionContext, "ui" | "hasUI">,
  options: WorkflowDisplayOptions & { streamToolUpdates?: boolean } = {},
): WorkflowDisplay {
  const widget = ctx ? createWidgetWorkflowDisplay(ctx, options) : undefined;
  const streamToolUpdates = options.streamToolUpdates ?? !ctx?.hasUI;

  const emit = (snapshot: WorkflowSnapshot, completed = false) => {
    if (streamToolUpdates) {
      onUpdate?.({
        content: [{ type: "text", text: renderWorkflowText(snapshot, completed) }],
        details: snapshot,
      });
    }
    if (completed) widget?.complete(snapshot);
    else widget?.update(snapshot);
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

/** Minimal theme surface so rendering works without a real Theme (tool output, tests). */
export interface ThemeLike {
  fg(color: string, text: string): string;
  bold(text: string): string;
}

/** Identity passthrough for contexts where no theme is available (tool text output). */
const NO_THEME: ThemeLike = { fg: (_c, t) => t, bold: (t) => t };

/** The first failed agent's label + short error, or "" when nothing failed yet. */
function firstFailureText(agents: ReadonlyArray<WorkflowAgentSnapshot>): string {
  const failed = agents.find((a) => a.status === "error");
  if (!failed) return "";
  const why = shorten(failed.error ?? failed.errorCode ?? "failed", 60);
  return `"${shorten(failed.label, 40)}": ${why}`;
}

/**
 * One collapsed error row per failed agent (the DEFAULT roster is the per-phase
 * rollup — only failures get an individual line so they are never silent).
 * Honors `maxAgents` (caps the error rows) and `showResultPreviews`.
 */
function renderErrorRows(
  agents: ReadonlyArray<WorkflowAgentSnapshot>,
  maxAgents: number,
  showResultPreviews: boolean,
  theme: ThemeLike,
  lines: string[],
): void {
  const failed = agents.filter((a) => a.status === "error");
  const visible = failed.slice(-maxAgents);
  for (const agent of visible) {
    const why = agent.error ? ` — ${shorten(agent.error, 60)}` : "";
    const result = showResultPreviews && agent.resultPreview ? ` — ${agent.resultPreview}` : "";
    lines.push(
      theme.fg("error", `    [${agent.id}] ${statusIcon(agent.status)} ${shorten(agent.label, 48)}${why}${result}`),
    );
  }
  if (failed.length > visible.length)
    lines.push(theme.fg("dim", `    … ${failed.length - visible.length} earlier failures`));
}

export function renderWorkflowLines(
  snapshot: WorkflowSnapshot,
  options: WorkflowDisplayOptions = {},
  theme: ThemeLike = NO_THEME,
  now: number = Date.now(),
): string[] {
  const maxAgents = options.maxAgents ?? 8;
  const showResultPreviews = options.showResultPreviews ?? false;
  const state =
    snapshot.errorCount > 0
      ? `, ${snapshot.errorCount} errors`
      : snapshot.runningCount > 0
        ? `, ${snapshot.runningCount} running`
        : "";
  // Build header with token info (and cost when the provider reports it)
  const usage = snapshot.tokenUsage;
  const costInfo = usage?.cost ? ` · ${fmtCost(usage.cost)}` : "";
  const segment = fmtTokenSegment(tokenFigures(usage), fmtFull);
  const tokenInfo = `${segment ? ` · ${segment}` : ""}${costInfo}`;
  // Wall-clock elapsed, derived from the earliest agent start (the snapshot has no
  // run-start stamp of its own). Omitted until at least one agent has started.
  const start = earliestAgentStart(snapshot.agents);
  const elapsedInfo = start !== undefined ? ` · ${fmtDuration(now - start)}` : "";
  const lines = [
    `${theme.bold(`◆ Workflow: ${snapshot.name}`)} (${snapshot.doneCount}/${snapshot.agentCount} done${state}${elapsedInfo}${tokenInfo})`,
  ];

  // Failures must never be silent: name the first one in red right under the header.
  if (snapshot.errorCount > 0) {
    lines.push(theme.fg("error", `  ✗ ${snapshot.errorCount} failed — ${firstFailureText(snapshot.agents)}`));
  }

  const phaseNames = snapshot.phases.length
    ? snapshot.phases
    : unique(snapshot.agents.map((agent) => agent.phase).filter(Boolean) as string[]);
  const rendered = new Set<WorkflowAgentSnapshot>();

  for (const phase of phaseNames) {
    const agents = snapshot.agents.filter((agent) => agent.phase === phase);
    for (const agent of agents) rendered.add(agent);
    const done = agents.filter((agent) => agent.status === "done").length;
    const running = agents.filter((agent) => agent.status === "running").length;
    const errors = agents.filter((agent) => agent.status === "error").length;
    const skipped = agents.filter((agent) => agent.status === "skipped").length;
    const complete = agents.length > 0 && done + errors + skipped === agents.length;
    const marker = running > 0 || (!complete && snapshot.currentPhase === phase) ? "▶" : complete ? "✓" : " ";
    lines.push(
      theme.fg("accent", `  ${marker} ${phase}`) +
        theme.fg(
          "dim",
          ` ${done}/${agents.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
        ),
    );
    // Healthy agents collapse into the rollup above; only failures get a row.
    renderErrorRows(agents, maxAgents, showResultPreviews, theme, lines);
  }

  const unphased = snapshot.agents.filter((agent) => !rendered.has(agent));
  if (unphased.length) {
    const done = unphased.filter((a) => a.status === "done").length;
    const running = unphased.filter((a) => a.status === "running").length;
    const errors = unphased.filter((a) => a.status === "error").length;
    const skipped = unphased.filter((a) => a.status === "skipped").length;
    lines.push(
      theme.fg("accent", "  Unphased") +
        theme.fg(
          "dim",
          ` ${done}/${unphased.length}${running ? ` · ${running} running` : ""}${errors ? ` · ${errors} errors` : ""}${skipped ? ` · ${skipped} skipped` : ""}`,
        ),
    );
    renderErrorRows(unphased, maxAgents, showResultPreviews, theme, lines);
  }

  return lines;
}

export function renderWorkflowText(snapshot: WorkflowSnapshot, completed = false): string {
  const header = completed ? "Workflow completed" : "Workflow running";
  return [header, ...renderWorkflowLines(snapshot)].join("\n");
}

function statusLine(snapshot: WorkflowSnapshot, completed: boolean): string {
  if (completed) return `workflow ✓ ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount}`;
  if (snapshot.runningCount > 0)
    return `workflow ${snapshot.name}: ${snapshot.runningCount} running, ${snapshot.doneCount}/${snapshot.agentCount} done`;
  return `workflow ${snapshot.name}: ${snapshot.doneCount}/${snapshot.agentCount} done`;
}

export function statusIcon(status: WorkflowAgentStatus): string {
  switch (status) {
    case "queued":
      return "○";
    case "running":
      return "●";
    case "done":
      return "✓";
    case "error":
      return "✗";
    case "skipped":
      return "-";
  }
}

function unique(values: string[]): string[] {
  return [...new Set(values)];
}

export function shorten(value: string, max: number): string {
  const text = value.replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

export function preview(value: unknown, max = 80): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}
