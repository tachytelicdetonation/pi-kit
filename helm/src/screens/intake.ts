/**
 * 6a — Intent intake. A plain conversation, ZERO agents until "go": PURE render of
 *   1. the operator's goal request, echoed as a `❯` line;
 *   2. pi's un-inferable questions, NUMBERED (pi asks nothing it can infer);
 *   3. an optional operator reply line (`❯`);
 *   4. a PLAN block — one line per workflow (`name  description`, purple model tag
 *      when the workflow's model differs from the default);
 *   5. the estimate + escalation-rule line with the action group
 *      `g go · e edit plan · x discard`, where `g go` renders DIM/disabled while pi
 *      still has open questions (locking intent is a no-op until they are answered).
 *
 * The app chrome supplies the header (`pi · new goal …spring… draft · nothing
 * running`) and the fleet footer. Every line is ANSI-safe and clipped to at most
 * `height` via windowLines (anchored at the top so the request + questions stay
 * visible).
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { column, spring, windowLines, wrapPlain } from "./../chrome.js";
import { GLYPH, paint, PALETTE, type ThemeLike } from "./../theme.js";
import type { IntakeDraft } from "./../state/types.js";

/** Left gutter (2 cells) so the card aligns with the other screens. */
const INDENT = "  ";
/** Name column for the plan workflow rows. */
const PLAN_COL = 16;

export function renderIntake(draft: IntakeDraft, theme: ThemeLike, width: number, height: number): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (w <= 0 || h <= 0) return [];

  const lines: string[] = [];
  const inner = Math.max(1, w - INDENT.length);

  // ── (1) the goal request, echoed ─────────────────────────────────────────
  lines.push(promptEcho(theme, draft.goalPrompt, w));
  lines.push("");

  // ── (2) numbered, un-inferable questions ─────────────────────────────────
  for (const segment of wrapPlain(draft.preamble, inner)) {
    lines.push(clip(paint(theme, PALETTE.primary, segment), w));
  }
  draft.questions.forEach((question, index) => {
    const num = paint(theme, PALETTE.dim, String(index + 1));
    // Hang wrapped continuations under the question text (past the number column).
    const textWidth = Math.max(1, inner - 4);
    const segments = wrapPlain(question, textWidth);
    segments.forEach((segment, segIndex) => {
      const lead = segIndex === 0 ? `  ${num} ` : "    ";
      lines.push(clip(`${lead}${paint(theme, PALETTE.mid, segment)}`, w));
    });
  });
  lines.push("");

  // ── (3) optional operator reply ──────────────────────────────────────────
  if (draft.userReply) {
    lines.push(promptEcho(theme, draft.userReply, w));
    lines.push("");
  }

  // ── (4) the PLAN block — one line per workflow ───────────────────────────
  const planHead =
    `${paint(theme, PALETTE.label, "plan")} ${paint(theme, PALETTE.dim, `· ${draft.planWorkflows.length} workflows`)}`;
  lines.push(clip(planHead, w));
  for (const workflow of draft.planWorkflows) {
    lines.push(planRow(theme, workflow.name, workflow.description, workflow.modelTag, w));
  }
  lines.push("");

  // ── (5) estimate + escalation rule + the action group ────────────────────
  lines.push(actionLine(theme, draft, w));

  return windowLines(theme, lines, 0, h, w);
}

/** `❯ <text>` — the caret in the input-border tier, the text primary. */
function promptEcho(theme: ThemeLike, text: string, width: number): string {
  const caret = paint(theme, PALETTE.inputBorder, GLYPH.prompt);
  return clip(`${caret} ${paint(theme, PALETTE.primary, text)}`, width);
}

/** `  <name>  <description>  · <purple model>` — a single plan-workflow line.
 * The purple model tag is budgeted first so it survives narrow widths (only the
 * description is truncated), per the spec's "purple model tag if non-default". */
function planRow(theme: ThemeLike, name: string, description: string, modelTag: string | undefined, width: number): string {
  const tag = modelTag ? ` ${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.purple, modelTag)}` : "";
  const head = `  ${paint(theme, PALETTE.bright, column(name, PLAN_COL))}${paint(theme, PALETTE.mid, description)}`;
  return `${truncateToWidth(head, Math.max(0, width - visibleWidth(tag)), "…")}${tag}`;
}

/**
 * `est <wall> · <cost> · <escalation rule> …spring… g go · e edit plan · x discard`.
 * `g go` is faint/disabled while open questions remain.
 */
function actionLine(theme: ThemeLike, draft: IntakeDraft, width: number): string {
  const dot = ` ${paint(theme, PALETTE.dim, "·")} `;
  const left =
    `${paint(theme, PALETTE.dim, "est")} ${paint(theme, PALETTE.label, draft.estWall)}` +
    `${dot}${paint(theme, PALETTE.label, draft.estCost)}` +
    `${dot}${paint(theme, PALETTE.mid, draft.escalationRule)}`;
  const goKey = draft.openQuestions
    ? `${paint(theme, PALETTE.faint, "g")} ${paint(theme, PALETTE.faint, "go")}`
    : `${paint(theme, PALETTE.brand, "g")} ${paint(theme, PALETTE.dim, "go")}`;
  const right =
    `${goKey}${dot}${paint(theme, PALETTE.brand, "e")} ${paint(theme, PALETTE.dim, "edit plan")}` +
    `${dot}${paint(theme, PALETTE.brand, "x")} ${paint(theme, PALETTE.dim, "discard")}`;
  return truncateToWidth(`${INDENT}${spring(theme, left, right, Math.max(0, width - INDENT.length))}`, width, "");
}

/** A left-indented, ANSI-safe line clipped to width. */
function clip(content: string, width: number): string {
  return truncateToWidth(`${INDENT}${content}`, width, "");
}
