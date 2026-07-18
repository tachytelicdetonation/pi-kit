/**
 * Background-run UX, mirroring Claude Code:
 *  - A live task panel below the input lists in-progress runs while you keep working.
 *    It is informational; run /workflows to open the full navigator.
 *  - When a background run finishes, its result is delivered back into the
 *    conversation so the paused task continues with the outcome.
 */
import { join } from "node:path";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { aggregateAgentUsage, fmtCost, fmtDuration, fmtTokenSegment, shorten, statusIcon, tokenFigures, } from "./display.js";
import { WorkflowErrorCode } from "./errors.js";
import { shortModel } from "./workflow-ui.js";
// `tokenUsage` is included so the panel repaints as tokens accrue (not only on
// agent start/end). It is harmless in compact mode — it redraws identical content.
const RUN_EVENTS = [
    "agentStart",
    "agentEnd",
    "phase",
    "log",
    "tokenUsage",
    "complete",
    "error",
    "stopped",
    "paused",
    "resumed",
];
/** Events after which a run is gone and its liveness activity can be dropped. */
const RUN_END_EVENTS = ["complete", "error", "stopped"];
/** Default cap on the JSON-dump fallback in a delivered result summary. Overridable
 *  via the `deliveredResultMaxChars` setting in ~/.pi/workflows/settings.json. */
const DEFAULT_DELIVERED_MAX_CHARS = 400;
/** Human-readable byte size for the dropped-tail hint: 512 B, 3.2 KB, 1.4 MB. */
function formatBytes(n) {
    if (n < 1024)
        return `${n} B`;
    if (n < 1024 * 1024)
        return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}
/**
 * Pick a clean human-readable summary from a workflow result, in order of
 * preference: a `verdict`/`report`/`summary` string field, a bare string
 * result, else a JSON dump capped at `maxChars`. When the dump is truncated the
 * dropped size is reported (the full result is still reachable via the pointer
 * that {@link deliverText} appends).
 */
