/**
 * 6c — Workflow drill-in. PURE render of one lane's internal pipelines:
 *   1. work-queue burn-down: a big remaining count + `imports left · from … ·
 *      burn …/hr · done …`, with the queue note on the right.
 *   2. worktree rows (selectable): `wt-N | package | fix→review→apply chips |
 *      …spring… applied · test-state`. One {@link GLYPH.chip} per agent, grouped
 *      by stage (fix=warning, review=purple, apply=success).
 *   3. race-to-green strips: per package, a row of {@link GLYPH.tick} ticks
 *      (red/green per test run) + a right status (`✓ time` / `wobbling` / `red`).
 *
 * The word "loops" NEVER appears here — internal pipelines are "lanes" (that word
 * is reserved for 6b background loops). Every line is ANSI-safe and clipped to at
 * most `height`, appending a "… N more" hint on overflow. `selection` highlights
 * the current worktree row (index into `detail.worktrees`).
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { column, spring, windowLines } from "./../chrome.js";
import { GLYPH, paint, PALETTE, type PaletteColor, type ThemeLike } from "./../theme.js";
import type { Worktree, WorkflowDetail } from "./../state/types.js";

/** Left column widths (chosen to match the mock's alignment). */
const WT_COL = 6;
const PKG_COL = 10;
/** Left gutter (2 cells): a selection marker or blank, keeping rows aligned. */
const GUTTER = 2;

/** Screen-local model context; shared state remains unchanged. */
export interface DrillInRenderModel extends WorkflowDetail {
  sessionModel?: string;
}

/** Header right-side counts for the app chrome: `N lanes × N worktrees · N agents`. */
export function renderDrillInCounts(theme: ThemeLike, detail: WorkflowDetail): string {
  const text = `${detail.lanes} lanes × ${detail.worktrees.length} worktrees · ${detail.agents} agents`;
  return paint(theme, PALETTE.dim, text);
}

/** Stage → chip color. fix=warning (yellow), review=purple, apply=success (green). */
function chipColor(stage: Worktree["chips"][number]["stage"]): PaletteColor {
  switch (stage) {
    case "fix":
      return PALETTE.warning;
    case "review":
      return PALETTE.purple;
    case "apply":
      return PALETTE.success;
  }
}

/** Test-state → { glyph, word, color } for a worktree row / race strip status. */
function testStateStatus(state: "green" | "wobbling" | "red"): { glyph: string; word: string; color: PaletteColor } {
  switch (state) {
    case "green":
      return { glyph: "✓", word: "green", color: PALETTE.success };
    case "wobbling":
      return { glyph: "", word: "wobbling", color: PALETTE.warning };
    case "red":
      return { glyph: "", word: "red", color: PALETTE.error };
  }
}

export function renderDrillIn(
  detail: DrillInRenderModel,
  theme: ThemeLike,
  width: number,
  height: number,
  selection: number,
): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (w <= 0 || h <= 0) return [];

  const lines: string[] = [];

  // ── Stratum 1: work-queue burn-down ─────────────────────────────────────
  lines.push(burnDownRow(theme, detail, w));
  lines.push("");

  // ── Stratum 2: worktree rows ────────────────────────────────────────────
  lines.push(
    headerLine(
      `${paint(theme, PALETTE.label, "worktrees")} ${paint(theme, PALETTE.mid, "fix → review → apply")} ${paint(theme, PALETTE.dim, "(each chip = one agent)")}`,
      w,
    ),
  );
  // Record the body-line index of the selected worktree so windowing can keep it
  // visible even when the strata below push it past a short terminal's fold.
  let anchor = 0;
  detail.worktrees.forEach((worktree, index) => {
    if (index === selection) anchor = lines.length;
    lines.push(worktreeRow(theme, worktree, detail.sessionModel, index === selection, w));
  });
  lines.push("");

  // ── Stratum 3: race-to-green strips ─────────────────────────────────────
  const withTicks = detail.worktrees.filter((worktree) => worktree.testTicks.length > 0);
  if (withTicks.length > 0) {
    lines.push(
      headerLine(
        `${paint(theme, PALETTE.label, "race to green, by package")} ${paint(theme, PALETTE.dim, "(each tick = a test run)")}`,
        w,
      ),
    );
    for (const worktree of withTicks) lines.push(raceRow(theme, worktree, w));
    lines.push("");
  }

  // ── Footer note ─────────────────────────────────────────────────────────
  lines.push(
    headerLine(
      paint(theme, PALETTE.dim, "no read/edit/bash here either — enter on a worktree opens its session view (4a)"),
      w,
    ),
  );

  return windowLines(theme, lines, anchor, h, w);
}

