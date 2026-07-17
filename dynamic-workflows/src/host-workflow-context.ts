import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, ExtensionUIContext, ToolDefinition } from "@earendil-works/pi-coding-agent";

export type WorkflowInputOrigin = "interactive" | "rpc" | "extension" | "print" | "json";
export type WorkflowHostMode = "tui" | "rpc" | "json" | "print";
export type WorkflowThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export type WorkflowPermissionMode = "default" | "accept-edits" | "auto" | "bypass";

export interface WorkflowPermissionRequest {
  readonly runId: string;
  readonly agentId: string;
  readonly toolName: string;
  readonly input: Readonly<Record<string, unknown>>;
  readonly cwd: string;
  readonly signal?: AbortSignal;
}

export interface WorkflowPermissionDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

/**
 * A session-scoped broker supplied by the host. Its implementation must retain the
 * parent session/UI routing needed by background children and must not broaden the
 * policy captured at launch.
 */
export interface WorkflowPermissionBroker {
  authorize(request: WorkflowPermissionRequest): Promise<WorkflowPermissionDecision>;
}

export interface HostWorkflowContext {
  readonly sessionId: string;
  readonly cwd: string;
  readonly inputOrigin: WorkflowInputOrigin;
  readonly mode: WorkflowHostMode;
  readonly model?: Model<any>;
  readonly thinkingLevel: WorkflowThinkingLevel;
  readonly activeToolNames: readonly string[];
  readonly activeToolDefinitions: readonly ToolDefinition[];
  readonly projectTrusted: boolean;
  readonly permissionMode: WorkflowPermissionMode;
  readonly permissionBroker: WorkflowPermissionBroker;
  /** Parent invocation context used only when executing snapshotted proxy tools. */
  readonly toolExecutionContext?: ExtensionContext;
  readonly uiBroker?: ExtensionUIContext;
  readonly abortSignal?: AbortSignal;
}

export interface CreateHostWorkflowContextOptions
  extends Omit<HostWorkflowContext, "activeToolDefinitions" | "activeToolNames"> {
  activeToolNames: Iterable<string>;
  activeToolDefinitions: Iterable<ToolDefinition>;
}

export class HostWorkflowCapabilityError extends Error {
  readonly code = "HOST_CAPABILITY_UNAVAILABLE";

  constructor(message: string) {
    super(message);
    this.name = "HostWorkflowCapabilityError";
  }
}

function freezeToolDefinition(definition: ToolDefinition): ToolDefinition {
  return Object.freeze({ ...definition });
}

/** Build the immutable launch-time contract consumed by workflow subagents. */
export function createHostWorkflowContext(options: CreateHostWorkflowContextOptions): HostWorkflowContext {
  const activeToolNames = Object.freeze([...new Set(options.activeToolNames)]);
  const definitionsByName = new Map(
    [...options.activeToolDefinitions].map((definition) => [definition.name, freezeToolDefinition(definition)]),
  );
  const missing = activeToolNames.filter((name) => !definitionsByName.has(name));
  if (missing.length > 0) {
    throw new HostWorkflowCapabilityError(
      `Host did not provide executable definitions for active tools: ${missing.join(", ")}`,
    );
  }

  const activeToolDefinitions = Object.freeze(
    activeToolNames.map((name) => definitionsByName.get(name) as ToolDefinition),
  );
  return Object.freeze({
    sessionId: options.sessionId,
    cwd: options.cwd,
    inputOrigin: options.inputOrigin,
    mode: options.mode,
    model: options.model,
    thinkingLevel: options.thinkingLevel,
    activeToolNames,
    activeToolDefinitions,
    projectTrusted: options.projectTrusted,
    permissionMode: options.permissionMode,
    permissionBroker: options.permissionBroker,
    toolExecutionContext: options.toolExecutionContext,
    uiBroker: options.uiBroker,
    abortSignal: options.abortSignal,
  });
}
