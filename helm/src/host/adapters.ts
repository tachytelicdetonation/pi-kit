import type { UsageAccountingSnapshot, UsageCostRecord, UsagePort, WorkflowGoalMetrics, WorkflowPort } from "../data/ports.js";
import type { ActivityLine, LoopDraft, Session, Workflow, WorkflowDetail, Worktree } from "../state/types.js";
import type { ClaudeFleetManager } from "../cmux/fleet-manager.js";
import type { UsageHealthHandle } from "../usage/register.js";
import { PROVIDER_ORDER, providerRemaining } from "../usage/types.js";
import type { AgentHistoryEntry } from "../workflows/agent-history.js";
import type { PersistedAgentState, PersistedRunState } from "../workflows/run-persistence.js";
import type { WorkflowManager } from "../workflows/workflow-manager.js";

interface HelmRunArgs {
  helmGoalId?: string;
  helmWorkflowName?: string;
  helmLoopId?: string;
  goalName?: string;
  prompt?: string;
}

function runArgs(run: PersistedRunState): HelmRunArgs {
  return run.args && typeof run.args === "object" ? run.args as HelmRunArgs : {};
}

function helmRuns(manager: WorkflowManager): PersistedRunState[] {
  return manager.listAllRuns().filter((run) => {
    const args = runArgs(run);
    return Boolean(args.helmGoalId || args.helmLoopId);
  });
}

function runSummary(run: PersistedRunState): string {
  if (run.status === "paused" && run.pauseReason) return run.pauseReason.replaceAll("_", " ");
  if (run.currentPhase) return run.currentPhase;
  const running = run.agents.filter((agent) => agent.status === "running").length;
  const done = run.agents.filter((agent) => agent.status === "done").length;
  return running ? `${running} agents working` : run.agents.length ? `${done}/${run.agents.length} agents done` : run.status;
}

function worktreeFor(run: PersistedRunState, agent: PersistedAgentState): Worktree {
  const stage = /verif|review|test/i.test(agent.phase ?? agent.label)
    ? "review" as const
    : agent.status === "done" ? "apply" as const : "fix" as const;
  const testState = agent.status === "error" ? "red" as const
    : agent.status === "done" ? "green" as const : "wobbling" as const;
  return {
    id: `${run.runId}::${agent.id}`,
    name: agent.label || `agent-${agent.id}`,
    package: agent.phase ?? run.workflowName,
    chips: [{ stage }],
    appliedText: agent.status === "done" ? "work complete" : agent.status === "error" ? "needs attention" : agent.status,
    testState,
    modelTag: agent.model,
    testTicks: agent.status === "done" ? ["green"] : agent.status === "error" ? ["red"] : [],
    raceStatus: testState,
  };
}

function detailFor(run: PersistedRunState): WorkflowDetail {
  const args = runArgs(run);
  const worktrees = run.agents.map((agent) => worktreeFor(run, agent));
  const total = Math.max(1, run.agents.length);
  const remaining = run.agents.filter((agent) => !["done", "skipped"].includes(agent.status)).length;
  return {
    workflowId: run.runId,
    label: `${args.goalName ?? "goal"} › ${args.helmWorkflowName ?? run.workflowName}`,
    lanes: Math.max(1, run.phases.length),
    agents: run.agents.length,
    queueRemaining: remaining,
    queueTotal: total,
    queueUnit: "agents",
    burnPerHr: run.status === "running" ? Math.max(1, total - remaining) : 0,
    etaText: run.status === "completed" ? "done" : run.status,
    queueNote: runSummary(run),
    worktrees,
  };
}

type HistoryCategory = "context" | "verify" | "edit";

interface HistoryCall {
  entry: AgentHistoryEntry;
  result?: AgentHistoryEntry;
  category: HistoryCategory;
  summary: string;
}

interface DiffReceipt {
  path: string;
  added: number;
  removed: number;
  peek: string[];
  moreCount: number;
}

