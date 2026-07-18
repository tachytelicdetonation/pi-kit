/**
 * Loop drill-in — one scheduled loop's summary, durable run history, and
 * guardrails. Enter is handled by the app and always descends to the 7a builder.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { column, spring, windowLines } from "./../chrome.js";
import { paint, PALETTE, type PaletteColor, type ThemeLike } from "./../theme.js";
import type { Loop, LoopRun } from "./../state/types.js";

const GUTTER = 2;
const OUTCOME_COL = 11;
const TIME_COL = 19;

export function renderLoopDrillInHeader(theme: ThemeLike, loop: Loop, runs: readonly LoopRun[]): string {
  const health = loop.health === "paused" && loop.pausedReason
    ? `${loop.health} · ${loop.pausedReason}`
    : loop.health;
  return paint(theme, loop.health === "paused" ? PALETTE.warning : PALETTE.dim, `${runs.length} ${runWord(runs.length)} · ${health}`);
}

export function renderLoopDrillIn(
  loop: Loop,
  runs: readonly LoopRun[],
  theme: ThemeLike,
  width: number,
  height: number,
  selection: number,
): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (w <= 0 || h <= 0) return [];

  // ── Stratum 1: loop summary ─────────────────────────────────────────────
  const summary = [summaryRow(theme, loop, runs.length, w)];

  // ── Stratum 2: durable run history ──────────────────────────────────────
  const runRows = runs.length === 0
    ? [headerLine(paint(theme, PALETTE.dim, "no runs yet"), w)]
    : runs.map((run, index) => runRow(theme, run, index === selection, w));

  // ── Stratum 3: active guardrails + isolated pending trial ───────────────
  const guardrails = [sectionLine(theme, "guardrails", w)];
  const active = loop.activeDefinition?.guardrails;
  if (active) guardrails.push(guardrailRow(theme, "active", active, false, w));
  const pending = loop.pendingDraft?.guardrails;
  if (pending && !sameGuardrails(active, pending)) {
    const label = loop.pendingDraft?.trialPassed === true
      ? "trial passed · pending schedule"
      : "pending trial";
    guardrails.push(guardrailRow(theme, label, pending, true, w));
  }

  // Summary and guardrails are fixed strata. Only the run rows consume a
  // selection-centred scrolling window, so a long history can never displace
  // the active or pending guardrail state.
  const runHeader = sectionLine(theme, "run history", w);
  const separators = h >= summary.length + guardrails.length + 4 ? 2 : 0;
  const fixedHeight = summary.length + guardrails.length + 1 + separators;
  const runHeight = Math.max(0, h - fixedHeight);
  const selected = runs.length === 0 ? 0 : Math.max(0, Math.min(runs.length - 1, selection));
  const windowedRuns = windowLines(theme, runRows, selected, runHeight, w);
  const lines = [
    ...summary,
    ...(separators ? [""] : []),
    runHeader,
    ...windowedRuns,
    ...(separators ? [""] : []),
    ...guardrails,
  ];
  if (lines.length <= h) return lines;

  // Tiny terminals may not fit even the fixed strata. Preserve their content
  // by dropping the run header first; render() performs the final unavoidable
  // clip only when the summary plus guardrails themselves exceed the viewport.
  const essentialGuardrails = guardrails.length > 1 ? guardrails.slice(1) : guardrails;
  return [...summary, ...essentialGuardrails].slice(0, h);
}

function summaryRow(theme: ThemeLike, loop: Loop, runCount: number, width: number): string {
  const parts = [`${runCount} ${runWord(runCount)}`];
  if (loop.yieldToday) parts.push(`yield today: ${loop.yieldToday}`);
  if (loop.costToday) parts.push(`cost today: ${loop.costToday}`);
  if (loop.lastFired) parts.push(`last fired: ${loop.lastFired}`);
  if (loop.nextRun) parts.push(`next run: ${loop.nextRun}`);
  return headerLine(paint(theme, PALETTE.mid, parts.join(" · ")), width);
}

function runRow(theme: ThemeLike, run: LoopRun, selected: boolean, width: number): string {
  const status = outcomeStatus(run.outcome);
  const outcome = paint(theme, status.color, column(`${status.marker} ${run.outcome}`, OUTCOME_COL));
  const time = paint(theme, PALETTE.dim, column(formatTimestamp(run.timestamp), TIME_COL));
  const left = `${outcome} ${time} ${paint(theme, PALETTE.mid, run.summary)}`;
  const right = run.cost ? paint(theme, PALETTE.label, run.cost) : "";
  const marker = selected ? `${paint(theme, PALETTE.brand, "▌")} ` : "  ";
  return truncateToWidth(`${marker}${spring(theme, left, right, Math.max(0, width - GUTTER))}`, width, "");
}

function guardrailRow(
  theme: ThemeLike,
  label: string,
  guardrails: readonly string[],
  pending: boolean,
  width: number,
): string {
  const labelColor = pending ? PALETTE.warning : PALETTE.label;
  const chips = guardrails.map((guardrail) => paint(theme, PALETTE.mid, guardrail)).join(` ${paint(theme, PALETTE.dim, "·")} `);
  const labelWidth = Math.max(15, label.length + 1);
  return headerLine(`${paint(theme, labelColor, column(label, labelWidth))}${chips}`, width);
}

function outcomeStatus(outcome: LoopRun["outcome"]): { marker: string; color: PaletteColor } {
  switch (outcome) {
    case "success":
      return { marker: "✓", color: PALETTE.success };
    case "failure":
      return { marker: "✗", color: PALETTE.error };
    case "trial":
      return { marker: "◇", color: PALETTE.warning };
  }
}

function formatTimestamp(timestamp: string): string {
  const match = timestamp.match(/^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/);
  return match ? `${match[1]} ${match[2]}Z` : timestamp;
}

function sameGuardrails(active: readonly string[] | undefined, pending: readonly string[]): boolean {
  if (!active || active.length !== pending.length) return false;
  const sortedActive = [...active].sort();
  const sortedPending = [...pending].sort();
  return sortedActive.every((guardrail, index) => guardrail === sortedPending[index]);
}

function runWord(count: number): string {
  return count === 1 ? "run" : "runs";
}

function sectionLine(theme: ThemeLike, label: string, width: number): string {
  return headerLine(paint(theme, PALETTE.label, label), width);
}

function headerLine(content: string, width: number): string {
  return truncateToWidth(`  ${content}`, width, "");
}