/** The big remaining count + `<unit> left · from N · burn N/hr · done ETA`. */
function burnDownRow(theme: ThemeLike, detail: WorkflowDetail, width: number): string {
  const count = paint(theme, PALETTE.bright, formatCount(detail.queueRemaining));
  const tail =
    `${paint(theme, PALETTE.label, `${detail.queueUnit} left`)}` +
    ` ${paint(theme, PALETTE.dim, `· from ${formatCount(detail.queueTotal)} · burn ${detail.burnPerHr}/hr · done ${detail.etaText}`)}`;
  const left = `${count} ${tail}`;
  const right = detail.queueNote ? paint(theme, PALETTE.dim, detail.queueNote) : "";
  return truncateToWidth(`  ${spring(theme, left, right, Math.max(0, width - GUTTER))}`, width, "");
}

/** `wt-N | package | fix→review→apply chips | …spring… applied · test-state`. */
function worktreeRow(
  theme: ThemeLike,
  worktree: Worktree,
  sessionModel: string | undefined,
  isSelected: boolean,
  width: number,
): string {
  const name = paint(theme, PALETTE.primary, column(worktree.name, WT_COL));
  const pkg = paint(theme, PALETTE.mid, column(worktree.package, PKG_COL));
  const chips = renderChips(theme, worktree);
  const tag = worktree.modelTag && worktree.modelTag !== sessionModel
    ? ` ${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.purple, worktree.modelTag)}`
    : "";
  const left = `${name}  ${pkg}  ${chips}${tag}`;

  const status = testStateStatus(worktree.testState);
  const glyph = status.glyph ? `${paint(theme, status.color, status.glyph)} ` : "";
  const time = worktree.statusTime ? ` ${worktree.statusTime}` : "";
  const right = `${paint(theme, PALETTE.label, worktree.appliedText)} ${paint(theme, PALETTE.dim, "·")} ${glyph}${paint(theme, status.color, `${status.word}${time}`)}`;

  return selectableRow(theme, left, right, isSelected, width);
}

/** Chips grouped by stage: `▪ → ▪▪ → ▪`, arrows dim, each chip in its stage color. */
function renderChips(theme: ThemeLike, worktree: Worktree): string {
  const stages: Worktree["chips"][number]["stage"][] = ["fix", "review", "apply"];
  const groups = stages.map((stage) => {
    const count = worktree.chips.filter((chip) => chip.stage === stage).length;
    return paint(theme, chipColor(stage), GLYPH.chip.repeat(count));
  });
  const arrow = ` ${paint(theme, PALETTE.dim, "→")} `;
  return groups.join(arrow);
}

/** `package | ▊▊▊… ticks | …spring… ✓ time / wobbling / red`. */
function raceRow(theme: ThemeLike, worktree: Worktree, width: number): string {
  const pkg = paint(theme, PALETTE.mid, column(worktree.package, PKG_COL));
  const ticks = worktree.testTicks
    .map((tick) => paint(theme, tick === "green" ? PALETTE.success : PALETTE.error, GLYPH.tick))
    .join("");
  const left = `${pkg}  ${ticks}`;

  const state = worktree.raceStatus ?? worktree.testState;
  const status = testStateStatus(state);
  const glyph = status.glyph ? `${paint(theme, status.color, status.glyph)} ` : "";
  const time = worktree.raceTime ? ` ${worktree.raceTime}` : "";
  // The race STRIP's enumerated forms are `✓ time` / `wobbling` / `red`: for a
  // green run the ✓ glyph already carries the meaning, so drop the "green" word
  // (the worktree ROW keeps it). Wobbling / red have no glyph, so the word stays.
  const word = state === "green" ? "" : status.word;
  const right = `${glyph}${paint(theme, status.color, `${word}${time}`.trim())}`;

  return truncateToWidth(`  ${spring(theme, left, right, Math.max(0, width - GUTTER))}`, width, "");
}

/** A non-selectable section/note header: 2-space gutter, then content. */
function headerLine(content: string, width: number): string {
  return truncateToWidth(`  ${content}`, width, "");
}

/** Compose a selectable row: [marker gutter][spring(left, right, width-gutter)]. */
function selectableRow(theme: ThemeLike, left: string, right: string, isSelected: boolean, width: number): string {
  const marker = isSelected ? `${paint(theme, PALETTE.brand, "▌")} ` : "  ";
  const inner = spring(theme, left, right, Math.max(0, width - GUTTER));
  return truncateToWidth(`${marker}${inner}`, width, "");
}

/** Group a whole number with thousands commas, e.g. 16000 → "16,000". */
function formatCount(value: number): string {
  const safe = Number.isFinite(value) ? Math.round(value) : 0;
  return safe.toLocaleString("en-US");
}
