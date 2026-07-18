# Fable loop: helm-design-conformance

## State: SHIPPED — gate-4 verdict SHIP, merged to main (local, not pushed)

### 2026-07-18 gate-4 verdict: SHIP
- Fix cycle 2 landed 16b1324 (identity guard, no resurrection of handed-off rows, success-gated UI state, empty-apply no-op) + behavioral regression tests (implementer-authored, top-level only, spot-checked non-tautological — logged deviation).
- Verification on main after merge: tsc clean; full suite 1856 pass / 0 fail / 1 skip; conformance-v2 67/67 (arbiter suite untouched since adjudication).
- Delta re-review closure: F2 CLOSED, F3 CLOSED (cycle 2), F4 CLOSED, F5 CLOSED (cycle 2), F6 CLOSED. R1 hardened despite production-unreachability.
- Open items carried in dossier: F1 multi-code-point paste gap DEFERRED (pre-existing, out of contract); F5 known limitation — no completion receipt from Pi's agent after handoff (suppression happens at confirmed handoff, not confirmed application).
- main HEAD = 16b1324. Branches fable/{footer,screens,app,data,tests,fix,integrate} retained; worktrees can be pruned.

### 2026-07-18 fix-cycle-1 closeout
- Fix lane (sol HIGH, continuation task boizi39hj) completed all 5 adjudicated audit items (F2 bounded LCS, F3 payload-preserving canonicalization + id-cached cards, F4 required decline surface = contract v1.1, F5 truthful "handoff" lifecycle + wording, F6 clamped pause duration). Only test edit: tests/app.test.ts fixture forwards required setPrecedentDeclined (interface fallout, sanctioned).
- Committed fable/fix 6b45184; merged fast-forward into fable/integrate (HEAD 6b45184).
- Independent verification on integrate: tsc clean; conformance-v2 67/67; full suite 1850 pass / 0 fail / 1 skip (cmux tests pass outside sandbox).
- Delta re-review: sol HIGH read-only on diff 271a847..6b45184 only (task bmi8g0nbt → out-rereview.md). Then gate-4 verdict.
- Gate-4 fix cycle counter: 1 of 2 used.

### 2026-07-18 delta re-review verdicts + fix cycle 2 (FINAL)
- Re-review (sol HIGH, diff 271a847..6b45184): F2 CLOSED, F4 CLOSED, F6 CLOSED; F3 REGRESSED, F5 NARROWED. 4 residuals:
  - R1 id-collision corrupts precedent identity — Fable adjudication: DOWNGRADED to hardening; ids share one namespace by construction (getCloseout proposals ARE store records, real.ts:828), collision unreachable via product flows; cheap signature-equality guard added anyway.
  - R2 handed-off precedents resurrect as togglable rows (app.ts durableById fallback) — CONFIRMED major.
  - R3 UI claims handoff before command success (applied.add before result) — CONFIRMED major.
  - R4 empty apply fabricates handoff audit + "No proposed precedents" prompt — CONFIRMED minor.
- Fix cycle 2 of 2 (FINAL): sol HIGH task bvpngjtmj → out-fix-cycle2.md on wt-fix (clean at 6b45184). After this: commit, merge, verify, gate-4 verdict REGARDLESS (max cycles reached; anything residual surfaces in dossier).

## Gate 3 (judged in-session by Fable)
PASSED. Manifest adjudicated; verdict bound to test commit 103e17b (single squashed, tests/conformance-v2/ only). Watch items: permission-class test infers class from "permission:" signature prefix; confirm test asserts /confirm.*y yes.*n no/i — mismatches there are likely TEST_DEFECT.

