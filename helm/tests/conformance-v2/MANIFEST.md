# Helm design conformance v2 manifest

- Manifest version: 1
- Base commit: `7998b65d4ceeaf6891278987252a47212af07cc5`
- Test commit SHA: recorded in .fable-loop planfile at commit time (single squashed commit on fable/tests)
- Scope: new files only under `helm/tests/conformance-v2/`
- Runtime: local `tsx` + `node:test`; no network

## Exact run commands

Run from the repository root:

```sh
cd helm
./node_modules/.bin/tsx --test tests/conformance-v2/*.runnable.test.ts tests/conformance-v2/proposed-extra.test.ts
./node_modules/.bin/tsx --test tests/conformance-v2/*.contract.test.ts
./node_modules/.bin/tsx --test tests/conformance-v2/*.test.ts
npm run check
npm run build
```

Baseline at `7998b65`: the runnable + proposed command executes 57 tests (30 pass, 27 fail on conformance assertions); the contract command executes 11 tests (1 pass, 10 fail); `npm run check` reports only the expected contract-surface differentials; `npm run build` passes.

## Per-test manifest

### Footer and rendering

- `Footer row: responsive boundaries keep the wider form at 110, 90, and 70` → asserts cwd/cost/context threshold boundaries and the retained eight-cell context bar → Footer.
- `Footer row: the context meter remains an eight-cell bar throughout 70-89 columns` → asserts bar form, not compact text, at representative narrow widths → Footer.
- `Footer row: canonical provider vectors produce a clamped fixed-width budget bar` → asserts 83%/100%/0% vectors, 20/30-cell allocation, stable unknown slot, and no overflow → Footer.
- `Footer row EXTRA invariant: bar allocation never exceeds its width for arbitrary remaining vectors` → 1,000-run fast-check probe over non-finite/out-of-range/unknown remaining values and arbitrary bar widths → EXTRA (Footer).
- `Footer row: paused visible text uses warning yellow exclusively` → asserts every visible foreground is warning yellow and the paused prefix remains visible → Footer.
- `Footer row: session and fleet variants expose their contracted strings` → asserts session ctx/cost and fleet burn/tok-min/today variants do not leak into each other → Footer.
- `Rendering contract: closeout hotkey-label pairs drop atomically at narrow widths` → rejects partial closeout action pairs → EXTRA (Rendering).
- `Rendering contract: loop-builder hotkey-label pairs drop atomically at narrow widths` → rejects partial loop-builder action pairs → EXTRA (Rendering).
- `Rendering contract: a model tag matching the default is suppressed; a differing tag is shown` → asserts default-model suppression and non-default visibility → EXTRA (Rendering).

### Session activity

- `Session row: consecutive reads, greps, and read-only bash collapse to exactly one context row` → adapts real persisted history and rejects read-only discovery as verify → Session.
- `Session row: concurrent tool calls become one parallel row with joined summaries` → asserts one parallel semantic row for a same-time group → Session.
- `Session row: only tests, builds, and lint classify as verify` → separates verification commands from read-only bash → Session.
- `Session row: edit adaptation preserves the real path and measured +N −N` → asserts path and line-delta extraction from an edit call → Session.
- `Session row: a 500-line edit renders at most three numbered content lines plus the exact remainder` → prevents full-file transcript leakage and checks `moreCount` → Session.
- `Session row: receipt rendering keeps build, lint, and the real test total distinct` → asserts independent build/lint states and a non-placeholder total → Session.
- `Session row: adapter receipts use parsed build/lint/test evidence rather than a generic success` → asserts real mixed receipts from history → Session.

### Keys and navigation

- `Keys row: q is unbound and types into an empty prompt; ctrl+q exits` → asserts the exit binding and Gmail-rule printable behavior → Keys.
- `Keys row: escape at empty home never exits, even repeatedly` → asserts home escape is inert → Keys.
- `Keys row: tab jumps to needs-you from mission control` → asserts global triage from home → Keys.
- `Keys row: tab jumps to needs-you from workflow drill-in` → asserts global triage from drill-in → Keys.
- `Keys row: tab jumps to needs-you from session` → asserts global triage from session → Keys.
- `Keys row: tab jumps to needs-you from escalation` → asserts global triage advances from a card → Keys.
- `Keys row: tab jumps to needs-you from digest` → asserts global triage from digest → Keys.
- `Keys row: tab jumps to needs-you from intake` → asserts global triage from intake → Keys.
- `Keys row: tab jumps to needs-you from loop builder` → asserts global triage from loop builder → Keys.
- `Keys row: tab jumps to needs-you from closeout` → asserts global triage from closeout → Keys.
- `Keys row: tab jumps to needs-you from search` → asserts global triage from search → Keys.
- `Keys row: enter on a completed goal opens its closeout` → asserts completed goal rows are selectable and descend correctly → Keys.
- `Keys row: enter on an active goal opens its top workflow drill-in` → asserts active goal descent → Keys.
- `Keys row: p on an escalation card is a strict no-op` → rejects prompt mutation and pause-all fallback → Keys.
- `Keys row: p with no selectable home row is a strict no-op` → rejects state changes with an empty selection → Keys.
- `Keys row: loop-builder e is rejected while trialing and after pass until r` → asserts the edit gate across trialing/passed/revised states → Keys.

