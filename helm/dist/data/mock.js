/**
 * MockDataSource — a deterministic, seeded {@link DataSource} for Phase 2.
 *
 * Backed by a {@link HelmStore}, it serves fixtures shaped like the design mock:
 * two goals (one with a purple-tagged non-default-model lane), three loops (one
 * yielding, one idle, one scheduled), two needs-you escalations, and fleet footer
 * numbers. Any timer-driven mutation is OPT-IN (constructor flag, default OFF) so
 * every test is deterministic; the not-yet-implemented DataSource methods throw a
 * clearly-labelled "phase 2" error rather than silently no-op.
 */
import { HelmStore } from "./../state/store.js";
const MAIN_MODEL = "gpt-5.6-sol";
/** Chip run for a worktree: one fix, two review, one apply agent (`▪ → ▪▪ → ▪`). */
const CHIP_RUN = [
    { stage: "fix" },
    { stage: "review" },
    { stage: "review" },
    { stage: "apply" },
];
/**
 * The 6c drill-in seed for the codemod lane — matches the mock: 16 lanes ×
 * 4 worktrees · 64 agents, 1,204 imports left from 16,000, burn 410/hr, done
 * ~03:40. Four worktree rows with fix→review→apply chips and per-package
 * race-to-green strips (pkg/http has none). Deterministic — no timers.
 */
export function seedCodemodDrillIn() {
    return {
        workflowId: "w-codemod",
        label: "esm › codemod",
        lanes: 16,
        agents: 64,
        queueRemaining: 1_204,
        queueTotal: 16_000,
        queueUnit: "imports",
        burnPerHr: 410,
        etaText: "~03:40",
        queueNote: "queue: cargo-style error file, grouped by package",
        worktrees: [
            {
                id: "wt-1",
                name: "wt-1",
                package: "pkg/core",
                chips: CHIP_RUN,
                appliedText: "252 applied",
                testState: "green",
                statusTime: "14:02",
                testTicks: ["red", "red", "green", "green", "red", "green", "green", "green"],
                raceStatus: "green",
                raceTime: "14:02",
            },
            {
                id: "wt-2",
                name: "wt-2",
                package: "pkg/cli",
                chips: CHIP_RUN,
                appliedText: "55 in review",
                testState: "red",
                testTicks: ["red", "red", "red", "green", "red", "green", "green"],
                raceStatus: "wobbling",
            },
            {
                id: "wt-3",
                name: "wt-3",
                package: "pkg/api",
                chips: CHIP_RUN,
                appliedText: "39 applied",
                testState: "red",
                testTicks: ["red", "green", "red", "red", "green", "red", "red"],
                raceStatus: "red",
            },
            {
                id: "wt-4",
                name: "wt-4",
                package: "pkg/http",
                chips: CHIP_RUN,
                appliedText: "6 applied",
                testState: "red",
                modelTag: "haiku-5",
                testTicks: [],
            },
        ],
    };
}
/** A lighter generic drill-in for any other lane, so `enter` never dead-ends.
 * Exported so the RealDataSource test fake reuses the same shapes (parity with the
 * mock keeps the conformance contract meaningful for both). */
export function genericDrillIn(workflowId, goalId, name) {
    return {
        workflowId,
        label: `${goalId.replace(/^g-/, "")} › ${name}`,
        lanes: 4,
        agents: 8,
        queueRemaining: 120,
        queueTotal: 400,
        queueUnit: "tasks",
        burnPerHr: 90,
        etaText: "~01:20",
        queueNote: "queue: grouped by package",
        worktrees: [
            {
                id: `${workflowId}-wt-1`,
                name: "wt-1",
                package: "pkg/a",
                chips: CHIP_RUN,
                appliedText: "40 applied",
                testState: "green",
                statusTime: "12:10",
                testTicks: ["red", "green", "green", "green"],
                raceStatus: "green",
                raceTime: "12:10",
            },
            {
                id: `${workflowId}-wt-2`,
                name: "wt-2",
                package: "pkg/b",
                chips: CHIP_RUN,
                appliedText: "12 in review",
                testState: "wobbling",
                testTicks: ["red", "red", "green", "red", "green"],
                raceStatus: "wobbling",
            },
        ],
    };
}
/**
 * The 4a session seed — matches the mock transcript: a rate-limiting turn with
 * context / parallel / edit / edit / verify activity lines, ✓ build ✓ lint ✓ 142
 * tests receipts, and a closing claim. Parameterised by worktree id so any
 * worktree opens a coherent transcript. Deterministic — no timers.
 */
