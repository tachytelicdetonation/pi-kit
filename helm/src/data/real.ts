/**
 * The production Helm data source. Helm owns durable project intent here; live
 * workflow execution stays authoritative in WorkflowManager through WorkflowPort.
 */
import { randomUUID } from "node:crypto";
import { HelmStore } from "../state/store.js";
import type { HelmRepository, PersistedHelmDomain, PersistedUsageSnapshot } from "../state/persistence.js";
import type {
  Closeout,
  DigestData,
  Escalation,
  Goal,
  HelmState,
  IntakeDraft,
  JournalEvent,
  Loop,
  LoopDraft,
  Precedent,
  Session,
  UsageDetail,
  WorkflowDetail,
} from "../state/types.js";
import {
  genericDrillIn,
  seedCloseout,
  seedCodemodDrillIn,
  seedDigest,
  seedIntake,
  seedLoopDraft,
  seedSession,
  seedState,
  seedUsageDetail,
} from "./mock.js";
import type { UsagePort, WorkflowPort } from "./ports.js";
import type { DataSource, HelmCommand, HelmCommandResult, SearchResult } from "./source.js";

export interface RealDataSourceDeps {
  workflows: WorkflowPort;
  usage: UsagePort;
  nativeState: HelmState;
  trialLoop: (id: string) => Promise<{ ok: boolean }>;
  synthDigest: () => DigestData;
  synthIntake: (id: string) => IntakeDraft;
  synthLoopDraft: (id: string, name?: string) => LoopDraft;
  synthCloseout: (goalId: string) => Closeout;
  shouldShowDigestFlag: boolean;
  /** Present in production. Tests intentionally exercise the same class in memory. */
  repository?: HelmRepository;
}

function slug(value: string, fallback: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 42) || fallback;
}

function shortName(prompt: string, fallback: string): string {
  const sentence = prompt.trim().split(/\n|[.!?](?:\s|$)/)[0]?.trim() ?? "";
  return sentence.slice(0, 64) || fallback;
}

function triggerFromPrompt(prompt: string, fallback: string): string {
  return /^(when|every|on|daily)\b/i.test(prompt.trim())
    ? prompt.trim().split(/[.;\n]/)[0]!.trim()
    : fallback;
}

function formatClock(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
}

const PROVIDER_ORDER = ["codex", "claude", "kimi"] as const;

function formatMoney(value: number): string {
  return `$${Math.max(0, Number.isFinite(value) ? value : 0).toFixed(2)}`;
}

