import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { PROVIDER_NAMES, PROVIDER_ORDER, providerRemaining } from "./types.js";
const PROVIDER_COLORS = {
    codex: { rgb: [76, 157, 240], xterm: 75 }, // #4c9df0
    claude: { rgb: [240, 149, 76], xterm: 209 }, // #f0954c
    kimi: { rgb: [45, 212, 191], xterm: 43 }, // #2dd4bf
};
const PALETTE = {
    empty: { rgb: [51, 54, 62], xterm: 237 }, // #33363e spent / unfilled cells
    dim: { rgb: [107, 114, 128], xterm: 242 }, // #6b7280 row base / cwd / percentages / cost·model
    mid: { rgb: [141, 147, 161], xterm: 246 }, // #8d93a1 branch + ctx filled cells
    ghost: { rgb: [61, 64, 72], xterm: 238 }, // #3d4048 separators
    faint: { rgb: [77, 81, 88], xterm: 239 }, // #4d5158 effort word
};
/** U+25AE BLACK VERTICAL RECTANGLE — the bar cell glyph. */
const BAR_GLYPH = "▮";
/** Separator with two spaces on each side: "  │  ". */
const SEPARATOR = "│";
const PROVIDER_BAR_CELLS_FULL = 30;
const PROVIDER_BAR_CELLS_COMPACT = 20;
const CTX_METER_CELLS = 8;
export class UsageFooterComponent {
    getModel;
    theme;
    constructor(getModel, theme) {
        this.getModel = getModel;
        this.theme = theme;
    }
    render(width) {
        return renderFooter(this.getModel(), this.theme, width);
    }
    invalidate() {
        // Rendering is stateless and resolves colors on every frame.
    }
}
export function renderFooter(model, theme, width) {
    // Guard non-finite widths: Infinity would make " ".repeat(gap) throw, NaN would
    // slip past every comparison below and skip truncation. Both collapse to 0 → "".
    const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
    if (safeWidth <= 0)
        return [""];
    if (safeWidth < 8)
        return [truncateToWidth("usage", safeWidth, "")];
    const showCwd = safeWidth >= 110;
    const showBranch = safeWidth >= 90;
    const barCells = safeWidth >= 90 ? PROVIDER_BAR_CELLS_FULL : PROVIDER_BAR_CELLS_COMPACT;
    const ctxMode = safeWidth >= 90 ? "bar" : safeWidth >= 70 ? "text" : "none";
    const showCost = safeWidth >= 90;
    const showEffort = safeWidth >= 90;
    const separator = `  ${paint(theme, PALETTE.ghost, SEPARATOR)}  `;
    const separatorWidth = visibleWidth(separator);
    // Fixed left content (bar, ctx) and right group must always fit; the cwd/branch
    // name group only gets the width left over, so a long cwd never crowds out the
    // usage bar (the footer's whole point) via the right-side safety-net truncation.
    const fixedGroups = [buildBarGroup(theme, model.providers, barCells)];
    if (ctxMode !== "none")
        fixedGroups.push(buildCtxGroup(theme, model.ctxPercent, ctxMode === "bar"));
    const fixedLeft = fixedGroups.join(separator);
    const right = buildRightGroup(theme, model, showCost, showEffort);
    const branch = showBranch && model.branch ? paint(theme, PALETTE.mid, model.branch) : "";
    const nameGroup = buildNameGroup(theme, model.cwd, showCwd, branch, {
        total: safeWidth,
        reserved: visibleWidth(fixedLeft) + (right ? visibleWidth(right) + 2 : 0) + (showCwd || branch ? separatorWidth : 0),
    });
    const left = nameGroup ? `${nameGroup}${separator}${fixedLeft}` : fixedLeft;
    let line;
    if (right) {
        const gap = Math.max(2, safeWidth - visibleWidth(left) - visibleWidth(right));
        line = `${left}${" ".repeat(gap)}${right}`;
    }
    else {
        line = left;
    }
    // Hard safety net: never exceed the available width, regardless of tier math.
    if (visibleWidth(line) > safeWidth)
        line = truncateToWidth(line, safeWidth, "");
    return [line];
}
/** cwd (budgeted to the leftover width, dropped if too little) then branch. */
function buildNameGroup(theme, cwd, showCwd, branch, budget) {
    const parts = [];
    const branchWidth = branch ? visibleWidth(branch) + (showCwd ? 1 : 0) : 0;
    const cwdBudget = budget.total - budget.reserved - branchWidth;
    if (showCwd && cwd && cwdBudget >= 4) {
        parts.push(paint(theme, PALETTE.dim, truncateToWidth(cwd, cwdBudget, "…")));
    }
    if (branch)
        parts.push(branch);
    return parts.join(" ");
}
function buildBarGroup(theme, states, cells) {
    const { colored, empty, totalPercent, known } = computeStackedBar(states, cells);
    const chunks = PROVIDER_ORDER.map((provider, index) => paint(theme, PROVIDER_COLORS[provider], BAR_GLYPH.repeat(colored[index] ?? 0)));
    chunks.push(paint(theme, PALETTE.empty, BAR_GLYPH.repeat(empty)));
    // No provider snapshot yet (startup) or a total outage: show "--", not "0%",
    // which would read as "all quota spent". Matches the ctx meter and detail view.
    const label = known === 0 ? "--" : `${totalPercent}%`;
    return `${chunks.join("")} ${paint(theme, PALETTE.dim, label)}`;
}
function buildCtxGroup(theme, percent, withBar) {
    if (percent === undefined)
        return paint(theme, PALETTE.dim, "ctx --");
    const rounded = Math.round(clampPercent(percent));
    if (!withBar)
        return paint(theme, PALETTE.dim, `ctx ${rounded}%`);
    const { filled, empty } = computeCtxMeter(percent);
    const bar = paint(theme, PALETTE.mid, BAR_GLYPH.repeat(filled)) + paint(theme, PALETTE.empty, BAR_GLYPH.repeat(empty));
    return `${paint(theme, PALETTE.dim, "ctx")} ${bar} ${paint(theme, PALETTE.dim, `${rounded}%`)}`;
}
function buildRightGroup(theme, model, showCost, showEffort) {
    const head = [];
    if (showCost && model.costUsd !== undefined)
        head.push(paint(theme, PALETTE.dim, formatCost(model.costUsd)));
    if (model.model)
        head.push(paint(theme, PALETTE.dim, model.model));
    let result = head.join(paint(theme, PALETTE.dim, " · "));
    if (showEffort && model.effort && model.model) {
        result += ` ${paint(theme, PALETTE.faint, model.effort)}`;
    }
    return result;
}
/**
 * Equal-weight stacked bar. For each provider (fixed order) the colored run is
 * round(remaining / N / 100 * cells); the concatenated run is clamped to `cells`
 * (rounding at 100%+ can overflow) and the remainder is padded with empty cells.
 */
