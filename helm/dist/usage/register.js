import { resolveUsagePaths } from "./paths.js";
import { UsageService } from "./service.js";
import { formatUsageDetails, UsageFooterComponent } from "./ui.js";
const REFRESH_MINUTES = Math.min(60, Math.max(5, Number(process.env.PI_USAGE_HEALTH_REFRESH_MINUTES) || 30));
export function registerUsageHealth(pi, opts) {
    let requestRender = () => { };
    let activeGeneration = 0;
    let tuiActive = false;
    // Captured from session_start / event handlers so the width-only render(width)
    // callback can read fresh ambient session facts without holding the ctx itself.
    let currentCtx;
    const listeners = new Set();
    const service = new UsageService({
        paths: resolveUsagePaths(),
        onUpdate: () => {
            if (tuiActive)
                requestRender();
            for (const l of listeners)
                l();
        },
    });
    const buildFooterModel = (footerData) => {
        const view = service.getView();
        const ctx = currentCtx;
        return {
            providers: view.providers,
            now: view.now,
            cwd: ctx?.cwd,
            branch: footerData?.getGitBranch() ?? undefined,
            ctxPercent: ctx?.getContextUsage()?.percent ?? undefined,
            costUsd: computeSessionCost(ctx),
            model: ctx?.model?.id,
            effort: pi.getThinkingLevel(),
        };
    };
    const installFooter = (ctx) => {
        const factory = (tui, theme, footerData) => {
            requestRender = () => tui.requestRender();
            const unsubscribe = footerData.onBranchChange(() => tui.requestRender());
            const component = new UsageFooterComponent(() => buildFooterModel(footerData), theme);
            return Object.assign(component, {
                dispose: () => {
                    unsubscribe();
                },
            });
        };
        opts.footer.installUsageFooter(factory);
    };
    pi.on("session_start", async (_event, ctx) => {
        if (ctx.mode !== "tui")
            return;
        const generation = ++activeGeneration;
        tuiActive = true;
        currentCtx = ctx;
        installFooter(ctx);
        void (async () => {
            await service.loadCache();
            if (!tuiActive || generation !== activeGeneration)
                return;
            await service.refreshIfOlderThan(REFRESH_MINUTES * 60_000);
        })().catch(() => {
            // Individual provider failures are represented in the view model.
        });
    });
    pi.on("agent_settled", async (_event, ctx) => {
        if (ctx.mode !== "tui" || !tuiActive)
            return;
        currentCtx = ctx;
        void service.refreshIfOlderThan(REFRESH_MINUTES * 60_000);
    });
    // Recompute cost + context usage and repaint the footer as the session moves.
    const refreshFooter = (ctx) => {
        if (ctx.mode !== "tui" || !tuiActive)
            return;
        currentCtx = ctx;
        requestRender();
    };
    pi.on("message_end", async (_event, ctx) => refreshFooter(ctx));
    pi.on("turn_end", async (_event, ctx) => refreshFooter(ctx));
    pi.on("model_select", async (_event, ctx) => refreshFooter(ctx));
    pi.on("thinking_level_select", async (_event, ctx) => refreshFooter(ctx));
    pi.on("session_shutdown", async (_event, ctx) => {
        activeGeneration += 1;
        tuiActive = false;
        currentCtx = undefined;
        requestRender = () => { };
    });
    pi.registerCommand("usage-health", {
        description: "Show detailed Codex, Claude Code, and Kimi Code quota health",
        handler: async (_args, ctx) => {
            await service.loadCache();
            ctx.ui.notify(formatUsageDetails(service.getView()), "info");
        },
    });
    pi.registerCommand("usage-refresh", {
        description: "Refresh all provider quota health snapshots now",
        handler: async (_args, ctx) => {
            ctx.ui.setStatus("usage-health", "Refreshing provider usage…");
            try {
                await service.refreshAll();
                ctx.ui.notify("Provider usage refreshed", "info");
            }
            finally {
                ctx.ui.setStatus("usage-health", undefined);
            }
        },
    });
    return { service, subscribe: (cb) => { listeners.add(cb); return () => listeners.delete(cb); } };
}
/**
 * Session cost = sum of assistant-message usage.cost.total across the session.
 * There is no direct host API; guard for entries/messages lacking usage.
 */
function computeSessionCost(ctx) {
    if (!ctx)
        return undefined;
    let total = 0;
    let seen = false;
    for (const entry of ctx.sessionManager.getEntries()) {
        if (entry.type !== "message")
            continue;
        const message = entry.message;
        if (message.role !== "assistant")
            continue;
        const cost = message.usage?.cost?.total;
        if (typeof cost === "number" && Number.isFinite(cost)) {
            total += cost;
            seen = true;
        }
    }
    return seen ? total : undefined;
}
