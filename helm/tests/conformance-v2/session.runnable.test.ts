import assert from "node:assert/strict";
import test from "node:test";
import { createWorkflowPort } from "../../src/host/adapters.js";
import { renderReceipts, renderSession } from "../../src/screens/session.js";
import type { ActivityLine, Session } from "../../src/state/types.js";
import type { PersistedRunState } from "../../src/workflows/run-persistence.js";
import type { WorkflowManager } from "../../src/workflows/workflow-manager.js";
import { stripAnsi, stripLines, theme256 } from "./helpers.js";

function runWithHistory(history: PersistedRunState["agents"][number]["history"]): PersistedRunState {
  return {
    runId: "run-contract",
    workflowName: "conformance",
    script: "",
    args: { helmGoalId: "goal-contract", helmWorkflowName: "verification", goalName: "contract goal" },
    status: "completed",
    phases: ["Execute", "Verify"],
    agents: [{
      id: 1,
      label: "contract-agent",
      prompt: "exercise the adapter",
      status: "done",
      history,
    }],
    logs: [],
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T00:01:00.000Z",
  };
}

function adapt(run: PersistedRunState): Session {
  const manager = {
    listAllRuns: () => [run],
    listRuns: () => [run],
    on() {},
    off() {},
  } as unknown as WorkflowManager;
  const cmux = { listRuns: () => [] };
  const port = createWorkflowPort(manager, () => cmux as never);
  const session = port.getSession(`${run.runId}::1`);
  assert.ok(session, "adapter returns a session for a persisted run agent");
  return session;
}

test("Session row: consecutive reads, greps, and read-only bash collapse to exactly one context row", () => {
  const session = adapt(runWithHistory([
    { role: "assistant", kind: "toolCall", toolName: "Read", text: '{"path":"src/a.ts"}', timestamp: 1_000 },
    { role: "assistant", kind: "toolCall", toolName: "Grep", text: '{"query":"needle"}', timestamp: 2_000 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"git status --short"}', timestamp: 3_000 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"rg --files src"}', timestamp: 4_000 },
  ]));
  const context = session.lines.filter((line) => line.verb === "context");
  assert.equal(context.length, 1);
  assert.match(`${context[0]?.target} ${context[0]?.result}`, /4/);
  assert.equal(session.lines.some((line) => line.verb === "verify"), false, "read-only bash is never verification");
});

test("Session row: concurrent tool calls become one parallel row with joined summaries", () => {
  const session = adapt(runWithHistory([
    { role: "assistant", kind: "toolCall", toolName: "Read", text: '{"path":"src/a.ts"}', timestamp: 1_000 },
    { role: "assistant", kind: "toolCall", toolName: "Grep", text: '{"query":"alpha"}', timestamp: 1_000 },
    { role: "assistant", kind: "toolCall", toolName: "Read", text: '{"path":"src/b.ts"}', timestamp: 1_000 },
  ]));
  assert.equal(session.lines.length, 1);
  assert.equal(session.lines[0]?.verb, "parallel");
  assert.match(session.lines[0]?.target ?? "", /a\.ts|Read/i);
  assert.match(session.lines[0]?.target ?? "", /alpha|Grep/i);
});

test("Session row: only tests, builds, and lint classify as verify", () => {
  const session = adapt(runWithHistory([
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"npm test"}', timestamp: 1 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"npm run build"}', timestamp: 2 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"npm run lint"}', timestamp: 3 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"pwd && find src -type f"}', timestamp: 4 },
  ]));
  const verify = session.lines.filter((line) => line.verb === "verify");
  assert.equal(verify.length, 3);
  assert.ok(verify.some((line) => /test/i.test(line.target)));
  assert.ok(verify.some((line) => /build/i.test(line.target)));
  assert.ok(verify.some((line) => /lint/i.test(line.target)));
  assert.equal(session.lines.at(-1)?.verb, "context");
});

test("Session row: edit adaptation preserves the real path and measured +N −N", () => {
  const session = adapt(runWithHistory([
    {
      role: "assistant",
      kind: "toolCall",
      toolName: "Edit",
      text: JSON.stringify({ path: "src/deep/real-file.ts", oldText: "a\nb\nc\n", newText: "a\nB\nc\nd\ne\n" }),
      timestamp: 1,
    },
  ]));
  assert.deepEqual(session.lines.map((line) => ({ verb: line.verb, target: line.target, added: line.added, removed: line.removed })), [
    { verb: "edit", target: "src/deep/real-file.ts", added: 3, removed: 1 },
  ]);
});

test("Session row: a 500-line edit renders at most three numbered content lines plus the exact remainder", () => {
  const peek = Array.from({ length: 500 }, (_, index) => `${index + 1} + hostile-${index + 1}`);
  const line: ActivityLine = {
    verb: "edit",
    target: "src/huge.ts",
    result: "",
    expandable: true,
    peek,
    moreCount: 497,
    added: 500,
    removed: 0,
  };
  const session: Session = {
    worktreeId: "wt-huge",
    task: "large edit",
    prompt: "do not stream the file",
    receipts: { build: true, lint: true, tests: 999 },
    lines: [line],
    claim: "done",
  };
  const rendered = stripLines(renderSession(session, theme256, 120, 40, 0, new Set([0])));
  const content = rendered.filter((value) => /^\s+\d+ [+−]/.test(value));
  assert.equal(content.length, 3);
  assert.ok(rendered.some((value) => value.includes("… 497 more · d full diff")));
  assert.equal(rendered.some((value) => value.includes("hostile-4")), false);
});

test("Session row: receipt rendering keeps build, lint, and the real test total distinct", () => {
  const mixed = stripAnsi(renderReceipts(theme256, { build: true, lint: false, tests: 2_431 }));
  assert.match(mixed, /✓ build/);
  assert.match(mixed, /✕ lint/);
  assert.match(mixed, /2,?431 tests/);
});

test("Session row: adapter receipts use parsed build/lint/test evidence rather than a generic success", () => {
  const session = adapt(runWithHistory([
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"npm run build"}', timestamp: 1 },
    { role: "tool", kind: "toolResult", toolName: "Bash", text: "build passed", timestamp: 2 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"npm run lint"}', timestamp: 3 },
    { role: "tool", kind: "error", toolName: "Bash", text: "lint failed", isError: true, timestamp: 4 },
    { role: "assistant", kind: "toolCall", toolName: "Bash", text: '{"command":"npm test"}', timestamp: 5 },
    { role: "tool", kind: "toolResult", toolName: "Bash", text: "2431 tests passed", timestamp: 6 },
  ]));
  assert.deepEqual(session.receipts, { build: true, lint: false, tests: 2_431 });
});
