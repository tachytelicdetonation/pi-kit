/**
 * 7d — Goal closeout. When a goal lands: the RECEIPT, and what pi LEARNED. PURE
 * render of
 *   1. the big receipt: `N/N <unit>  +added −removed · commits · green …spring…
 *      $actual (est was ~$N)`;
 *   2. three rows — `your time` (decisions + attention), `interventions`,
 *      `overrun why`;
 *   3. the proposed `precedents` (SAME store as 7b), NUMBERED — DECLINED ones are
 *      already filtered out upstream, so they are never re-proposed;
 *   4. the action line `a apply precedents · r full report · x archive` (replaced by
 *      a confirmation once applied), and an optional dim "next:" nudge.
 *
 * The app chrome supplies the header (`pi · goal complete · <name> …spring… started
 * … · landed …`) and the fleet footer. Every line is ANSI-safe and clipped to at
 * most `height` via windowLines.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { actionGroup, column, spring, windowLines, wrapPlain } from "./../chrome.js";
import { paint, PALETTE, type ThemeLike } from "./../theme.js";
import type { Closeout } from "./../state/types.js";

/** Left gutter (2 cells) so the receipt aligns with the other screens. */
const INDENT = "  ";
/** The `your time / interventions / overrun why` label column width. */
const LABEL_COL = 13;

/** View flags: whether the precedents have been applied this session. */
export interface CloseoutView {
  applied?: boolean;
}

export function renderCloseout(
  closeout: Closeout,
  theme: ThemeLike,
  width: number,
  height: number,
  view: CloseoutView = {},
): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (w <= 0 || h <= 0) return [];

  const lines: string[] = [];

  // ── (1) the big receipt line ─────────────────────────────────────────────
  lines.push(receiptLine(theme, closeout, w));
  lines.push("");

  // ── (2) the three summary rows ───────────────────────────────────────────
  pushRow(lines, theme, "your time", closeout.yourTime, w);
  pushRow(lines, theme, "interventions", closeout.interventions, w);
  pushRow(lines, theme, "overrun why", closeout.overrunWhy, w);
  lines.push("");

  // ── (3) proposed precedents, NUMBERED ────────────────────────────────────
  lines.push(
    clip(`${paint(theme, PALETTE.label, "precedents")} ${paint(theme, PALETTE.dim, "· proposed for CLAUDE.md / skills")}`, w),
  );
  closeout.proposedPrecedents.forEach((precedent, index) => {
    const num = paint(theme, PALETTE.dim, String(index + 1));
    const text = precedent.decision
      ? `${precedent.question} → ${precedent.decision}`
      : precedent.question;
    const textWidth = Math.max(1, w - INDENT.length - 4);
    const segments = wrapPlain(text, textWidth);
    segments.forEach((segment, segIndex) => {
      const lead = segIndex === 0 ? `  ${num}  ` : "     ";
      lines.push(clip(`${lead}${paint(theme, PALETTE.primary, segment)}`, w));
    });
  });
  lines.push("");

  // ── (4) the action line (or applied confirmation) + the next nudge ───────
  if (view.applied) {
    lines.push(
      clip(`${paint(theme, PALETTE.success, "✓")} ${paint(theme, PALETTE.dim, "precedents handed off for repository guidance")}`, w),
    );
  } else {
    lines.push(actionLine(theme, w));
  }
  if (closeout.nextSuggestion) {
    lines.push(clip(`${paint(theme, PALETTE.dim, "next:")} ${paint(theme, PALETTE.mid, closeout.nextSuggestion)}`, w));
  }

  return windowLines(theme, lines, 0, h, w);
}

/**
 * `N/N <unit>  +added −removed · commits · green …spring… $actual (est was ~$N)`.
 * The count is bright; added is green, removed is red; the cost detail is dim.
 */
function receiptLine(theme: ThemeLike, c: Closeout, width: number): string {
  const count = paint(theme, PALETTE.bright, `${c.packagesDone}/${c.packagesTotal} ${c.unit}`);
  const dot = ` ${paint(theme, PALETTE.dim, "·")} `;
  const stats =
    `${paint(theme, PALETTE.success, c.addedText)} ${paint(theme, PALETTE.error, c.removedText)}` +
    `${dot}${paint(theme, PALETTE.mid, c.commitsText)}${dot}${paint(theme, PALETTE.success, c.greenText)}`;
  const left = `${count}   ${stats}`;
  const right = `${paint(theme, PALETTE.primary, c.actualCost)} ${paint(theme, PALETTE.dim, `(est was ${c.estCost})`)}`;
  return truncateToWidth(`${INDENT}${spring(theme, left, right, Math.max(0, width - INDENT.length))}`, width, "");
}

/** `  <label>  <value>` — a summary row with a hanging indent for wraps. */
function pushRow(lines: string[], theme: ThemeLike, label: string, value: string, width: number): void {
  const textWidth = Math.max(1, width - INDENT.length - LABEL_COL - 1);
  const segments = wrapPlain(value, textWidth);
  segments.forEach((segment, index) => {
    const left =
      index === 0
        ? `${paint(theme, PALETTE.dim, column(label, LABEL_COL))} `
        : column("", LABEL_COL + 1);
    lines.push(clip(`${left}${paint(theme, PALETTE.mid, segment)}`, width));
  });
}

/** `a apply precedents · r full report · x archive`. */
function actionLine(theme: ThemeLike, width: number): string {
  const key = (k: string, label: string) => `${paint(theme, PALETTE.brand, k)} ${paint(theme, PALETTE.dim, label)}`;
  return clip(
    actionGroup(
      theme,
      [key("a", "apply precedents"), key("r", "full report"), key("x", "archive")],
      Math.max(0, width - INDENT.length),
    ),
    width,
  );
}

/** A left-indented, ANSI-safe line clipped to width. */
function clip(content: string, width: number): string {
  return truncateToWidth(`${INDENT}${content}`, width, "");
}