## Integration (wt-integrate, branch fable/integrate)
- Merges: footer/screens/app 98e58e3+fe3a41d; integration fixes 656b5b8 (sessionModel spreads ×3, README ctrl+q).
- data pt.1 5c7d11b; data pt.2 f75ee17 (all 10 items DONE; check green; full suite 1778 pass sandbox / lane report).
- fable/data merged clean; EscalationOption.requiresConfirm dedupe → c074704.
- app.ts escalation.ask callsite verified OK as-is: real.ts no longer returns agentPrompt for escalation.ask, so card stays active (data2's flagged app change unnecessary).
- Full merged suite: 1783/1784 pass, 0 fail (1 skip).
- Test commit cherry-picked → 5c01fae (verified: only helm/tests/conformance-v2/).

## Cross-verify: conformance-v2 arbitration run
38/68 pass, 30 fail. Provisional clusters: (a) TEST_SEAM — UsagePort.getAccountingSnapshot now required, called in RealDataSource ctor persist (real.ts:950); helper stub lacks it → ~majority of failures; (b) TEST_SEAM — RealDataSourceDeps.trialLoop removed (moved to workflows port) → injection ignored, invocations 0; (c) session edit rows +5−3 vs expected +3−1 — side TBD; (d) receipt drops "✕ lint" — likely PRODUCT_DEFECT vs contract line 30; (e) misc TBD.
Classification lane: sol LOW read-only, task blgaqj9bl → out-classify.md. Fable adjudicated ALL 30 as CONFIRMED:
- 26 TEST_SEAM (helpers stub UsagePort/WorkflowPort against pre-merge shapes; assertions intact) → manifest v2 revision, tests lane, assertions frozen except sanctioned trialLoop-injection rewire (deps.trialLoop removed → workflows-port override).
- 3 PRODUCT_DEFECT (attempt 1 each): D `p` on escalation card types to prompt (app.ts:854-860, contract L17); F edit rows +N−N counts whole payload not diff (adapters.ts:204-208, contract L30); G renderReceipts drops falsy lint / always success glyph (session.ts:29-35, contract L30).
- 1 OTHER: astral unicode rejected by decodeKey data.length===1 (keys.ts:72-96). No contract requirement; Fable approves as discretionary fix (logged, reversible — "types like any printable" intends emoji).
Deviation (logged): manifest v2 revision runs on wt-integrate (not re-rooted on fable/tests) so stubs typecheck against merged ports; assertions-frozen verified by diff at adjudication.
Fix lanes (parallel, sol HIGH): tests-plumbing task be9se1wql → out-tests-v2.md; product fixes task bzqldzzi6 → out-fix-product.md.
Round-1 results: product fixes DONE 4/4 → fable/fix 5a3a3e9. Manifest v2 committed 9b69d5d (delta-adjudicated APPROVED: diff shows only helpers + verdict-shape plumbing, zero assertion drift). fable/fix merged → acaa4a2. Conformance now 60/68; the 4 product-fix tests pass.
Round 2: 8 residual failures + TS2578. Classification lane 2 (bjsrircyf killed on stdin hang; rerun bwskphne9 with </dev/null) → out-classify2.md. Fable adjudicated all 9 CONFIRMED:
- 3 PRODUCT_DEFECT (attempt 1 each): P1 getCloseout dedup keeps stale non-declined proposal over canonical declined record (real.ts:368, contract L27); P2 closeout digit toggle app-local only, declines not persisted at toggle (app.ts:986/998, contract L19 — Fable ruling: decline is its own persisted action, `a` applies accepted only); P3 applyPrecedents writes audit only, never appliesTo (real.ts:601, contract L19/27).
- 5 TEST_DEFECT, assertion changes individually sanctioned by Fable: metrics regex allows optional "(N/M checks)" detail; digest fixture raw label (digest layer owns "self-caught · paused" semantic, L23); auto-resolve audit asserted on snapshot().audit/decisions[].precedentNote not journal (L29+L34); permission fixture sets resolutionClass:"permission" (= gate-3 watch item, predicted TEST_DEFECT); TS2578 @ts-expect-error removed (type-level enforcement beyond contract; runtime covered by passing pausedReason test).
- 1 OTHER adopted as approved hardening: clock-skew clamp — restored deadline >= pre-pause deadline (real.ts:244-252).
Round-2 lanes (parallel, sol HIGH): product bo20an4i2 → out-fix-product2.md (wt-fix, synced to integrate HEAD first); tests manifest v3 bd2vjfd9v → out-tests-v3.md (wt-integrate, 5 sanctioned edits only).
Round-2 results: manifest v3 lane stopped correctly at boundary with 2 unsanctioned residuals; Fable adjudicated + applied directly (logged): estCost fixture seed (TEST_SEAM — "not estimated" is truthful absence, not placeholder) and resolved undefined-vs-false (TEST_DEFECT — type is resolved?: boolean, unresolved=absent legitimate; assertion → notEqual(resolved, true)). Manifest v3 commit 902a210 (5 sanctioned + 2 Fable edits). Product round 2 DONE 4/4 → fable/fix cd83f71; merged → 271a847.
FINAL VERIFICATION on integrate: npm run check clean; conformance-v2 67/67; full suite 1850/1851 pass (1 skip), 0 fail.
Gate 4: adversarial review (sol HIGH read-only, bchbwwtka → out-adversarial.md, commits 5a3a3e9+cd83f71) returned 5 major + 1 minor. Fable adjudication (findings verbatim in out-adversarial.md):
- F1 paste/multi-code-point dropped: REBUTTED as regression (baseline data.length===1 already dropped all multi-unit chunks; fix strictly widened). Valid pre-existing gap, no contract requirement → DEFERRED, follow-up noted.
- F2 LCS quadratic (236MiB on 5k identical lines): ACCEPTED → FIX (fast paths + prefix/suffix trim + capped LCS + bounded previews).
- F3 canonicalization replaces proposal payload wholesale + stale open-card object cache: ACCEPTED → FIX (overlay only declined/appliesTo; cache ids not objects).
- F4 decline via optional setPrecedentDeclined?.: ACCEPTED → FIX (required declinePrecedent + required re-accept; contract delta v1.1 sanctioned by Fable: DataSource gains required undecline/set method).
- F5 appliesTo persisted pre-application with guessed "claudeMd": PARTIAL — fix fabricated destination + truthful handoff audit; suppression-at-confirmed-handoff KEPT (no completion-receipt loop exists from Pi agent; re-proposing after operator-confirmed apply is worse). Known limitation logged.
- F6 negative paused duration in append-only audit: ACCEPTED → FIX (Math.max(0,·) shared).
FIX cycle 1 (of max 2): sol HIGH task bucz9uocq → out-fix-audit.md on wt-fix (synced to integrate). Then: commit, merge, full verify, delta re-review of the fix diff only, verdict.

## State history: EXECUTING done (all lanes committed)

## User confirmation (received)
Q1 full conformance incl. data layer · Q2 ctrl+q exits, q types · Q3 truthful selfCaughtPaused, no auto-revert · Q4 auto-resolve all except permission class. All = Fable's recommendations.

## Contract & matrix
- contract-v1.md + test-matrix.md in scratchpad (v1, frozen; changes only via re-plan → v2).

## Worktrees (base 7998b65)
- wt-footer → fable/footer (lane bcubczb8r, out-impl-footer.md)
- wt-screens → fable/screens (lane badqsn34i, out-impl-screens.md)
- wt-app → fable/app (lane b8pfhr6oc, out-impl-app.md)
- wt-data → fable/data (lane bgotw2y0i, out-impl-data1.md; DATA PART 2 pending: loop activeDefinition isolation + lifecycle, pause-all checkpoint, per-worktree pause, precedent decline+auto-resolve signatures, escalation follow-up mutations, search/audit corpus, intake planner — author lane-impl-data2.txt on data1 completion)
- wt-tests → fable/tests (lane bblaqbma3, out-tests.md; new files only under tests/conformance-v2/, single squashed commit + MANIFEST.md)

## Additional decisions (logged)
- Loop drill-in screen (6c-reuse for loops) DESCOPED this run — unmocked surface, taste work; enter on scheduled loop keeps opening builder. Goes in gate-4 dossier as accepted deviation.
- Background #17181c not actively painted; host terminal theme owns bg (visual lane open question resolved).
- Implementer lanes may update EXISTING tests only where they encode superseded behavior, each listed in lane report; adversarial thread + gate 4 check those edits. Tests lane may not touch src/ or existing tests.

## Lane results
- footer DONE → commit 7f719d2 (5/5 items; 68/68 tests; 1 existing test updated: usage/ui.test.ts ctx-meter assertion)
- screens DONE → commit d9dd12c (720/720; no test edits)
- app DONE → commit 3f0ed2d (71/71 + 296/296; 4 existing tests updated: app, functional-actions, loop-builder, selectors; cmux EPERM failures = ENVIRONMENT)
- All lane commit steps hit sandbox EPERM on shared .git — opus commits (expected, ENVIRONMENT).

## Integration TODOs (opus)
- app.ts render callsites (≈344/361/366 post-merge): pass { ...model, sessionModel } to intake/drill-in/loop-builder renderers (screens lane note).
- helm/README.md:47: q → ctrl+q exit documentation (app lane BLOCKED item 1).
- Reconcile identical `requiresConfirm?: boolean` one-liner in types.ts (app lane added; data lane will too).

## Next actions
1. On data1 done → author + launch data part 2 (same worktree, fresh exec, sol high).
2. On tests done → gate 3: adjudicate MANIFEST.md vs matrix + request (pull 2–3 highest-blast tests + 1 random).
3. On all impl lanes done → integrate in a 6th worktree (impl commits merged, cherry-pick adjudicated test SHA), run suite, classify failures, fix cycles per protocol, then gate 4 audit.

## Gate 2 (judged in-session by Fable, 2026-07-18)
Input: 15-lane workflow sweep (wf_318d46b0-a62), 15/15 lanes returned. Findings: 94 diverges / 9 ambiguous / 3 unverified / 13 open-question blocks → scratchpad/gaps.md (full), gaps-judge.md (med/high+ambiguous, adjudicated), gaps-low.md (29 low-risk, auto-approved to checklist).
Verdict pattern: renderers/keys largely CONFORM; divergences concentrate in the real data layer (real.ts, adapters.ts) — placeholder metrics, fabricated journal events (prOpened on goal start, selfCaughtRevert without revert, merged=completion), missing behaviors (precedent decline, per-worktree pause, loop activeDefinition isolation, pause-all checkpoint), plus a short list of true UI fixes (footer 70–89 ctx meter, paused-footer full yellow, peek slice(0,3), atomic hotkey segments, unconditional model tags, session adapter collapsing).

### Interpretation deltas (Fable)
1. "working as expected from design docs" read as conformance INCLUDING data truthfulness (UI shows measured reality, not placeholders) — not just visual/key fidelity. ~60% of fixes are data-layer.
2. Unmocked surfaces (search/popover layout, test-race detail, trial internals) are behavior-binding only — current reasonable adaptations stay.
3. Superseded panels + support.js runtime are out of scope.

### Decisions resolved by Fable (logged, reversible)
- Goal rows become selectable: completed → closeout; active → top workflow drill-in.
- Empty strata render with zero counts (satisfies "exactly three strata").
- Relative "resets in Nd" acceptable for popover reset dates.
- 6c `t` keeps generic viewer (design leaves it undefined).
- Loop trial stays non-destructive but must return a machine-readable verdict; post-trial `e` gated off (r first); trialing locks edits.
- Pause-all = checkpoint between operations (no mid-write interrupt), durable checkpoint of which lanes paused; loop deadlines shift by pause duration.
- 7b digits: confirm only options flagged destructive (add risk metadata to EscalationOption).

### Blocked-on-human (batched to user)
Q1 scope (data-truthfulness in or out) · Q2 exit key (q vs ctrl+q) · Q3 digest 4th line (truthful paused vs real auto-revert) · Q4 precedent auto-resolve scope (exclude permission class?).

## Next action
On user confirm: author per-module fix checklists (sol HIGH lanes via Workflow, worktree-isolated) + separate adversarial test thread (own worktree); gate 3 manifest adjudication before tests arbitrate.

## Verbatim request
> use fable loop to make sure the codebase is working as excpted from design docs @design_handoff_pi_tui/
> you need to always escalate context gathering to gpt 5.6 sol low and implmentation to gpt 5.6 high
> your job is only to coordinate and orcahstrate and act as a senior software engineer, who manages gpt 5.6 sol to get this work done, and provide your own cleverness and "taste" to get this working

## Session mode
Fable-driven session (`/model fable`): gates judged in-session by Fable, no oracle calls. Discipline kept: sol drafts/implements, isolated test worktree, implementer never authors tests, manifest adjudication before arbitration, failure taxonomy, criteria as arbiter.
Routing override from user: context gathering = sol LOW; implementation = sol HIGH.

## Qualification (state left: QUALIFYING)
Qualifies by risk: user-facing TUI surface, interaction usability is a first-class tested dimension (memory: helm-interaction-first), design-conformance requires judgment. Logged 2026-07-18.

## Starting commit
7998b65 (main, clean except untracked design_handoff_pi_tui/)

## Worktrees
- (none yet)

## Context threads (sol low, read-only, DONE)
- Design digest → scratchpad/design-digest-clean.md (11 final panels, key contract, usage-bar math, 27 ambiguities)
- Implementation map → scratchpad/impl-map-clean.md (all panels+keys implemented; file:line index)

## Baseline
- `npm test` in helm/: 1777 tests, 1776 pass, 0 fail, 1 skipped (HELM_NATIVE opt-in). GREEN.
- Divergence candidates queued for plan: q-exit key, footer 70–89 form, fleet-footer-everywhere, loop drill-in missing, bell/notify >60s, resort-on-state-change, threshold off-by-one, bar rounding clamp.

## Plan draft thread (sol medium, read-only, running)
- → scratchpad/sol-plan-draft.md

## Plan / criteria / contract / manifest versions
- (pending gate 2)

## Decisions log
- (none)

## Attempt counters
- Per-defect: none. Gate-4 fix cycles: 0.

## Next action
When both context threads return: sol drafts conformance-verification plan (gap list) → Fable gate-2 review in-session → user confirmation.