export function seedSession(worktreeId) {
    return {
        worktreeId,
        task: "add rate limiting to /api",
        prompt: "add per-user rate limiting to the api",
        receipts: { build: true, lint: true, tests: 142 },
        lines: [
            {
                verb: "context",
                target: "9 files · src/api src/middleware · skill: api-conventions",
                result: "2.1s",
            },
            {
                verb: "parallel",
                target: "read ratelimit.md · grep limiter · bash pnpm ls express",
                result: "0.8s",
            },
            {
                verb: "edit",
                target: "src/middleware/ratelimit.ts",
                result: "",
                added: 48,
                removed: 0,
                expandable: true,
                moreCount: 45,
                peek: [
                    "12 + export function rateLimit(opts: RateLimitOptions) {",
                    "13 + const bucket = buckets.get(userId) ?? new TokenBucket(opts)",
                    "14 + if (!bucket.take()) throw new TooManyRequests()",
                ],
            },
            {
                verb: "edit",
                target: "src/api/server.ts",
                result: "",
                added: 3,
                removed: 1,
                expandable: true,
                moreCount: 2,
                peek: [
                    "8 + import { rateLimit } from '../middleware/ratelimit'",
                    "9 + app.use('/api', rateLimit({ perMinute: 100 }))",
                    "10 − app.use('/api', legacyThrottle)",
                ],
            },
            {
                verb: "verify",
                target: "pnpm test",
                result: "✓ exit 0 · 4.2s",
                expandable: true,
                peek: ["142 passed · 0 failed · 3.9s"],
            },
        ],
        claim: "Added token-bucket rate limiting (100 req/min per user) on all /api routes. Verified end-to-end.",
    };
}
/**
 * The 7b escalation seed — matches the mock card: the export-map conflict, a
 * 3-line MINIMAL evidence block (a caption + the two diff lines, NEVER the full
 * file), and three options with option 1 recommended.
 */
export function seedExportMapEscalation() {
    return {
        id: "e-export-map",
        source: { kind: "workflow", label: "esm › codemod" },
        question: "touched an export map (platform team owns it)",
        verb: "review",
        blockedSinceMs: 1_000,
        idleCost: "$0.40 idle",
        problem: "pkg/api's ESM rewrite requires touching exports.map.json — you told me to avoid it: platform team merged a conflicting change 40 min ago.",
        evidence: [
            "the 4-line conflict, not the 300-line file:",
            '- "./api": "./dist/api.cjs"  (theirs, merged 40m ago)',
            '+ "./api": { "import": "./dist/api.mjs" }  (what the migration needs)',
        ],
        options: [
            { text: "keep both: conditional exports block — pi drafts it, platform team auto-CC'd on the PR", recommended: true },
            { text: "skip pkg/api's export map, file a ticket to platform, migration continues around it" },
            { text: "pause pkg/api entirely until you talk to platform" },
        ],
        blockedMinutes: 12,
        idleNote: "wt-3 idle while you decide",
        signature: "workflow:export-map-conflict",
        precedentPhrase: "export maps → conditional block",
        worktreeId: "wt-3",
    };
}
/** A second escalation so `[ ]` cycling and the tab triage walk have somewhere to go. */
export function seedApiRenameEscalation() {
    return {
        id: "e-api-rename",
        source: { kind: "loop", label: "gh-issues loop" },
        question: "#4312 needs a product call on the API rename",
        verb: "answer",
        blockedSinceMs: 2_000,
        problem: "#4312 wants to rename the public listItems() API — the loop can't open the PR without a product call.",
        evidence: [
            "the rename touches the shipped public surface:",
            "- listItems(opts)  (current, shipped in v3)",
            "+ list(opts)  (proposed by the issue)",
        ],
        options: [
            { text: "keep listItems, add list() as an alias — non-breaking, ship now", recommended: true },
            { text: "rename to list() and bump a major version with a changelog migration note" },
            { text: "defer: leave #4312 for the next product sync" },
        ],
        blockedMinutes: 8,
        idleNote: "gh-issues loop idle while you decide",
        signature: "loop:public-api-rename",
        precedentPhrase: "public API renames → alias, non-breaking",
    };
}
/**
 * The 7c catch-up digest seed — matches the mock: a span + spend, one row of each
 * of the four line types, and the overnight per-provider quota drain.
 */
