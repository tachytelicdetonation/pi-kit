/**
 * The production Helm data source. Helm owns durable project intent here; live
 * workflow execution stays authoritative in WorkflowManager through WorkflowPort.
 */
import { randomUUID } from "node:crypto";
import { HelmStore } from "../state/store.js";
import type { HelmRepository, PersistedHelmDomain, PersistedUsageSnapshot } from "../state/persistence.js";
import type {
  AuditRecord,
  Closeout,
  DigestData,
  Escalation,
  Goal,
  HelmState,
  IntakeDraft,
  IntakeQuestion,
  JournalEvent,
  Loop,
  LoopDefinition,
  LoopDraft,
  Precedent,
  Session,
  TrialVerdict,
  UsageDetail,
  WorkflowDetail,
} from "../state/types.js";
import { canonicalProposedPrecedents, stableDecisionSignature } from "../state/precedents.js";
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

function guardrailsFromPrompt(prompt: string, fallback: string[]): string[] {
  const line = prompt.match(/\bguardrails?\s*:\s*([^\n]+)/i)?.[1];
  if (!line) return fallback;
  const parsed = line.split(/[,|;]/).map((item) => item.trim()).filter(Boolean);
  return parsed.length ? parsed : fallback;
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

function definitionFromDraft(draft: LoopDraft): LoopDefinition {
  const { trialPassed: _trialPassed, lifecycle: _lifecycle, lastTrialVerdict: _lastTrialVerdict, ...definition } = draft;
  return structuredClone(definition);
}

function normalizeVerdict(verdict: TrialVerdict): TrialVerdict {
  const passed = verdict.passed === true;
  return { ...verdict, passed, ok: passed, evidence: verdict.evidence?.map(String) ?? [] };
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
    decisions: [],
    audit: [],
    pausedAll: false,
  };
}