function summarizeResult(result, maxChars = DEFAULT_DELIVERED_MAX_CHARS) {
    if (typeof result === "string")
        return result;
    if (result == null)
        return "null";
    if (typeof result === "object") {
        const obj = result;
        for (const key of ["verdict", "report", "summary"]) {
            const val = obj[key];
            if (typeof val === "string" && val.trim())
                return val;
        }
    }
    const json = JSON.stringify(result, null, 2);
    if (json.length <= maxChars)
        return json;
    // Slice once (the kept head); derive the dropped size by byte-length subtraction
    // so we don't also allocate the (potentially large) truncated tail to measure it.
    const kept = json.slice(0, maxChars);
    const droppedBytes = Buffer.byteLength(json, "utf8") - Buffer.byteLength(kept, "utf8");
    return `${kept}\n…(truncated ${formatBytes(droppedBytes)})`;
}
function fitLine(line, width) {
    if (typeof width !== "number" || !Number.isFinite(width))
        return line;
    const maxWidth = Math.max(0, Math.floor(width));
    if (visibleWidth(line) <= maxWidth)
        return line;
    return truncateToWidth(line, maxWidth);
}
/** One-line aggregate of the quality-stdlib outcomes behind a result, when any ran. */
function crossChecksText(quality) {
    if (!quality)
        return "";
    const segments = [];
    if (quality.verify.checks > 0) {
        segments.push(`verify ${quality.verify.confirmed}/${quality.verify.checks} confirmed (${quality.verify.votes} votes)`);
    }
    if (quality.judge.panels > 0) {
        segments.push(`judge best ${quality.judge.bestScore.toFixed(2)} (${quality.judge.panels} panel${quality.judge.panels > 1 ? "s" : ""})`);
    }
    if (quality.completeness.runs > 0) {
        segments.push(quality.completeness.gaps > 0
            ? `completeness: ${quality.completeness.gaps} gap${quality.completeness.gaps > 1 ? "s" : ""} flagged`
            : "completeness: no gaps");
    }
    return segments.length ? `Cross-checks: ${segments.join(" · ")}` : "";
}
/** Warning line naming checkpoint gates that auto-approved without a human (background runs). */
function autoCheckpointsText(auto) {
    if (!auto?.length)
        return "";
    const shown = auto.slice(0, 3).map((c) => `"${shorten(c.prompt, 40)}"`);
    const more = auto.length > 3 ? ", …" : "";
    return (`⚠ ${auto.length} checkpoint${auto.length > 1 ? "s" : ""} auto-approved while running in the background ` +
        `(no one was asked; defaults were used): ${shown.join(", ")}${more}`);
}
export function deliverText(run, opts = {}) {
    const summary = summarizeResult(run.result?.result, opts.maxChars);
    const tu = run.result?.tokenUsage;
    const cost = tu?.cost ? ` · ${fmtCost(tu.cost)}` : "";
    const segment = fmtTokenSegment(tokenFigures(tu), fmtTokensShort);
    const tokens = `${segment ? ` · ${segment}` : ""}${cost}`;
    const agentCount = run.result?.agentCount ?? run.snapshot.agentCount;
    // Honest outcome counts: a synthesis built on silently-nulled failed agents must
    // say so. Prefer the snapshot's tallies; fall back to counting the agent statuses.
    const snapAgents = Array.isArray(run.snapshot.agents) ? run.snapshot.agents : [];
    const ok = run.snapshot.doneCount ?? snapAgents.filter((a) => a.status === "done").length;
    const failed = run.snapshot.errorCount ?? snapAgents.filter((a) => a.status === "error").length;
    const skipped = snapAgents.filter((a) => a.status === "skipped").length;
    const haveBreakdown = snapAgents.length > 0 || run.snapshot.doneCount !== undefined || run.snapshot.errorCount !== undefined;
    const agents = haveBreakdown
        ? `${agentCount} agents: ${ok} ok${failed > 0 ? `, ${failed} failed` : ""}${skipped > 0 ? `, ${skipped} skipped` : ""}`
        : `${agentCount} agents`;
    const duration = run.result?.durationMs ? ` · ${(run.result.durationMs / 1000).toFixed(1)}s` : "";
    const lines = [`✓ Background workflow "${run.snapshot.name}" finished (${agents}${tokens}${duration}).`, "", summary];
    // The confidence signals: what was cross-checked — and what NOBODY checked
    // (headless checkpoint gates that took their defaults unseen).
    const crossChecks = crossChecksText(run.result?.quality);
    if (crossChecks)
        lines.push("", crossChecks);
    const autoCheckpoints = autoCheckpointsText(run.result?.autoCheckpoints);
    if (autoCheckpoints)
        lines.push("", autoCheckpoints);
    // Always point at the full persisted result so the tail is never lost — even when
    // the summary above is a complete verdict/summary field or an untruncated dump.
    if (opts.resultPath)
        lines.push("", `↳ Full result: ${opts.resultPath}`);
    return lines.join("\n");
}
/**
 * User-facing failure line for a background run. Carries the machine error code
 * (when meaningful) and always ends in the one next action: resume when the
 * failure is resumable, fix-and-restart when it is not.
 */
export function failureText(runId, error) {
    const msg = error?.message ?? "unknown error";
    const code = error?.code && error.code !== WorkflowErrorCode.UNKNOWN ? ` [${error.code}]` : "";
    if (error?.recoverable === false) {
        return (`✗ Background workflow ${runId} failed:${code} ${msg} ` +
            "This won't resolve by re-running — fix the cause and start a new run.");
    }
    return (`✗ Background workflow ${runId} failed:${code} ${msg} ` +
        `Completed steps are saved — run /workflows resume ${runId} to continue where it left off.`);
}
/** Absolute path to a run's persisted result JSON. Undefined if the persistence
 *  layer can't be resolved — delivery must never throw in the complete handler. */
function persistedResultPath(manager, runId) {
    try {
        return join(manager.getPersistence().getRunsDir(), `${runId}.json`);
    }
    catch {
        return undefined;
    }
}
/** Delivered JSON-dump truncation threshold from settings (already normalized),
 *  defaulting to 400 when unset or unreadable. */
