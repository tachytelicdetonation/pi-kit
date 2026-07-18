/**
 * DataSource CONFORMANCE CONTRACT — every invariant ANY implementation must satisfy.
 * GREEN against MockDataSource today; the gate RealDataSource must pass later.
 */
import assert from "node:assert/strict";
import test from "node:test";
import type { DataSource } from "../../src/data/source.js";
import type { Escalation, HelmState } from "../../src/state/types.js";

export interface ContractOptions {
  /** A loop id whose trialLoop() resolves ok:true. Default: first loop in snapshot. */
  passingTrialLoopId?: string;
  /** A loop id whose trialLoop() resolves ok:false (the mandatory failed-trial path). */
  failingTrialLoopId: string;
  /** A goal id getCloseout() must serve. Default: first goal in snapshot. */
  closeoutGoalId?: string;
  /** STRICT: a freshly-recorded decision must be findable via `/` (two-keys audit). */
  strictLiveSearch?: boolean;
}

function fixtureEscalation(id: string, signature: string, blockedSinceMs = 1): Escalation {
  return {
    id,
    source: { kind: "workflow", label: "contract › fixture" },
    question: `contract fixture question ${id}`,
    verb: "review",
    blockedSinceMs,
    problem: "A contract fixture conflict needs exactly one operator decision.",
    evidence: ["the 2-line evidence, never the full file:", "- current", "+ proposed"],
    options: [{ text: `adopt conditional block for ${id}`, recommended: true }, { text: "defer to next sync" }],
    blockedMinutes: 1,
    idleNote: "fixture idle note",
    signature,
    precedentPhrase: `fixture: ${signature}`,
  };
}

const PROVIDER_ORDER = ["codex", "claude", "kimi"];

function assertProviderOrder(ids: string[], where: string): void {
  const known = ids.filter((id) => PROVIDER_ORDER.includes(id));
  const canonical = PROVIDER_ORDER.filter((id) => known.includes(id));
  assert.deepEqual(known, canonical, `${where}: providers must keep the fixed order codex→claude→kimi (design §3a "fixed provider order")`);
}

function assertEscalationsSorted(state: HelmState): void {
  const pending = state.escalations.filter((e) => !e.resolved);
  for (let i = 1; i < pending.length; i++) {
    const a = pending[i - 1];
    const b = pending[i];
    const ok = a.blockedSinceMs < b.blockedSinceMs || (a.blockedSinceMs === b.blockedSinceMs && a.id <= b.id);
    assert.ok(ok, `escalations not sorted oldest-first (ties by id): ${a.id} before ${b.id}`);
  }
}

