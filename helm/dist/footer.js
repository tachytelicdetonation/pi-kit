/**
 * helm-owned usage footer — two variants over one layout.
 *
 * The bar math is PORTED from usage-health/src/ui.ts (equal-weight stacked bar,
 * context meter, truncation tiers) rather than imported: helm stays dependency-
 * free and owns its own footer render. The only structural difference between the
 * two variants is the middle meter and the money word:
 *   - "session": ctx meter (8-cell bar / text) + `$cost`
 *   - "fleet":   `burn NN k tok/min`           + `$NN.NN today`   (used by 6b)
 *
 * Truncation tiers (identical to 3a): <110 drop cwd · <90 drop the right-of-bar
 * money detail and shrink the bar to 20 cells · <70 drop the middle meter. Hard
 * invariant, guaranteed by a final safety-net truncate: visibleWidth(line) <= width.
 */
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { GLYPH, paint, PALETTE } from "./theme.js";
/** Fixed provider order (matches the stacked-bar spec and the palette). */
const PROVIDER_ORDER = ["codex", "claude", "kimi"];
const PROVIDER_COLORS = {
    codex: PALETTE.codex,
    claude: PALETTE.claude,
    kimi: PALETTE.kimi,
};
const SEPARATOR = "│";
const PROVIDER_BAR_CELLS_FULL = 30;
const PROVIDER_BAR_CELLS_COMPACT = 20;
const CTX_METER_CELLS = 8;
function safeWidth(width) {
    return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}
/**
 * Render the footer to a SINGLE line, ANSI-safe and never wider than `width`.
 * Returns "" for a non-positive width. Below 8 cells it degrades to a truncated
 * "usage" label (there is no room for even the bar).
 */
