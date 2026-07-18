/**
 * User-level settings for pi-dynamic-workflows.
 *
 * Stored separately from Pi's own settings.json so extension preferences remain
 * stable without depending on host-internal config shape.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MAX_AGENT_RETRIES, MAX_CONCURRENCY, normalizeKeywordTriggerWord } from "./config.js";
import { workflowHomeDir, workflowProjectPaths } from "./workflow-paths.js";
/** Path to the user-level workflow settings JSON file (~/.pi/workflows/settings.json). */
export function getWorkflowSettingsPath() {
    return join(workflowHomeDir(), "settings.json");
}
/** Path to this project's optional workflow settings override. */
export function getWorkflowProjectSettingsPath(cwd) {
    return workflowProjectPaths(cwd).settingsPath;
}
/** Load settings from disk. Missing, corrupt, or invalid files resolve to {}. */
export function loadWorkflowSettings(settingsPathOrOptions) {
    const options = normalizeOptions(settingsPathOrOptions);
    const globalSettings = readSettings(options.settingsPath ?? getWorkflowSettingsPath());
    const projectPath = options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
    if (!projectPath)
        return globalSettings;
    return { ...globalSettings, ...readSettings(projectPath) };
}
/** Merge known settings into the user-level settings file. */
export function saveWorkflowSettings(settings, settingsPathOrOptions) {
    const options = normalizeOptions(settingsPathOrOptions);
    const projectPath = options.projectSettingsPath ?? (options.cwd ? getWorkflowProjectSettingsPath(options.cwd) : undefined);
    const path = options.scope === "project" && projectPath ? projectPath : (options.settingsPath ?? getWorkflowSettingsPath());
    const dir = dirname(path);
    if (!existsSync(dir))
        mkdirSync(dir, { recursive: true });
    const existing = readObject(path);
    writeFileSync(path, `${JSON.stringify({ ...existing, ...normalizeSettings(settings) }, null, 2)}\n`, "utf-8");
}
/** Save a global preference and update an existing project override if one is present. */
export function saveWorkflowSettingsForCwd(settings, cwd) {
    saveWorkflowSettings(settings);
    const projectPath = getWorkflowProjectSettingsPath(cwd);
    if (existsSync(projectPath)) {
        saveWorkflowSettings(settings, { projectSettingsPath: projectPath, scope: "project" });
    }
}
function normalizeOptions(settingsPathOrOptions) {
    return typeof settingsPathOrOptions === "string"
        ? { settingsPath: settingsPathOrOptions }
        : (settingsPathOrOptions ?? {});
}
function readSettings(path) {
    if (!existsSync(path))
        return {};
    try {
        return normalizeSettings(JSON.parse(readFileSync(path, "utf-8")));
    }
    catch {
        return {};
    }
}
function normalizeSettings(value) {
    if (!value || typeof value !== "object" || Array.isArray(value))
        return {};
    const raw = value;
    const settings = {};
    if (typeof raw.keywordTriggerEnabled === "boolean") {
        settings.keywordTriggerEnabled = raw.keywordTriggerEnabled;
    }
    const keywordTriggerWord = normalizeKeywordTriggerWord(raw.keywordTriggerWord);
    if (keywordTriggerWord !== undefined)
        settings.keywordTriggerWord = keywordTriggerWord;
    if (raw.defaultAgentTimeoutMs === null) {
        settings.defaultAgentTimeoutMs = null;
    }
    else if (typeof raw.defaultAgentTimeoutMs === "number" &&
        Number.isFinite(raw.defaultAgentTimeoutMs) &&
        raw.defaultAgentTimeoutMs > 0) {
        settings.defaultAgentTimeoutMs = raw.defaultAgentTimeoutMs;
    }
    const defaultConcurrency = normalizeInteger(raw.defaultConcurrency, 1, MAX_CONCURRENCY);
    if (defaultConcurrency !== undefined)
        settings.defaultConcurrency = defaultConcurrency;
    const defaultAgentRetries = normalizeInteger(raw.defaultAgentRetries, 0, MAX_AGENT_RETRIES);
    if (defaultAgentRetries !== undefined)
        settings.defaultAgentRetries = defaultAgentRetries;
    if (raw.progressPanelMode === "compact" || raw.progressPanelMode === "detailed") {
        settings.progressPanelMode = raw.progressPanelMode;
    }
    if (typeof raw.progressPanelMaxAgents === "number" &&
        Number.isFinite(raw.progressPanelMaxAgents) &&
        raw.progressPanelMaxAgents >= 1) {
        settings.progressPanelMaxAgents = Math.min(1000, Math.floor(raw.progressPanelMaxAgents));
    }
    if (typeof raw.persistAgentSessions === "boolean") {
        settings.persistAgentSessions = raw.persistAgentSessions;
    }
    const deliveredResultMaxChars = normalizeInteger(raw.deliveredResultMaxChars, 1, 1_000_000);
    if (deliveredResultMaxChars !== undefined)
        settings.deliveredResultMaxChars = deliveredResultMaxChars;
    return settings;
}
function normalizeInteger(value, min, max) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < min)
        return undefined;
    return Math.min(max, Math.floor(value));
}
function readObject(path) {
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
    }
    catch {
        return {};
    }
}
