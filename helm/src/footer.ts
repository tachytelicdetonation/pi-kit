/**
 * helm-owned usage footer — two variants over one layout.
 *
 * The bar math is PORTED from usage-health/src/ui.ts (equal-weight stacked bar,
 * context meter, truncation tiers) rather than imported: helm stays dependency-
 * free and owns its own footer render. The only structural difference between the
 * two variants is the middle meter and the money word:
 *   - "session": ctx meter (8-cell bar) + `$cost`
 *   - "fleet":   `burn NN k tok/min`           + `$NN.NN today`   (used by 6b)
 *
 * Truncation tiers (identical to 3a): <110 drop cwd · <90 drop the right-of-bar
 * money detail and shrink the bar to 20 cells · <70 drop the middle meter. Hard
 * invariant, guaranteed by a final safety-net truncate: visibleWidth(line) <= width.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH, paint, PALETTE, type PaletteColor, type ThemeLike } from "./theme.js";
import type { FooterProvider, HelmFooterModel } from "./state/types.js";

export type { HelmFooterModel } from "./state/types.js";

/** Fixed provider order (matches the stacked-bar spec and the palette). */
const PROVIDER_ORDER = ["codex", "claude", "kimi"] as const;
type ProviderId = (typeof PROVIDER_ORDER)[number];

const PROVIDER_COLORS: Record<ProviderId, PaletteColor> = {
  codex: PALETTE.codex,
  claude: PALETTE.claude,
  kimi: PALETTE.kimi,
};

const SEPARATOR = "│";
const PROVIDER_BAR_CELLS_FULL = 30;
const PROVIDER_BAR_CELLS_COMPACT = 20;
const CTX_METER_CELLS = 8;

/** Which footer to render: the per-session view or the fleet (6b) view. */
export type FooterVariant = "session" | "fleet";

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

/**
 * Render the footer to a SINGLE line, ANSI-safe and never wider than `width`.
 * Returns "" for a non-positive width. Below 8 cells it degrades to a truncated
 * "usage" label (there is no room for even the bar).
 */
export function renderHelmFooter(
  model: HelmFooterModel,
  theme: ThemeLike,
  width: number,
  variant: FooterVariant,
  paused = false,
): string {
  const w = safeWidth(width);
  if (w <= 0) return "";
  if (w < 8) {
    const tiny = truncateToWidth(paused ? "⏸ paused" : "usage", w, "");
    return paused ? paint(theme, PALETTE.warning, tiny) : tiny;
  }

  // ctrl+p PAUSE ALL: a clear `⏸ paused` indicator leads at the far left. The
  // completed line is flattened and tinted once below so no normal nested colors
  // remain on any visible character.
  const pausedTag = paused ? `⏸ paused  ${SEPARATOR}  ` : "";
  const pausedTagWidth = visibleWidth(pausedTag);

  const showCwd = w >= 110;
  const showBranch = w >= 90;
  const barCells = w >= 90 ? PROVIDER_BAR_CELLS_FULL : PROVIDER_BAR_CELLS_COMPACT;
  // The 8-cell ctx bar is retained through the 70–89 compact tier.
  const showMeter = w >= 70;
  const showMoney = w >= 90;
  const showEffort = w >= 90;

  const separator = `  ${paint(theme, PALETTE.divider, SEPARATOR)}  `;
  const separatorWidth = visibleWidth(separator);

  // Fixed groups (bar + middle meter) and the right group always fit; the cwd /
  // branch name group takes only the leftover width so a long cwd never crowds
  // out the usage bar.
  const fixedGroups = [buildBarGroup(theme, model.providers, barCells)];
  if (showMeter) fixedGroups.push(buildMeterGroup(theme, model, variant));
  const fixedLeft = fixedGroups.join(separator);
  const right = buildRightGroup(theme, model, variant, showMoney, showEffort);

  const branch = showBranch && model.branch ? paint(theme, PALETTE.mid, model.branch) : "";
  const nameGroup = buildNameGroup(theme, model.cwd, showCwd, branch, {
    total: w,
    reserved:
      pausedTagWidth + visibleWidth(fixedLeft) + (right ? visibleWidth(right) + 2 : 0) + (showCwd || branch ? separatorWidth : 0),
  });
  const left = `${pausedTag}${nameGroup ? `${nameGroup}${separator}${fixedLeft}` : fixedLeft}`;

  let line: string;
  if (right) {
    const gap = Math.max(2, w - visibleWidth(left) - visibleWidth(right));
    line = `${left}${" ".repeat(gap)}${right}`;
  } else {
    line = left;
  }

  // Hard safety net: never exceed the available width, whatever the tier math did.
  if (visibleWidth(line) > w) line = truncateToWidth(line, w, "");
  return paused ? paint(theme, PALETTE.warning, stripAnsi(line)) : line;
}

/** cwd (budgeted to the leftover width, dropped if too little) then branch. */
function buildNameGroup(
  theme: ThemeLike,
  cwd: string | undefined,
  showCwd: boolean,
  branch: string,
  budget: { total: number; reserved: number },
): string {
  const parts: string[] = [];
  const branchWidth = branch ? visibleWidth(branch) + (showCwd ? 1 : 0) : 0;
  const cwdBudget = budget.total - budget.reserved - branchWidth;
  if (showCwd && cwd && cwdBudget >= 4) parts.push(paint(theme, PALETTE.dim, truncateToWidth(cwd, cwdBudget, "…")));
  if (branch) parts.push(branch);
  return parts.join(" ");
}

