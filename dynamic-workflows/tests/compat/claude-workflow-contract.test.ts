import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import test from "node:test";
import {
  CLAUDE_WORKFLOW_CONTRACT,
  CLAUDE_WORKFLOW_ORACLE_VERSION,
  canTransitionClaudeWorkflow,
  resolveClaudeWorkflowInvocationSource,
  shouldTriggerClaudeWorkflowKeyword,
  shouldWarnForLargeClaudeWorkflow,
} from "../../src/claude-workflow-contract.js";
import { MAX_AGENTS_PER_RUN, MAX_CONCURRENCY } from "../../src/config.js";
import { type JournalEntry, runWorkflow } from "../../src/workflow.js";

test("contract is pinned to the latest frozen Claude workflow oracle", () => {
  assert.equal(CLAUDE_WORKFLOW_ORACLE_VERSION, "2.1.212");
  assert.equal(CLAUDE_WORKFLOW_CONTRACT.oracleVersion, CLAUDE_WORKFLOW_ORACLE_VERSION);
  assert.ok(Object.isFrozen(CLAUDE_WORKFLOW_CONTRACT));
});

test("INV-01 source resolution follows scriptPath > script > name", () => {
  assert.equal(resolveClaudeWorkflowInvocationSource({ name: "saved" }), "name");
  assert.equal(resolveClaudeWorkflowInvocationSource({ script: "inline", name: "saved" }), "script");
  assert.equal(
    resolveClaudeWorkflowInvocationSource({ scriptPath: "run.js", script: "inline", name: "saved" }),
    "scriptPath",
  );
  assert.throws(() => resolveClaudeWorkflowInvocationSource({}), /INVALID_INVOCATION/);
  assert.throws(() => resolveClaudeWorkflowInvocationSource({ script: "  " }), /INVALID_INVOCATION/);
});

test("RUN-03 runtime limits are consumed by legacy configuration exports", () => {
  assert.equal(MAX_CONCURRENCY, 16);
  assert.equal(MAX_AGENTS_PER_RUN, 1_000);
  assert.equal(MAX_CONCURRENCY, CLAUDE_WORKFLOW_CONTRACT.runtime.maximumConcurrentAgents);
  assert.equal(MAX_AGENTS_PER_RUN, CLAUDE_WORKFLOW_CONTRACT.runtime.maximumAgentsPerRun);
});

test("AGT-02 label, effort, and isolation independently invalidate the journal hash", async () => {
  const hashFor = async (options: string): Promise<string> => {
    const journal: JournalEntry[] = [];
    await runWorkflow(
      `export const meta = { name: 'hash', description: 'hash options' }
return await agent('work', ${options})`,
      {
        agent: { run: async () => "ok" },
        cwd: tmpdir(),
        persistLogs: false,
        onAgentJournal: (entry) => journal.push(entry),
      },
    );
    assert.equal(journal.length, 1);
    return journal[0].hash;
  };

  const baseline = await hashFor("{ label: 'a', effort: 'low' }");
  assert.notEqual(await hashFor("{ label: 'b', effort: 'low' }"), baseline);
  assert.notEqual(await hashFor("{ label: 'a', effort: 'high' }"), baseline);
  assert.notEqual(await hashFor("{ label: 'a', effort: 'low', isolation: 'worktree' }"), baseline);
});

test("lifecycle table permits only contract transitions", () => {
  assert.equal(canTransitionClaudeWorkflow("pending", "running"), true);
  assert.equal(canTransitionClaudeWorkflow("running", "paused"), true);
  assert.equal(canTransitionClaudeWorkflow("paused", "running"), true);
  assert.equal(canTransitionClaudeWorkflow("running", "completed"), true);
  assert.equal(canTransitionClaudeWorkflow("completed", "running"), false);
  assert.equal(canTransitionClaudeWorkflow("stopped", "running"), false);
});

test("TRG-01 keyword trigger is restricted to human origin", () => {
  assert.equal(shouldTriggerClaudeWorkflowKeyword(true, "human"), true);
  for (const origin of ["print", "rpc", "extension", "scheduled", "webhook"] as const) {
    assert.equal(shouldTriggerClaudeWorkflowKeyword(true, origin), false);
  }
  assert.equal(shouldTriggerClaudeWorkflowKeyword(false, "human"), false);
});

test("UI-02 large workflow threshold is strict and suppressed by Ultracode", () => {
  assert.equal(shouldWarnForLargeClaudeWorkflow(25, 1_500_000, false), false);
  assert.equal(shouldWarnForLargeClaudeWorkflow(26, 0, false), true);
  assert.equal(shouldWarnForLargeClaudeWorkflow(0, 1_500_001, false), true);
  assert.equal(shouldWarnForLargeClaudeWorkflow(100, 2_000_000, true), false);
});
