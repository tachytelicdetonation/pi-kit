import { EventEmitter } from "node:events";
import type { AgentUsage } from "../../src/workflows/agent.js";
import type { WorkflowSnapshot } from "../../src/workflows/display.js";
import type { PersistedRunState } from "../../src/workflows/run-persistence.js";
import { WorkflowManager, type ManagedRun } from "../../src/workflows/workflow-manager.js";

const emptyUsage: AgentUsage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
};

export function deterministicAgent(usage: Partial<AgentUsage> = {}, result: unknown = "ok") {
  return {
    async run(_prompt: string, options?: { onUsage?: (value: AgentUsage) => void }) {
      options?.onUsage?.({ ...emptyUsage, ...usage });
      return result;
    },
  };
}

export function deferredAgent() {
  let resolvePromise: ((value: unknown) => void) | undefined;
  let rejectPromise: ((error: Error) => void) | undefined;
  const promise = new Promise<unknown>((resolve, reject) => {
    resolvePromise = resolve;
    rejectPromise = reject;
  });
  return {
    resolve: (value: unknown = "done") => resolvePromise?.(value),
    reject: (error: Error) => rejectPromise?.(error),
    runner: { async run() { return promise; } },
  };
}

export function delayedAgent(delayMs: number, result: unknown = "slow") {
  return {
    async run(_prompt: string, options?: { onUsage?: (value: AgentUsage) => void }) {
      await new Promise((resolve) => setTimeout(resolve, delayMs));
      options?.onUsage?.(emptyUsage);
      return result;
    },
  };
}

export function workflowSnapshot(overrides: Partial<WorkflowSnapshot> = {}): WorkflowSnapshot {
  return {
    name: "test-workflow",
    phases: [],
    logs: [],
    agents: [],
    agentCount: 0,
    runningCount: 0,
    doneCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

export function managedRun(overrides: Partial<ManagedRun> & Record<string, unknown> = {}): ManagedRun {
  return {
    runId: "test-run-1",
    background: true,
    status: "completed",
    snapshot: workflowSnapshot({
      name: "test-workflow",
      agentCount: 3,
      agents: [
        { id: 1, status: "done", label: "agent 1", prompt: "agent 1", phase: "phase-1" },
        { id: 2, status: "done", label: "agent 2", prompt: "agent 2", phase: "phase-1" },
        { id: 3, status: "done", label: "agent 3", prompt: "agent 3", phase: "phase-2" },
      ],
      phases: ["phase-1", "phase-2"],
      currentPhase: "phase-2",
      doneCount: 3,
    }),
    result: {
      agentCount: 3,
      durationMs: 1500,
      tokenUsage: { total: 50000, input: 25000, output: 25000 },
      result: { verdict: "## All tests passed\n\nEverything looks good!" },
    },
    ...overrides,
  } as ManagedRun;
}

export function eventManager(run?: unknown, runsDir?: string) {
  const manager = new EventEmitter() as EventEmitter & {
    getRun: (...args: unknown[]) => unknown;
    getPersistence?: () => { getRunsDir: () => string };
    __deliveryInstalled?: boolean;
    listRuns?: () => unknown[];
  };
  manager.getRun = () => run;
  if (runsDir) manager.getPersistence = () => ({ getRunsDir: () => runsDir });
  return manager;
}

export function workflowManager(
  cwd: string,
  options: Omit<ConstructorParameters<typeof WorkflowManager>[0], "cwd"> = {},
): WorkflowManager {
  return new WorkflowManager({ cwd, ...options });
}

export function staticManager(
  runs: PersistedRunState[],
  getRun: (runId: string) => ManagedRun | undefined = () => undefined,
): Pick<WorkflowManager, "listRuns" | "getRun"> {
  return { listRuns: () => runs, getRun };
}

export async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("Timed out waiting for workflow state");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
