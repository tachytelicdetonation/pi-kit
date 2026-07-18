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
import { genericDrillIn, seedCloseout, seedCodemodDrillIn, seedDigest, seedIntake, seedLoopDraft, seedSession, seedState, seedUsageDetail, } from "./mock.js";
export class RealDataSource {
    deps;
    store;
    constructor(deps) {
        this.deps = deps;
        this.store = new HelmStore(deps.nativeState);
        // Pull the backend-derived slices into the single composed state up front …
        this.store.setWorkflows(deps.workflows.listWorkflows());
        this.store.setFooter(deps.usage.getFooter());
        // … then keep them live. Test fakes never emit, so tests stay deterministic;
        // real adapters push WorkflowManager / UsageService updates through here.
        deps.workflows.subscribe(() => this.store.setWorkflows(deps.workflows.listWorkflows()));
        deps.usage.subscribe(() => this.store.setFooter(deps.usage.getFooter()));
    }
    snapshot() {
        return this.store.getState();
    }
    subscribe(callback) {
        return this.store.subscribe(callback);
    }
    pauseAll() {
        this.store.pauseAll();
    }
    resumeAll() {
        this.store.resumeAll();
    }
    pauseWorkflow(id) {
        // Optimistic: reflect the pause in the store immediately (interaction-first —
        // the operator sees feedback now), then tell the backend. Its next event
        // reconciles the authoritative state.
        this.store.pauseWorkflow(id);
        this.deps.workflows.pauseWorkflow(id);
    }
    getDrillIn(workflowId) {
        return this.deps.workflows.getDrillIn(workflowId);
    }
    getSession(worktreeId) {
        return this.deps.workflows.getSession(worktreeId);
    }
    decide(escalationId, option) {
        this.store.decide(escalationId, option);
        return Promise.resolve();
    }
    getEscalation(id) {
        return this.store.getState().escalations.find((escalation) => escalation.id === id);
    }
    listEscalations() {
        return this.store.getState().escalations;
    }
    precedents() {
        return this.store.getState().precedents;
    }
    getDigest() {
        return this.deps.synthDigest();
    }
    shouldShowDigest() {
        return this.deps.shouldShowDigestFlag;
    }
    getIntake(draftId) {
        if (!draftId)
            return undefined;
        return this.deps.synthIntake(draftId);
    }
    getLoopDraft(loopId) {
        if (!loopId)
            return undefined;
        const loop = this.store.getState().loops.find((item) => item.id === loopId);
        return this.deps.synthLoopDraft(loopId, loop?.name);
    }
    getCloseout(goalId) {
        if (!goalId)
            return undefined;
        const seed = this.deps.synthCloseout(goalId);
        // Merge the precedents recorded via decide (the SAME store as 7b) with the
        // proposed ones, then drop DECLINED precedents so they are never re-proposed.
        const merged = [...seed.proposedPrecedents, ...this.store.getState().precedents];
        const seen = new Set();
        const proposedPrecedents = [];
        for (const precedent of merged) {
            if (precedent.declined || seen.has(precedent.id))
                continue;
            seen.add(precedent.id);
            proposedPrecedents.push(precedent);
        }
        return { ...seed, proposedPrecedents };
    }
    getUsageDetail() {
        return this.deps.usage.getUsageDetail();
    }
    addEscalation(escalation) {
        this.store.addEscalation(escalation);
    }
    archiveGoal(id) {
        this.store.archiveGoal(id);
    }
    trialLoop(id) {
        return this.deps.trialLoop(id);
    }
    search(query) {
        const q = query.trim().toLowerCase();
        if (!q)
            return [];
        const state = this.store.getState();
        // Search spans EVERYTHING and is forever (archived included): live goals /
        // workflows / loops carry the screen `enter` navigates to; decided precedents
        // make anything pi did autonomously auditable within two keys (README:89) and
        // omit a screen (no dedicated one), so they never open a blank card.
        const corpus = [
            ...state.goals.map((goal) => ({
                kind: "goal",
                label: goal.name,
                sublabel: `${Math.round(goal.progress * 100)}% · ${goal.phase}`,
                screen: { id: "closeout", goalId: goal.id },
            })),
            ...state.workflows.map((workflow) => ({
                kind: "workflow",
                label: workflow.name,
                sublabel: workflow.summary,
                screen: { id: "drillin", workflowId: workflow.id },
            })),
            ...state.loops.map((loop) => ({
                kind: "loop",
                label: loop.name,
                sublabel: loop.pipelineSummary,
                screen: { id: "loopBuilder", loopId: loop.id },
            })),
            ...state.precedents.map((precedent) => ({
                kind: "precedent",
                label: precedent.question,
                sublabel: `decision · ${precedent.decision}`,
            })),
        ];
        return corpus.filter((result) => `${result.label} ${result.sublabel ?? ""}`.toLowerCase().includes(q));
    }
}
// ── Test fakes: deterministic ports that reuse the seed shapes, so RealDataSource's
//    COMPOSITION is validated against the same conformance contract as the mock. ──
function fakeWorkflowPort() {
    return {
        listWorkflows: () => seedState().workflows,
        getDrillIn: (id) => {
            if (id === "w-codemod")
                return seedCodemodDrillIn();
            const workflow = seedState().workflows.find((w) => w.id === id);
            return workflow ? genericDrillIn(workflow.id, workflow.goalId, workflow.name) : undefined;
        },
        getSession: (worktreeId) => (worktreeId ? seedSession(worktreeId) : undefined),
        pauseWorkflow: () => { },
        subscribe: () => () => { },
    };
}
function fakeUsagePort() {
    return {
        getFooter: () => seedState().footer,
        getUsageDetail: () => seedUsageDetail(),
        subscribe: () => () => { },
    };
}
/**
 * A hermetic RealDataSource wired to deterministic fakes — the factory the
 * conformance contract (real.conformance.test.ts) instantiates. Proves the real
 * composition satisfies every DataSource invariant before any live backend exists;
 * the structural merge swaps these fakes for real-manager adapters unchanged.
 */
export function createTestRealDataSource() {
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