### Digest and journal truth

- `Digest row: launch gate is false at exactly 30 minutes and true one millisecond later` → freezes the clock and asserts strict `>30 min` gating → Digest.
- `Digest row: starting a goal emits no prOpened journal event` → rejects fabricated PR truth at goal launch → Digest.
- `Digest row: spend and provider drain are deltas from the persisted last-seen usage snapshot` → asserts real spend delta and fixed codex/claude/kimi drain including zero → Digest.
- `Digest row: all four line types render in strict order` → asserts goals, loops, decisions, failures order → Digest.
- `Digest row: a journal without a revert receipt never fabricates selfCaughtRevert` → asserts absence without a receipt → Digest.
- `Digest contract row: caught failure persists as selfCaughtPaused and renders self-caught · paused` → uses the frozen contract journal kind and checks digest wording → Digest (expected baseline differential).

### Closeout and precedents

- `Closeout row: a completed goal exposes concrete measured metrics, not placeholder prose` → asserts numeric packages/diff/commits/green/cost/attention/interventions and rejects placeholders → Closeout.
- `Closeout contract row: declining a precedent persists and suppresses it after relaunch` → invokes `declinePrecedent` and checks durable non-reproposal → Closeout (expected baseline differential).
- `Closeout contract row: digits toggle a numbered precedent to declined and apply sends only accepted ones` → drives closeout keys and checks acceptance filtering → Keys / Closeout (expected baseline differential).
- `Closeout contract row: applied precedent state survives relaunch` → checks durable `appliesTo` state and suppression after apply → Closeout.

### Loops and pause

- `Loops row: scheduling is rejected without a passed supervised verdict` → asserts the mandatory schedule gate → Loops.
- `Loops row: machine-readable failed verdict overrides a technically completed trial run` → parses `{passed:false,evidence}` rather than trusting process completion → Loops.
- `Loops row: failed trial persists no trialPassed gate and is invoked only once` → rejects passed state and automatic retry → Loops.
- `Loops row: an operator-paused loop always carries a non-empty reason` → asserts paused-with-reason at runtime → Loops.
- `Loops contract row: editing a scheduled loop preserves activeDefinition and resets the draft gate` → checks immutable armed definition and pending draft separation → Loops (expected baseline differential).
- `Loops contract row: an armed firing reads immutable activeDefinition, never the pending draft` → fires an overdue persisted loop and inspects the real run definition → Loops (expected baseline differential).
- `Loops contract row: paused-with-reason is enforced by the Loop type` → compile-time rejection of an unreasoned paused loop → Loops (expected baseline type differential).
- `Pause row: global pause survives a fresh data-source instance` → asserts durable globally-paused relaunch → Pause.
- `Pause row: lanes paused before pause-all remain paused after resume-all` → asserts checkpoint scope does not resume pre-paused lanes → Pause.
- `Pause row: loop deadline shifts by the full paused duration` → freezes time and checks exact deadline shift → Pause.
- `Pause row: pausing one worktree leaves its sibling and top-level workflow running` → rejects workflow-wide fallback for worktree pause → Pause.

### Escalation

- `Escalation contract row: ? appends a persisted follow-up and leaves the card active` → submits a follow-up, checks card continuity, and relaunch persistence → Escalation (expected baseline differential).
- `Escalation contract row: requiresConfirm asks y/n and n cancels without deciding` → asserts pre-decision confirmation and cancellation → Escalation (expected baseline differential).
- `Escalation contract row: identical decision conflict auto-resolves and writes a precedent note` → asserts stable-signature reuse plus an audit note → Escalation.
- `Escalation contract row: permission-class escalation never auto-resolves from stored precedent` → asserts approvals remain needs-you even with an identical stored precedent → Escalation.

### Search, popover, and intake