export function seedDigest() {
    return {
        spanText: "9:40 pm → 7:15 am",
        spentText: "$9.80 spent",
        shippedGoals: ["esm migration 58% → 71% · pkg/core green, 252 merges, 0 rollbacks"],
        shippedByLoops: ["gh-issues loop shipped 4 PRs (#4301 #4303 #4308 #4310) — 2 already approved by your team"],
        decisionsQueued: [
            "2 decisions queued (export map · #4312 API rename) — nothing is blocked-blocked; wt-3 rerouted to pkg/http meanwhile",
        ],
        failedHandled: [
            "1 self-caught failure: test-repair's flake fix regressed a timing test — auto-reverted, retrying with a different approach",
        ],
        quotaDrain: [
            { provider: "codex", deltaPercent: -9 },
            { provider: "claude", deltaPercent: -4 },
            { provider: "kimi", deltaPercent: 0 },
        ],
    };
}
/**
 * The 6a intent-intake seed — matches the mock: the ESM goal, three un-inferable
 * questions (so `g go` renders DIM/disabled per the "open questions" rule), and a
 * three-workflow plan (docs on a non-default `opus-mini`, rendered purple).
 */
export function seedIntake(draftId = "d-esm") {
    return {
        id: draftId,
        goalName: "migrate repo to ESM",
        goalPrompt: "migrate the repo to ESM",
        preamble: "Before I plan workflows — three things I can't infer:",
        questions: [
            "scope: all 8 packages, or leave pkg/legacy alone?",
            "the platform team owns the export maps — coordinate with them or avoid those files?",
            "merge policy: auto-merge green codemods, or you review everything?",
        ],
        // Open questions remain → `g go` is disabled. A real source flips this once the
        // operator answers (the reply would then echo as `userReply`).
        planWorkflows: [
            { name: "codemod", description: "4 worktrees, per-package lanes" },
            { name: "test-repair", description: "follows codemod, own worktree" },
            { name: "docs", description: "starts when codemod is green", modelTag: "opus-mini" },
        ],
        estWall: "6-9h wall",
        estCost: "~$40",
        escalationRule: "export-map touches escalate to you",
        openQuestions: true,
    };
}
/**
 * The 7a loop-builder seed — matches the mock: the gh-issues loop structured into
 * trigger / steps / skips / guardrails (a `haiku-5` per-step model on triage,
 * rendered purple) and the mandatory trial statement.
 */
export function seedLoopDraft(id = "l-draft-gh-issues", name = "gh-issues") {
    return {
        id,
        name,
        prompt: "watch our github issues, fix anything that's a real bug, run tests, open a PR",
        trigger: "new issue labeled bug, or existing issue gets a repro",
        steps: "triage → reproduce → fix in own worktree → verify → PR w/ repro test",
        skips: "feature requests, questions, anything needing a product call → escalates",
        guardrails: ["never merges", "$3/day cap", "max 3 concurrent"],
        guardrailModel: { model: "haiku-5", note: "for triage step" },
        trialStatement: "run once on issue #4307 under full review, then propose a schedule",
    };
}
/** Human names for the goals a closeout can be opened for (search corpus + esm). */
const CLOSEOUT_NAMES = {
    "g-esm": "migrate repo to ESM",
    "g-auth": "auth v2 rollout",
    "g-perf": "q3 perf pass",
};
/**
 * The 7d goal-closeout seed — matches the mock receipt for the ESM migration. The
 * proposed precedents include a DECLINED one (`pc-deps`) that {@link
 * MockDataSource.getCloseout} filters out, proving declined precedents are never
 * re-proposed.
 */
