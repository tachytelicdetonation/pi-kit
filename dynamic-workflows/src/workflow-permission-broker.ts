import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type {
  WorkflowPermissionBroker,
  WorkflowPermissionDecision,
  WorkflowPermissionRequest,
} from "./host-workflow-context.js";

export type WorkflowPermissionPolicyDecision = "allow" | "deny" | "ask";
export type WorkflowPermissionPolicy = (
  request: WorkflowPermissionRequest,
) => WorkflowPermissionPolicyDecision | Promise<WorkflowPermissionPolicyDecision>;

export interface ParentRoutedPermissionBrokerOptions {
  readonly activeToolNames: Iterable<string>;
  readonly policy: WorkflowPermissionPolicy;
  readonly ui?: Pick<ExtensionUIContext, "confirm">;
}

/**
 * Session-scoped, fail-closed broker for child tool calls. Dialogs are serialized
 * through the retained parent UI, so background children never attempt to prompt
 * from their headless process.
 */
export class ParentRoutedPermissionBroker implements WorkflowPermissionBroker {
  private readonly activeToolNames: ReadonlySet<string>;
  private readonly policy: WorkflowPermissionPolicy;
  private readonly ui?: Pick<ExtensionUIContext, "confirm">;
  private promptTail: Promise<void> = Promise.resolve();

  constructor(options: ParentRoutedPermissionBrokerOptions) {
    this.activeToolNames = new Set(options.activeToolNames);
    this.policy = options.policy;
    this.ui = options.ui;
  }

  async authorize(request: WorkflowPermissionRequest): Promise<WorkflowPermissionDecision> {
    if (request.signal?.aborted) return { allowed: false, reason: "Workflow was aborted" };
    if (!this.activeToolNames.has(request.toolName)) {
      return { allowed: false, reason: `Tool was not active when workflow ${request.runId} launched` };
    }

    let policyDecision: WorkflowPermissionPolicyDecision;
    try {
      policyDecision = await this.policy(request);
    } catch (error) {
      return { allowed: false, reason: `Permission policy failed: ${errorMessage(error)}` };
    }
    if (policyDecision === "allow") return { allowed: true };
    if (policyDecision === "deny") return { allowed: false, reason: "Denied by parent-session policy" };
    if (!this.ui) return { allowed: false, reason: "Approval required but parent UI is unavailable" };

    return this.enqueuePrompt(async () => {
      if (request.signal?.aborted) return { allowed: false, reason: "Workflow was aborted" };
      const confirmed = await this.ui?.confirm(
        `Workflow agent ${request.agentId} requests ${request.toolName}`,
        formatPermissionRequest(request),
        request.signal ? { signal: request.signal } : undefined,
      );
      return confirmed ? { allowed: true } : { allowed: false, reason: "Denied by user in the parent session" };
    });
  }

  private enqueuePrompt<T>(prompt: () => Promise<T>): Promise<T> {
    const result = this.promptTail.then(prompt, prompt);
    this.promptTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

export function createParentRoutedPermissionBroker(
  options: ParentRoutedPermissionBrokerOptions,
): WorkflowPermissionBroker {
  return new ParentRoutedPermissionBroker(options);
}

function formatPermissionRequest(request: WorkflowPermissionRequest): string {
  return [
    `Run: ${request.runId}`,
    `Agent: ${request.agentId}`,
    `Tool: ${request.toolName}`,
    `Working directory: ${request.cwd}`,
    "",
    truncate(JSON.stringify(request.input, null, 2), 4_000),
  ].join("\n");
}

function truncate(value: string, maximum: number): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n…`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
