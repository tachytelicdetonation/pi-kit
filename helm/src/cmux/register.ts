import { StringEnum } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { join, resolve } from "node:path";
import { Type } from "typebox";
import { bridgePermissionRequest } from "../host/escalation-bridge.js";
import type { HelmPresence } from "../host/presence.js";
import {
  AuditLog,
  ClaudeFleetManager,
  ClaudeHookStore,
  CmuxClient,
  CmuxEventTail,
  loadConfig,
  resolveRuntimePaths,
  StateStore,
  type FleetTaskInput,
  type ManagedSession,
  type PermissionDecider,
  type PermissionMode,
  type TrustDecider,
} from "./index.js";

const permissionModes = ["plan", "manual", "acceptEdits", "dontAsk"] as const;
const actions = ["run", "parallel", "status", "stop"] as const;

const FleetTaskSchema = Type.Object({
  id: Type.Optional(Type.String({ description: "Caller-defined task identifier" })),
  prompt: Type.String({ description: "Prompt to send to the interactive Claude Code session" }),
  cwd: Type.Optional(Type.String({ description: "Working directory; defaults to Pi's cwd" })),
  name: Type.Optional(Type.String({ description: "Short workspace label" })),
  permissionMode: Type.Optional(StringEnum(permissionModes)),
  keepOpen: Type.Optional(Type.Boolean({ description: "Keep the Claude workspace open after completion" })),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })),
});

const ToolSchema = Type.Object({
  action: StringEnum(actions, { description: "run one task, run tasks in parallel, inspect status, or stop sessions" }),
  prompt: Type.Optional(Type.String({ description: "Prompt for action=run" })),
  cwd: Type.Optional(Type.String({ description: "Working directory for action=run; defaults to Pi's cwd" })),
  name: Type.Optional(Type.String({ description: "Workspace label for action=run" })),
  permissionMode: Type.Optional(StringEnum(permissionModes)),
  keepOpen: Type.Optional(Type.Boolean()),
  timeoutSeconds: Type.Optional(Type.Integer({ minimum: 10, maximum: 3600 })),
  tasks: Type.Optional(Type.Array(FleetTaskSchema, { minItems: 1, maxItems: 16 })),
  concurrency: Type.Optional(Type.Integer({ minimum: 1, maximum: 8 })),
  runId: Type.Optional(Type.String({ description: "Run ID for action=stop; omit to stop all managed sessions" })),
});