export function renderHelmFooter(model, theme, width, variant, paused = false) {
    const w = safeWidth(width);
    if (w <= 0)
        return "";
    if (w < 8)
        return truncateToWidth(paused ? "⏸" : "usage", w, "");
    // ctrl+p PAUSE ALL: the footer turns yellow. A clear `⏸ paused` indicator leads
    // at the far left in the warning tier; the whole line is width-clamped below, so
    // the indicator never breaks the invariant. (Normal footers never use warning,
    // so warning's presence cleanly signals the paused state.)
    const pausedTag = paused ? `${paint(theme, PALETTE.warning, "⏸ paused")}${`  ${paint(theme, PALETTE.warning, SEPARATOR)}  `}` : "";
    const pausedTagWidth = visibleWidth(pausedTag);
    const showCwd = w >= 110;
    const showBranch = w >= 90;
    const barCells = w >= 90 ? PROVIDER_BAR_CELLS_FULL : PROVIDER_BAR_CELLS_COMPACT;
    // Middle meter: bar at >=90, compact text at 70–89, gone below 70.
    const meterMode = w >= 90 ? "bar" : w >= 70 ? "text" : "none";
    const showMoney = w >= 90;
    const showEffort = w >= 90;
    const separator = `  ${paint(theme, PALETTE.divider, SEPARATOR)}  `;
    const separatorWidth = visibleWidth(separator);
    // Fixed groups (bar + middle meter) and the right group always fit; the cwd /
    // branch name group takes only the leftover width so a long cwd never crowds
    // out the usage bar.
    const fixedGroups = [buildBarGroup(theme, model.providers, barCells)];
    if (meterMode !== "none")
        fixedGroups.push(buildMeterGroup(theme, model, variant, meterMode === "bar"));
    const fixedLeft = fixedGroups.join(separator);
    const right = buildRightGroup(theme, model, variant, showMoney, showEffort);
    const branch = showBranch && model.branch ? paint(theme, PALETTE.mid, model.branch) : "";
    const nameGroup = buildNameGroup(theme, model.cwd, showCwd, branch, {
        total: w,
        reserved: pausedTagWidth + visibleWidth(fixedLeft) + (right ? visibleWidth(right) + 2 : 0) + (showCwd || branch ? separatorWidth : 0),
    });
    const left = `${pausedTag}${nameGroup ? `${nameGroup}${separator}${fixedLeft}` : fixedLeft}`;
    let line;
    if (right) {
        const gap = Math.max(2, w - visibleWidth(left) - visibleWidth(right));
        line = `${left}${" ".repeat(gap)}${right}`;
    }
    else {
        line = left;
    }
    // Hard safety net: never exceed the available width, whatever the tier math did.
    if (visibleWidth(line) > w)
        line = truncateToWidth(line, w, "");
    return line;
}
/** cwd (budgeted to the leftover width, dropped if too little) then branch. */
function buildNameGroup(theme, cwd, showCwd, branch, budget) {
    const parts = [];
    const branchWidth = branch ? visibleWidth(branch) + (showCwd ? 1 : 0) : 0;
    const cwdBudget = budget.total - budget.reserved - branchWidth;
    if (showCwd && cwd && cwdBudget >= 4)
        parts.push(paint(theme, PALETTE.dim, truncateToWidth(cwd, cwdBudget, "…")));
    if (branch)
        parts.push(branch);
    return parts.join(" ");
}
function buildBarGroup(theme, providers, cells) {
    const { colored, empty, totalPercent, known } = computeStackedBar(providers, cells);
    const chunks = PROVIDER_ORDER.map((provider, index) => paint(theme, PROVIDER_COLORS[provider], GLYPH.bar.repeat(colored[index] ?? 0)));
    chunks.push(paint(theme, PALETTE.spent, GLYPH.bar.repeat(empty)));
    // No provider snapshot / total outage shows "--", never "0%" (which would read
    // as "all quota spent").
    const label = known === 0 ? "--" : `${totalPercent}%`;
    return `${chunks.join("")} ${paint(theme, PALETTE.dim, label)}`;
}
/** Middle meter: ctx (session) or burn rate (fleet). */
function buildMeterGroup(theme, model, variant, withBar) {
    if (variant === "fleet")
        return buildBurnGroup(theme, model.burnRatePerMin);
    return buildCtxGroup(theme, model.ctxPercent, withBar);
}
function buildCtxGroup(theme, percent, withBar) {
    if (percent === undefined)
        return paint(theme, PALETTE.dim, "ctx --");
    const rounded = Math.round(clampPercent(percent));
    if (!withBar)
        return paint(theme, PALETTE.dim, `ctx ${rounded}%`);
    const { filled, empty } = computeCtxMeter(percent);
    const bar = paint(theme, PALETTE.mid, GLYPH.bar.repeat(filled)) + paint(theme, PALETTE.spent, GLYPH.bar.repeat(empty));
    return `${paint(theme, PALETTE.dim, "ctx")} ${bar} ${paint(theme, PALETTE.dim, `${rounded}%`)}`;
}
/** `burn NN k tok/min` — "burn" in mid, the rate dim. "--" when unknown. */
function buildBurnGroup(theme, burnRatePerMin) {
    const rate = burnRatePerMin === undefined ? "--" : `${Math.round(burnRatePerMin / 1000)}k tok/min`;
    return `${paint(theme, PALETTE.mid, "burn")} ${paint(theme, PALETTE.dim, rate)}`;
}
function buildRightGroup(theme, model, variant, showMoney, showEffort) {
    const head = [];
    if (showMoney) {
        const money = variant === "fleet" ? formatSpendToday(model.spendTodayUsd) : formatCost(model.costUsd);
        if (money)
            head.push(paint(theme, PALETTE.dim, money));
    }
    if (model.model)
        head.push(paint(theme, PALETTE.dim, model.model));
    let result = head.join(paint(theme, PALETTE.dim, " · "));
    if (showEffort && model.effort && model.model)
        result += ` ${paint(theme, PALETTE.faint, model.effort)}`;
    return result;
}
/**
 * Equal-weight stacked bar (ported from usage-health). For each provider (fixed
 * order) the colored run is `round(remaining / N / 100 * cells)`; the concatenated
 * run is clamped to `cells` (rounding at 100%+ can overflow) and the remainder is
 * padded with empty cells. `totalPercent` = round(avg(remaining_i)); `known` = how
 * many providers reported a value (0 → caller shows "--").
 */
export function computeStackedBar(providers, cells) {
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
export function computeCtxMeter(percent) {
    const filled = Math.round((clampPercent(percent) / 100) * CTX_METER_CELLS);
    return { filled, empty: CTX_METER_CELLS - filled };
}
function formatCost(cost) {
    if (cost === undefined)
        return "";
    return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}
function formatSpendToday(spend) {
    if (spend === undefined)
        return "";
    return `$${spend.toFixed(2)} today`;
}
function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(100, Math.max(0, value));
}