function buildBarGroup(theme: ThemeLike, providers: FooterProvider[], cells: number): string {
  const { colored, empty, totalPercent, known } = computeStackedBar(providers, cells);
  const chunks = PROVIDER_ORDER.map((provider, index) =>
    paint(theme, PROVIDER_COLORS[provider], GLYPH.bar.repeat(colored[index] ?? 0)),
  );
  chunks.push(paint(theme, PALETTE.spent, GLYPH.bar.repeat(empty)));
  // No provider snapshot / total outage shows "--", never "0%" (which would read
  // as "all quota spent").
  const label = known === 0 ? "--" : `${totalPercent}%`;
  return `${chunks.join("")} ${paint(theme, PALETTE.dim, label)}`;
}

/** Middle meter: ctx (session) or burn rate (fleet). */
function buildMeterGroup(
  theme: ThemeLike,
  model: HelmFooterModel,
  variant: FooterVariant,
): string {
  if (variant === "fleet") return buildBurnGroup(theme, model.burnRatePerMin);
  return buildCtxGroup(theme, model.ctxPercent);
}

function buildCtxGroup(theme: ThemeLike, percent: number | undefined): string {
  if (percent === undefined) return paint(theme, PALETTE.dim, "ctx --");
  const rounded = Math.round(clampPercent(percent));
  const { filled, empty } = computeCtxMeter(percent);
  const bar = paint(theme, PALETTE.mid, GLYPH.bar.repeat(filled)) + paint(theme, PALETTE.spent, GLYPH.bar.repeat(empty));
  return `${paint(theme, PALETTE.dim, "ctx")} ${bar} ${paint(theme, PALETTE.dim, `${rounded}%`)}`;
}

/** `burn NN k tok/min` — "burn" in mid, the rate dim. "--" when unknown. */
function buildBurnGroup(theme: ThemeLike, burnRatePerMin: number | undefined): string {
  const rate = burnRatePerMin === undefined ? "--" : `${Math.round(burnRatePerMin / 1000)}k tok/min`;
  return `${paint(theme, PALETTE.mid, "burn")} ${paint(theme, PALETTE.dim, rate)}`;
}

function buildRightGroup(
  theme: ThemeLike,
  model: HelmFooterModel,
  variant: FooterVariant,
  showMoney: boolean,
  showEffort: boolean,
): string {
  const head: string[] = [];
  if (showMoney) {
    const money = variant === "fleet" ? formatSpendToday(model.spendTodayUsd) : formatCost(model.costUsd);
    if (money) head.push(paint(theme, PALETTE.dim, money));
  }
  if (model.model) head.push(paint(theme, PALETTE.dim, model.model));
  let result = head.join(paint(theme, PALETTE.dim, " · "));
  if (showEffort && model.effort && model.model) result += ` ${paint(theme, PALETTE.faint, model.effort)}`;
  return result;
}

/**
 * Equal-weight stacked bar (ported from usage-health). For each provider (fixed
 * order) the colored run is `round(remaining / N / 100 * cells)`; the concatenated
 * run is clamped to `cells` (rounding at 100%+ can overflow) and the remainder is
 * padded with empty cells. `totalPercent` = round(avg(remaining_i)); `known` = how
 * many providers reported a value (0 → caller shows "--").
 */
export function computeStackedBar(
  providers: FooterProvider[],
  cells: number,
): { colored: number[]; empty: number; totalPercent: number; known: number } {
  const safeCells = Math.max(0, Math.floor(cells));
  const byProvider = new Map(providers.map((provider) => [provider.id, provider]));
  const providerCount = PROVIDER_ORDER.length;
  const raw = PROVIDER_ORDER.map((provider) => byProvider.get(provider)?.remaining);
  const known = raw.filter((remaining) => remaining !== undefined).length;
  // Unknown providers contribute 0 (gray cells, no invented %) while at least one
  // is known; the all-unknown case shows "--" upstream.
  const remainings = raw.map((remaining) => (remaining === undefined ? 0 : clampPercent(remaining)));
  let used = 0;
  const colored = remainings.map((remaining) => {
    const want = Math.max(0, Math.round((remaining / providerCount / 100) * safeCells));
    const take = Math.min(want, safeCells - used);
    used += take;
    return take;
  });
  const totalPercent = Math.round(remainings.reduce((sum, remaining) => sum + remaining, 0) / providerCount);
  return { colored, empty: safeCells - used, totalPercent, known };
}

/** Context meter: filled = round(percent/100 * 8), the rest empty. */
export function computeCtxMeter(percent: number): { filled: number; empty: number } {
  const filled = Math.round((clampPercent(percent) / 100) * CTX_METER_CELLS);
  return { filled, empty: CTX_METER_CELLS - filled };
}

function formatCost(cost: number | undefined): string {
  if (cost === undefined) return "";
  return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}

function formatSpendToday(spend: number | undefined): string {
  if (spend === undefined) return "";
  return `$${spend.toFixed(2)} today`;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/** Remove renderer-owned SGR sequences before applying the single paused tint. */
function stripAnsi(value: string): string {
  return value.replace(/\x1b\[[0-9;]*m/g, "");
}
