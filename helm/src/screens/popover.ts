/**
 * ctrl+u usage popover — a centered bordered overlay drawn OVER the current screen
 * body (NOT a stack frame, so it never disturbs navigation). It shows per-provider
 * remaining % + reset dates, spend today/week, and the per-goal cost split.
 *
 * The box is framed with {@link PALETTE.inputBorder}. {@link overlayPopover}
 * composites the box over a body region: the box occupies a band of FULL-WIDTH rows
 * centered vertically, so the body above and below still shows and the frame never
 * corrupts a partial line. The box width is capped to fit `width`, and the band is
 * clipped to fit the body height — the overlay never exceeds its bounds.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { paint, PALETTE, type PaletteColor, type ThemeLike } from "./../theme.js";
import type { UsageDetail } from "./../state/types.js";

/** Provider name → palette color for the popover rows. */
function providerColor(id: string): PaletteColor {
  switch (id) {
    case "codex":
      return PALETTE.codex;
    case "claude":
      return PALETTE.claude;
    case "kimi":
      return PALETTE.kimi;
    default:
      return PALETTE.mid;
  }
}

/** An 8-cell remaining-budget bar in the provider color. */
function bar(theme: ThemeLike, color: PaletteColor, remaining: number): string {
  const clamped = Math.min(100, Math.max(0, remaining));
  const filled = Math.round((clamped / 100) * 8);
  return paint(theme, color, "▮".repeat(filled)) + paint(theme, PALETTE.spent, "▮".repeat(8 - filled));
}

/** One content row as a {plain, painted} pair so padding measures the visible width. */
interface Row {
  plain: string;
  painted: string;
}

/** Build the popover's content rows (no border yet). */
function contentRows(detail: UsageDetail, theme: ThemeLike): Row[] {
  const rows: Row[] = [];
  for (const provider of detail.providers) {
    const name = provider.id.padEnd(7);
    const pct = `${provider.remaining}%`.padStart(4);
    const plain = `${name} ${"▮".repeat(8)} ${pct}  ${provider.resetText}`;
    const painted =
      `${paint(theme, providerColor(provider.id), name)} ${bar(theme, providerColor(provider.id), provider.remaining)} ` +
      `${paint(theme, PALETTE.label, pct)}  ${paint(theme, PALETTE.dim, provider.resetText)}`;
    rows.push({ plain, painted });
  }
  rows.push({ plain: "", painted: "" });
  const spend = `spend  today ${detail.spendToday} · week ${detail.spendWeek}`;
  rows.push({
    plain: spend,
    painted:
      `${paint(theme, PALETTE.dim, "spend")}  ${paint(theme, PALETTE.dim, "today")} ${paint(theme, PALETTE.label, detail.spendToday)} ` +
      `${paint(theme, PALETTE.dim, "·")} ${paint(theme, PALETTE.dim, "week")} ${paint(theme, PALETTE.label, detail.spendWeek)}`,
  });
  rows.push({ plain: "per goal:", painted: paint(theme, PALETTE.dim, "per goal:") });
  for (const goal of detail.perGoal) {
    const label = goal.name.padEnd(18);
    rows.push({
      plain: `  ${label} ${goal.cost}`,
      painted: `  ${paint(theme, PALETTE.mid, label)} ${paint(theme, PALETTE.label, goal.cost)}`,
    });
  }
  return rows;
}

/**
 * The framed popover lines, each ANSI-safe and never wider than `width`. Returns
 * `[]` when there is not enough room for even a minimal box. The title sits in the
 * top border: `┌ usage ─…─┐`.
 */
export function usagePopoverLines(detail: UsageDetail, theme: ThemeLike, width: number): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (w < 8) return [];

  const rows = contentRows(detail, theme);
  const title = " usage ";
  // Inner width = widest content, capped so the whole box fits: box = inner + 4
  // ("│ " + content + " │"). Leave a 2-cell margin on each side of the screen.
  const maxInner = Math.max(1, Math.min(w, w - 4) - 4);
  const naturalInner = Math.max(title.length, ...rows.map((row) => row.plain.length));
  const inner = Math.min(naturalInner, maxInner);

  const border = (s: string) => paint(theme, PALETTE.inputBorder, s);
  const lines: string[] = [];

  // Top border with the inline title.
  const titleFit = title.length <= inner ? title : "";
  const dashCount = Math.max(0, inner + 2 - titleFit.length); // +2 for the corners' inner pad
  lines.push(border(`┌${titleFit}${"─".repeat(dashCount)}┐`));

  for (const row of rows) {
    const paddedPlain = row.painted; // already painted; pad to `inner` by visible width
    const pad = Math.max(0, inner - visibleWidth(row.plain));
    const body = visibleWidth(row.plain) > inner ? truncateToWidth(paddedPlain, inner, "…") : `${paddedPlain}${" ".repeat(pad)}`;
    lines.push(`${border("│")} ${body} ${border("│")}`);
  }

  lines.push(border(`└${"─".repeat(inner + 2)}┘`));

  // Final safety net: never exceed width.
  return lines.map((line) => (visibleWidth(line) > w ? truncateToWidth(line, w, "") : line));
}

/**
 * Composite `box` over `body`, centered vertically, each box row centered
 * horizontally as a FULL row (so the body above/below still shows). Returns a NEW
 * array the same length as `body`. The box is clipped to the body height so it never
 * overflows. A body shorter than the box shows as much of the box as fits.
 */
export function overlayPopover(body: string[], box: string[], width: number): string[] {
  const w = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
  if (box.length === 0 || body.length === 0 || w <= 0) return body;

  const boxWidth = Math.max(0, ...box.map((line) => visibleWidth(line)));
  const leftPad = Math.max(0, Math.floor((w - boxWidth) / 2));
  const centeredBox = box.map((line) => truncateToWidth(`${" ".repeat(leftPad)}${line}`, w, ""));

  const visibleBox = centeredBox.slice(0, body.length);
  const start = Math.max(0, Math.floor((body.length - visibleBox.length) / 2));

  const out = [...body];
  for (let i = 0; i < visibleBox.length; i++) out[start + i] = visibleBox[i];
  return out;
}
