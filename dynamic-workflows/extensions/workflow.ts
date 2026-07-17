import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  createEffortState,
  createHostWorkflowContext,
  createParentRoutedPermissionBroker,
  createWorkflowApprovalStore,
  createWorkflowStorage,
  createWorkflowTool,
  installResultDelivery,
  installTaskPanel,
  installWorkflowEditor,
  loadWorkflowSettings,
  registerAllSavedWorkflows,
  registerBuiltinWorkflows,
  registerEffortCommand,
  registerWorkflowCommands,
  registerWorkflowModelsCommand,
  saveWorkflowSettingsForCwd,
  UsageLimitScheduler,
  WorkflowManager,
  workflowLaunchApprovalRequirement,
} from "../src/index.js";

export default function extension(pi: ExtensionAPI) {
  // Single manager/storage shared by the workflow tool and the /workflows command,
  // so background runs started by the tool are reachable from the command.
  const cwd = process.cwd();
  let lastInputOrigin: "interactive" | "rpc" | "extension" = "interactive";
  pi.on("input", (event) => {
    lastInputOrigin = event.source;
  });
  const storage = createWorkflowStorage(cwd);
  const approvalStore = createWorkflowApprovalStore();
  const effort = createEffortState();
  const settings = loadWorkflowSettings({ cwd });
  const manager = new WorkflowManager({
    cwd,
    loadSavedWorkflow: (name) => storage.load(name)?.script,
    defaultAgentTimeoutMs: settings.defaultAgentTimeoutMs ?? null,
    concurrency: settings.defaultConcurrency,
    defaultAgentRetries: settings.defaultAgentRetries,
    persistAgentSessions: settings.persistAgentSessions,
  });

  const workflowTool = createWorkflowTool({
    cwd,
    manager,
    storage,
    async reviewLaunch(review) {
      const identity = {
        projectCwd: review.ctx.cwd,
        workflowName: review.workflowName,
        sourceLocation: review.sourcePath ?? `<inline:${review.workflowName}>`,
      };
      const requirement = workflowLaunchApprovalRequirement({
        permissionMode: review.ctx.hasUI ? "default" : "headless",
        hasUI: review.ctx.hasUI,
        ultracode: effort.level === "ultra",
        permanentlyApproved: approvalStore.has(identity),
        autoConsentRecorded: false,
      });
      if (!requirement.required) return { approved: true };

      let script = review.script;
      while (true) {
        const action = await review.ctx.ui.select("Run generated workflow?", [
          "Run once",
          "Always allow this workflow",
          "View script",
          "Edit script",
          "Deny",
        ]);
        if (action === "Run once") return { approved: true, script };
        if (action === "Always allow this workflow") {
          approvalStore.approve(identity);
          return { approved: true, script };
        }
        if (action === "View script") {
          await review.ctx.ui.editor("Workflow script (review only)", script);
          continue;
        }
        if (action === "Edit script") {
          const edited = await review.ctx.ui.editor("Edit workflow before launch", script);
          if (edited !== undefined) script = edited;
          continue;
        }
        return { approved: false };
      }
    },
    createHostContext(ctx, signal) {
      // Newer workflow-capable Pi hosts expose executable definitions. Older hosts
      // intentionally fall back rather than recreating executable tools from
      // getAllTools() metadata.
      const workflowHost = pi as ExtensionAPI & {
        getWorkflowHostCapabilities?: () => {
          executableActiveToolDefinitions?: boolean;
          cwdAwareBuiltinDefinitions?: boolean;
        };
        getActiveToolDefinitions?: () => readonly ToolDefinition[];
      };
      const capabilities = workflowHost.getWorkflowHostCapabilities?.call(pi);
      const getDefinitions = workflowHost.getActiveToolDefinitions;
      if (
        !getDefinitions ||
        !capabilities?.executableActiveToolDefinitions ||
        !capabilities.cwdAwareBuiltinDefinitions
      ) {
        return undefined;
      }
      const activeToolNames = pi.getActiveTools();
      const permissionBroker = createParentRoutedPermissionBroker({
        activeToolNames,
        policy: () => "ask",
        ui: ctx.hasUI ? ctx.ui : undefined,
      });
      return createHostWorkflowContext({
        sessionId: ctx.sessionManager.getSessionId(),
        cwd: ctx.cwd,
        inputOrigin: lastInputOrigin,
        mode: ctx.mode,
        model: ctx.model,
        thinkingLevel: pi.getThinkingLevel(),
        activeToolNames,
        activeToolDefinitions: getDefinitions.call(pi),
        projectTrusted: ctx.isProjectTrusted(),
        permissionMode: "default",
        permissionBroker,
        toolExecutionContext: ctx,
        uiBroker: ctx.hasUI ? ctx.ui : undefined,
        abortSignal: signal,
      });
    },
  });
  pi.registerTool(workflowTool);
  // Auto-resume runs that paused on a provider usage limit once the quota is
  // likely refilled. Standalone: only consumes the manager's public surface, so
  // it stays decoupled from manager/persistence internals. Its constructor also
  // re-arms any run that was already paused-on-usage_limit before this process
  // started (cold start), so restarting pi doesn't strand a paused run.
  const usageLimitScheduler = new UsageLimitScheduler(manager);
  pi.on("session_shutdown", () => {
    usageLimitScheduler.dispose();
  });
  // Standing /effort opt-in (off|high|ultra): auto-arms a workflow for substantive
  // messages, like CC's ultracode. Shared with launch approval, the editor input
  // hook below, and the explicit /workflows run <prompt> manual trigger.
  registerWorkflowCommands(pi, manager, { storage, cwd, effort });
  registerWorkflowModelsCommand(pi);
  registerBuiltinWorkflows(pi, { cwd });
  registerAllSavedWorkflows(pi, cwd, storage, manager);
  registerEffortCommand(pi, effort);
  // "Workflows mode": type `workflow(s)` to arm a forced workflow (animated),
  // Backspace right after the word disarms it. Registers the `input` hook now;
  // the editor itself is installed once the UI is available (session_start).
  let editorInstalled = false;

  pi.on("session_start", (_event: unknown, ctx: ExtensionContext) => {
    // Tell the manager the session's main model so "explore" agents auto-tier
    // down to a lighter same-family sibling (e.g. Claude → Haiku).
    manager.setMainModel(ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
    // Share the host session's model registry so tier/phase routing resolves
    // extension-registered providers (e.g. ollama-cloud) consistently. Set it
    // before activating the tool: the tool's promptGuidelines read the
    // manager's registry lazily, so tool-registry refreshes from here on
    // advertise the shared registry's models.
    manager.setModelRegistry(ctx.modelRegistry);
    const active = pi.getActiveTools();
    if (!active.includes(workflowTool.name)) {
      pi.setActiveTools([...active, workflowTool.name]);
    }
    // Scope the /workflows history to this session: runs persist on disk across
    // sessions, but the navigator/task panel show only the current session's runs.
    // Switching back to a previous session re-shows that session's runs.
    try {
      manager.setSessionId(ctx.sessionManager?.getSessionId());
    } catch {
      // sessionManager may be unavailable in some contexts — fall back to global history.
    }
    // Deliver a background run's result into the conversation when it finishes.
    // The live settings loader lets `deliveredResultMaxChars` take effect without
    // a restart.
    installResultDelivery(pi, manager, { loadSettings: () => loadWorkflowSettings({ cwd }) });
    // Live "workflows running" panel below the input (focus + enter to open).
    // Pass a live settings loader so /workflows-progress (compact|detailed) takes
    // effect without a restart.
    installTaskPanel(pi, manager, ctx.ui, { storage, cwd, loadSettings: () => loadWorkflowSettings({ cwd }) });
    if (!editorInstalled) {
      installWorkflowEditor(pi, ctx.ui, effort, {
        settingsStore: {
          load: () => loadWorkflowSettings({ cwd }),
          save: (nextSettings) => saveWorkflowSettingsForCwd(nextSettings, cwd),
        },
      });
      editorInstalled = true;
    }
  });
}