export function seedCloseout(goalId = "g-esm") {
    return {
        goalId,
        goalName: CLOSEOUT_NAMES[goalId] ?? "completed goal",
        startedText: "started tue 9:04 am",
        landedText: "landed thu 3:12 pm",
        packagesDone: 17,
        packagesTotal: 17,
        unit: "packages",
        addedText: "+41.2k",
        removedText: "−38.7k",
        commitsText: "611 commits",
        greenText: "100% green",
        actualCost: "$61.40",
        estCost: "~$40",
        yourTime: "11 decisions · 24 min total attention across 3 days",
        interventions: "2 escalations · 1 self-caught regression (auto-reverted) · 0 rollbacks post-merge",
        overrunWhy: "pkg/api export-map detour + 2 flaky suites cost ~$18 of retries",
        proposedPrecedents: [
            {
                id: "pc-export-map",
                signature: "workflow:export-map-conflict",
                question: "export maps are platform-owned",
                decision: "always draft conditional blocks, CC platform",
                rationale: "recurred across pkg/api and pkg/http",
            },
            {
                id: "pc-flaky-net",
                signature: "test:pkg-net-timing",
                question: "timing-sensitive tests in pkg/net are flaky under parallel runs",
                decision: "serialize them",
                rationale: "two suites cost ~$18 of retries",
            },
            {
                // DECLINED — must never be re-proposed (filtered out by getCloseout).
                id: "pc-deps",
                signature: "loop:nightly-dep-bumps",
                question: "auto-bump all deps nightly",
                decision: "pin majors, patch only",
                rationale: "operator declined the broad-bump precedent",
                declined: true,
            },
        ],
        nextSuggestion: 'pi suggests "q3 perf pass" absorbs wt-1..4 while they\'re warm',
    };
}
/** The ctrl+u usage-popover seed — per-provider %, reset dates, spend, per-goal split. */
export function seedUsageDetail() {
    return {
        providers: [
            { id: "codex", remaining: 90, resetText: "resets in 3d" },
            { id: "claude", remaining: 100, resetText: "resets in 5d" },
            { id: "kimi", remaining: 60, resetText: "resets in 2d" },
        ],
        spendToday: "$18.40",
        spendWeek: "$96.20",
        perGoal: [
            { name: "migrate repo to ESM", cost: "$4.20" },
            { name: "q3 perf pass", cost: "$2.10" },
        ],
    };
}
/**
 * The `/` search corpus — everything, ARCHIVED included (search is forever). Results
 * carry the screen `enter` navigates to; kinds with no dedicated screen (pr,
 * loopRun, and the deferred decision) omit it so the app falls back sensibly.
 * `auth v2 rollout` is archived and lives ONLY here, proving search finds archived.
 */