interface VerificationReceipt {
  kind: "build" | "lint" | "test";
  passed: boolean;
  tests: number;
  summary: string;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function structuredText(text: string): Record<string, unknown> | undefined {
  try {
    return asRecord(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function stringField(record: Record<string, unknown> | undefined, ...keys: string[]): string | undefined {
  for (const key of keys) if (typeof record?.[key] === "string") return record[key] as string;
  return undefined;
}

function commandFor(entry: AgentHistoryEntry): string {
  const args = structuredText(entry.text);
  return stringField(args, "cmd", "command", "script") ?? entry.text;
}

function isVerificationCommand(command: string, tool: string): boolean {
  return /(?:^|[-_])(test|tests|lint|build|check|verify)(?:$|[-_])/.test(tool)
    || /(?:^|[;&|]\s*)(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|lint|build|check)\b/i.test(command)
    || /\b(?:pytest|vitest|jest|mocha|cargo\s+test|go\s+test|tsc\b|eslint\b|ruff\s+(?:check|format\s+--check))/.test(command);
}

function isReadOnlyCommand(command: string): boolean {
  if (!command.trim() || /(?:^|[^<])>(?!>)|\b(?:rm|mv|cp|touch|mkdir|install|unlink|truncate)\b|\bsed\s+-i\b|\bgit\s+(?:add|commit|merge|rebase|checkout|switch|reset|clean)\b/i.test(command)) return false;
  const segments = command.split(/&&|\|\||;/).map((part) => part.trim()).filter(Boolean);
  return segments.length > 0 && segments.every((part) => /^(?:env\s+\S+=\S+\s+)*(?:cd\s+\S+|rg|grep|find|fd|ls|cat|head|tail|wc|pwd|which|type|stat|file|jq|sed\s+-n|git\s+(?:status|diff|log|show|rev-parse|branch\s+--show-current))\b/i.test(part));
}

function categoryFor(entry: AgentHistoryEntry): HistoryCategory | undefined {
  const tool = entry.toolName?.toLowerCase() ?? "";
  if (/(?:^|[-_])(edit|write|patch)(?:$|[-_])/.test(tool) || tool === "apply_patch") return "edit";
  const command = commandFor(entry);
  if (isVerificationCommand(command, tool)) return "verify";
  if (/(?:^|[-_])(read|find|grep|search|list|glob)(?:$|[-_])/.test(tool)) return "context";
  if (/(exec|bash|command|shell)/.test(tool) && isReadOnlyCommand(command)) return "context";
  return undefined;
}

function pairedResult(history: AgentHistoryEntry[], callIndex: number): AgentHistoryEntry | undefined {
  const call = history[callIndex]!;
  const tool = call.toolName?.toLowerCase();
  for (let i = callIndex + 1; i < history.length; i += 1) {
    const candidate = history[i]!;
    if (candidate.kind === "toolResult" || candidate.kind === "error") {
      if (!tool || candidate.toolName?.toLowerCase() === tool) return candidate;
    }
  }
  return undefined;
}

function pathFromCall(entry: AgentHistoryEntry): string {
  const args = structuredText(entry.text);
  const explicit = stringField(args, "path", "file_path", "filePath", "file", "target");
  if (explicit) return explicit;
  const patch = stringField(args, "patch", "diff", "content") ?? entry.text;
  return patch.match(/^\*\*\* (?:Update|Add|Delete) File:\s*(.+)$/m)?.[1]?.trim()
    ?? patch.match(/^\+\+\+\s+(?:b\/)?(.+)$/m)?.[1]?.trim()
    ?? "unknown file";
}

function textLines(value: string): string[] {
  return value ? value.replace(/\n$/, "").split("\n") : [];
}

const MAX_LCS_LINES_PER_SIDE = 1_500;
const MAX_DIFF_PREVIEW_LINES = 3;

interface LineDiff {
  added: number;
  removed: number;
  peek: string[];
  moreCount: number;
}

function lineDiff(oldText: string, newText: string): LineDiff {
  if (oldText === newText) return { added: 0, removed: 0, peek: [], moreCount: 0 };

  const oldLines = textLines(oldText);
  const newLines = textLines(newText);
  const peek: string[] = [];
  const remember = (line: string): void => {
    if (peek.length < MAX_DIFF_PREVIEW_LINES) peek.push(line);
  };

  if (oldLines.length === 0) {
    for (let index = 0; index < Math.min(newLines.length, MAX_DIFF_PREVIEW_LINES); index += 1) {
      remember(`${index + 1} + ${newLines[index]}`);
    }
    return { added: newLines.length, removed: 0, peek, moreCount: Math.max(0, newLines.length - peek.length) };
  }
  if (newLines.length === 0) {
    for (let index = 0; index < Math.min(oldLines.length, MAX_DIFF_PREVIEW_LINES); index += 1) {
      remember(`${index + 1} − ${oldLines[index]}`);
    }
    return { added: 0, removed: oldLines.length, peek, moreCount: Math.max(0, oldLines.length - peek.length) };
  }

  let prefixLength = 0;
  while (
    prefixLength < oldLines.length
    && prefixLength < newLines.length
    && oldLines[prefixLength] === newLines[prefixLength]
  ) prefixLength += 1;

  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (
    oldEnd > prefixLength
    && newEnd > prefixLength
    && oldLines[oldEnd - 1] === newLines[newEnd - 1]
  ) {
    oldEnd -= 1;
    newEnd -= 1;
  }

  const oldMiddle = oldLines.slice(prefixLength, oldEnd);
  const newMiddle = newLines.slice(prefixLength, newEnd);
  if (oldMiddle.length === 0 || newMiddle.length === 0) {
    for (let index = 0; index < oldMiddle.length; index += 1) {
      remember(`${prefixLength + index + 1} − ${oldMiddle[index]}`);
    }
    for (let index = 0; index < newMiddle.length; index += 1) {
      remember(`${prefixLength + index + 1} + ${newMiddle[index]}`);
    }
    const changed = oldMiddle.length + newMiddle.length;
    return { added: newMiddle.length, removed: oldMiddle.length, peek, moreCount: Math.max(0, changed - peek.length) };
  }

  if (oldMiddle.length > MAX_LCS_LINES_PER_SIDE || newMiddle.length > MAX_LCS_LINES_PER_SIDE) {
    for (let index = 0; index < oldMiddle.length && peek.length < MAX_DIFF_PREVIEW_LINES; index += 1) {
      remember(`${prefixLength + index + 1} − ${oldMiddle[index]}`);
    }
    for (let index = 0; index < newMiddle.length && peek.length < MAX_DIFF_PREVIEW_LINES; index += 1) {
      remember(`${prefixLength + index + 1} + ${newMiddle[index]}`);
    }
    const changed = oldMiddle.length + newMiddle.length;
    return { added: newMiddle.length, removed: oldMiddle.length, peek, moreCount: Math.max(0, changed - peek.length) };
  }

  const columns = newMiddle.length + 1;
  const lengths = new Uint32Array((oldMiddle.length + 1) * columns);
  const at = (oldIndex: number, newIndex: number): number => oldIndex * columns + newIndex;

  for (let oldIndex = oldMiddle.length - 1; oldIndex >= 0; oldIndex -= 1) {
    for (let newIndex = newMiddle.length - 1; newIndex >= 0; newIndex -= 1) {
      lengths[at(oldIndex, newIndex)] = oldMiddle[oldIndex] === newMiddle[newIndex]
        ? lengths[at(oldIndex + 1, newIndex + 1)]! + 1
        : Math.max(lengths[at(oldIndex + 1, newIndex)]!, lengths[at(oldIndex, newIndex + 1)]!);
    }
  }

  let oldIndex = 0;
  let newIndex = 0;
  let added = 0;
  let removed = 0;
  while (oldIndex < oldMiddle.length || newIndex < newMiddle.length) {
    if (oldIndex < oldMiddle.length && newIndex < newMiddle.length && oldMiddle[oldIndex] === newMiddle[newIndex]) {
      oldIndex += 1;
      newIndex += 1;
    } else if (newIndex < newMiddle.length && (oldIndex >= oldMiddle.length || lengths[at(oldIndex, newIndex + 1)]! > lengths[at(oldIndex + 1, newIndex)]!)) {
      added += 1;
      remember(`${prefixLength + newIndex + 1} + ${newMiddle[newIndex]}`);
      newIndex += 1;
    } else {
      removed += 1;
      remember(`${prefixLength + oldIndex + 1} − ${oldMiddle[oldIndex]}`);
      oldIndex += 1;
    }
  }
  return { added, removed, peek, moreCount: Math.max(0, added + removed - peek.length) };
}

function diffReceipt(entry: AgentHistoryEntry, result?: AgentHistoryEntry): DiffReceipt {
  const args = structuredText(entry.text);
  const resultRecord = result ? structuredText(result.text) : undefined;
  const path = stringField(resultRecord, "path", "file_path", "filePath", "file") ?? pathFromCall(entry);
  const patch = stringField(resultRecord, "diff", "patch")
    ?? stringField(args, "patch", "diff")
    ?? (/^@@|^\*\*\* (?:Update|Add|Delete) File:/m.test(entry.text) ? entry.text : "");
  const explicitAdded = typeof resultRecord?.added === "number" ? resultRecord.added : undefined;
  const explicitRemoved = typeof resultRecord?.removed === "number" ? resultRecord.removed : undefined;
  const oldText = stringField(args, "oldText", "old_text");
  const newText = stringField(args, "newText", "new_text", "content");
  let oldLine = 1;
  let newLine = 1;
  let added = 0;
  let removed = 0;
  let measuredMoreCount: number | undefined;
  const peek: string[] = [];
  const remember = (line: string): void => {
    if (peek.length < MAX_DIFF_PREVIEW_LINES) peek.push(line);
  };
  for (const raw of patch.split("\n")) {
    const hunk = raw.match(/^@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
    } else if (raw.startsWith("+") && !raw.startsWith("+++")) {
      added += 1;
      remember(`${newLine} + ${raw.slice(1)}`);
      newLine += 1;
    } else if (raw.startsWith("-") && !raw.startsWith("---")) {
      removed += 1;
      remember(`${oldLine} − ${raw.slice(1)}`);
      oldLine += 1;
    } else if (!raw.startsWith("\\") && !raw.startsWith("***")) {
      oldLine += 1;
      newLine += 1;
    }
  }
  if (!patch && (oldText !== undefined || newText !== undefined)) {
    const measured = lineDiff(oldText ?? "", newText ?? "");
    removed = measured.removed;
    added = measured.added;
    peek.push(...measured.peek);
    measuredMoreCount = measured.moreCount;
  }
  added = explicitAdded ?? added;
  removed = explicitRemoved ?? removed;
  return { path, added, removed, peek, moreCount: measuredMoreCount ?? Math.max(0, added + removed - peek.length) };
}

function testCount(text: string): number {
  const patterns = [
    /\btests?\s*[:=]?\s*(\d+)\s+passed\b/i,
    /\b(\d+)\s+(?:tests?\s+)?pass(?:ed|ing)\b/i,
    /\bpassed\s*[:=]?\s*(\d+)\b/i,
    /#\s*tests\s+(\d+)\b/i,
    /\b(\d+)\s+tests?\b/i,
  ];
  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) return Number(match[1]);
  }
  return 0;
}

function verificationReceipt(call: AgentHistoryEntry, result?: AgentHistoryEntry): VerificationReceipt {
  const command = commandFor(call);
  const tool = call.toolName?.toLowerCase() ?? "";
  const kind = /lint|eslint|ruff/.test(`${tool} ${command}`) ? "lint" as const
    : /build|tsc\b|compile/.test(`${tool} ${command}`) ? "build" as const : "test" as const;
  const output = result?.text ?? "";
  const failed = !result || Boolean(result.isError)
    || /\b(?:failed|failure)\b|\b[1-9]\d*\s+errors?\b|"(?:code|exitCode)"\s*:\s*[1-9]/i.test(output);
  const tests = kind === "test" ? testCount(output) : 0;
  return { kind, passed: !failed, tests, summary: `${kind} ${failed ? "failed" : "passed"}${tests ? ` · ${tests} tests` : ""}` };
}

function elapsedText(entries: AgentHistoryEntry[]): string {
  const stamps = entries.map((entry) => entry.timestamp).filter((value): value is number => value !== undefined);
  if (stamps.length < 2) return "";
  const ms = Math.max(...stamps) - Math.min(...stamps);
  return ms >= 1_000 ? `${(ms / 1_000).toFixed(ms < 10_000 ? 1 : 0)}s` : `${ms}ms`;
}

function compactCommand(command: string): string {
  return command.replace(/\s+/g, " ").trim().slice(0, 96);
}

function callSummary(entry: AgentHistoryEntry, category: HistoryCategory): string {
  if (category === "edit") return pathFromCall(entry);
  const command = commandFor(entry);
  if (/(exec|bash|command|shell)/i.test(entry.toolName ?? "")) return compactCommand(command);
  const args = structuredText(entry.text);
  return stringField(args, "path", "file_path", "query", "pattern") ?? entry.toolName ?? category;
}

function historyCalls(history: AgentHistoryEntry[]): HistoryCall[] {
  const calls: HistoryCall[] = [];
  history.forEach((entry, index) => {
    if (entry.kind !== "toolCall") return;
    const category = categoryFor(entry);
    if (!category) return;
    calls.push({ entry, result: pairedResult(history, index), category, summary: callSummary(entry, category) });
  });
  return calls;
}

export function classifyHistory(history: AgentHistoryEntry[] | undefined): ActivityLine[] {
  const calls = historyCalls(history ?? []);
  const lines: ActivityLine[] = [];
  for (let index = 0; index < calls.length;) {
    const current = calls[index]!;
    const concurrent = current.entry.timestamp === undefined ? [current] : calls.slice(index).filter((call) => call.entry.timestamp === current.entry.timestamp);
    if (concurrent.length > 1 && calls.slice(index, index + concurrent.length).every((call) => call.entry.timestamp === current.entry.timestamp)) {
      const elapsed = elapsedText(concurrent.flatMap((call) => [call.entry, ...(call.result ? [call.result] : [])]));
      lines.push({
        verb: "parallel",
        target: concurrent.map((call) => call.summary).join(" · ").slice(0, 180),
        result: `${concurrent.length} concurrent${elapsed ? ` · ${elapsed}` : ""}`,
      });
      index += concurrent.length;
      continue;
    }
    if (current.category === "context") {
      const group = [current];
      while (calls[index + group.length]?.category === "context") group.push(calls[index + group.length]!);
      const elapsed = elapsedText(group.flatMap((call) => [call.entry, ...(call.result ? [call.result] : [])]));
      lines.push({
        verb: "context",
        target: `${group.length} context ${group.length === 1 ? "read" : "reads"}`,
        result: elapsed || `${group.length} source${group.length === 1 ? "" : "s"}`,
      });
      index += group.length;
      continue;
    }
    if (current.category === "verify") {
      const receipt = verificationReceipt(current.entry, current.result);
      lines.push({
        verb: "verify",
        target: compactCommand(commandFor(current.entry)),
        result: receipt.summary,
        expandable: Boolean(current.result),
        peek: current.result ? [receipt.summary] : undefined,
      });
    } else {
      const receipt = diffReceipt(current.entry, current.result);
      lines.push({
        verb: "edit",
        target: receipt.path,
        result: "",
        expandable: receipt.peek.length > 0,
        peek: receipt.peek,
        moreCount: receipt.moreCount || undefined,
        added: receipt.added,
        removed: receipt.removed,
      });
    }
    index += 1;
  }
  return lines.slice(-12);
}

function sessionFor(run: PersistedRunState, agent: PersistedAgentState): Session {
  const lines = classifyHistory(agent.history);
  const receipts = historyCalls(agent.history ?? [])
    .filter((call) => call.category === "verify")
    .map((call) => verificationReceipt(call.entry, call.result));
  return {
    worktreeId: `${run.runId}::${agent.id}`,
    task: agent.label || run.workflowName,
    prompt: agent.prompt,
    receipts: {
      build: receipts.some((receipt) => receipt.kind === "build" && receipt.passed),
      lint: receipts.some((receipt) => receipt.kind === "lint" && receipt.passed),
      tests: receipts.filter((receipt) => receipt.kind === "test" && receipt.passed).reduce((total, receipt) => total + receipt.tests, 0),
    },
    lines: lines.length ? lines : [{ verb: "context", target: agent.phase ?? run.workflowName, result: agent.status }],
    claim: agent.error ?? (agent.result === undefined ? `${agent.label} is ${agent.status}.` : String(agent.result).slice(0, 240)),
  };
}

function goalScript(goalName: string, workflowName: string, description: string): string {
  const safeName = workflowName.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40) || "goal_workflow";
  return `export const meta = ${JSON.stringify({
    name: safeName,
    description: `${goalName}: ${description}`,
    phases: [{ title: "Execute" }, { title: "Verify" }],
  })}
phase('Execute')
const implementation = await agent(String(args.prompt), { label: ${JSON.stringify(workflowName)}, tier: 'big' })
if (!implementation) throw new Error('goal implementation produced no result')
phase('Verify')
const verification = await agent(${JSON.stringify(`Independently verify the work for goal "${goalName}" and workflow "${workflowName}". Inspect the working tree, run the relevant checks, fix issues you find, and report exact evidence.`)}, { label: 'verify', tier: 'medium' })
if (!verification) throw new Error('goal verification produced no result')
return { implementation, verification }`;
}

function loopTrialScript(loop: LoopDraft): string {
  return `export const meta = ${JSON.stringify({
    name: `trial_${loop.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40),
    description: `Supervised trial for ${loop.name}`,
    phases: [{ title: "Trial" }],
})}
phase('Trial')
const result = await agent(${JSON.stringify(`Run one supervised, non-destructive trial of this proposed Helm loop. Do not publish, merge, or mutate external systems.\n\nTrigger: ${loop.trigger}\nSteps: ${loop.steps}\nSkips: ${loop.skips}\nGuardrails: ${loop.guardrails.join(", ")}\n\nReturn a JSON object only: {"passed": boolean, "evidence": string[]}. passed may be true only when the trial evidence demonstrates every step and guardrail is safe; workflow completion by itself is not a pass.`)}, { label: 'supervised trial', tier: 'medium' })
if (!result) throw new Error('supervised trial produced no result')
return result`;
}

function parseTrialVerdict(value: unknown): { passed: boolean; evidence: string[] } | undefined {
  if (typeof value === "object" && value !== null) {
    const candidate = value as { passed?: unknown; evidence?: unknown };
    if (typeof candidate.passed === "boolean" && Array.isArray(candidate.evidence) && candidate.evidence.every((item) => typeof item === "string")) {
      return { passed: candidate.passed, evidence: candidate.evidence };
    }
  }
  if (typeof value !== "string") return undefined;
  const fenced = value.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
  const raw = fenced ?? value.slice(value.indexOf("{"), value.lastIndexOf("}") + 1);
  try {
    return parseTrialVerdict(JSON.parse(raw));
  } catch {
    return undefined;
  }
}

function planGoalInput(prompt: string) {
  const normalized = prompt.trim();
  const ambiguous = /\b(?:tbd|unsure|somehow|whatever|either option)\b/i.test(normalized);
  const questions = !normalized
    ? [{ id: "outcome", question: "What concrete outcome should Pi deliver?" }]
    : ambiguous ? [{ id: "ambiguity", question: "Which unresolved option should the plan use?" }] : [];
  const words = normalized.split(/\s+/).filter(Boolean).length;
  const workflowCount = words > 80 ? 3 : words > 30 ? 2 : 1;
  return {
    questions,
    plan: Array.from({ length: workflowCount }, (_, index) => ({
      name: workflowCount === 1 ? "execute" : `lane-${index + 1}`,
      description: index === workflowCount - 1 ? "implement the scoped outcome and verify acceptance evidence" : "inspect and implement an independent portion of the scoped outcome",
    })),
    estWall: workflowCount === 1 ? "1-3h wall" : `${workflowCount * 2}-${workflowCount * 4}h wall`,
    estCost: `~$${workflowCount * 8}-${workflowCount * 20}`,
    escalationRule: "un-inferable, destructive, permission, and cross-scope decisions escalate to you",
  };
}

function scheduledLoopScript(loop: LoopDraft): string {
  return `export const meta = ${JSON.stringify({
    name: `loop_${loop.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40),
    description: `Scheduled Helm loop: ${loop.name}`,
    phases: [{ title: "Execute" }, { title: "Verify" }],
  })}
phase('Execute')
const result = await agent(${JSON.stringify(`Execute this scheduled Helm loop in the current repository.\n\nSteps: ${loop.steps}\nSkips/escalations: ${loop.skips}\nGuardrails: ${loop.guardrails.join(", ")}\n\nHonor every guardrail. Do not merge or publish unless a guardrail explicitly grants it. Preserve unrelated changes and leave auditable evidence.`)}, { label: ${JSON.stringify(loop.name)}, tier: 'medium' })
if (!result) throw new Error('scheduled loop produced no result')
phase('Verify')
const verification = await agent(${JSON.stringify(`Verify the scheduled loop "${loop.name}" completed safely. Inspect the current repository state, run relevant checks, and report violations or failures. Do not merge or publish.`)}, { label: 'verify loop', tier: 'medium' })
if (!verification) throw new Error('scheduled loop verification produced no result')
return { result, verification }`;
}

function timestampMs(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function runCost(run: PersistedRunState): number | undefined {
  if (typeof run.tokenUsage?.cost === "number" && Number.isFinite(run.tokenUsage.cost)) return Math.max(0, run.tokenUsage.cost);
  let measured = false;
  const total = run.agents.reduce((sum, agent) => {
    const cost = agent.tokenUsage?.cost;
    if (typeof cost !== "number" || !Number.isFinite(cost)) return sum;
    measured = true;
    return sum + Math.max(0, cost);
  }, 0);
  return measured ? total : undefined;
}

function costRecords(manager: WorkflowManager): UsageCostRecord[] {
  return manager.listAllRuns().flatMap((run) => {
    const costUsd = runCost(run);
    if (costUsd === undefined || costUsd <= 0) return [];
    const args = runArgs(run);
    return [{
      goalId: args.helmGoalId,
      goalName: args.goalName,
      costUsd,
      at: timestampMs(run.completedAt ?? run.updatedAt ?? run.startedAt) ?? Date.now(),
      contributor: args.helmWorkflowName ?? run.workflowName,
    }];
  });
}

function commitsFromHistory(history: AgentHistoryEntry[] | undefined): number {
  let commits = 0;
  for (const call of historyCalls(history ?? [])) {
    if (!/\bgit\s+commit\b/i.test(commandFor(call.entry))) continue;
    const output = call.result?.text ?? "";
    if (call.result && !call.result.isError && !/\b(?:failed|error|nothing to commit)\b/i.test(output)) commits += 1;
  }
  return commits;
}

function goalMetrics(manager: WorkflowManager, goalId: string): WorkflowGoalMetrics | undefined {
  const runs = helmRuns(manager).filter((run) => runArgs(run).helmGoalId === goalId);
  if (!runs.length) return undefined;
  let unitsDone = 0;
  let unitsTotal = 0;
  let added = 0;
  let removed = 0;
  let diffMeasured = false;
  let commits = 0;
  let verificationPassed = 0;
  let verificationTotal = 0;
  let interventions = 0;
  let startedAtMs: number | undefined;
  let completedAtMs: number | undefined;
  let costUsd = 0;
  let costMeasured = false;
  let largestCostContributor: WorkflowGoalMetrics["largestCostContributor"];
  for (const run of runs) {
    const started = timestampMs(run.startedAt);
    const completed = timestampMs(run.completedAt);
    if (started !== undefined) startedAtMs = startedAtMs === undefined ? started : Math.min(startedAtMs, started);
    if (completed !== undefined) completedAtMs = completedAtMs === undefined ? completed : Math.max(completedAtMs, completed);
    unitsTotal += run.agents.length;
    unitsDone += run.agents.filter((agent) => ["done", "skipped"].includes(agent.status)).length;
    interventions += ["failed", "aborted", "paused"].includes(run.status) ? 1 : 0;
    interventions += run.agents.filter((agent) => agent.status === "error").length;
    const cost = runCost(run);
    if (cost !== undefined) {
      costMeasured = true;
      costUsd += cost;
    }
    if (cost !== undefined && (!largestCostContributor || cost > largestCostContributor.costUsd)) {
      largestCostContributor = { name: runArgs(run).helmWorkflowName ?? run.workflowName, costUsd: cost };
    }
    for (const agent of run.agents) {
      commits += commitsFromHistory(agent.history);
      for (const call of historyCalls(agent.history ?? [])) {
        if (call.category === "edit") {
          const receipt = diffReceipt(call.entry, call.result);
          diffMeasured = true;
          added += receipt.added;
          removed += receipt.removed;
        } else if (call.category === "verify") {
          verificationTotal += 1;
          if (verificationReceipt(call.entry, call.result).passed) verificationPassed += 1;
        }
      }
    }
  }
  return {
    startedAtMs,
    completedAtMs,
    unitsDone,
    unitsTotal,
    unit: "work units",
    added: diffMeasured ? added : undefined,
    removed: diffMeasured ? removed : undefined,
    commits: commits || undefined,
    verificationPassed,
    verificationTotal,
    costUsd: costMeasured ? costUsd : undefined,
    interventions,
    largestCostContributor,
  };
}

export function createWorkflowPort(manager: WorkflowManager, getCmux: () => ClaudeFleetManager): WorkflowPort {
  return {
    listWorkflows() {
      const dwLanes: Workflow[] = helmRuns(manager)
        .filter((run) => ["pending", "running", "paused", "failed", "aborted"].includes(run.status))
        .map((run) => ({
          id: run.runId,
          goalId: runArgs(run).helmGoalId ?? "",
          name: runArgs(run).helmWorkflowName ?? run.workflowName,
          state: run.status === "running" ? "running" : ["paused", "failed", "aborted"].includes(run.status) ? "paused" : "queued",
          summary: runSummary(run),
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
    getDrillIn(id) {
      const run = manager.listAllRuns().find((item) => item.runId === id);
      return run ? detailFor(run) : undefined;
    },
    getSession(worktreeId) {
      const [runId, rawAgentId] = worktreeId.split("::");
      const run = manager.listAllRuns().find((item) => item.runId === runId);
      const agent = run?.agents.find((item) => item.id === Number(rawAgentId));
      return run && agent ? sessionFor(run, agent) : undefined;
    },
    pauseWorkflow(id) {
      if (manager.listRuns().some((run) => run.runId === id)) manager.pause(id);
    },
    resumeWorkflow: (id) => manager.resume(id),
    pauseWorktree(worktreeId) {
      const [runId, agentId] = worktreeId.split("::");
      return manager.pauseAgent(runId!, Number(agentId));
    },
    resumeWorktree(worktreeId) {
      const [runId, agentId] = worktreeId.split("::");
      return manager.resumeAgent(runId!, Number(agentId));
    },
    isWorktreePaused(worktreeId) {
      const [runId, agentId] = worktreeId.split("::");
      return manager.isAgentPaused(runId!, Number(agentId));
    },
    pauseAll() {
      const paused: string[] = [];
      for (const run of helmRuns(manager)) {
        if (run.status === "running" && manager.pause(run.runId)) paused.push(run.runId);
      }
      return paused;
    },
    resumeAll(runIds) {
      for (const runId of runIds) void manager.resume(runId);
    },
    async planGoal(input) {
      // Pure planning capability: intentionally does not call manager.start*/runSync.
      const derived = planGoalInput(input.prompt);
      const answers = new Map(input.answers.filter((item) => item.answer).map((item) => [item.id, item.answer!]));
      return { ...derived, questions: derived.questions.map((question) => ({ ...question, answer: answers.get(question.id) })) };
    },
    async startGoal(input) {
      const plans = input.plan.length ? input.plan : [{ name: "execution", description: "Implement and verify the goal" }];
      return plans.map((plan) => manager.startInBackground(
        goalScript(input.goalName, plan.name, plan.description),
        {
          helmGoalId: input.goalId,
          helmWorkflowName: plan.name,
          goalName: input.goalName,
          prompt: `${input.prompt}\n\nWorkflow responsibility: ${plan.description}`,
        } satisfies HelmRunArgs,
        { tokenBudget: 160_000, maxAgents: 2, concurrency: 1, agentTimeoutMs: 30 * 60_000 },
      ).runId);
    },
    async trialLoop(loop) {
      const started = manager.startInBackground(loopTrialScript(loop), {
        helmLoopId: loop.id,
        prompt: loop.prompt,
      } satisfies HelmRunArgs, { tokenBudget: 80_000, maxAgents: 1, concurrency: 1, agentTimeoutMs: 20 * 60_000 });
      try {
        await started.promise;
        const run = manager.listAllRuns().find((item) => item.runId === started.runId);
        const verdict = parseTrialVerdict(run?.result);
        return verdict
          ? { ...verdict, ok: verdict.passed, runId: started.runId }
          : { passed: false, ok: false, evidence: ["Trial report did not contain a valid {passed, evidence} verdict."], runId: started.runId };
      } catch {
        return { passed: false, ok: false, evidence: ["Trial workflow failed before producing a verdict."], runId: started.runId };
      }
    },
    async runLoop(loop) {
      const started = manager.startInBackground(scheduledLoopScript(loop), {
        helmLoopId: loop.id,
        prompt: loop.prompt,
      } satisfies HelmRunArgs, { tokenBudget: 160_000, maxAgents: 2, concurrency: 1, agentTimeoutMs: 30 * 60_000 });
      try {
        await started.promise;
        const run = manager.listAllRuns().find((item) => item.runId === started.runId);
        return { ok: run?.status === "completed", runId: started.runId };
      } catch {
        return { ok: false, runId: started.runId };
      }
    },
    getGoalProgress(goalId) {
      const runs = helmRuns(manager).filter((run) => runArgs(run).helmGoalId === goalId);
      if (!runs.length) return undefined;
      const completed = runs.filter((run) => run.status === "completed").length;
      return { progress: completed / runs.length, complete: completed === runs.length };
    },
    getGoalMetrics(goalId) {
      return goalMetrics(manager, goalId);
    },
    listUsageCostRecords() {
      return costRecords(manager);
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

export function createUsagePort(handle: UsageHealthHandle, manager?: WorkflowManager): UsagePort {
  const accounting = (): UsageAccountingSnapshot => {
    const records = manager ? costRecords(manager) : [];
    const view = handle.service.getView();
    return {
      spentUsd: records.reduce((total, record) => total + record.costUsd, 0),
      providerRemaining: Object.fromEntries(PROVIDER_ORDER.flatMap((provider) => {
        const remaining = providerRemaining(view.providers.find((state) => state.provider === provider)?.snapshot);
        return remaining === undefined ? [] : [[provider, remaining]];
      })),
      records,
    };
  };
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
      const records = accounting().records;
      const todayStart = new Date(view.now);
      todayStart.setHours(0, 0, 0, 0);
      const weekStart = view.now - 7 * 86_400_000;
      const formatCost = (cost: number) => `$${cost.toFixed(2)}`;
      const byGoal = new Map<string, { name: string; cost: number }>();
      for (const record of records) {
        if (!record.goalId) continue;
        const existing = byGoal.get(record.goalId) ?? { name: record.goalName ?? record.goalId, cost: 0 };
        existing.cost += record.costUsd;
        byGoal.set(record.goalId, existing);
      }
      return {
        providers: PROVIDER_ORDER.map((id) => view.providers.find((provider) => provider.provider === id) ?? { provider: id, refreshing: false }).map((provider) => {
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
        spendToday: formatCost(records.filter((record) => record.at >= todayStart.getTime()).reduce((total, record) => total + record.costUsd, 0)),
        spendWeek: formatCost(records.filter((record) => record.at >= weekStart).reduce((total, record) => total + record.costUsd, 0)),
        perGoal: [...byGoal.values()]
          .sort((a, b) => b.cost - a.cost || a.name.localeCompare(b.name))
          .map((goal) => ({ name: goal.name, cost: formatCost(goal.cost) })),
      };
    },
    getAccountingSnapshot: accounting,
    subscribe: handle.subscribe,
  };
}