function deliveredMaxChars(opts) {
    try {
        return opts.loadSettings?.().deliveredResultMaxChars ?? DEFAULT_DELIVERED_MAX_CHARS;
    }
    catch {
        return DEFAULT_DELIVERED_MAX_CHARS;
    }
}
/**
 * When a background run finishes (or fails), deliver its result back into the
 * conversation AND continue the turn so the assistant can act on it — without
 * blocking the user meanwhile:
 *
 *  - `triggerTurn: true` starts a fresh turn when the agent is idle, feeding the
 *    result to the model so the paused conversation continues.
 *  - `deliverAs: "followUp"` means that if the user is busy in another turn, the
 *    result is queued and picked up after that turn finishes — never interrupting.
 *
 * Set up once per extension; idempotent via an internal guard.
 */
export function installResultDelivery(pi, manager, opts = {}) {
    // Mutable holder on manager so shared across re-calls (e.g. session_start after /reload).
    const m = manager;
    if (m.__deliveryInstalled) {
        // Refresh pi reference only — listeners stay registered.
        if (m.__holder)
            m.__holder.pi = pi;
        return;
    }
    m.__deliveryInstalled = true;
    m.__holder = { pi };
    // Delivery must never throw — but it must also never be silently lost. When
    // the chat path fails (a stale ctx after /reload is the expected case), fall
    // back to a notification so the user at least learns a result is waiting.
    const notifyFallback = () => opts.notify?.("A background workflow result could not be delivered to the chat — find it in /workflows", "warning");
    const deliver = (content) => {
        try {
            const ret = m.__holder?.pi.sendMessage({ customType: "workflow-result", content, display: true }, { triggerTurn: true, deliverAs: "followUp" });
            // sendMessage may return a promise; a sync try/catch can't catch its
            // rejection, so handle the async path too.
            void Promise.resolve(ret).catch(notifyFallback);
        }
        catch {
            // Synchronous failure (e.g. stale ctx).
            notifyFallback();
        }
    };
    manager.on("complete", ({ runId }) => {
        const run = manager.getRun(runId);
        // Only background/resumed runs are delivered: a foreground (sync) run already
        // returns its result inline as the tool result, so re-delivering would dup it.
        if (run?.background) {
            deliver(deliverText(run, { resultPath: persistedResultPath(manager, runId), maxChars: deliveredMaxChars(opts) }));
            opts.notify?.(`Workflow "${run.snapshot.name}" finished — result delivered to the conversation.`, "info");
        }
    });
    manager.on("error", ({ runId, error }) => {
        const run = manager.getRun(runId);
        if (!run?.background)
            return;
        // A manual pause()/stop() also surfaces here as WORKFLOW_ABORTED (executeRun's
        // catch emits "error" either way) — a user action, not a failure to report.
        if (run.status === "aborted" || run.status === "paused")
            return;
        const text = failureText(runId, error);
        deliver(text);
        opts.notify?.(text, "error");
    });
    // A provider usage/quota limit checkpoints the run as paused (not failed): tell the
    // user it is resumable once their budget refills, rather than letting it look dead.
    // Manual pause() also emits "paused" but with no reason — guard so only the
    // usage-limit case delivers a message.
    manager.on("paused", ({ runId, reason, error, resetHint, }) => {
        if (reason !== "usage_limit")
            return;
        if (!manager.getRun(runId)?.background)
            return;
        const when = resetHint ? ` (${resetHint})` : "";
        const cause = error?.message ?? "provider usage limit reached";
        const text = `⏸ Background workflow ${runId} paused: ${cause}${when}. ` +
            `Completed steps are saved — run /workflows resume ${runId} once your usage limit resets.`;
        deliver(text);
        opts.notify?.(text, "warning");
    });
}
export function renderPanel(manager, theme, width, now = Date.now()) {
    const all = manager.listRuns();
    const active = all.filter((r) => r.status === "running" || r.status === "paused");
    if (!active.length)
        return [];
    const rows = active.flatMap((r) => {
        const live = manager.getRun(r.runId);
        const agents = live?.snapshot.agents ?? r.agents;
        const done = agents.filter((a) => a.status === "done").length;
        const errorAgents = agents.filter((a) => a.status === "error");
        const icon = r.status === "paused" ? "⏸" : "◆";
        const usage = aggregateAgentUsage(agents);
        // Wall-clock elapsed for the run (never durationMs — that's only set at
        // completion). The persisted startedAt is the source of truth; the live run's
        // Date is the fallback. Omitted when neither is available (tests/minimal hosts).
        const startMs = live?.startedAt instanceof Date ? live.startedAt.getTime() : Date.parse(r.startedAt);
        const elapsed = Number.isFinite(startMs) ? fmtDuration(now - startMs) : "";
        // Liveness: time since the last observed run event (falling back to the last
        // persisted update) — the compact answer to "is it stuck?".
        const lastActivity = activity.get(r.runId) ?? Date.parse(r.updatedAt);
        const autoCheckpoints = live?.snapshot.autoCheckpointCount ?? 0;
        const meta = [
            `${done}/${agents.length} agents`,
            live?.snapshot.currentPhase || "",
            elapsed,
            fmtTokenSegment(usage, fmtTokensShort),
            usage.cost > 0 ? fmtCost(usage.cost) : "",
            autoCheckpoints > 0 ? `⚠${autoCheckpoints} auto-checkpoint${autoCheckpoints > 1 ? "s" : ""}` : "",
            Number.isFinite(lastActivity) ? `updated ${fmtAgo(now, lastActivity)}` : "",
        ]
            .filter(Boolean)
            .join(" · ");
        const row = `  ${icon} ${r.workflowName}  ${theme.fg("dim", meta)}`;
        // Failures must be visible on the default surface: a run with N failed agents
        // can no longer render identically to a healthy one.
        if (errorAgents.length > 0) {
            const first = errorAgents[0];
            const why = shorten(first.error ?? first.errorCode ?? "failed", 60);
            return [row, theme.fg("error", `    ✗ ${errorAgents.length} failed — "${shorten(first.label, 40)}": ${why}`)];
        }
        return [row];
    });
    // Finished runs leave this live panel but are kept in the navigator. Tell the
    // user so a completed run doesn't look like it vanished.
    const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
    const hint = theme.fg("dim", finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator");
    return [theme.bold(`Workflows running (${active.length}):`), ...rows, hint].map((line) => fitLine(line, width));
}
// ─── Liveness: run activity + per-agent stall ──────────────────────────────────
/** A running agent is flagged stalled after this long with no observed event. */
const STALL_THRESHOLD_MS = 90_000;
/**
 * Stall flag for a RUNNING agent whose last event is older than the threshold —
 * e.g. "no activity 2m ago". "" for non-running agents, or when there is no event
 * stamp yet, or when it is still fresh. `now`/`fmtAgo` keep it human-readable.
 */
export function agentStallFlag(agent, now) {
    if (agent.status !== "running" || typeof agent.lastEventAt !== "number")
        return "";
    if (now - agent.lastEventAt < STALL_THRESHOLD_MS)
        return "";
    return `no activity ${fmtAgo(now, agent.lastEventAt)}`;
}
/** Last observed event time per run — the liveness signal behind "updated Ns ago". */
const activity = new Map();
/** Record run activity (any manager event) at time `now` (ms). */
export function noteActivity(runId, now) {
    activity.set(runId, now);
}
/** Forget a run's activity timestamp (call when it finishes) so the map can't grow. */
export function clearActivity(runId) {
    activity.delete(runId);
}
/** Short relative time for panel liveness: "just now", "12s ago", "3m ago", "1h5m ago". */
export function fmtAgo(now, then) {
    const s = Math.max(0, Math.floor((now - then) / 1000));
    if (s < 5)
        return "just now";
    if (s < 60)
        return `${s}s ago`;
    const m = Math.floor(s / 60);
    if (m < 60)
        return `${m}m ago`;
    return `${Math.floor(m / 60)}h${m % 60}m ago`;
}
/** Compact token count for the space-constrained panel: 980, 12.4K, 1.3M. */
function fmtTokensShort(n) {
    if (!Number.isFinite(n) || n <= 0)
        return "";
    if (n < 1000)
        return `${Math.round(n)}`;
    if (n < 1_000_000)
        return `${(n / 1000).toFixed(1)}K`;
    return `${(n / 1_000_000).toFixed(1)}M`;
}
/** Normalize the configured per-phase agent cap to a sane integer (default 8). */
export function clampMaxAgents(value) {
    if (typeof value !== "number" || !Number.isFinite(value) || value < 1)
        return 8;
    return Math.min(1000, Math.floor(value));
}
/** Per-phase + per-agent body for one run in detailed mode (mirrors renderWorkflowLines). */
function renderRunBody(snap, agents, maxAgents, theme, now) {
    const dim = (t) => theme.fg("dim", t);
    const lines = [];
    // Group agents by phase, declared order first then discovery order (as the navigator does).
    const order = snap.phases.length ? [...snap.phases] : [];
    const byPhase = new Map();
    for (const a of agents) {
        const key = a.phase ?? "(no phase)";
        if (!byPhase.has(key))
            byPhase.set(key, []);
        byPhase.get(key)?.push(a);
        if (!order.includes(key))
            order.push(key);
    }
    for (const title of order) {
        const phaseAgents = byPhase.get(title) ?? [];
        if (!phaseAgents.length)
            continue;
        const done = phaseAgents.filter((a) => a.status === "done").length;
        const running = phaseAgents.filter((a) => a.status === "running").length;
        const errors = phaseAgents.filter((a) => a.status === "error").length;
        const skipped = phaseAgents.filter((a) => a.status === "skipped").length;
        const complete = done + errors + skipped === phaseAgents.length;
        const marker = running > 0 || (!complete && snap.currentPhase === title) ? "▶" : complete ? "✓" : " ";
        const phaseMeta = [
            `${done}/${phaseAgents.length} agents`,
            running ? `${running} running` : "",
            errors ? `${errors} errors` : "",
            fmtTokenSegment(aggregateAgentUsage(phaseAgents), fmtTokensShort),
        ]
            .filter(Boolean)
            .join(" · ");
        lines.push(theme.fg("accent", `  ${marker} ${title}`) + dim(`  ${phaseMeta}`));
        const visible = phaseAgents.slice(-maxAgents);
        for (const a of visible) {
            const segment = fmtTokenSegment(tokenFigures(a.tokenUsage, a.tokens), fmtTokensShort);
            const tok = segment ? dim(` ${segment}`) : "";
            const mdl = shortModel(a.model);
            const model = mdl ? dim(` · ${mdl}`) : "";
            // A running agent gone quiet for ≥90s is the real stall signal (tok/s used to
            // fake this and mislabel a long single agent as stalled).
            const stall = agentStallFlag(a, now);
            const stalled = stall ? theme.fg("warning", ` · ${stall}`) : "";
            lines.push(`    [${a.id}] ${statusIcon(a.status)} ${shorten(a.label, 40)}${tok}${model}${stalled}`);
        }
        if (phaseAgents.length > visible.length) {
            lines.push(dim(`    … ${phaseAgents.length - visible.length} earlier agents`));
        }
    }
    return lines;
}
/**
 * Detailed variant of {@link renderPanel}: per-run header with aggregate tokens,
 * cost, and wall-clock elapsed, followed by per-phase progress and per-agent rows
 * (capped at `maxAgents` per phase). Running agents that have gone quiet get a
 * per-agent stall flag. `now` is injected for testability.
 */
export function renderPanelDetailed(manager, theme, width, maxAgents, now) {
    const all = manager.listRuns();
    const active = all.filter((r) => r.status === "running" || r.status === "paused");
    if (!active.length)
        return [];
    const dim = (t) => theme.fg("dim", t);
    const out = [theme.bold(`Workflows running (${active.length}):`)];
    for (const r of active) {
        const live = manager.getRun(r.runId);
        const snap = live?.snapshot;
        const agents = (snap?.agents ?? r.agents);
        const done = agents.filter((a) => a.status === "done").length;
        const icon = r.status === "paused" ? "⏸" : "◆";
        const usage = snap?.tokenUsage ?? r.tokenUsage;
        // The run-level tokenUsage aggregate is only finalized when the run ends, so
        // it reads 0 for the whole live run; per-agent figures update on each agent
        // completion, so aggregate those instead.
        const runUsage = aggregateAgentUsage(agents);
        // Live cost accrues from per-agent figures at completion granularity; the
        // finalized run-level cost (known once the run ends) is the fallback.
        const liveCost = runUsage.cost > 0 ? runUsage.cost : (usage?.cost ?? 0);
        // Wall-clock elapsed replaces the old tok/s: it never falsely reads a long
        // single agent as a stall. Persisted startedAt first, live Date as fallback.
        const startMs = live?.startedAt instanceof Date ? live.startedAt.getTime() : Date.parse(r.startedAt);
        const elapsed = Number.isFinite(startMs) ? fmtDuration(now - startMs) : "";
        const meta = [
            `${done}/${agents.length} agents`,
            snap?.currentPhase || "",
            elapsed,
            fmtTokenSegment(runUsage, fmtTokensShort),
            liveCost > 0 ? fmtCost(liveCost) : "",
        ]
            .filter(Boolean)
            .join(" · ");
        out.push(`  ${icon} ${theme.bold(r.workflowName)}  ${dim(meta)}`);
        if (snap)
            out.push(...renderRunBody(snap, agents, maxAgents, theme, now));
    }
    const finished = all.filter((r) => r.status !== "running" && r.status !== "paused").length;
    out.push(dim(finished > 0
        ? `  /workflows — open navigator (${finished} finished kept in history)`
        : "  /workflows — open navigator"));
    return out.map((line) => fitLine(line, width));
}
/**
 * Install the live "workflows running" panel below the editor. Re-rendered on
 * every manager event. Informational only — the user opens the navigator with
 * /workflows. (`_pi` is kept for signature stability.)
 */
export function installTaskPanel(_pi, manager, ui, opts = {}) {
    // Live-read settings with a ~1s TTL: a render-path disk read every frame would
    // be wasteful, but re-reading at most once a second still makes
    // /workflows-progress take effect "immediately" (no restart).
    let cached = {};
    let cachedAt = Number.NEGATIVE_INFINITY;
    const settings = () => {
        if (!opts.loadSettings)
            return cached;
        const now = Date.now();
        if (now - cachedAt > 1000) {
            try {
                cached = opts.loadSettings() ?? {};
            }
            catch {
                cached = {};
            }
            cachedAt = now;
        }
        return cached;
    };
    const hasActiveRun = () => manager.listRuns().some((r) => r.status === "running" || r.status === "paused");
    ui.setWidget("workflow-tasks", (tui, theme) => {
        const onEvent = ({ runId } = {}) => {
            if (runId)
                noteActivity(runId, Date.now());
            tui.requestRender();
        };
        for (const ev of RUN_EVENTS)
            manager.on(ev, onEvent);
        const onRunEnd = ({ runId }) => {
            clearActivity(runId);
        };
        for (const ev of RUN_END_EVENTS)
            manager.on(ev, onRunEnd);
        // Force a redraw every 2s while a run is active so the run elapsed, the
        // per-agent stall flag, and the compact "updated … ago" liveness label keep
        // ticking between manager events. Unref'd so it's free when idle.
        const timer = setInterval(() => {
            if (hasActiveRun())
                tui.requestRender();
        }, 2000);
        timer.unref?.();
        // Purely informational: it lists running runs and re-renders on events. To
        // open the navigator, the user runs /workflows (the panel takes no input).
        const comp = {
            render: (width) => {
                const s = settings();
                if (s.progressPanelMode === "detailed") {
                    return renderPanelDetailed(manager, theme, width, clampMaxAgents(s.progressPanelMaxAgents), Date.now());
                }
                return renderPanel(manager, theme, width);
            },
            invalidate: () => { },
            dispose: () => {
                clearInterval(timer);
                for (const ev of RUN_EVENTS)
                    manager.off(ev, onEvent);
                for (const ev of RUN_END_EVENTS)
                    manager.off(ev, onRunEnd);
            },
        };
        return comp;
    }, { placement: "belowEditor" });
}