export function seedSearchCorpus() {
    return [
        { kind: "goal", label: "migrate repo to ESM", sublabel: "71% · running", screen: { id: "closeout", goalId: "g-esm" } },
        { kind: "goal", label: "q3 perf pass", sublabel: "25% · running", screen: { id: "closeout", goalId: "g-perf" } },
        { kind: "goal", label: "auth v2 rollout", sublabel: "archived", screen: { id: "closeout", goalId: "g-auth" } },
        { kind: "workflow", label: "codemod", sublabel: "esm migration", screen: { id: "drillin", workflowId: "w-codemod" } },
        { kind: "workflow", label: "test-repair", sublabel: "esm migration", screen: { id: "drillin", workflowId: "w-test-repair" } },
        { kind: "workflow", label: "docs", sublabel: "esm migration", screen: { id: "drillin", workflowId: "w-docs" } },
        { kind: "workflow", label: "profiling", sublabel: "q3 perf pass", screen: { id: "drillin", workflowId: "w-profiling" } },
        { kind: "loop", label: "gh-issues", sublabel: "4 PRs today", screen: { id: "loopBuilder", loopId: "l-gh-issues" } },
        { kind: "loop", label: "ci-red", sublabel: "idle · last fired 2h ago", screen: { id: "loopBuilder", loopId: "l-ci-red" } },
        { kind: "loop", label: "deps", sublabel: "next run 02:00", screen: { id: "loopBuilder", loopId: "l-deps" } },
        {
            kind: "decision",
            label: "touched an export map (platform team owns it)",
            sublabel: "needs you · esm › codemod",
            screen: { id: "escalation", escalationId: "e-export-map" },
        },
        { kind: "precedent", label: "export maps → conditional block", sublabel: "decision · esm", screen: { id: "closeout", goalId: "g-esm" } },
        { kind: "decision", label: "public API renames → alias, non-breaking", sublabel: "#4312" },
        { kind: "pr", label: "#4301 fix flaky timer test", sublabel: "gh-issues loop · merged" },
        { kind: "pr", label: "#4308 rate-limit /api", sublabel: "gh-issues loop · in review" },
        { kind: "loopRun", label: "gh-issues run #88 — 2 PRs opened", sublabel: "loop run · 03:12" },
    ];
}
/** The seed state — matches the 6b mock's content, hierarchy and footer numbers. */
export function seedState() {
    return {
        mainModel: MAIN_MODEL,
        pausedAll: false,
        goals: [
            { id: "g-esm", name: "migrate repo to ESM", phase: "running", progress: 0.71, etaText: "~6h left" },
            { id: "g-perf", name: "q3 perf pass", phase: "running", progress: 0.25, etaText: "~2d left" },
        ],
        workflows: [
            { id: "w-codemod", goalId: "g-esm", name: "codemod", state: "running", summary: "4 worktrees · 14/17 packages" },
            { id: "w-test-repair", goalId: "g-esm", name: "test-repair", state: "verifying", summary: "worktree wt-5 · 3 flakes open" },
            { id: "w-docs", goalId: "g-esm", name: "docs", state: "queued", summary: "waiting on codemod ✓", modelTag: "opus-mini" },
            { id: "w-profiling", goalId: "g-perf", name: "profiling", state: "running", summary: "3 benches running", modelTag: "gpt-5.6-turbo" },
        ],
        loops: [
            {
                id: "l-gh-issues",
                name: "gh-issues",
                trigger: "watch issues",
                pipelineSummary: "fix → test → PR",
                health: "healthy",
                yieldToday: "4 PRs today",
                costToday: "$1.20",
            },
            {
                id: "l-ci-red",
                name: "ci-red",
                trigger: "red on main",
                pipelineSummary: "flake hunter → bisect",
                health: "idle",
                lastFired: "2h ago",
            },
            {
                id: "l-deps",
                name: "deps",
                trigger: "nightly",
                pipelineSummary: "bumps → audit",
                health: "healthy",
                nextRun: "02:00",
            },
        ],
        escalations: [seedExportMapEscalation(), seedApiRenameEscalation()],
        precedents: [],
        journal: [],
        footer: {
            cwd: "~/pi-kit",
            branch: "main",
            providers: [
                { id: "codex", remaining: 90 },
                { id: "claude", remaining: 100 },
                { id: "kimi", remaining: 60 },
            ],
            burnRatePerMin: 41_000,
            spendTodayUsd: 18.4,
            ctxPercent: 60,
            costUsd: 0.012,
            model: MAIN_MODEL,
            effort: "auto",
        },
    };
}
export class MockDataSource {
    intakes = new Map();
    loopDrafts = new Map();
    store;
    showDigest;
    /**
     * @param options.tick - opt-in periodic mutation (default OFF). Kept off for
     *   deterministic tests; when enabled a real interval would drive progress.
     * @param options.shouldShowDigest - launch-time "away > 30 min" flag. DEFAULT
     *   OFF so the base (263-test) launch still lands on home; a real source would
     *   compute it from the activity journal's timestamps.
     */
    constructor(options = {}) {
        this.store = new HelmStore(seedState());
        this.showDigest = options.shouldShowDigest ?? false;
        // ponytail: no live ticking implemented in Phase 2 — the flag exists so the
        // opt-in contract is honored and tests can assert it stays off by default.
        void options.tick;
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
        this.store.pauseWorkflow(id);
    }
    getDrillIn(workflowId) {
        if (workflowId === "w-codemod")
            return seedCodemodDrillIn();
        const workflow = this.store.getState().workflows.find((w) => w.id === workflowId);
        if (!workflow)
            return undefined;
        return genericDrillIn(workflow.id, workflow.goalId, workflow.name);
    }
    getSession(worktreeId) {
        if (!worktreeId)
            return undefined;
        return seedSession(worktreeId);
    }
    // ── 7b escalations + precedents (Phase 4) ────────────────────────────────
    decide(escalationId, option) {
        // The store mutates synchronously (records the precedent + drops the item);
        // the resolved promise honors the async DataSource contract for real sources.
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
    // ── 7c catch-up digest (Phase 4) ─────────────────────────────────────────
    getDigest() {
        return seedDigest();
    }
    shouldShowDigest() {
        return this.showDigest;
    }
    // ── 6a / 7a / 7d drafts + closeout (Phase 5) ─────────────────────────────
    getIntake(draftId) {
        if (!draftId)
            return undefined;
        const existing = this.intakes.get(draftId);
        if (existing)
            return existing;
        const draft = seedIntake(draftId);
        this.intakes.set(draftId, draft);
        return draft;
    }
    getLoopDraft(loopId) {
        if (!loopId)
            return undefined;
        const existing = this.loopDrafts.get(loopId);
        if (existing)
            return existing;
        // Reuse an existing loop's name when the id is a live loop; otherwise the draft
        // keeps the gh-issues shape (a single seeded structure, like a session).
        const loop = this.store.getState().loops.find((item) => item.id === loopId);
        const draft = seedLoopDraft(loopId, loop?.name ?? "gh-issues");
        this.loopDrafts.set(loopId, draft);
        return draft;
    }
    getCloseout(goalId) {
        if (!goalId)
            return undefined;
        const seed = seedCloseout(goalId);
        // Merge the precedents recorded via decide (the SAME store as 7b) with the
        // proposed ones, then drop DECLINED precedents so they are never re-proposed.
        const live = this.store.getState().precedents;
        const merged = [...seed.proposedPrecedents, ...live];
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
    // ── Global features (Phase 5) ────────────────────────────────────────────
    getUsageDetail() {
        return seedUsageDetail();
    }
    addEscalation(escalation) {
        this.store.addEscalation(escalation);
    }
    // ── Archive + trial + search (Phase 5) ───────────────────────────────────
    archiveGoal(id) {
        this.store.archiveGoal(id);
    }
    trialLoop(id) {
        // Deterministic outcome for tests: a draft id containing "fail" fails its trial,
        // everything else passes. A real source would run the loop once under review.
        const ok = !id.includes("fail");
        const draft = this.getLoopDraft(id);
        if (ok && draft)
            this.loopDrafts.set(id, { ...draft, trialPassed: true });
        return Promise.resolve({ ok });
    }
    search(query) {
        const q = query.trim().toLowerCase();
        if (!q)
            return [];
        // Search is FOREVER and spans everything pi did autonomously — including
        // decisions recorded via decide() (design README:89, "auditable within two
        // keys"). The static corpus is history; live precedents make a fresh decision
        // findable the instant it is made. A precedent has no dedicated screen, so it
        // omits `screen` (the app falls back), never opening a blank card.
        const live = this.store.getState().precedents.map((precedent) => ({
            kind: "precedent",
            label: precedent.question,
            sublabel: `decision · ${precedent.decision}`,
        }));
        return [...seedSearchCorpus(), ...live].filter((result) => {
            const haystack = `${result.label} ${result.sublabel ?? ""}`.toLowerCase();
            return haystack.includes(q);
        });
    }
    async execute(command) {
        switch (command.type) {
            case "goal.createDraft": {
                const id = command.draftId ?? (command.prompt ? `d-${command.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}` : "d-esm");
                const seeded = seedIntake(id);
                this.intakes.set(id, command.prompt ? {
                    ...seeded,
                    goalName: command.prompt,
                    goalPrompt: command.prompt,
                    questions: [],
                    openQuestions: false,
                } : seeded);
                return { id, ok: true };
            }
            case "goal.answer": {
                const draft = this.getIntake(command.draftId);
                if (draft)
                    this.intakes.set(command.draftId, { ...draft, userReply: command.text, openQuestions: false });
                return { ok: Boolean(draft) };
            }
            case "goal.editPlan": {
                const draft = this.getIntake(command.draftId);
                if (draft?.planWorkflows[command.index]) {
                    const planWorkflows = draft.planWorkflows.map((plan, index) => index === command.index ? { ...plan, description: command.text } : plan);
                    this.intakes.set(command.draftId, { ...draft, planWorkflows });
                }
                return { ok: Boolean(draft) };
            }
            case "goal.discardDraft":
                this.intakes.delete(command.draftId);
                return { ok: true };
            case "goal.spawn":
                return { id: command.draftId, ok: true, message: "Goal launched." };
            case "goal.togglePause":
                return { ok: true };
            case "loop.togglePause":
                this.store.toggleLoop(command.loopId);
                return { ok: true };
            case "workflow.togglePause": {
                const lane = this.store.getState().workflows.find((item) => item.id === command.workflowId);
                if (lane?.state === "paused")
                    this.store.resumeWorkflow(lane.id);
                else
                    this.store.pauseWorkflow(command.workflowId);
                return { ok: true };
            }
            case "worktree.togglePause":
                this.store.pauseWorkflow(command.workflowId);
                return { ok: true };
            case "goal.archive":
                this.archiveGoal(command.goalId);
                return { ok: true };
            case "goal.applyPrecedents":
                return { ok: true, agentPrompt: `Apply precedents for ${command.goalId}` };
            case "goal.report":
                return { ok: true, document: { title: "goal report", lines: ["mock report"] } };
            case "loop.createDraft": {
                const id = command.draftId ?? (command.prompt ? `l-${command.prompt.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)}` : "l-draft-gh-issues");
                const seeded = seedLoopDraft(id);
                this.loopDrafts.set(id, { ...seeded, prompt: command.prompt || seeded.prompt });
                return { id, ok: true };
            }
            case "loop.edit": {
                const draft = this.getLoopDraft(command.loopId);
                if (draft)
                    this.loopDrafts.set(command.loopId, { ...draft, prompt: command.text, steps: command.text, trialPassed: false });
                return { ok: Boolean(draft) };
            }
            case "loop.discardDraft":
                this.loopDrafts.delete(command.loopId);
                return { ok: true };
            case "loop.schedule":
                return this.getLoopDraft(command.loopId)?.trialPassed
                    ? { id: command.loopId, ok: true, message: "Loop scheduled." }
                    : { ok: false, message: "Trial required." };
            case "worktree.reassign":
                return { ok: true, agentPrompt: `Reassign ${command.worktreeId}` };
            case "worktree.testDetails":
                return { ok: true, document: { title: "test race", lines: ["green"] } };
            case "session.diff":
                return { ok: true, agentPrompt: `Show diff for ${command.worktreeId}` };
            case "session.merge":
                return { ok: true, agentPrompt: `Merge ${command.worktreeId}` };
            case "session.steer":
                return { ok: true, agentPrompt: command.text };
            case "escalation.ask":
                return { ok: true, agentPrompt: command.text };
            case "digest.fullLog":
                return { ok: true, document: { title: "full activity log", lines: ["mock activity"] } };
        }
    }
}