export function runDataSourceContract(
  name: string,
  makeSource: () => DataSource | Promise<DataSource>,
  opts: ContractOptions,
): void {
  const t = (label: string, fn: (ds: DataSource) => void | Promise<void>) =>
    test(`[contract:${name}] ${label}`, async () => fn(await makeSource()));

  // source.ts:39 "The current, fully-sorted state (stable reference between mutations)."
  t("snapshot: same reference between mutations; a mutation yields a NEW object and never edits old snapshots", (ds) => {
    const s1 = ds.snapshot();
    assert.equal(ds.snapshot(), s1, "no mutation → identical reference");
    ds.pauseAll();
    const s2 = ds.snapshot();
    assert.notEqual(s2, s1, "mutation → new state object");
    assert.equal(s2.pausedAll, true);
    assert.equal(s1.pausedAll, false, "old snapshot must stay immutable (render caching depends on it)");
  });

  // source.ts:39 "fully-sorted" + design §6b "rows re-sort only on state change (no jitter)".
  t("snapshot arrays arrive fully-sorted: escalations oldest-blocked-first (ties by id); paused loops sink below active", (ds) => {
    const state = ds.snapshot();
    assertEscalationsSorted(state);
    const firstPaused = state.loops.findIndex((l) => l.health === "paused");
    if (firstPaused !== -1) {
      for (const l of state.loops.slice(firstPaused)) {
        assert.equal(l.health, "paused", "an active loop must never render below a paused one");
      }
    }
  });

  // source.ts:41-42 "Subscribe to state changes; returns an unsubscribe function."
  t("subscribe fires on every mutator; unsubscribe stops delivery", async (ds) => {
    let calls = 0;
    const unsubscribe = ds.subscribe(() => { calls += 1; });
    const bump = (label: string, fn: () => unknown) => {
      const before = calls;
      fn();
      assert.ok(calls > before, `${label} must notify subscribers`);
    };
    bump("pauseAll", () => ds.pauseAll());
    bump("resumeAll", () => ds.resumeAll());
    const wf = ds.snapshot().workflows[0];
    if (wf) bump("pauseWorkflow", () => ds.pauseWorkflow(wf.id));
    bump("addEscalation", () => ds.addEscalation(fixtureEscalation("e-contract-sub", "contract:sub")));
    const before = calls;
    await ds.decide("e-contract-sub", 0);
    assert.ok(calls > before, "decide must notify subscribers");
    const goal = ds.snapshot().goals[0];
    if (goal) bump("archiveGoal", () => ds.archiveGoal(goal.id));
    unsubscribe();
    const after = calls;
    ds.pauseAll();
    assert.equal(calls, after, "unsubscribed callback must not fire");
  });

  // design §8a ctrl+p "PAUSE ALL (freeze mid-step; again resumes)"; types.ts:460-461 pausedAll flag.
  t("pauseAll / resumeAll round-trip the pausedAll flag; both are idempotent and never throw", (ds) => {
    assert.equal(ds.snapshot().pausedAll, false, "fresh source starts un-paused");
    ds.pauseAll();
    ds.pauseAll(); // idempotent
    assert.equal(ds.snapshot().pausedAll, true);
    ds.resumeAll();
    assert.equal(ds.snapshot().pausedAll, false, "a single resume releases the pause (flag, not a counter)");
    ds.resumeAll(); // idempotent
    assert.equal(ds.snapshot().pausedAll, false);
  });

  // source.ts:47-48; design §6b key `p`.
  t("pauseWorkflow marks that lane paused; an unknown id never throws", (ds) => {
    const wf = ds.snapshot().workflows[0];
    if (wf) {
      ds.pauseWorkflow(wf.id);
      const paused = ds.snapshot().workflows.find((w) => w.id === wf.id);
      assert.equal(paused?.state, "paused");
    }
    assert.doesNotThrow(() => ds.pauseWorkflow("no-such-lane"));
  });

  // source.ts:60-63 + design §7b "Decisions + rationale are stored as precedents".
  t("decide records a PRECEDENT (signature + chosen option text) and removes the escalation from the queue", async (ds) => {
    const fx = fixtureEscalation("e-contract-decide", "contract:decide-sig");
    ds.addEscalation(fx);
    assert.ok(ds.getEscalation(fx.id), "fixture joins the queue first");
    await ds.decide(fx.id, 0); // option index is 0-based (store.ts:108)
    assert.equal(ds.getEscalation(fx.id), undefined, "decided escalation leaves the queue");
    assert.ok(!ds.listEscalations().some((e) => e.id === fx.id), "listEscalations no longer includes it");
    const precedent = ds.precedents().find((p) => p.signature === fx.signature);
    assert.ok(precedent, "a precedent with the escalation's signature was recorded");
    assert.equal(precedent!.decision, fx.options[0].text, "the precedent stores the CHOSEN option's text (types.ts:234)");
  });

  // source.ts:65 "undefined when unknown / already resolved"; store no-op semantics.
  t("decide with an unknown id or out-of-range option is a safe no-op", async (ds) => {
    const fx = fixtureEscalation("e-contract-noop", "contract:noop-sig");
    ds.addEscalation(fx);
    const escBefore = ds.listEscalations().length;
    const preBefore = ds.precedents().length;
    await assert.doesNotReject(() => ds.decide("no-such-escalation", 0));
    await assert.doesNotReject(() => ds.decide(fx.id, 99));
    assert.equal(ds.listEscalations().length, escBefore, "queue unchanged");
    assert.equal(ds.precedents().length, preBefore, "no phantom precedent");
  });

  // design §7b "identical future conflicts auto-resolve and note it"; types.ts:104-107.
  t("an identical future conflict AUTO-RESOLVES against the recorded precedent and never re-blocks", async (ds) => {
    const first = fixtureEscalation("e-contract-auto-1", "contract:auto-sig");
    ds.addEscalation(first);
    await ds.decide(first.id, 0);
    const second = fixtureEscalation("e-contract-auto-2", "contract:auto-sig");
    ds.addEscalation(second);
    const pending = ds.listEscalations().filter((e) => !e.resolved);
    assert.ok(!pending.some((e) => e.id === second.id), "the identical conflict must NOT join the blocking queue");
    const kept = ds.getEscalation(second.id);
    if (kept) {
      assert.equal(kept.resolved, true);
      assert.ok(kept.precedentNote, "an auto-resolved escalation notes the precedent it used (§7b 'note it')");
    }
  });

  // design §7d "precedents (same store as 7b)" + "Declined precedents are never re-proposed".
  t("closeout proposes 7b-recorded precedents and NEVER a declined one", async (ds) => {
    const fx = fixtureEscalation("e-contract-closeout", "contract:closeout-sig");
    ds.addEscalation(fx);
    await ds.decide(fx.id, 0);
    const goalId = opts.closeoutGoalId ?? ds.snapshot().goals[0]?.id;
    assert.ok(goalId, "contract needs a closeout goal id");
    const closeout = ds.getCloseout(goalId!);
    assert.ok(closeout, "closeout must exist for the designated goal");
    assert.ok(
      closeout!.proposedPrecedents.some((p) => p.signature === fx.signature),
      "the decision recorded via decide() flows into the closeout proposal (same store)",
    );
    assert.ok(closeout!.proposedPrecedents.every((p) => !p.declined), "declined precedents are never re-proposed");
  });

  // source.ts:95-96 + design §8a "/ search everything … archived included, forever".
  t("archiveGoal flips the phase and `/` search STILL finds the goal (search is forever)", (ds) => {
    const goal = ds.snapshot().goals[0];
    if (!goal) return;
    ds.archiveGoal(goal.id);
    const archived = ds.snapshot().goals.find((g) => g.id === goal.id);
    assert.equal(archived?.phase, "archived");
    const hits = ds.search(goal.name);
    assert.ok(
      hits.some((h) => h.label.toLowerCase().includes(goal.name.toLowerCase())),
      "an archived goal must remain searchable",
    );
  });

  // source.ts:97-98 + design §7a "a failed trial reports and reopens the builder — never auto-retries".
  t("trialLoop resolves {ok} once; a FAILED trial never schedules the loop", async (ds) => {
    const passId = opts.passingTrialLoopId ?? ds.snapshot().loops[0]?.id ?? "l-contract-pass";
    const pass = await ds.trialLoop(passId);
    assert.equal(pass.ok, true, `trial for ${passId} should pass`);
    const loopIdsBefore = ds.snapshot().loops.map((l) => l.id);
    const fail = await ds.trialLoop(opts.failingTrialLoopId);
    assert.equal(fail.ok, false, `trial for ${opts.failingTrialLoopId} must fail`);
    const loopIdsAfter = ds.snapshot().loops.map((l) => l.id);
    assert.deepEqual(loopIdsAfter, loopIdsBefore, "a failed trial must not add/schedule the loop (goes live only after a PASSED trial)");
  });

  // source.ts:53-56,65,78-83 "undefined when the id is unknown so the caller can decline to descend".
  t("empty-id getters return undefined; arbitrary unknown ids NEVER throw", (ds) => {
    assert.equal(ds.getDrillIn(""), undefined);
    assert.equal(ds.getSession(""), undefined);
    assert.equal(ds.getEscalation(""), undefined);
    assert.equal(ds.getIntake(""), undefined);
    assert.equal(ds.getLoopDraft(""), undefined);
    assert.equal(ds.getCloseout(""), undefined);
    for (const id of ["zz-unknown", "🚀", "../../etc/passwd"]) {
      assert.doesNotThrow(() => {
        ds.getDrillIn(id);
        ds.getSession(id);
        ds.getEscalation(id);
        ds.getIntake(id);
        ds.getLoopDraft(id);
        ds.getCloseout(id);
      }, `getters must not throw for id ${JSON.stringify(id)}`);
    }
  });

  // design §8a "enter descends, esc ascends, NO DEAD ENDS" + §6c "Enter on a worktree opens its 4a session"
  // + §7b "enter full session".
  t("reachability: every id the snapshot exposes descends without a dead end", (ds) => {
    const state = ds.snapshot();
    for (const wf of state.workflows) {
      const drill = ds.getDrillIn(wf.id);
      assert.ok(drill, `workflow ${wf.id} must open a 6c drill-in (enter descends)`);
      for (const wt of drill!.worktrees) {
        assert.ok(ds.getSession(wt.id), `worktree ${wt.id} must open a 4a session`);
      }
    }
    for (const esc of ds.listEscalations()) {
      assert.ok(ds.getEscalation(esc.id), `listed escalation ${esc.id} must be retrievable`);
      if (esc.worktreeId) {
        assert.ok(ds.getSession(esc.worktreeId), `escalation ${esc.id}'s worktree must open a session (§7b enter)`);
      }
    }
    for (const loop of state.loops) {
      assert.ok(ds.getLoopDraft(loop.id), `loop ${loop.id} must open its 7a builder (§8a loop drill-in → builder)`);
    }
    for (const goal of state.goals.filter((g) => g.phase === "complete")) {
      assert.ok(ds.getCloseout(goal.id), `complete goal ${goal.id} must open its 7d closeout`);
    }
  });

  // design §8a search + §8b/app guard: a result must never open a blank screen.
  t("every search result carrying a screen is reachable through the matching getter", (ds) => {
    const state = ds.snapshot();
    const queries = [
      ...state.goals.map((g) => g.name),
      ...state.workflows.map((w) => w.name),
      ...state.loops.map((l) => l.name),
    ];
    for (const query of queries) {
      for (const hit of ds.search(query)) {
        if (!hit.screen) continue;
        const s = hit.screen;
        switch (s.id) {
          case "drillin":
            assert.ok(ds.getDrillIn(s.workflowId), `search hit "${hit.label}" → dead drill-in ${s.workflowId}`);
            break;
          case "session":
            assert.ok(ds.getSession(s.worktreeId), `search hit "${hit.label}" → dead session ${s.worktreeId}`);
            break;
          case "escalation":
            assert.ok(ds.getEscalation(s.escalationId), `search hit "${hit.label}" → dead escalation ${s.escalationId}`);
            break;
          case "loopBuilder":
            assert.ok(ds.getLoopDraft(s.loopId), `search hit "${hit.label}" → dead loop draft ${s.loopId}`);
            break;
          case "closeout":
            assert.ok(ds.getCloseout(s.goalId), `search hit "${hit.label}" → dead closeout ${s.goalId}`);
            break;
          case "intake":
            assert.ok(ds.getIntake(s.draftId), `search hit "${hit.label}" → dead intake ${s.draftId}`);
            break;
          default:
            break;
        }
      }
    }
  });

  // source.ts:88-92 "Drives the 'bell on a new needs-you item' heuristic".
  t("addEscalation with a NEW signature joins the queue sorted and notifies (the bell driver)", (ds) => {
    let notified = 0;
    ds.subscribe(() => { notified += 1; });
    const before = ds.listEscalations().filter((e) => !e.resolved).length;
    ds.addEscalation(fixtureEscalation("e-contract-bell", "contract:bell-sig", 1));
    assert.ok(notified > 0, "addEscalation must notify (the app's bell hangs off subscribe + count-increase)");
    const pending = ds.listEscalations().filter((e) => !e.resolved);
    assert.equal(pending.length, before + 1);
    assertEscalationsSorted(ds.snapshot());
    assert.equal(pending[0].id, "e-contract-bell", "blockedSinceMs=1 is the oldest → sorts first");
  });

  // design §7c "Exactly four line types in order" + §"State Management" usage/digest lines.
  t("digest payload is well-formed: span + spend + the four line-type arrays + per-provider quota drain", (ds) => {
    const digest = ds.getDigest();
    assert.equal(typeof digest.spanText, "string");
    assert.equal(typeof digest.spentText, "string");
    for (const key of ["shippedGoals", "shippedByLoops", "decisionsQueued", "failedHandled"] as const) {
      assert.ok(Array.isArray(digest[key]), `${key} must be an array (empty allowed, order fixed by the renderer)`);
    }
    for (const drain of digest.quotaDrain) {
      assert.equal(typeof drain.provider, "string");
      assert.equal(typeof drain.deltaPercent, "number");
    }
    const a = ds.shouldShowDigest();
    assert.equal(typeof a, "boolean");
    assert.equal(ds.shouldShowDigest(), a, "shouldShowDigest is stable without a state change");
  });

  // design §3a "in fixed provider order" + types.ts:399-404,425-430.
  t("usage detail + footer keep the fixed provider order with sane percentages", (ds) => {
    const detail = ds.getUsageDetail();
    assertProviderOrder(detail.providers.map((p) => p.id), "getUsageDetail");
    for (const p of detail.providers) {
      assert.ok(p.remaining >= 0 && p.remaining <= 100, `${p.id} remaining ${p.remaining} out of [0,100]`);
      assert.equal(typeof p.resetText, "string");
    }
    const footer = ds.snapshot().footer;
    assertProviderOrder(footer.providers.map((p) => p.id), "snapshot().footer");
    for (const p of footer.providers) {
      if (p.remaining !== undefined) {
        assert.ok(p.remaining >= 0 && p.remaining <= 100, `footer ${p.id} remaining out of [0,100]`);
      }
    }
  });

  // mock.ts search semantics + design §8a: search spans everything; empty query is quiet.
  t("search: empty / whitespace query yields nothing; matching is case-insensitive", (ds) => {
    assert.deepEqual(ds.search(""), []);
    assert.deepEqual(ds.search("   "), []);
    const goal = ds.snapshot().goals[0];
    if (!goal) return;
    const lower = ds.search(goal.name.toLowerCase()).map((h) => h.label);
    const upper = ds.search(goal.name.toUpperCase()).map((h) => h.label);
    assert.deepEqual(upper, lower, "case must not change the result set");
    assert.ok(lower.length > 0, "a live goal's name must produce at least one hit");
  });

  if (opts.strictLiveSearch) {
    // design §"Guarantees": "anything pi did autonomously is auditable within two keys (/ + enter)".
    t("STRICT: a freshly-recorded decision is findable via `/` (two-keys auditability)", async (ds) => {
      const fx = fixtureEscalation("e-contract-audit", "contract:audit-sig");
      ds.addEscalation(fx);
      await ds.decide(fx.id, 0);
      const hits = ds.search("contract fixture question e-contract-audit");
      assert.ok(
        hits.some((h) => h.kind === "decision" || h.kind === "precedent"),
        "the decision must enter the search corpus immediately",
      );
    });
  }
}