- `Search row: archived goals, decisions, loop runs, and PR events are all findable` → covers every named corpus class including archive retention → Search.
- `Search row: an autonomous action is auditable with / then enter` → drives the two-key audit path to a result viewer → Search.
- `Popover row: real today/week spend and per-goal costs render without seed placeholders` → renders injected real usage values → Popover.
- `Intake row: vague intent derives only un-inferable questions and no workflow starts before g` → checks derived questions, disabled go, and zero pre-confirmation starts → Intake.
- `Intake row: answering clarification re-derives the structured plan before launch` → asserts plan mutation and still-zero starts after an answer → Intake.

### Proposed hostile extras

- `PROPOSED terminal: zero-width and non-finite widths never throw or emit visible cells` → geometry hardening → PROPOSED.
- `PROPOSED history: one thousand consecutive context entries still adapt to one bounded row` → volume/collapse hardening → PROPOSED.
- `PROPOSED input: unicode prompt text survives key dispatch and rendering intact` → CJK, accents, combining marks, emoji, and RTL-script text → PROPOSED.
- `PROPOSED usage: an empty provider list is explicit, bounded, and never masquerades as 0%` → provider-outage semantics → PROPOSED.
- `PROPOSED pause: backward clock skew never moves a loop deadline backward` → wall-clock rollback safety → PROPOSED.
- `PROPOSED gap: a bound action remains literal after prompt focus (Gmail rule precedence)` → resolves the design's focused-prompt ambiguity → PROPOSED.

## Matrix row accounting

| Matrix row | Status | Files |
|---|---|---|
| Footer | COVERED + EXTRA | `footer.runnable.test.ts`, `rendering-invariants.runnable.test.ts` |
| Session | COVERED + PROPOSED hostile volume | `session.runnable.test.ts`, `proposed-extra.test.ts` |
| Keys | COVERED | `keys.runnable.test.ts`, `closeout.contract.test.ts`, `escalation.contract.test.ts` |
| Digest | COVERED | `digest-data.runnable.test.ts`, `digest.contract.test.ts` |
| Closeout | COVERED | `closeout.runnable.test.ts`, `closeout.contract.test.ts` |
| Loops | COVERED | `loops-pause.runnable.test.ts`, `loops-pause.contract.test.ts` |
| Pause | COVERED + PROPOSED clock skew | `loops-pause.runnable.test.ts`, `proposed-extra.test.ts` |
| Escalation | COVERED | `escalation.contract.test.ts` |
| Search | COVERED | `search-popover-intake.runnable.test.ts` |
| Popover | COVERED | `search-popover-intake.runnable.test.ts` |
| Intake | COVERED | `search-popover-intake.runnable.test.ts` |

## Non-runnable design rows and named verification methods

- OS notification after more than 60 seconds unfocused → **Manual macOS notification acceptance**: grant/deny notification permission in turn, unfocus the real host app for 61 seconds, inject one needs-you transition, and verify delivery, denial fallback, and deduplication in Notification Center.
- Terminal bell on a new needs-you item → **Real PTY audible-bell acceptance**: run Helm in a bell-enabled terminal profile, inject one new needs-you transition, and verify one audible/visual bell while resolution and duplicate refreshes remain silent.
- True focus detection → **Foreground/background focus-transition acceptance**: move focus between the real terminal window and another macOS app around the 60-second boundary and correlate host focus logs with notification behavior. A fake boolean is explicitly not accepted.

## Inspection inventory

Authoritative inputs read in full: `contract-v1.md`, `test-matrix.md`, `design-digest-clean.md`.

Repository/runtime files inspected: `helm/package.json`, `helm/src/app.ts`, `helm/src/footer.ts`, `helm/src/keys.ts`, `helm/src/host/adapters.ts`, `helm/src/data/source.ts`, `helm/src/data/real.ts`, `helm/src/data/mock.ts`, `helm/src/state/types.ts`, `helm/src/state/store.ts`, `helm/src/state/selectors.ts`, `helm/src/state/persistence.ts`, `helm/src/workflows/agent-history.ts`, and `helm/src/workflows/run-persistence.ts`.

Existing tests inspected for style/harness patterns only: `helm/tests/footer.test.ts`, `helm/tests/app.test.ts`, `helm/tests/keys.test.ts`, `helm/tests/persistence.test.ts`, `helm/tests/phase5-global.test.ts`, `helm/tests/session.test.ts`, `helm/tests/digest.test.ts`, `helm/tests/closeout.test.ts`, `helm/tests/loop-builder.test.ts`, `helm/tests/escalation.test.ts`, `helm/tests/intake.test.ts`, `helm/tests/search.test.ts`, and `helm/tests/popover.test.ts`.
