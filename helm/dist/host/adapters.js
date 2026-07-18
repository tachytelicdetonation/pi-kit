import { providerRemaining } from "../usage/types.js";
function runArgs(run) {
    return run.args && typeof run.args === "object" ? run.args : {};
}
function helmRuns(manager) {
    return manager.listAllRuns().filter((run) => {
        const args = runArgs(run);
        return Boolean(args.helmGoalId || args.helmLoopId);
    });
}
function runSummary(run) {
    if (run.status === "paused" && run.pauseReason)
        return run.pauseReason.replaceAll("_", " ");
    if (run.currentPhase)
        return run.currentPhase;
    const running = run.agents.filter((agent) => agent.status === "running").length;
    const done = run.agents.filter((agent) => agent.status === "done").length;
    return running ? `${running} agents working` : run.agents.length ? `${done}/${run.agents.length} agents done` : run.status;
}
function worktreeFor(run, agent) {
    const stage = /verif|review|test/i.test(agent.phase ?? agent.label)
        ? "review"
        : agent.status === "done" ? "apply" : "fix";
    const testState = agent.status === "error" ? "red"
        : agent.status === "done" ? "green" : "wobbling";
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
function detailFor(run) {
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
function classifyHistory(history) {
    const lines = [];
    for (const entry of history ?? []) {
        const tool = entry.toolName?.toLowerCase() ?? "";
        if (entry.kind === "toolCall" && /(edit|write|patch)/.test(tool)) {
            lines.push({
                verb: "edit",
                target: entry.toolName ?? "edit",
                result: "",
                expandable: true,
                peek: [entry.text.slice(0, 220)],
                added: 0,
                removed: 0,
            });
        }
        else if (entry.kind === "toolCall" && /(test|lint|build|exec|bash|command)/.test(tool)) {
            lines.push({
                verb: "verify",
                target: entry.text.slice(0, 72) || entry.toolName || "command",
                result: "ran",
                expandable: true,
                peek: [entry.text.slice(0, 220)],
            });
        }
        else if (entry.kind === "toolCall" && /(read|find|grep|search|list)/.test(tool)) {
            lines.push({ verb: "context", target: entry.toolName ?? "read context", result: "read" });
        }
    }
    return lines.slice(-12);
}
function sessionFor(run, agent) {
    const lines = classifyHistory(agent.history);
    const hasVerification = lines.some((line) => line.verb === "verify");
    return {
        worktreeId: `${run.runId}::${agent.id}`,
        task: agent.label || run.workflowName,
        prompt: agent.prompt,
        receipts: {
            build: hasVerification && agent.status === "done",
            lint: hasVerification && agent.status === "done",
            tests: hasVerification && agent.status === "done" ? 1 : 0,
        },
        lines: lines.length ? lines : [{ verb: "context", target: agent.phase ?? run.workflowName, result: agent.status }],
        claim: agent.error ?? (agent.result === undefined ? `${agent.label} is ${agent.status}.` : String(agent.result).slice(0, 240)),
    };
}
function goalScript(goalName, workflowName, description) {
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
function loopTrialScript(loop) {
    return `export const meta = ${JSON.stringify({
        name: `trial_${loop.name}`.toLowerCase().replace(/[^a-z0-9]+/g, "_").slice(0, 40),
        description: `Supervised trial for ${loop.name}`,
        phases: [{ title: "Trial" }],
    })}
phase('Trial')
const result = await agent(${JSON.stringify(`Run one supervised, non-destructive trial of this proposed Helm loop. Do not publish, merge, or mutate external systems.\n\nTrigger: ${loop.trigger}\nSteps: ${loop.steps}\nSkips: ${loop.skips}\nGuardrails: ${loop.guardrails.join(", ")}\n\nReport what would happen, checks performed, and whether it is safe to schedule.`)}, { label: 'supervised trial', tier: 'medium' })
if (!result) throw new Error('supervised trial produced no result')
return result`;
}
function scheduledLoopScript(loop) {
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
export function createWorkflowPort(manager, getCmux) {
    return {
        listWorkflows() {
            const dwLanes = helmRuns(manager)
                .filter((run) => ["pending", "running", "paused", "failed", "aborted"].includes(run.status))
                .map((run) => ({
                id: run.runId,
                goalId: runArgs(run).helmGoalId ?? "",
                name: runArgs(run).helmWorkflowName ?? run.workflowName,
                state: run.status === "running" ? "running" : ["paused", "failed", "aborted"].includes(run.status) ? "paused" : "queued",
                summary: runSummary(run),
            }));
            const cmuxLanes = getCmux().listRuns()
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
            if (manager.listRuns().some((run) => run.runId === id))
                manager.pause(id);
        },
        resumeWorkflow: (id) => manager.resume(id),
        pauseAll() {
            for (const run of helmRuns(manager)) {
                if (run.status === "running")
                    manager.pause(run.runId);
            }
        },
        resumeAll() {
            for (const run of helmRuns(manager)) {
                if (run.status === "paused")
                    void manager.resume(run.runId);
            }
        },
        async startGoal(input) {
            const plans = input.plan.length ? input.plan : [{ name: "execution", description: "Implement and verify the goal" }];
            return plans.map((plan) => manager.startInBackground(goalScript(input.goalName, plan.name, plan.description), {
                helmGoalId: input.goalId,
                helmWorkflowName: plan.name,
                goalName: input.goalName,
                prompt: `${input.prompt}\n\nWorkflow responsibility: ${plan.description}`,
            }, { tokenBudget: 160_000, maxAgents: 2, concurrency: 1, agentTimeoutMs: 30 * 60_000 }).runId);
        },
        async trialLoop(loop) {
            const started = manager.startInBackground(loopTrialScript(loop), {
                helmLoopId: loop.id,
                prompt: loop.prompt,
            }, { tokenBudget: 80_000, maxAgents: 1, concurrency: 1, agentTimeoutMs: 20 * 60_000 });
            try {
                await started.promise;
                const run = manager.listAllRuns().find((item) => item.runId === started.runId);
                return { ok: run?.status === "completed", runId: started.runId };
            }
            catch {
                return { ok: false, runId: started.runId };
            }
        },
        async runLoop(loop) {
            const started = manager.startInBackground(scheduledLoopScript(loop), {
                helmLoopId: loop.id,
                prompt: loop.prompt,
            }, { tokenBudget: 160_000, maxAgents: 2, concurrency: 1, agentTimeoutMs: 30 * 60_000 });
            try {
                await started.promise;
                const run = manager.listAllRuns().find((item) => item.runId === started.runId);
                return { ok: run?.status === "completed", runId: started.runId };
            }
            catch {
                return { ok: false, runId: started.runId };
            }
        },
        getGoalProgress(goalId) {
            const runs = helmRuns(manager).filter((run) => runArgs(run).helmGoalId === goalId);
            if (!runs.length)
                return undefined;
            const completed = runs.filter((run) => run.status === "completed").length;
            return { progress: completed / runs.length, complete: completed === runs.length };
        },
        subscribe(cb) {
            const events = ["complete", "paused", "resumed", "stopped", "error", "phase", "agentStart", "agentEnd"];
            for (const event of events)
                manager.on(event, cb);
            return () => {
                for (const event of events)
                    manager.off(event, cb);
            };
        },
    };
}
export function createUsagePort(handle) {
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
                        .reduce((earliest, bucket) => earliest === undefined ? bucket.resetsAt : Math.min(earliest, bucket.resetsAt), undefined);
                    let resetText;
                    if (resetsAt === undefined) {
                        resetText = "reset unknown";
                    }
                    else {
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