export function registerClaudeCmux(pi: ExtensionAPI, opts: { presence: HelmPresence }): { getManager: () => ClaudeFleetManager } {
  const config = loadConfig();
  const paths = resolveRuntimePaths();
  const cmux = new CmuxClient();
  const createManager = (instanceId: string) => {
    const safeId = instanceId.replace(/[^A-Za-z0-9._-]/g, "_");
    const instancesRoot = join(paths.root, "instances");
    const instanceRoot = join(instancesRoot, safeId);
    return new ClaudeFleetManager({
      cmux,
      events: new CmuxEventTail({ cmuxBin: cmux.bin, cursorFile: join(instanceRoot, "events.seq"), env: cmux.env }),
      hooks: new ClaudeHookStore(paths.hookStoreFile),
      audit: new AuditLog(paths.auditFile),
      state: new StateStore(join(instanceRoot, "state.json")),
      config,
      instanceId: safeId,
      instancesRoot,
    });
  };
  // session_start replaces this bootstrap holder with a manager keyed by Pi's
  // stable session ID. That prevents cursor/state races across multiple Pi TUIs
  // while preserving recovery when the same Pi session is resumed or reloaded.
  let manager = createManager(`bootstrap-${process.pid}`);

  const updateStatus = (ctx: ExtensionContext, label?: string) => {
    if (!ctx.hasUI) return;
    const active = manager.listRuns().filter((run) => !["terminated", "failed"].includes(run.state));
    if (label) {
      ctx.ui.setStatus("claude-cmux", ctx.ui.theme.fg("accent", label));
    } else if (active.length > 0) {
      ctx.ui.setStatus("claude-cmux", ctx.ui.theme.fg("warning", `Claude ${active.length} active`));
    } else {
      ctx.ui.setStatus("claude-cmux", ctx.ui.theme.fg("dim", "Claude cmux ready"));
    }
  };

  const makeDecider = (ctx: ExtensionContext): PermissionDecider => async (request) => {
    const ds = opts.presence.isOpen() ? opts.presence.dataSource() : undefined;
    if (ds) {
      if (request.kind === "exit-plan") {
        const idx = await bridgePermissionRequest(ds, {
          source: { kind: "workflow", label: "cmux › plan" },
          question: "Claude completed its plan",
          options: ["Continue with manual approvals", "Continue in auto mode", "Deny"],
        });
        return idx === 0 ? { action: "plan-manual" } : idx === 1 ? { action: "plan-auto" } : { action: "deny" };
      }
      if (request.kind === "permission") {
        const idx = await bridgePermissionRequest(ds, {
          source: { kind: "workflow", label: "cmux › permission" },
          question: request.toolName ? `Claude requests: ${request.toolName}` : "Claude requests permission",
          options: ["Allow once", "Deny"],
        });
        return idx === 0 ? { action: "allow-once" } : { action: "deny" };
      }
      return { action: "deny" };
    }
    if (!ctx.hasUI) return { action: "deny" };
    if (request.kind === "exit-plan") {
      const choice = await ctx.ui.select(
        "Claude completed its plan",
        ["Continue with manual approvals", "Continue in auto mode", "Deny"],
        { timeout: config.permissionTimeoutMs },
      );
      if (choice === "Continue with manual approvals") return { action: "plan-manual" };
      if (choice === "Continue in auto mode") return { action: "plan-auto" };
      return { action: "deny" };
    }
    if (request.kind === "permission") {
      const label = request.toolName ? `Claude requests: ${request.toolName}` : "Claude requests permission";
      const choice = await ctx.ui.select(label, ["Allow once", "Deny"], { timeout: config.permissionTimeoutMs });
      return choice === "Allow once" ? { action: "allow-once" } : { action: "deny" };
    }
    ctx.ui.notify("Claude asked an unsupported/redacted question; denied fail-closed", "warning");
    return { action: "deny" };
  };

  const makeTrustDecider = (ctx: ExtensionContext): TrustDecider => async (run) => {
    const ds = opts.presence.isOpen() ? opts.presence.dataSource() : undefined;
    if (ds) {
      const idx = await bridgePermissionRequest(ds, {
        source: { kind: "workflow", label: "cmux › trust" },
        question: `Trust Claude working directory? ${run.cwd}`,
        options: ["Trust", "Deny"],
        evidence: [run.cwd],
      });
      return idx === 0;
    }
    if (!ctx.hasUI) return false;
    return ctx.ui.confirm(
      "Trust Claude working directory?",
      `${run.cwd}\n\nClaude Code will gain normal agent access to this directory.`,
      { timeout: config.registrationTimeoutMs },
    );
  };

  pi.on("session_start", async (_event, ctx) => {
    // Tear down the prior manager (the bootstrap holder, or a switched-away Pi
    // session) before replacing it. Otherwise its event-tail child, permission
    // broker (which would double-reply to PermissionRequests), and reconcile
    // timers keep running — and could autonomously resume sessions from the old
    // state file with no UI attached. cleanup=true also terminates that session's
    // now-unsupervised managed Claude processes.
    const previous = manager;
    manager = createManager(ctx.sessionManager.getSessionId());
    await previous.shutdown(true).catch(() => {});
    try {
      const report = await manager.start();
      if (report.ok) {
        updateStatus(ctx);
        if (report.warnings.length > 0) ctx.ui.notify(report.warnings.join("\n"), "warning");
      } else {
        ctx.ui.setStatus("claude-cmux", ctx.ui.theme.fg("error", "Claude cmux unavailable"));
        ctx.ui.notify(`Claude cmux compatibility gate failed:\n${report.errors.join("\n")}`, "error");
      }
    } catch (error) {
      ctx.ui.setStatus("claude-cmux", ctx.ui.theme.fg("error", "Claude cmux unavailable"));
      ctx.ui.notify(`Claude cmux failed to start: ${message(error)}`, "error");
    }
  });

  pi.on("session_shutdown", async (event, ctx) => {
    ctx.ui.setStatus("claude-cmux", undefined);
    await manager.shutdown(event.reason === "quit");
  });

  pi.registerTool({
    name: "claude_cmux",
    label: "Claude via cmux",
    description: [
      "Run normal interactive Claude Code sessions in managed cmux workspaces.",
      "Uses raw cmux hook events for completion, terminal paste for safe multiline prompts, fail-closed permission gates,",
      "bounded concurrency, exact-session recovery, and PID-confirmed cleanup.",
      "Use action=run for one task or action=parallel for a fleet.",
    ].join(" "),
    promptSnippet: "Delegate work to interactive Claude Code sessions through cmux",
    promptGuidelines: [
      "Use claude_cmux when the user explicitly asks to delegate work to Claude Code through their subscription-backed interactive cmux workflow.",
      "Do not use claude_cmux for simple work that Pi can complete directly, and do not select broad or bypass permission modes.",
    ],
    parameters: ToolSchema,
    async execute(_toolCallId, params, signal, onUpdate, ctx) {
      if (params.action === "status") {
        const runs = manager.listRuns();
        return { content: [{ type: "text", text: formatRuns(runs) }], details: { action: "status", runs } };
      }
      if (params.action === "stop") {
        if (params.runId) {
          const stopped = await manager.stop(params.runId);
          updateStatus(ctx);
          return {
            content: [{ type: "text", text: stopped ? `Stopped ${params.runId}` : `Unknown run: ${params.runId}` }],
            details: { action: "stop", runId: params.runId, stopped },
          };
        }
        await manager.stopAll();
        updateStatus(ctx);
        return { content: [{ type: "text", text: "Stopped all managed Claude sessions." }], details: { action: "stop-all" } };
      }

      const decider = makeDecider(ctx);
      const trustDecider = makeTrustDecider(ctx);
      if (params.action === "run") {
        if (!params.prompt?.trim()) throw new Error("action=run requires prompt");
        updateStatus(ctx, "Claude launching…");
        onUpdate?.({ content: [{ type: "text", text: "Launching interactive Claude Code session…" }], details: {} });
        const result = await manager.runTask(
          {
            prompt: params.prompt,
            cwd: params.cwd ? resolve(ctx.cwd, params.cwd) : ctx.cwd,
            name: params.name,
            permissionMode: params.permissionMode as PermissionMode | undefined,
            keepOpen: params.keepOpen,
            timeoutMs: params.timeoutSeconds ? params.timeoutSeconds * 1_000 : undefined,
          },
          { signal, decider, trustDecider },
        );
        updateStatus(ctx);
        return {
          content: [{ type: "text", text: result.output }],
          details: { action: "run", run: result.run, elapsedMs: result.elapsedMs },
        };
      }

      if (!params.tasks?.length) throw new Error("action=parallel requires tasks");
      updateStatus(ctx, `Claude fleet 0/${params.tasks.length}`);
      const tasks: FleetTaskInput[] = params.tasks.map((task) => ({
        id: task.id,
        prompt: task.prompt,
        cwd: task.cwd ? resolve(ctx.cwd, task.cwd) : ctx.cwd,
        name: task.name,
        permissionMode: task.permissionMode as PermissionMode | undefined,
        keepOpen: task.keepOpen,
        timeoutMs: task.timeoutSeconds ? task.timeoutSeconds * 1_000 : undefined,
      }));
      const results = await manager.runFleet(tasks, {
        signal,
        decider,
        trustDecider,
        concurrency: params.concurrency,
        onProgress: (finished, total) => {
          updateStatus(ctx, `Claude fleet ${finished}/${total}`);
          onUpdate?.({
            content: [{ type: "text", text: `Claude fleet: ${finished}/${total} finished` }],
            details: { finished, total },
          });
        },
      });
      updateStatus(ctx);
      const succeeded = results.filter((result) => result.ok).length;
      const text = results
        .map((result, index) =>
          result.ok
            ? `### ${result.id ?? `Task ${index + 1}`}\n\n${result.result?.output ?? "(no output)"}`
            : `### ${result.id ?? `Task ${index + 1}`} — failed\n\n${result.error ?? "Unknown failure"}`,
        )
        .join("\n\n---\n\n");
      return {
        content: [{ type: "text", text: `Claude fleet: ${succeeded}/${results.length} succeeded\n\n${text}` }],
        details: { action: "parallel", results },
      };
    },
  });

  pi.registerCommand("claude-cmux", {
    description: "Run a prompt in a managed interactive Claude Code workspace",
    handler: async (args, ctx) => {
      if (!args.trim()) {
        ctx.ui.notify("Usage: /claude-cmux <prompt>", "warning");
        return;
      }
      updateStatus(ctx, "Claude launching…");
      try {
        const result = await manager.runTask(
          { prompt: args, cwd: ctx.cwd },
          { decider: makeDecider(ctx), trustDecider: makeTrustDecider(ctx) },
        );
        pi.sendMessage({ customType: "claude-cmux-result", content: result.output, display: true });
      } catch (error) {
        ctx.ui.notify(message(error), "error");
      } finally {
        updateStatus(ctx);
      }
    },
  });

  pi.registerCommand("claude-cmux-status", {
    description: "Show managed Claude Code sessions",
    handler: async (_args, ctx) => {
      const text = formatRuns(manager.listRuns());
      await ctx.ui.editor("Claude cmux sessions", text);
    },
  });

  pi.registerCommand("claude-cmux-stop", {
    description: "Stop one managed Claude session by run ID, or all when omitted",
    handler: async (args, ctx) => {
      if (args.trim()) await manager.stop(args.trim());
      else await manager.stopAll();
      updateStatus(ctx);
      ctx.ui.notify(args.trim() ? `Stopped ${args.trim()}` : "Stopped all managed Claude sessions", "info");
    },
  });

  pi.registerCommand("claude-cmux-recover", {
    description: "Reconcile cmux topology, hook state, PIDs, and resumable Claude sessions",
    handler: async (_args, ctx) => {
      updateStatus(ctx, "Claude reconciling…");
      await manager.reconcile("manual-command");
      updateStatus(ctx);
      ctx.ui.notify("Claude cmux reconciliation completed", "info");
    },
  });

  return { getManager: () => manager };
}

function formatRuns(runs: ManagedSession[]): string {
  if (runs.length === 0) return "No managed Claude sessions.";
  return runs
    .map(
      (run) =>
        `${run.runId}  ${run.state.padEnd(18)} ${run.name}\n` +
        `  cwd=${run.cwd}\n` +
        `  session=${run.sessionId ?? "pending"} surface=${run.surfaceId ?? "pending"}` +
        (run.error ? `\n  error=${run.error}` : ""),
    )
    .join("\n\n");
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