function parseMoney(value: string | undefined): number | undefined {
  const match = value?.match(/\$\s*([\d,.]+)/);
  if (!match) return undefined;
  const parsed = Number(match[1]!.replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function formatDateMarker(prefix: "started" | "landed", timestamp: number | undefined): string {
  if (timestamp === undefined) return `${prefix} time unavailable`;
  return `${prefix} ${new Date(timestamp).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }).toLowerCase()}`;
}

function parseSchedule(trigger: string, now = Date.now()): { everyMs: number; nextAtMs: number } | undefined {
  const every = trigger.match(/\bevery\s+(?:(\d+)\s*)?(minute|minutes|hour|hours|day|days)\b/i);
  if (every) {
    const count = Math.max(1, Number(every[1] ?? 1));
    const unit = every[2]!.toLowerCase();
    const multiplier = unit.startsWith("minute") ? 60_000 : unit.startsWith("hour") ? 3_600_000 : 86_400_000;
    const everyMs = count * multiplier;
    return { everyMs, nextAtMs: now + everyMs };
  }
  const daily = trigger.match(/\bdaily\s+at\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\b/i);
  if (!daily) return undefined;
  let hour = Number(daily[1]);
  const minute = Number(daily[2] ?? 0);
  const meridiem = daily[3]?.toLowerCase();
  if (meridiem === "pm" && hour < 12) hour += 12;
  if (meridiem === "am" && hour === 12) hour = 0;
  if (hour > 23 || minute > 59) return undefined;
  const next = new Date(now);
  next.setHours(hour, minute, 0, 0);
  if (next.getTime() <= now) next.setDate(next.getDate() + 1);
  return { everyMs: 86_400_000, nextAtMs: next.getTime() };
}

function blankDomain(cwd: string): PersistedHelmDomain {
  return {
    version: 1,
    cwd,
    goals: [],
    loops: [],
    escalations: [],
    precedents: [],
    journal: [],
    intakes: [],
    loopDrafts: [],
    closeouts: [],
  };
}

export class RealDataSource implements DataSource {
  private readonly store: HelmStore;
  private readonly intakes = new Map<string, IntakeDraft>();
  private readonly loopDrafts = new Map<string, LoopDraft>();
  private readonly closeouts = new Map<string, Closeout>();
  private readonly loopTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private domain: PersistedHelmDomain;
  private readonly launchShouldShowDigest: boolean;
  private readonly launchLastSeenAt?: number;
  private readonly launchUsageSnapshot?: PersistedUsageSnapshot;

  constructor(private readonly deps: RealDataSourceDeps) {
    const loaded = deps.repository?.load();
    this.launchLastSeenAt = loaded?.lastSeenAt;
    this.launchUsageSnapshot = loaded?.usageSnapshot;
    this.domain = loaded ?? blankDomain(deps.nativeState.footer.cwd ?? process.cwd());
    const nativeState = loaded ? {
      ...deps.nativeState,
      goals: loaded.goals,
      loops: loaded.loops,
      escalations: loaded.escalations,
      precedents: loaded.precedents,
      journal: loaded.journal,
    } : deps.nativeState;
    this.store = new HelmStore(nativeState);
    for (const intake of loaded?.intakes ?? []) this.intakes.set(intake.id, intake);
    for (const loop of loaded?.loopDrafts ?? []) this.loopDrafts.set(loop.id, loop);
    for (const closeout of loaded?.closeouts ?? []) this.closeouts.set(closeout.goalId, closeout);
    this.launchShouldShowDigest = deps.shouldShowDigestFlag
      || Boolean(loaded?.lastSeenAt && Date.now() - loaded.lastSeenAt > 30 * 60_000);

    this.syncWorkflows();
    this.store.setFooter(deps.usage.getFooter());
    deps.workflows.subscribe(() => {
      this.syncWorkflows();
      this.persist();
    });
    deps.usage.subscribe(() => {
      this.store.setFooter(deps.usage.getFooter());
      this.persist();
    });
    if (deps.repository) {
      for (const loop of this.store.getState().loops) this.armLoop(loop);
    }
    if (deps.repository) this.persist();
  }

  snapshot(): HelmState {
    return this.store.getState();
  }

  subscribe(callback: () => void): () => void {
    return this.store.subscribe(callback);
  }

  pauseAll(): void {
    this.store.pauseAll();
    this.deps.workflows.pauseAll();
    for (const loop of this.store.getState().loops) this.clearLoopTimer(loop.id);
  }

  resumeAll(): void {
    this.store.resumeAll();
    this.deps.workflows.resumeAll();
    for (const loop of this.store.getState().loops) this.armLoop(loop);
  }

  pauseWorkflow(id: string): void {
    this.store.pauseWorkflow(id);
    this.deps.workflows.pauseWorkflow(id);
  }

  getDrillIn(workflowId: string): WorkflowDetail | undefined {
    return this.deps.workflows.getDrillIn(workflowId);
  }

  getSession(worktreeId: string): Session | undefined {
    return this.deps.workflows.getSession(worktreeId);
  }

  decide(escalationId: string, option: number): Promise<void> {
    this.store.decide(escalationId, option);
    this.persist();
    return Promise.resolve();
  }

  getEscalation(id: string): Escalation | undefined {
    return this.store.getState().escalations.find((escalation) => escalation.id === id);
  }

  listEscalations(): Escalation[] {
    return this.store.getState().escalations;
  }

  precedents(): Precedent[] {
    return this.store.getState().precedents;
  }

  getDigest(): DigestData {
    const allJournal = this.store.getState().journal;
    const journal = this.launchLastSeenAt === undefined
      ? allJournal
      : allJournal.filter((event) => event.timestampMs > this.launchLastSeenAt!);
    const currentUsage = this.deps.usage.getAccountingSnapshot();
    const spent = this.launchUsageSnapshot
      ? Math.max(0, currentUsage.spentUsd - this.launchUsageSnapshot.spentUsd)
      : 0;
    const quotaDrain = PROVIDER_ORDER.map((provider) => {
      const before = this.launchUsageSnapshot?.providerRemaining[provider];
      const now = currentUsage.providerRemaining[provider];
      return { provider, deltaPercent: before === undefined || now === undefined ? 0 : Math.round(now - before) };
    });
    if (!journal.length) {
      const fallback = this.deps.synthDigest();
      return { ...fallback, spentText: `${formatMoney(spent)} spent`, quotaDrain };
    }
    const first = journal[0]!.timestampMs;
    const last = journal[journal.length - 1]!.timestampMs;
    return {
      spanText: `${formatClock(first)} → ${formatClock(last)}`,
      spentText: `${formatMoney(spent)} spent`,
      shippedGoals: journal.filter((event) => event.kind === "merged").map((event) => event.label),
      shippedByLoops: journal.filter((event) => event.kind === "prOpened").map((event) => event.label),
      decisionsQueued: journal.filter((event) => event.kind === "escalated").map((event) => event.label),
      failedHandled: journal.flatMap((event) => event.kind === "selfCaughtPaused"
        ? [`self-caught · paused · ${event.label}`]
        : event.kind === "selfCaughtRevert" ? [`self-caught · reverted · ${event.label}`] : []),
      quotaDrain,
    };
  }

  shouldShowDigest(): boolean {
    return this.launchShouldShowDigest;
  }

  getIntake(draftId: string): IntakeDraft | undefined {
    if (!draftId) return undefined;
    return this.intakes.get(draftId) ?? (this.deps.repository ? undefined : this.deps.synthIntake(draftId));
  }

  getLoopDraft(loopId: string): LoopDraft | undefined {
    if (!loopId) return undefined;
    const stored = this.loopDrafts.get(loopId);
    if (stored) return stored;
    if (this.deps.repository) return undefined;
    const loop = this.store.getState().loops.find((item) => item.id === loopId);
    return this.deps.synthLoopDraft(loopId, loop?.name);
  }

  getCloseout(goalId: string): Closeout | undefined {
    if (!goalId) return undefined;
    const stored = this.closeouts.get(goalId);
    const seed = stored ?? (this.deps.repository ? this.buildCloseout(goalId) : this.deps.synthCloseout(goalId));
    if (!seed) return undefined;
    const merged = [...seed.proposedPrecedents, ...this.store.getState().precedents];
    const seen = new Set<string>();
    const proposedPrecedents = merged.filter((precedent) => {
      if (precedent.declined || seen.has(precedent.id)) return false;
      seen.add(precedent.id);
      return true;
    });
    return { ...seed, proposedPrecedents };
  }

  getUsageDetail(): UsageDetail {
    return this.deps.usage.getUsageDetail();
  }

  addEscalation(escalation: Escalation): void {
    const goalId = escalation.goalId ?? this.goalIdForEscalation(escalation);
    const resolved = this.store.addEscalation(goalId ? { ...escalation, goalId } : escalation);
    if (!resolved.resolved) this.appendJournal("escalated", escalation.question);
    this.persist();
  }

  archiveGoal(id: string): void {
    this.store.archiveGoal(id);
    this.persist();
  }

  trialLoop(id: string): Promise<{ ok: boolean }> {
    const draft = this.loopDrafts.get(id) ?? (this.deps.repository ? undefined : this.deps.synthLoopDraft(id));
    if (!draft) return Promise.resolve({ ok: false });
    return this.deps.trialLoop(id).then((result) => {
      if (result.ok) {
        this.loopDrafts.set(id, { ...draft, trialPassed: true });
        this.persist();
      }
      return result;
    });
  }

  search(query: string): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const state = this.store.getState();
    const corpus: SearchResult[] = [
      ...state.goals.map((goal) => ({
        kind: "goal" as const,
        label: goal.name,
        sublabel: `${Math.round(goal.progress * 100)}% · ${goal.phase}`,
        screen: { id: "closeout" as const, goalId: goal.id },
      })),
      ...state.workflows.map((workflow) => ({
        kind: "workflow" as const,
        label: workflow.name,
        sublabel: workflow.summary,
        screen: { id: "drillin" as const, workflowId: workflow.id },
      })),
      ...state.loops.map((loop) => ({
        kind: "loop" as const,
        label: loop.name,
        sublabel: loop.pipelineSummary,
        screen: { id: "loopBuilder" as const, loopId: loop.id },
      })),
      ...state.precedents.map((precedent) => ({
        kind: "precedent" as const,
        label: precedent.question,
        sublabel: `decision · ${precedent.decision}`,
      })),
    ];
    return corpus.filter((result) => `${result.label} ${result.sublabel ?? ""}`.toLowerCase().includes(q));
  }

  async execute(command: HelmCommand): Promise<HelmCommandResult> {
    try {
      switch (command.type) {
        case "goal.createDraft": {
          const id = command.draftId ?? `goal-${slug(command.prompt, randomUUID().slice(0, 8))}`;
          const uniqueId = this.intakes.has(id) ? `${id}-${randomUUID().slice(0, 4)}` : id;
          const prompt = command.prompt.trim();
          const draft: IntakeDraft = {
            id: uniqueId,
            goalName: shortName(prompt, "new goal"),
            goalPrompt: prompt,
            preamble: prompt ? "I can structure this into an executable workflow now." : "Describe the outcome you want Pi to own.",
            questions: [],
            planWorkflows: [{ name: "execute", description: "implement the goal, validate it, and report evidence" }],
            estWall: "estimated after launch",
            estCost: "usage-capped by Pi",
            escalationRule: "ambiguous or destructive decisions escalate to you",
            openQuestions: !prompt,
          };
          this.intakes.set(uniqueId, draft);
          this.persist();
          return { id: uniqueId, ok: true };
        }
        case "goal.answer": {
          const draft = this.intakes.get(command.draftId);
          if (!draft) return { ok: false, message: "Goal draft no longer exists." };
          const firstAnswer = !draft.goalPrompt;
          const next = {
            ...draft,
            goalName: firstAnswer ? shortName(command.text, draft.goalName) : draft.goalName,
            goalPrompt: firstAnswer ? command.text.trim() : draft.goalPrompt,
            userReply: firstAnswer ? draft.userReply : command.text.trim(),
            openQuestions: false,
          };
          this.intakes.set(command.draftId, next);
          this.persist();
          return { ok: true };
        }
        case "goal.editPlan": {
          const draft = this.intakes.get(command.draftId);
          if (!draft || !draft.planWorkflows[command.index]) return { ok: false, message: "Plan line not found." };
          const [rawName, ...rest] = command.text.split(":");
          const current = draft.planWorkflows[command.index]!;
          const replacement = rest.length
            ? { ...current, name: rawName!.trim() || current.name, description: rest.join(":").trim() || current.description }
            : { ...current, description: command.text.trim() || current.description };
          const planWorkflows = draft.planWorkflows.map((plan, index) => index === command.index ? replacement : plan);
          this.intakes.set(command.draftId, { ...draft, planWorkflows });
          this.persist();
          return { ok: true };
        }
        case "goal.discardDraft":
          this.intakes.delete(command.draftId);
          this.persist();
          return { ok: true };
        case "goal.spawn": {
          const draft = this.intakes.get(command.draftId);
          if (!draft) return { ok: false, message: "Goal draft no longer exists." };
          if (draft.openQuestions || !draft.goalPrompt.trim()) return { ok: false, message: "Answer the open question before launching." };
          const goal: Goal = {
            id: draft.id,
            name: draft.goalName,
            phase: "running",
            progress: 0,
            startedAtMs: Date.now(),
            estCost: parseMoney(draft.estCost) === undefined ? undefined : draft.estCost,
          };
          const runIds = await this.deps.workflows.startGoal({
            goalId: goal.id,
            goalName: goal.name,
            prompt: draft.goalPrompt,
            plan: draft.planWorkflows,
          });
          this.store.addGoal(goal);
          this.intakes.delete(draft.id);
          this.appendJournal("goalStarted", `Started ${goal.name} · ${runIds.length} workflow${runIds.length === 1 ? "" : "s"}`);
          this.syncWorkflows();
          this.persist();
          return { id: goal.id, ok: true, message: `Launched ${runIds.length} workflow${runIds.length === 1 ? "" : "s"}.` };
        }
        case "goal.togglePause": {
          const lanes = this.store.getState().workflows.filter((workflow) => workflow.goalId === command.goalId);
          const shouldResume = lanes.length > 0 && lanes.every((workflow) => workflow.state === "paused");
          for (const lane of lanes) {
            if (shouldResume) {
              this.store.resumeWorkflow(lane.id);
              await this.deps.workflows.resumeWorkflow(lane.id);
            } else {
              this.store.pauseWorkflow(lane.id);
              this.deps.workflows.pauseWorkflow(lane.id);
            }
          }
          return { ok: true, message: shouldResume ? "Goal resumed." : "Goal paused." };
        }
        case "goal.archive":
          this.archiveGoal(command.goalId);
          return { ok: true };
        case "goal.applyPrecedents": {
          const closeout = this.getCloseout(command.goalId);
          const decisions = closeout?.proposedPrecedents.map((item) => `- ${item.question}: ${item.decision}`).join("\n") || "- No proposed precedents";
          return { ok: true, agentPrompt: `Apply these approved Helm precedents to the most appropriate repository guidance (CLAUDE.md or a focused skill). Inspect existing guidance first, make the smallest coherent edit, run relevant validation, and commit it separately.\n\n${decisions}` };
        }
        case "goal.report": {
          const closeout = this.getCloseout(command.goalId);
          if (!closeout) return { ok: false, message: "No closeout report is available." };
          return { ok: true, document: {
            title: `report · ${closeout.goalName}`,
            lines: [
              `${closeout.packagesDone}/${closeout.packagesTotal} ${closeout.unit}`,
              `${closeout.commitsText} · ${closeout.greenText}`,
              `cost ${closeout.actualCost} (estimate ${closeout.estCost})`,
              `your time ${closeout.yourTime}`,
              `interventions ${closeout.interventions}`,
              `overrun ${closeout.overrunWhy}`,
              ...(closeout.nextSuggestion ? [`next ${closeout.nextSuggestion}`] : []),
            ],
          } };
        }
        case "loop.createDraft": {
          const id = command.draftId ?? `loop-${slug(command.prompt, randomUUID().slice(0, 8))}`;
          const prompt = command.prompt.trim();
          const draft: LoopDraft = {
            id,
            name: shortName(prompt, "new loop"),
            prompt,
            trigger: triggerFromPrompt(prompt, "manual until scheduled"),
            steps: prompt || "describe → execute → verify → report",
            skips: "ambiguous or destructive work",
            guardrails: ["never merges", "requires review", "bounded concurrency"],
            trialStatement: "run once under full review before scheduling",
          };
          this.loopDrafts.set(id, draft);
          this.persist();
          return { id, ok: true };
        }
        case "loop.edit": {
          const draft = this.loopDrafts.get(command.loopId);
          if (!draft) return { ok: false, message: "Loop draft no longer exists." };
          const prompt = command.text.trim();
          this.loopDrafts.set(command.loopId, {
            ...draft,
            name: shortName(prompt, draft.name),
            prompt,
            trigger: triggerFromPrompt(prompt, draft.trigger),
            steps: prompt || draft.steps,
            trialPassed: false,
          });
          this.persist();
          return { ok: true };
        }
        case "loop.discardDraft":
          this.loopDrafts.delete(command.loopId);
          this.persist();
          return { ok: true };
        case "loop.schedule": {
          const draft = this.loopDrafts.get(command.loopId);
          if (!draft) return { ok: false, message: "Loop draft no longer exists." };
          if (!draft.trialPassed) return { ok: false, message: "Run and pass the supervised trial before scheduling." };
          const schedule = parseSchedule(draft.trigger);
          if (!schedule) return {
            ok: false,
            message: "Use a schedulable trigger such as 'every 30 minutes', 'every 2 hours', or 'daily at 09:00'.",
          };
          const nextRunAtMs = schedule.nextAtMs;
          const loop: Loop = {
            id: draft.id,
            name: draft.name,
            trigger: draft.trigger,
            pipelineSummary: draft.steps,
            health: "healthy",
            nextRun: `next ${new Date(nextRunAtMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
            scheduleEveryMs: schedule.everyMs,
            nextRunAtMs,
          };
          this.store.upsertLoop(loop);
          this.armLoop(loop);
          this.persist();
          return { id: loop.id, ok: true, message: "Loop scheduled." };
        }
        case "loop.togglePause":
          this.store.toggleLoop(command.loopId);
          {
            const loop = this.store.getState().loops.find((item) => item.id === command.loopId);
            if (loop?.health === "paused") this.clearLoopTimer(loop.id);
            else if (loop) this.armLoop(loop);
          }
          this.persist();
          return { ok: true };
        case "workflow.togglePause": {
          const lane = this.store.getState().workflows.find((workflow) => workflow.id === command.workflowId);
          if (!lane) return { ok: false, message: "Workflow no longer exists." };
          if (lane.state === "paused") {
            this.store.resumeWorkflow(lane.id);
            return { ok: await this.deps.workflows.resumeWorkflow(lane.id), message: "Workflow resumed." };
          }
          this.store.pauseWorkflow(lane.id);
          this.deps.workflows.pauseWorkflow(lane.id);
          return { ok: true, message: "Workflow paused." };
        }
        case "worktree.togglePause":
          return this.execute({ type: "workflow.togglePause", workflowId: command.workflowId });
        case "worktree.reassign":
          return { ok: true, agentPrompt: `Reassign the work represented by Helm worktree/session ${command.worktreeId} in workflow ${command.workflowId}. Inspect the live workflow state first, preserve completed work, choose an appropriate model/agent, and report the new ownership.` };
        case "worktree.testDetails": {
          const detail = this.getDrillIn(command.workflowId);
          const worktree = detail?.worktrees.find((item) => item.id === command.worktreeId);
          return worktree ? { ok: true, document: {
            title: `test race · ${worktree.name}`,
            lines: [
              `state ${worktree.testState}`,
              `race ${worktree.testTicks.join(" → ") || "no test receipt yet"}`,
              worktree.raceStatus ? `aggregate ${worktree.raceStatus}` : "aggregate pending",
              worktree.appliedText,
            ],
          } } : { ok: false, message: "Worktree no longer exists." };
        }
        case "session.diff":
          return { ok: true, agentPrompt: `Inspect and show the complete git diff associated with Helm worktree/session ${command.worktreeId}. Do not modify or merge anything. Summarize the important changes and validation evidence.` };
        case "session.merge":
          return { ok: true, agentPrompt: `Merge the completed work associated with Helm worktree/session ${command.worktreeId}. Inspect status and diff first, verify tests are green, preserve unrelated changes, perform the safest repository-native merge, and report exact evidence. Stop if the work is not merge-ready.` };
        case "session.steer":
          return { ok: true, agentPrompt: `Steer the active Helm worktree/session ${command.worktreeId} with this operator instruction. Inspect the live workflow state, preserve accepted progress, and apply the instruction to the narrowest active work unit.\n\nOperator instruction: ${command.text}` };
        case "escalation.ask": {
          const escalation = this.getEscalation(command.escalationId);
          if (!escalation) return { ok: false, message: "Escalation is already resolved." };
          this.store.updateEscalation(escalation.id, {
            followUps: [...(escalation.followUps ?? []), { question: command.text, at: Date.now() }],
          });
          this.persist();
          return { ok: true, agentPrompt: `Answer a follow-up about this Helm escalation without resolving it yet.\n\nProblem: ${escalation.problem}\nEvidence:\n${escalation.evidence.join("\n")}\n\nFollow-up: ${command.text}` };
        }
        case "digest.fullLog":
          return { ok: true, document: {
            title: "full activity log",
            lines: this.store.getState().journal.length
              ? this.store.getState().journal.map((event) => `${new Date(event.timestampMs).toLocaleString()} · ${event.kind} · ${event.label}`)
              : ["No Helm activity has been recorded for this project yet."],
          } };
      }
    } catch (error) {
      return { ok: false, message: error instanceof Error ? error.message : String(error) };
    }
  }

  private syncWorkflows(): void {
    this.store.setWorkflows(this.deps.workflows.listWorkflows());
    for (const goal of this.store.getState().goals) {
      if (goal.phase === "archived") continue;
      const progress = this.deps.workflows.getGoalProgress(goal.id);
      if (!progress) continue;
      this.store.updateGoal(goal.id, {
        progress: progress.progress,
        phase: progress.complete ? "complete" : "running",
        etaText: progress.complete ? undefined : goal.etaText,
        completedAtMs: progress.complete ? (goal.completedAtMs ?? Date.now()) : goal.completedAtMs,
      });
      if (progress.complete && !this.closeouts.has(goal.id)) {
        const closeout = this.buildCloseout(goal.id);
        if (closeout) {
          this.closeouts.set(goal.id, closeout);
        }
      }
    }
  }

  private buildCloseout(goalId: string): Closeout | undefined {
    const goal = this.store.getState().goals.find((item) => item.id === goalId);
    if (!goal) return undefined;
    const metrics = this.deps.workflows.getGoalMetrics(goalId);
    const decisions = this.store.getState().precedents.filter((precedent) => precedent.goalId === goalId);
    const decisionAttentionMinutes = decisions.length * 2;
    const actualCost = metrics?.costUsd;
    const estimate = parseMoney(goal.estCost);
    const overrunWhy = estimate === undefined
      ? "No numeric intake estimate was recorded"
      : actualCost === undefined
        ? "Actual cost accounting was unavailable"
        : actualCost <= estimate
          ? `${formatMoney(estimate - actualCost)} under estimate`
          : metrics?.largestCostContributor
            ? `${metrics.largestCostContributor.name} was the largest contributor at ${formatMoney(metrics.largestCostContributor.costUsd)}`
            : `${formatMoney(actualCost - estimate)} over estimate; contributor costs unavailable`;
    const verificationTotal = metrics?.verificationTotal ?? 0;
    const verificationPassed = metrics?.verificationPassed ?? 0;
    const greenPercent = verificationTotal ? Math.round((verificationPassed / verificationTotal) * 100) : 0;
    return {
      goalId,
      goalName: goal.name,
      startedText: formatDateMarker("started", goal.startedAtMs ?? metrics?.startedAtMs),
      landedText: formatDateMarker("landed", goal.completedAtMs ?? metrics?.completedAtMs),
      packagesDone: metrics?.unitsDone ?? 0,
      packagesTotal: metrics?.unitsTotal ?? 0,
      unit: metrics?.unit ?? "work units",
      addedText: metrics?.added === undefined ? "added lines unavailable" : `+${metrics.added}`,
      removedText: metrics?.removed === undefined ? "removed lines unavailable" : `−${metrics.removed}`,
      commitsText: metrics?.commits === undefined ? "commit count unavailable" : `${metrics.commits} commit${metrics.commits === 1 ? "" : "s"}`,
      greenText: verificationTotal
        ? `${greenPercent}% green (${verificationPassed}/${verificationTotal} checks)`
        : "green % unavailable (no verification receipts)",
      actualCost: actualCost === undefined ? "actual cost unavailable" : formatMoney(actualCost),
      estCost: goal.estCost ?? "not estimated",
      yourTime: `${decisions.length} decision${decisions.length === 1 ? "" : "s"} · ${decisionAttentionMinutes} min attention (2 min/decision estimate)`,
      interventions: `${metrics?.interventions ?? 0} workflow intervention${metrics?.interventions === 1 ? "" : "s"}`,
      overrunWhy,
      proposedPrecedents: decisions,
    };
  }

  private goalIdForEscalation(escalation: Escalation): string | undefined {
    const state = this.store.getState();
    const worktreeRunId = escalation.worktreeId?.split("::")[0];
    if (worktreeRunId) {
      const goalId = state.workflows.find((workflow) => workflow.id === worktreeRunId)?.goalId;
      if (goalId) return goalId;
    }
    if (escalation.source.kind === "goal") {
      return state.goals.find((goal) => goal.id === escalation.source.label || goal.name === escalation.source.label)?.id;
    }
    if (escalation.source.kind === "workflow") {
      return state.workflows.find((workflow) => workflow.id === escalation.source.label || workflow.name === escalation.source.label)?.goalId;
    }
    return undefined;
  }

  private appendJournal(kind: JournalEvent["kind"], label: string): void {
    this.store.appendJournal({ id: randomUUID(), kind, timestampMs: Date.now(), label });
  }

  private clearLoopTimer(id: string): void {
    const timer = this.loopTimers.get(id);
    if (timer) clearTimeout(timer);
    this.loopTimers.delete(id);
  }

  private armLoop(loop: Loop): void {
    this.clearLoopTimer(loop.id);
    if (!this.deps.repository || this.store.getState().pausedAll || loop.health === "paused" || !loop.scheduleEveryMs) return;
    const deadline = loop.nextRunAtMs ?? Date.now() + loop.scheduleEveryMs;
    const delay = Math.max(250, Math.min(2_147_000_000, deadline - Date.now()));
    const timer = setTimeout(() => {
      const current = this.store.getState().loops.find((item) => item.id === loop.id);
      if (current?.nextRunAtMs && current.nextRunAtMs > Date.now() + 250) this.armLoop(current);
      else void this.fireLoop(loop.id);
    }, delay);
    timer.unref?.();
    this.loopTimers.set(loop.id, timer);
  }

  private async fireLoop(id: string): Promise<void> {
    this.loopTimers.delete(id);
    const loop = this.store.getState().loops.find((item) => item.id === id);
    const draft = this.loopDrafts.get(id);
    if (!loop || !draft || this.store.getState().pausedAll || loop.health === "paused" || !loop.scheduleEveryMs) return;
    const result = await this.deps.workflows.runLoop(draft).catch(() => ({ ok: false }));
    const now = Date.now();
    const nextRunAtMs = now + loop.scheduleEveryMs;
    const updated: Loop = result.ok ? {
      ...loop,
      health: "healthy",
      lastFired: new Date(now).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
      nextRun: `next ${new Date(nextRunAtMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
      nextRunAtMs,
      yieldToday: "last run completed",
    } : {
      ...loop,
      health: "paused",
      pausedReason: "last run failed — review required",
      lastFired: new Date(now).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
      nextRun: undefined,
      nextRunAtMs: undefined,
    };
    this.store.upsertLoop(updated);
    this.appendJournal(result.ok ? "loopRunCompleted" : "selfCaughtPaused", `${loop.name} ${result.ok ? "completed a scheduled run" : "failed and paused"}`);
    this.persist();
    if (result.ok) this.armLoop(updated);
  }

  private persist(): void {
    if (!this.deps.repository) return;
    const state = this.store.getState();
    this.domain = {
      ...this.domain,
      version: 1,
      goals: state.goals,
      loops: state.loops,
      escalations: state.escalations,
      precedents: state.precedents,
      journal: state.journal,
      intakes: [...this.intakes.values()],
      loopDrafts: [...this.loopDrafts.values()],
      closeouts: [...this.closeouts.values()],
      lastSeenAt: Date.now(),
      usageSnapshot: (() => {
        const usage = this.deps.usage.getAccountingSnapshot();
        return { spentUsd: usage.spentUsd, providerRemaining: usage.providerRemaining };
      })(),
    };
    this.deps.repository.save(this.domain);
  }
}

function fakeWorkflowPort(): WorkflowPort {
  return {
    listWorkflows: () => seedState().workflows,
    getDrillIn: (id) => {
      if (id === "w-codemod") return seedCodemodDrillIn();
      const workflow = seedState().workflows.find((item) => item.id === id);
      return workflow ? genericDrillIn(workflow.id, workflow.goalId, workflow.name) : undefined;
    },
    getSession: (worktreeId) => (worktreeId ? seedSession(worktreeId) : undefined),
    pauseWorkflow: () => {},
    resumeWorkflow: () => Promise.resolve(true),
    pauseAll: () => {},
    resumeAll: () => {},
    startGoal: () => Promise.resolve(["test-run"]),
    trialLoop: () => Promise.resolve({ ok: true, runId: "test-trial" }),
    runLoop: () => Promise.resolve({ ok: true, runId: "test-loop" }),
    getGoalProgress: () => undefined,
    getGoalMetrics: () => undefined,
    listUsageCostRecords: () => [],
    subscribe: () => () => {},
  };
}

function fakeUsagePort(): UsagePort {
  return {
    getFooter: () => seedState().footer,
    getUsageDetail: () => seedUsageDetail(),
    getAccountingSnapshot: () => ({ spentUsd: 0, providerRemaining: {}, records: [] }),
    subscribe: () => () => {},
  };
}

export function createTestRealDataSource(): RealDataSource {
  return new RealDataSource({
    workflows: fakeWorkflowPort(),
    usage: fakeUsagePort(),
    nativeState: seedState(),
    trialLoop: (id) => Promise.resolve({ ok: !id.includes("fail") }),
    synthDigest: () => seedDigest(),
    synthIntake: (id) => seedIntake(id),
    synthLoopDraft: (id, name) => seedLoopDraft(id, name),
    synthCloseout: (goalId) => seedCloseout(goalId),
    shouldShowDigestFlag: false,
  });
}
