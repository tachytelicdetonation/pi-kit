/**
 * RealDataSource — the REAL composite {@link DataSource} behind helm's panel.
 *
 * It owns a {@link HelmStore} for the helm-native domain (goals, loops, escalations,
 * precedents, journal) and pulls the backend-derived slices (workflow lanes, the
 * footer, drill-ins, sessions, usage) through {@link WorkflowPort} / {@link UsagePort}.
 * The same class runs in tests and production — only the ports differ: test fakes
 * here, adapters over dynamic-workflows / claude-cmux / usage-health at merge time.
 *
 * The helm-native drafts that no backend produces yet (intake, loop-builder, digest,
 * closeout) come through injected synthesis functions (seed-backed in tests; real
 * LLM synthesis lands with the screens that consume them). Nothing about the shape
 * of {@link DataSource} changes — that is what lets {@link createTestRealDataSource}
 * pass the very same conformance contract MockDataSource does.
 */
import { HelmStore } from "../state/store.js";
import type {
  Closeout,
  DigestData,
  Escalation,
  HelmState,
  IntakeDraft,
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
import type { DataSource, SearchResult } from "./source.js";

/** Everything RealDataSource composes. Ports are backend seams; synth fills the
 * helm-native drafts no backend produces yet. All required — the factory wires them. */
export interface RealDataSourceDeps {
  workflows: WorkflowPort;
  usage: UsagePort;
  /** Native seed (goals/loops/escalations); workflows + footer are overwritten from ports. */
  nativeState: HelmState;
  /** Run a loop's mandatory trial under full review (§7a). */
  trialLoop: (id: string) => Promise<{ ok: boolean }>;
  synthDigest: () => DigestData;
  synthIntake: (id: string) => IntakeDraft;
  synthLoopDraft: (id: string, name?: string) => LoopDraft;
  synthCloseout: (goalId: string) => Closeout;
  /** Launch-time "away > 30 min" flag (real source derives it from the journal). */
  shouldShowDigestFlag: boolean;
}

export class RealDataSource implements DataSource {
  private readonly store: HelmStore;

  constructor(private readonly deps: RealDataSourceDeps) {
    this.store = new HelmStore(deps.nativeState);
    // Pull the backend-derived slices into the single composed state up front …
    this.store.setWorkflows(deps.workflows.listWorkflows());
    this.store.setFooter(deps.usage.getFooter());
    // … then keep them live. Test fakes never emit, so tests stay deterministic;
    // real adapters push WorkflowManager / UsageService updates through here.
    deps.workflows.subscribe(() => this.store.setWorkflows(deps.workflows.listWorkflows()));
    deps.usage.subscribe(() => this.store.setFooter(deps.usage.getFooter()));
  }

  snapshot(): HelmState {
    return this.store.getState();
  }

  subscribe(callback: () => void): () => void {
    return this.store.subscribe(callback);
  }

  pauseAll(): void {
    this.store.pauseAll();
  }

  resumeAll(): void {
    this.store.resumeAll();
  }

  pauseWorkflow(id: string): void {
    // Optimistic: reflect the pause in the store immediately (interaction-first —
    // the operator sees feedback now), then tell the backend. Its next event
    // reconciles the authoritative state.
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
    return this.deps.synthDigest();
  }

  shouldShowDigest(): boolean {
    return this.deps.shouldShowDigestFlag;
  }

  getIntake(draftId: string): IntakeDraft | undefined {
    if (!draftId) return undefined;
    return this.deps.synthIntake(draftId);
  }

  getLoopDraft(loopId: string): LoopDraft | undefined {
    if (!loopId) return undefined;
    const loop = this.store.getState().loops.find((item) => item.id === loopId);
    return this.deps.synthLoopDraft(loopId, loop?.name);
  }

  getCloseout(goalId: string): Closeout | undefined {
    if (!goalId) return undefined;
    const seed = this.deps.synthCloseout(goalId);
    // Merge the precedents recorded via decide (the SAME store as 7b) with the
    // proposed ones, then drop DECLINED precedents so they are never re-proposed.
    const merged = [...seed.proposedPrecedents, ...this.store.getState().precedents];
    const seen = new Set<string>();
    const proposedPrecedents: Precedent[] = [];
    for (const precedent of merged) {
      if (precedent.declined || seen.has(precedent.id)) continue;
      seen.add(precedent.id);
      proposedPrecedents.push(precedent);
    }
    return { ...seed, proposedPrecedents };
  }

  getUsageDetail(): UsageDetail {
    return this.deps.usage.getUsageDetail();
  }

  addEscalation(escalation: Escalation): void {
    this.store.addEscalation(escalation);
  }

  archiveGoal(id: string): void {
    this.store.archiveGoal(id);
  }

  trialLoop(id: string): Promise<{ ok: boolean }> {
    return this.deps.trialLoop(id);
  }

  search(query: string): SearchResult[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const state = this.store.getState();
    // Search spans EVERYTHING and is forever (archived included): live goals /
    // workflows / loops carry the screen `enter` navigates to; decided precedents
    // make anything pi did autonomously auditable within two keys (README:89) and
    // omit a screen (no dedicated one), so they never open a blank card.
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
}

// ── Test fakes: deterministic ports that reuse the seed shapes, so RealDataSource's
//    COMPOSITION is validated against the same conformance contract as the mock. ──

function fakeWorkflowPort(): WorkflowPort {
  return {
    listWorkflows: () => seedState().workflows,
    getDrillIn: (id) => {
      if (id === "w-codemod") return seedCodemodDrillIn();
      const workflow = seedState().workflows.find((w) => w.id === id);
      return workflow ? genericDrillIn(workflow.id, workflow.goalId, workflow.name) : undefined;
    },
    getSession: (worktreeId) => (worktreeId ? seedSession(worktreeId) : undefined),
    pauseWorkflow: () => {},
    subscribe: () => () => {},
  };
}

function fakeUsagePort(): UsagePort {
  return {
    getFooter: () => seedState().footer,
    getUsageDetail: () => seedUsageDetail(),
    subscribe: () => () => {},
  };
}

/**
 * A hermetic RealDataSource wired to deterministic fakes — the factory the
 * conformance contract (real.conformance.test.ts) instantiates. Proves the real
 * composition satisfies every DataSource invariant before any live backend exists;
 * the structural merge swaps these fakes for real-manager adapters unchanged.
 */
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