export function computeStackedBar(states, cells) {
    const safeCells = Math.max(0, Math.floor(cells));
    const byProvider = new Map(states.map((state) => [state.provider, state]));
    const providerCount = PROVIDER_ORDER.length;
    const raw = PROVIDER_ORDER.map((provider) => providerRemaining(byProvider.get(provider)?.snapshot));
    const known = raw.filter((remaining) => remaining !== undefined).length;
    // Unknown providers contribute 0 (gray cells, no invented %) — spec behavior
    // while at least one provider is known; the all-unknown case shows "--" upstream.
    const remainings = raw.map((remaining) => remaining ?? 0);
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
    return `$${cost < 1 ? cost.toFixed(3) : cost.toFixed(2)}`;
}
function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(100, Math.max(0, value));
}
/** Emit `text` wrapped in a truecolor (or 256-color fallback) foreground code. */
function paint(theme, color, text) {
    if (!text)
        return "";
    if (theme.getColorMode?.() === "256color")
        return `[38;5;${color.xterm}m${text}[39m`;
    const [red, green, blue] = color.rgb;
    return `[38;2;${red};${green};${blue}m${text}[39m`;
}
export function formatUsageDetails(view) {
    const lines = ["Usage health"];
    for (const provider of PROVIDER_ORDER) {
        const state = view.providers.find((candidate) => candidate.provider === provider);
        const remaining = providerRemaining(state?.snapshot);
        const source = state?.snapshot?.source ?? "unavailable";
        lines.push(`\n${PROVIDER_NAMES[provider]} — ${remaining === undefined ? "--" : `${Math.round(remaining)}% left`} (${source})`);
        if (state?.snapshot) {
            for (const bucket of state.snapshot.buckets) {
                const reset = bucket.resetsAt ? ` · ${formatReset(bucket.resetsAt, view.now)}` : "";
                const ignored = bucket.affectsHealth === false ? " · informational" : "";
                lines.push(`  ${bucket.label}: ${Math.round(bucket.usedPercent)}% used${reset}${ignored}`);
            }
        }
        if (state?.error)
            lines.push(`  Last refresh: ${state.error}`);
    }
    return lines.join("\n");
}
function formatReset(resetsAt, now) {
    const seconds = Math.max(0, Math.round((resetsAt - now) / 1_000));
    if (seconds === 0)
        return "reset due";
    const days = Math.floor(seconds / 86_400);
    const hours = Math.floor((seconds % 86_400) / 3_600);
    const minutes = Math.floor((seconds % 3_600) / 60);
    const parts = [];
    if (days)
        parts.push(`${days}d`);
    if (hours)
        parts.push(`${hours}h`);
    if (minutes && parts.length < 2)
        parts.push(`${minutes}m`);
    if (parts.length === 0)
        parts.push("<1m");
    return `resets in ${parts.join(" ")}`;
}
