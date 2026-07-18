/**
 * 7b — Escalation card. A decision, pre-chewed. PURE render of one needs-you item:
 *   1. a ONE-sentence problem statement (word-wrapped, primary text);
 *   2. a MINIMAL evidence block inside a dim hairline frame — e.g. the 4-line
 *      conflict, NEVER the full file (the block is exactly `escalation.evidence`);
 *   3. numbered options (1..N) with pi's RECOMMENDED option highlighted GREEN
 *      (PALETTE.success) and the others normal;
 *   4. the key hint line `1-N decide · ? ask pi more · enter open full session`;
 *   5. the dim "your call becomes precedent: …" reminder.
 *
 * If the escalation was auto-resolved by a precedent, a green flag line leads the
 * card. Every line is ANSI-safe and clipped to at most `height` via windowLines
 * (anchored at the top so the problem + evidence stay visible). The card owns its
 * own key-hint/footer line; the app chrome supplies the header (blocked N min · …)
 * and the fleet footer.
 */
import { truncateToWidth } from "@earendil-works/pi-tui";
import { windowLines, wrapPlain } from "./../chrome.js";
import { paint, PALETTE, type ThemeLike } from "./../theme.js";
import type { Escalation, EscalationOption } from "./../state/types.js";

/** Left gutter (2 cells) so the card body aligns with the other screens. */
const INDENT = "  ";

export function renderEscalation(
  escalation: Escalation,
  theme: ThemeLike,
  width: number,
  height: number,
): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  const h = Number.isFinite(height) ? Math.max(0, Math.floor(height)) : 0;
  if (w <= 0 || h <= 0) return [];

  const lines: string[] = [];
  const inner = Math.max(0, w - INDENT.length);

  // ── Auto-resolved flag (only when a precedent matched) ───────────────────
  if (escalation.precedentNote) {
    lines.push(indent(theme, `${paint(theme, PALETTE.success, "✓")} ${paint(theme, PALETTE.success, escalation.precedentNote)}`, w));
    lines.push("");
  }

  // ── (1) one-sentence problem ─────────────────────────────────────────────
  for (const segment of wrapPlain(escalation.problem, inner)) {
    lines.push(indent(theme, paint(theme, PALETTE.primary, segment), w));
  }
  lines.push("");

  // ── (2) minimal evidence block (dim hairline frame) ──────────────────────
  for (const raw of escalation.evidence) {
    const frame = paint(theme, PALETTE.inputBorder, "│");
    const body = paintEvidenceLine(theme, raw);
    lines.push(truncateToWidth(`${INDENT}${frame} ${body}`, w, ""));
  }
  lines.push("");

  // ── (3) numbered options, recommended highlighted GREEN ──────────────────
  const recommended = escalation.options.findIndex((option) => option.recommended);
  const recLabel =
    recommended >= 0
      ? ` ${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.dim, "pi recommends")} ${paint(theme, PALETTE.success, String(recommended + 1))}`
      : "";
  lines.push(indent(theme, `${paint(theme, PALETTE.label, "options")}${recLabel}`, w));
  escalation.options.forEach((option, index) => {
    lines.push(optionRow(theme, option, index + 1, w));
  });
  lines.push("");

  // ── (4) key-hint line ─────────────────────────────────────────────────────
  const count = escalation.options.length;
  const range = count > 1 ? `1-${count}` : "1";
  const dot = ` ${paint(theme, PALETTE.dim, "·")} `;
  const hint =
    `${paint(theme, PALETTE.brand, range)} ${paint(theme, PALETTE.dim, "decide")}` +
    `${dot}${paint(theme, PALETTE.brand, "?")} ${paint(theme, PALETTE.dim, "ask pi more")}` +
    `${dot}${paint(theme, PALETTE.brand, "[ ]")} ${paint(theme, PALETTE.dim, "prev/next")}` +
    `${dot}${paint(theme, PALETTE.brand, "enter")} ${paint(theme, PALETTE.dim, "open full session")}`;
  lines.push(indent(theme, hint, w));

  // ── (5) precedent reminder ────────────────────────────────────────────────
  if (escalation.precedentPhrase) {
    const remind =
      `${paint(theme, PALETTE.dim, "your call becomes precedent: ")}` +
      `${paint(theme, PALETTE.mid, `"${escalation.precedentPhrase}"`)}` +
      `${paint(theme, PALETTE.dim, " is remembered")}`;
    lines.push(indent(theme, remind, w));
  }

  return windowLines(theme, lines, 0, h, w);
}

/** A left-indented, ANSI-safe line clipped to width. */
function indent(_theme: ThemeLike, content: string, width: number): string {
  return truncateToWidth(`${INDENT}${content}`, width, "");
}

/** `  N  <text>` — recommended option is GREEN (number + text); others normal. */
function optionRow(theme: ThemeLike, option: EscalationOption, num: number, width: number): string {
  const numColor = option.recommended ? PALETTE.success : PALETTE.dim;
  const textColor = option.recommended ? PALETTE.success : PALETTE.primary;
  const left = `${paint(theme, numColor, String(num))}  ${paint(theme, textColor, option.text)}`;
  return truncateToWidth(`${INDENT}${left}`, width, "");
}

/**
 * Paint one evidence line. A `-`/`+` diff line gets a red/green sign + primary
 * code, with any trailing `(annotation)` dimmed; anything else (a caption) is dim.
 */
function paintEvidenceLine(theme: ThemeLike, raw: string): string {
  const diff = raw.match(/^([+-])\s(.*)$/);
  if (!diff) return paint(theme, PALETTE.dim, raw);
  const [, sign, rest] = diff;
  const signColor = sign === "+" ? PALETTE.success : PALETTE.error;
  const annotated = rest.match(/^(.*?)(\s*\([^)]*\))\s*$/);
  if (annotated) {
    const [, code, note] = annotated;
    return `${paint(theme, signColor, sign)} ${paint(theme, PALETTE.primary, code.trimEnd())} ${paint(theme, PALETTE.dim, note.trim())}`;
  }
  return `${paint(theme, signColor, sign)} ${paint(theme, PALETTE.primary, rest)}`;
}