export class RealDataSource implements DataSource {
  private readonly store: HelmStore;
  private readonly intakes = new Map<string, IntakeDraft>();
  private readonly loopDrafts = new Map<string, LoopDraft>();
  private readonly closeouts = new Map<string, Closeout>();
  private readonly observedPrecedents = new Map<string, Precedent>();
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
      loops: loaded.loops.map((loop) => {
        const draft = loaded.loopDrafts.find((item) => item.id === loop.id);
        return {
          ...loop,
          lifecycle: "scheduled" as const,
          scheduledState: loop.scheduledState ?? loop.health,
          pausedReason: loop.health === "paused" ? (loop.pausedReason ?? "paused — reason unavailable from legacy state") : loop.pausedReason,
          activeDefinition: loop.activeDefinition ?? (draft ? definitionFromDraft(draft) : undefined),
        };
      }),
      escalations: loaded.escalations,
      precedents: loaded.precedents,
      journal: loaded.journal,
      decisions: loaded.decisions,
      audit: loaded.audit,
      pausedAll: loaded.pausedAll,
      pauseCheckpoint: loaded.pauseCheckpoint,
    } : deps.nativeState;
    this.store = new HelmStore(nativeState);
    for (const intake of loaded?.intakes ?? []) this.intakes.set(intake.id, intake);
    for (const loop of loaded?.loopDrafts ?? []) {
      const isScheduled = loaded?.loops.some((item) => item.id === loop.id);
      this.loopDrafts.set(loop.id, { ...loop, lifecycle: loop.lifecycle ?? (isScheduled ? "scheduled" : "draft") });
    }
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
      if (this.store.getState().pausedAll) {
        // Runs are already persisted paused; reassert the freeze before considering timers.
        deps.workflows.pauseAll();
      } else {
        for (const loop of this.store.getState().loops) {
          if (loop.nextRunAtMs !== undefined && loop.scheduleEveryMs && loop.nextRunAtMs <= Date.now()) {
            this.store.updateScheduledLoop(loop.id, { health: "idle", scheduledState: "idle" });
          }
          this.armLoop(this.store.getState().loops.find((item) => item.id === loop.id)!);
        }
      }
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
    if (this.store.getState().pausedAll) return;
    const now = Date.now();
    const loops = this.store.getState().loops
      .filter((loop) => loop.health !== "paused" && loop.nextRunAtMs !== undefined)
      .map((loop) => ({ loopId: loop.id, remainingDelayMs: Math.max(0, loop.nextRunAtMs! - now) }));
    const runIds = this.deps.workflows.pauseAll();
    this.store.pauseAll({ runIds, loops, pausedAt: now });
    for (const loop of this.store.getState().loops) this.clearLoopTimer(loop.id);
    this.appendAudit("pause", [...runIds, ...loops.map((item) => item.loopId)], "Paused all active Helm work", `Checkpointed ${runIds.length} runs and ${loops.length} loop deadlines.`);
    this.persist();
  }

  resumeAll(): void {
    const checkpoint = this.store.getState().pauseCheckpoint;
    if (!this.store.getState().pausedAll || !checkpoint) return;
    const now = Date.now();
    const pausedDurationMs = Math.max(0, now - checkpoint.pausedAt);
    this.deps.workflows.resumeAll(checkpoint.runIds);
    for (const paused of checkpoint.loops) {
      const loop = this.store.getState().loops.find((item) => item.id === paused.loopId);
      if (!loop || loop.health === "paused") continue;
      const prePauseDeadline = checkpoint.pausedAt + paused.remainingDelayMs;
      const nextRunAtMs = prePauseDeadline + pausedDurationMs;
      this.store.updateScheduledLoop(loop.id, {
        nextRunAtMs,
        nextRun: `next ${new Date(nextRunAtMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
      });
    }
    this.store.resumeAll();
    for (const loop of this.store.getState().loops) this.armLoop(loop);
    this.appendAudit("resume", [...checkpoint.runIds, ...checkpoint.loops.map((item) => item.loopId)], "Resumed global Helm checkpoint", `Resumed only checkpointed work after ${pausedDurationMs}ms paused.`);
    this.persist();
  }

  pauseWorkflow(id: string): void {
    const workflow = this.store.getState().workflows.find((item) => item.id === id);
    this.store.pauseWorkflow(id);
    this.deps.workflows.pauseWorkflow(id);
    if (workflow) this.appendAudit("pause", [id], `Paused workflow ${workflow.name}`, "DataSource pauseWorkflow boundary.");
    this.persist();
  }

  getDrillIn(workflowId: string): WorkflowDetail | undefined {
    return this.deps.workflows.getDrillIn(workflowId);
  }

  getSession(worktreeId: string): Session | undefined {
    return this.deps.workflows.getSession(worktreeId);
  }

  decide(escalationId: string, option: number): Promise<void> {
    const escalation = this.getEscalation(escalationId);
    this.store.decide(escalationId, option);
    const precedent = escalation ? this.store.getState().precedents.find((item) => item.signature === escalation.signature) : undefined;
    if (precedent) this.appendAudit("precedentApplied", [escalationId, precedent.id], "Recorded an escalation decision as precedent", precedent.decision);
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
    return this.store.getState().precedents.map((durable) => {
      const latest = this.observedPrecedents.get(durable.id);
      return latest
        ? { ...latest, declined: durable.declined, appliesTo: durable.appliesTo }
        : durable;
    });
  }

  declinePrecedent(id: string): void {
    this.setPrecedentDeclined(id, true);
  }

  setPrecedentDeclined(id: string, declined: boolean): void {
    const precedent = this.observedPrecedents.get(id)
      ?? this.store.getState().precedents.find((item) => item.id === id);
    if (!precedent) return;
    if (!this.store.setPrecedentDeclined(precedent, declined)) return;
    this.appendAudit(
      declined ? "precedentDeclined" : "precedentAccepted",
      [id],
      declined ? "Declined a precedent" : "Re-accepted a precedent",
      declined ? "The precedent will not be proposed or auto-applied again." : "The precedent is eligible for closeout application again.",
    );
    this.persist();
  }

  answerEscalationFollowUp(escalationId: string, questionAt: number, answer: string): void {
    const escalation = this.getEscalation(escalationId);
    if (!escalation) return;
    this.store.updateEscalation(escalationId, {
      followUps: (escalation.followUps ?? []).map((followUp) => followUp.at === questionAt ? { ...followUp, answer } : followUp),
    });
    this.persist();
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
    for (const precedent of seed.proposedPrecedents) this.observedPrecedents.set(precedent.id, precedent);
    const proposedPrecedents = canonicalProposedPrecedents(seed.proposedPrecedents, this.store.getState().precedents);
    return { ...seed, proposedPrecedents };
  }

  getUsageDetail(): UsageDetail {
    return this.deps.usage.getUsageDetail();
  }

  addEscalation(escalation: Escalation): void {
    const classified = escalation.resolutionClass === "permission" || escalation.resolutionClass === "approval"
      ? escalation
      : { ...escalation, resolutionClass: "decision" as const, signature: escalation.conflictKind || escalation.scope ? stableDecisionSignature(escalation) : escalation.signature };
    const goalId = classified.goalId ?? this.goalIdForEscalation(classified);
    const resolved = this.store.addEscalation(goalId ? { ...classified, goalId } : classified);
    if (!resolved.resolved) this.appendJournal("escalated", escalation.question);
    else this.appendAudit("autoResolve", [escalation.id], "Auto-resolved a decision conflict", resolved.precedentNote ?? "Applied a stored precedent.");
    this.persist();
  }

  archiveGoal(id: string): void {
    this.store.archiveGoal(id);
    this.persist();
  }

  trialLoop(id: string): Promise<TrialVerdict> {
    const draft = this.loopDrafts.get(id) ?? (this.deps.repository ? undefined : this.deps.synthLoopDraft(id));
    if (!draft) return Promise.resolve({ passed: false, ok: false, evidence: ["Loop draft not found."] });
    const trialing = { ...draft, lifecycle: "trial" as const, trialPassed: false };
    this.loopDrafts.set(id, trialing);
    this.store.setLoopPendingDraft(id, trialing);
    this.persist();
    return this.deps.workflows.trialLoop(trialing).then((result) => {
      const verdict = normalizeVerdict(result);
      const next: LoopDraft = {
        ...trialing,
        lifecycle: verdict.passed ? "trial" : "draft",
        trialPassed: verdict.passed,
        lastTrialVerdict: verdict,
      };
      this.loopDrafts.set(id, next);
      this.store.setLoopPendingDraft(id, next);
      this.persist();
      return verdict;
    }).catch((error) => {
      const verdict = { passed: false, ok: false, evidence: [error instanceof Error ? error.message : String(error)] };
      const next = { ...trialing, lifecycle: "draft" as const, trialPassed: false, lastTrialVerdict: verdict };
      this.loopDrafts.set(id, next);
      this.store.setLoopPendingDraft(id, next);
      this.persist();
      return verdict;
    });
  }

  search(query: string): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const state = this.store.getState();
    const journalResults = state.journal.flatMap<SearchResult>((event) => event.kind === "prOpened" || event.kind === "merged" ? [{
      kind: "pr",
      label: event.label,
      sublabel: event.kind,
      screen: { id: "viewer", title: event.kind, lines: [event.label, new Date(event.timestampMs).toISOString()] },
    }] : event.kind === "loopRunCompleted" ? [{
      kind: "loopRun",
      label: event.label,
      sublabel: "past loop run",
      screen: { id: "viewer", title: "loop run", lines: [event.label, new Date(event.timestampMs).toISOString()] },
    }] : []);
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
      ...(state.decisions ?? []).map((decision) => ({
        kind: "decision" as const,
        label: decision.question,
        sublabel: decision.precedentNote ?? "resolved decision",
        screen: { id: "viewer" as const, title: `decision · ${decision.source.label}`, lines: [decision.problem, ...decision.evidence, decision.precedentNote ?? "resolved"] },
      })),
      ...journalResults,
      ...(state.audit ?? []).map((record) => ({
        kind: "audit" as const,
        label: record.summary,
        sublabel: `${record.kind} · ${record.targetIds.join(", ")} · ${record.detail}`,
        screen: { id: "viewer" as const, title: `audit · ${record.kind}`, lines: [record.summary, record.detail, `targets ${record.targetIds.join(", ")}`, new Date(record.at).toISOString()] },
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
          const planned = await this.deps.workflows.planGoal({ prompt, answers: [] });
          const draft: IntakeDraft = {
            id: uniqueId,
            goalName: shortName(prompt, "new goal"),
            goalPrompt: prompt,
            preamble: planned.questions.length ? "Before I can lock the plan, I need the details that cannot be inferred:" : "The goal is specific enough to plan without follow-up questions.",
            questions: planned.questions.map((question) => question.question),
            questionDetails: planned.questions,
            planWorkflows: planned.plan,
            estWall: planned.estWall,
            estCost: planned.estCost,
            escalationRule: planned.escalationRule,
            openQuestions: planned.questions.some((question) => !question.answer),
          };
          this.intakes.set(uniqueId, draft);
          this.persist();
          return { id: uniqueId, ok: true };
        }
        case "goal.answer": {
          const draft = this.intakes.get(command.draftId);
          if (!draft) return { ok: false, message: "Goal draft no longer exists." };
          const firstAnswer = !draft.goalPrompt;
          const details: IntakeQuestion[] = [...(draft.questionDetails ?? draft.questions.map((question, index) => ({ id: `q${index + 1}`, question })))];
          const unanswered = details.findIndex((question) => !question.answer);
          if (!firstAnswer && unanswered >= 0) details[unanswered] = { ...details[unanswered]!, answer: command.text.trim() };
          const goalPrompt = firstAnswer ? command.text.trim() : draft.goalPrompt;
          const planned = await this.deps.workflows.planGoal({ prompt: goalPrompt, answers: details });
          const next: IntakeDraft = {
            ...draft,
            goalName: firstAnswer ? shortName(command.text, draft.goalName) : draft.goalName,
            goalPrompt,
            userReply: firstAnswer ? draft.userReply : command.text.trim(),
            questionDetails: planned.questions,
            questions: planned.questions.map((question) => question.question),
            planWorkflows: planned.plan,
            estWall: planned.estWall,
            estCost: planned.estCost,
            escalationRule: planned.escalationRule,
            openQuestions: planned.questions.some((question) => !question.answer),
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
          this.appendAudit("goalStarted", [goal.id, ...runIds], `Started goal ${goal.name}`, `Spawned ${runIds.length} workflow run(s) after intake planning completed.`);
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
          this.appendAudit(shouldResume ? "resume" : "pause", lanes.map((lane) => lane.id), `${shouldResume ? "Resumed" : "Paused"} goal ${command.goalId}`, `Changed ${lanes.length} workflow lane(s).`);
          this.persist();
          return { ok: true, message: shouldResume ? "Goal resumed." : "Goal paused." };
        }
        case "goal.archive":
          this.archiveGoal(command.goalId);
          return { ok: true };
        case "goal.applyPrecedents": {
          const closeout = this.getCloseout(command.goalId);
          const decisions = closeout?.proposedPrecedents.map((item) => `- ${item.question}: ${item.decision}`).join("\n") || "- No proposed precedents";
          const ids = closeout?.proposedPrecedents.map((item) => item.id) ?? [];
          for (const precedent of closeout?.proposedPrecedents ?? []) this.store.applyPrecedent(precedent);
          this.appendAudit("precedentApplied", [command.goalId, ...ids], "Handed approved precedents to the application workflow", decisions);
          this.persist();
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
            guardrails: guardrailsFromPrompt(prompt, ["never merges", "requires review", "bounded concurrency"]),
            trialStatement: "run once under full review before scheduling",
            lifecycle: "draft",
          };
          this.loopDrafts.set(id, draft);
          this.persist();
          return { id, ok: true };
        }
        case "loop.edit": {
          const draft = this.loopDrafts.get(command.loopId);
          if (!draft) return { ok: false, message: "Loop draft no longer exists." };
          const prompt = command.text.trim();
          const edited: LoopDraft = {
            ...draft,
            name: shortName(prompt, draft.name),
            prompt,
            trigger: triggerFromPrompt(prompt, draft.trigger),
            steps: prompt || draft.steps,
            guardrails: guardrailsFromPrompt(prompt, draft.guardrails),
            trialPassed: false,
            lifecycle: "draft",
            lastTrialVerdict: undefined,
          };
          this.loopDrafts.set(command.loopId, edited);
          this.store.setLoopPendingDraft(command.loopId, edited);
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
          const previousDefinition = this.store.getState().loops.find((item) => item.id === draft.id)?.activeDefinition;
          const loop: Loop = {
            id: draft.id,
            name: draft.name,
            trigger: draft.trigger,
            pipelineSummary: draft.steps,
            health: "healthy",
            lifecycle: "scheduled",
            scheduledState: "healthy",
            nextRun: `next ${new Date(nextRunAtMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
            scheduleEveryMs: schedule.everyMs,
            nextRunAtMs,
            activeDefinition: definitionFromDraft(draft),
            pendingDraft: undefined,
          };
          this.store.scheduleLoop(loop);
          this.loopDrafts.set(draft.id, { ...draft, lifecycle: "scheduled", trialPassed: true });
          this.appendAudit("loopPromoted", [loop.id], `Promoted accepted loop definition ${loop.name}`, previousDefinition
            ? `Replaced definition: ${JSON.stringify(previousDefinition)}; active definition: ${JSON.stringify(loop.activeDefinition)}`
            : `Initial active definition: ${JSON.stringify(loop.activeDefinition)}`);
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
          {
            const loop = this.store.getState().loops.find((item) => item.id === command.loopId);
            if (loop) this.appendAudit(loop.health === "paused" ? "pause" : "resume", [loop.id], `${loop.health === "paused" ? "Paused" : "Resumed"} loop ${loop.name}`, loop.pausedReason ?? "Operator lifecycle transition.");
          }
          this.persist();
          return { ok: true };
        case "workflow.togglePause": {
          const lane = this.store.getState().workflows.find((workflow) => workflow.id === command.workflowId);
          if (!lane) return { ok: false, message: "Workflow no longer exists." };
          if (lane.state === "paused") {
            this.store.resumeWorkflow(lane.id);
            const ok = await this.deps.workflows.resumeWorkflow(lane.id);
            if (ok) this.appendAudit("resume", [lane.id], `Resumed workflow ${lane.name}`, "Operator resumed one workflow lane.");
            this.persist();
            return { ok, message: "Workflow resumed." };
          }
          this.store.pauseWorkflow(lane.id);
          this.deps.workflows.pauseWorkflow(lane.id);
          this.appendAudit("pause", [lane.id], `Paused workflow ${lane.name}`, "Operator paused one workflow lane.");
          this.persist();
          return { ok: true, message: "Workflow paused." };
        }
        case "worktree.togglePause":
          if (this.deps.workflows.isWorktreePaused(command.worktreeId)) {
            const ok = this.deps.workflows.resumeWorktree(command.worktreeId);
            if (ok) this.appendAudit("resume", [command.worktreeId], "Resumed one worktree agent", `Workflow ${command.workflowId} siblings were left unchanged.`);
            this.persist();
            return { ok, message: ok ? "Worktree resumed." : "Worktree is no longer resumable." };
          } else {
            const ok = this.deps.workflows.pauseWorktree(command.worktreeId);
            if (ok) this.appendAudit("pause", [command.worktreeId], "Paused one worktree agent", `Workflow ${command.workflowId} siblings were left running.`);
            this.persist();
            return { ok, message: ok ? "Worktree paused." : "Worktree is no longer active." };
          }
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
          return { ok: true, message: "Follow-up added; the escalation remains active." };
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
      if (progress.complete && goal.phase !== "complete") {
        this.appendAudit("runCompleted", [goal.id], `Completed goal ${goal.name}`, "All persisted workflow runs for the goal reached completion.");
      }
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

  private appendAudit(kind: AuditRecord["kind"], targetIds: string[], summary: string, detail: string): void {
    this.store.appendAudit({ id: randomUUID(), kind, targetIds, at: Date.now(), summary, detail });
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
    const definition = loop?.activeDefinition;
    if (!loop || !definition || this.store.getState().pausedAll || loop.health === "paused" || !loop.scheduleEveryMs) return;
    const result: { ok: boolean; runId?: string } = await this.deps.workflows.runLoop(structuredClone(definition)).catch(() => ({ ok: false }));
    const now = Date.now();
    const nextRunAtMs = now + loop.scheduleEveryMs;
    const updated: Loop = result.ok ? {
      ...loop,
      health: "healthy",
      scheduledState: "healthy",
      lastFired: new Date(now).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
      nextRun: `next ${new Date(nextRunAtMs).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" })}`,
      nextRunAtMs,
      lastFiredAtMs: now,
      yieldToday: "last run completed",
    } : {
      ...loop,
      health: "paused",
      scheduledState: "paused",
      pausedReason: "last run failed — review required",
      lastFired: new Date(now).toLocaleString([], { weekday: "short", hour: "numeric", minute: "2-digit" }),
      nextRun: undefined,
      nextRunAtMs: undefined,
      lastFiredAtMs: now,
    };
    this.store.updateScheduledLoop(loop.id, updated);
    this.appendJournal(result.ok ? "loopRunCompleted" : "selfCaughtPaused", `${loop.name} ${result.ok ? "completed a scheduled run" : "failed and paused"}`);
    this.appendAudit(result.ok ? "runCompleted" : "selfCaughtPause", [loop.id, ...(result.runId ? [result.runId] : [])], `${loop.name} ${result.ok ? "completed" : "self-caught a failure and paused"}`, result.ok ? "Scheduled run completed and its next deadline was armed." : "The loop will not auto-retry; operator review is required.");
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
      decisions: state.decisions ?? [],
      audit: state.audit ?? [],
      pausedAll: state.pausedAll,
      pauseCheckpoint: state.pauseCheckpoint,
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
    pauseWorktree: () => true,
    resumeWorktree: () => true,
    isWorktreePaused: () => false,
    pauseAll: () => [],
    resumeAll: () => {},
    planGoal: async ({ prompt }) => ({ questions: prompt ? [] : [{ id: "outcome", question: "What outcome?" }], plan: [{ name: "execute", description: "implement and verify" }], estWall: "1-3h", estCost: "~$8-20", escalationRule: "ambiguous decisions escalate" }),
    startGoal: () => Promise.resolve(["test-run"]),
    trialLoop: (loop) => Promise.resolve({ passed: !loop.id.includes("fail"), ok: !loop.id.includes("fail"), evidence: ["test verdict"], runId: "test-trial" }),
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
    synthDigest: () => seedDigest(),
    synthIntake: (id) => seedIntake(id),
    synthLoopDraft: (id, name) => seedLoopDraft(id, name),
    synthCloseout: (goalId) => seedCloseout(goalId),
    shouldShowDigestFlag: false,
  });
}
