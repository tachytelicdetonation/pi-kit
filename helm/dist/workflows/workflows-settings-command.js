/**
 * `/workflows-settings` — a single hub for the extension's scattered settings.
 *
 * The dedicated commands (`/workflows-models`, `/workflows-trigger`,
 * `/workflows-progress`, `/workflows-progress-max`, `/effort`) still exist; this
 * command shows every current value in one menu so users can discover them, and
 * jumps into the right editor. Simple enums (trigger on/off, panel mode, effort)
 * switch inline via a nested select; complex edits (model tiers, custom trigger
 * words, numeric caps) defer to their dedicated commands. Headless sessions get
 * a plain-text summary plus the exact commands to change each setting.
 */
import { listAvailableModels } from "./agent.js";
import { DEFAULT_KEYWORD_TRIGGER_WORD, normalizeKeywordTriggerWord } from "./config.js";
import { buildDefaultTierConfig, loadModelTierConfig, sortedTierNames } from "./model-tier-config.js";
import { loadWorkflowSettings, saveWorkflowSettings, saveWorkflowSettingsForCwd, } from "./workflow-settings.js";
import { openModelTiersEditor } from "./workflows-models-command.js";
/**
 * Register the `/workflows-settings` command with Pi.
 */
export function registerWorkflowSettingsCommand(pi, opts = {}) {
    pi.registerCommand("workflows-settings", {
        description: "Settings hub — model tiers, keyword trigger, progress panel, effort",
        handler: async (_args, ctx) => {
            const store = opts.settingsStore ?? defaultSettingsStore(opts.cwd);
            if (ctx.hasUI && typeof ctx.ui.select === "function") {
                await runSettingsHub(ctx, opts, store);
                return;
            }
            // Headless (print/RPC): no select dialog, so print the current values and
            // the exact commands that change them.
            await pi.sendMessage({
                customType: "workflows-settings",
                content: settingsSummary(ctx, opts, store),
                display: true,
            });
        },
    });
}
/** The on-disk settings store, matching how the editor/panel commands persist. */
function defaultSettingsStore(cwd) {
    if (!cwd)
        return { load: loadWorkflowSettings, save: saveWorkflowSettings };
    return {
        load: () => loadWorkflowSettings({ cwd }),
        save: (settings) => saveWorkflowSettingsForCwd(settings, cwd),
    };
}
/** Menu loop: show current values, apply one change, loop back refreshed. */
async function runSettingsHub(ctx, opts, store) {
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const entries = [
            `Model tiers — ${tiersLabel(ctx)}`,
            `Keyword trigger — ${triggerLabel(store)}`,
            `Progress panel — ${loadProgressMode(store)}`,
            `Progress max agents — ${loadProgressMaxAgents(store)}`,
        ];
        if (opts.effort)
            entries.push(`Effort — ${opts.effort.level}`);
        entries.push("Close");
        const choice = await ctx.ui.select("Workflow settings", entries);
        if (!choice || choice === "Close")
            return;
        if (choice.startsWith("Model tiers")) {
            await openModelTiersEditor(ctx);
        }
        else if (choice.startsWith("Keyword trigger")) {
            await editKeywordTrigger(ctx, store);
        }
        else if (choice.startsWith("Progress panel")) {
            await editProgressMode(ctx, store);
        }
        else if (choice.startsWith("Progress max agents")) {
            ctx.ui.notify("Run /workflows-progress-max <1-1000> to change the cap.", "info");
        }
        else if (choice.startsWith("Effort")) {
            await editEffort(ctx, opts.effort);
        }
    }
}
async function editKeywordTrigger(ctx, store) {
    const choice = await ctx.ui.select(`Keyword trigger (currently ${triggerLabel(store)})`, [
        "Turn on",
        "Turn off",
        "Set custom trigger word",
    ]);
    if (choice === "Turn on" || choice === "Turn off") {
        const enabled = choice === "Turn on";
        const saved = persist(store, { keywordTriggerEnabled: enabled });
        ctx.ui.notify(saved
            ? `Workflows keyword trigger ${enabled ? "on" : "off"} — saved for new sessions.`
            : `Could not save the keyword trigger preference.`, "info");
        return;
    }
    if (choice === "Set custom trigger word") {
        ctx.ui.notify("Run /workflows-trigger set <word> to choose a custom trigger word.", "info");
    }
}
async function editProgressMode(ctx, store) {
    const choice = await ctx.ui.select(`Progress panel (currently ${loadProgressMode(store)})`, ["compact", "detailed"]);
    if (choice !== "compact" && choice !== "detailed")
        return;
    const saved = persist(store, { progressPanelMode: choice });
    ctx.ui.notify(saved
        ? `Workflow progress panel set to ${choice} — takes effect on the next render of a live run (no restart needed).`
        : "Could not save the progress panel preference.", "info");
}
async function editEffort(ctx, effort) {
    if (!effort)
        return;
    const choice = await ctx.ui.select(`Effort (currently ${effort.level})`, ["off", "high", "ultra"]);
    if (choice !== "off" && choice !== "high" && choice !== "ultra")
        return;
    effort.level = choice;
    ctx.ui.notify(choice === "off"
        ? "Effort off — messages are no longer auto-armed as workflows."
        : `Effort ${choice} — substantive messages now auto-arm a workflow. Use /effort off to stop.`, "info");
}
/** Plain-text snapshot for headless sessions: values plus the commands that change them. */
function settingsSummary(ctx, opts, store) {
    const lines = [
        "Workflow settings (current values and how to change them):",
        `  Model tiers — ${tiersLabel(ctx)}`,
        "    change: /workflows-models",
        `  Keyword trigger — ${triggerLabel(store)}`,
        "    change: /workflows-trigger on | off | set <word>",
        `  Progress panel — ${loadProgressMode(store)}`,
        "    change: /workflows-progress compact | detailed",
        `  Progress max agents — ${loadProgressMaxAgents(store)}`,
        "    change: /workflows-progress-max <1-1000>",
    ];
    if (opts.effort) {
        lines.push(`  Effort — ${opts.effort.level}`, "    change: /effort off | high | ultra");
    }
    return lines.join("\n");
}
function tiersLabel(ctx) {
    const currentModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
    const config = loadModelTierConfig() ?? buildDefaultTierConfig(currentModel, listAvailableModels());
    return sortedTierNames(config)
        .map((name) => `${name}: ${config.tiers[name]}`)
        .join(" · ");
}
function triggerLabel(store) {
    const { enabled, word } = loadTrigger(store);
    return enabled ? `on ("${word}")` : "off";
}
// Loaders mirror the defaults of the dedicated commands: trigger on/"workflow",
// panel "compact", max 8 agents per phase.
function loadTrigger(store) {
    try {
        const settings = store.load();
        return {
            enabled: settings.keywordTriggerEnabled ?? true,
            word: normalizeKeywordTriggerWord(settings.keywordTriggerWord) ?? DEFAULT_KEYWORD_TRIGGER_WORD,
        };
    }
    catch {
        return { enabled: true, word: DEFAULT_KEYWORD_TRIGGER_WORD };
    }
}
function loadProgressMode(store) {
    try {
        return store.load().progressPanelMode ?? "compact";
    }
    catch {
        return "compact";
    }
}
function loadProgressMaxAgents(store) {
    try {
        return store.load().progressPanelMaxAgents ?? 8;
    }
    catch {
        return 8;
    }
}
function persist(store, settings) {
    try {
        store.save(settings);
        return true;
    }
    catch {
        return false;
    }
}
