import type { UsagePort, WorkflowPort } from "../data/ports.js";
import type { Workflow } from "../state/types.js";
import type { ClaudeFleetManager } from "../cmux/fleet-manager.js";
import type { UsageHealthHandle } from "../usage/register.js";
import { providerRemaining } from "../usage/types.js";
import type { WorkflowManager } from "../workflows/workflow-manager.js";

export function createWorkflowPort(manager: WorkflowManager, getCmux: () => ClaudeFleetManager): WorkflowPort {
  return {
    listWorkflows() {
      const dwLanes: Workflow[] = manager.listRuns()
        .filter((run) => ["pending", "running", "paused"].includes(run.status))
        .map((run) => ({
          id: run.runId,
          goalId: "",
          name: run.workflowName,
          state: run.status === "running" ? "running" : run.status === "paused" ? "paused" : "queued",
          summary: run.currentPhase ?? run.status,
        }));
      const cmuxLanes: Workflow[] = getCmux().listRuns()
        .filter((run) => !["terminated", "failed"].includes(run.state))
        .map((run) => ({
          id: run.runId,
          goalId: "",
          name: run.name,
          state: "running",
          summary: run.state,
        }));
      return [...dwLanes, ...cmuxLanes];
    },
    getDrillIn: () => undefined,
    getSession: () => undefined,
    pauseWorkflow(id) {
      if (manager.listRuns().some((run) => run.runId === id)) manager.pause(id);
    },
    subscribe(cb) {
      const events = ["complete", "paused", "resumed", "stopped", "error", "phase", "agentStart", "agentEnd"];
      for (const event of events) manager.on(event, cb);
      return () => {
        for (const event of events) manager.off(event, cb);
      };
    },
  };
}

export function createUsagePort(handle: UsageHealthHandle): UsagePort {
  return {
    getFooter() {
      const view = handle.service.getView();
      return {
        providers: view.providers.map((provider) => ({
          id: provider.provider,
          remaining: providerRemaining(provider.snapshot),
        })),
      };
    },
    getUsageDetail() {
      const view = handle.service.getView();
      return {
        providers: view.providers.map((provider) => {
          const resetsAt = provider.snapshot?.buckets
            .filter((bucket) => bucket.affectsHealth !== false && bucket.resetsAt !== undefined)
            .reduce<number | undefined>(
              (earliest, bucket) => earliest === undefined ? bucket.resetsAt : Math.min(earliest, bucket.resetsAt!),
              undefined,
            );
          let resetText: string;
          if (resetsAt === undefined) {
            resetText = "reset unknown";
          } else {
            const ms = resetsAt - view.now;
            resetText = ms >= 24 * 3_600_000
              ? `resets in ${Math.round(ms / 86_400_000)}d`
              : `resets in ${Math.max(1, Math.round(ms / 3_600_000))}h`;
          }
          return {
            id: provider.provider,
            remaining: providerRemaining(provider.snapshot) ?? 0,
            resetText,
          };
        }),
        spendToday: "—",
        spendWeek: "—",
        perGoal: [],
      };
    },
    subscribe: handle.subscribe,
  };
}
