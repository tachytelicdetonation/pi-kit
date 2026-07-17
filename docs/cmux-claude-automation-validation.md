# Interactive Claude Code Automation Through cmux

Status: validated for implementation, with daemon-restart durability still isolated as a deployment-gate test.

Last validated against:

- cmux `0.64.19 (99)`
- Claude Code `2.1.212`
- cmux access mode `cmuxOnly`
- Claude `permissions.defaultMode = auto`

## Goal and constraints

The proposed automation lets a Pi agent operate normal interactive Claude Code sessions through cmux. It must not use Claude detached mode, print mode, or an API billing path. The controller creates a terminal/workspace, starts the normal Claude TUI, injects prompts, observes hooks, handles gates, resumes failed sessions, and tears everything down.

All validation used disposable temporary directories and interactive Claude sessions. No project source files were intentionally modified by the tests.

## Initial validation matrix

### 1. Turn completion

PASS.

A disposable session was correlated by cmux surface UUID and Claude session ID. After prompt submission, lifecycle first appeared as running after about 0.36 seconds and returned to idle after about 3.59 seconds. Claude returned the expected response. Screen scraping was not a reliable completion detector.

Authoritative turn gate:

1. Send to an explicit surface UUID.
2. Observe `UserPromptSubmit` for the expected session.
3. Observe the corresponding later top-level `Stop`.
4. Confirm lifecycle returns to an input-ready state.
5. Use `read-screen` only to retrieve or diagnose presentation state.

### 2. Permission/feed round trip

PASS, with an auto-mode limitation.

A real ExitPlan/PermissionRequest gate was captured. `feed.exit_plan.reply` with `mode: deny` returned `delivered: true` and transitioned pending to resolved. An unanswered request expired after approximately 125 seconds. The expired feed request left a stale TUI dialog, which required Escape before another prompt could be sent safely.

Because the user's global mode is `auto`, ordinary Bash and WebFetch actions were approved by Claude's classifier and did not produce normal tool permission dialogs. Generic tool permission behavior therefore remains dependent on compatibility checks and a fail-closed policy.

### 3. Persistent event cursor

PASS.

An event reader stopped with cursor `1582`. Another turn completed while the reader was down. Restarting from the cursor delivered new Stop events at sequence `1604+`, replayed no old events, and advanced the cursor. The cursor survived forcible reader termination.

Important behavior: `cmux events --limit N` can wait indefinitely until all N events arrive. Streaming readers require reconnect semantics; bounded probes require an external timeout.

### 4. Crash and exact-session resume

PASS.

A session was terminated and resumed interactively with `claude --resume <sessionId>`. The same session ID and prior conversation context were retained, including a planted codeword (`ZEBRA-42`).

### 5. Concurrent session isolation

PASS.

Two sessions received interleaved prompts. Events remained attributable by session ID, and transcripts contained only their own ALPHA/BETA values. No cross-attribution was observed.

### 6. Cold-start trust gate

PASS.

A genuinely new directory displayed a trust dialog before `SessionStart`. While blocked, there was no hook or session-store registration. After safe confirmation, SessionStart appeared about 9.5 seconds later.

## Additional validation matrix

### A. Parent turns that spawn subagents

PASS.

The raw cmux agent stream distinguished top-level `agent.hook.Stop` from `agent.hook.SubagentStop`. In one observed turn, SubagentStop appeared at sequences 2136 and 2158 while the top-level Stop appeared at sequence 2146 or later.

`workstream.jsonl` collapsed both event types into `kind: "stop"`; it must not be used as the authoritative completion source.

Completion must use the raw agent event stream and require:

- a matching UserPromptSubmit fence,
- a later top-level Stop (not SubagentStop),
- lifecycle returning to `needsInput`/idle,
- and a short settle/reconciliation window.

### B. Direct permission-mode launch

PASS.

`claude --permission-mode plan` starts directly in plan mode and removes the need to automate Shift+Tab. An invalid permission-mode value fails fast, creates no SessionStart, and does not register a session.

Observed accepted values:

- `acceptEdits`
- `auto`
- `bypassPermissions`
- `manual`
- `dontAsk`
- `plan`

The automation policy must never select `bypassPermissions`.

### C. cmux daemon-restart durability

BLOCKED in the current shared environment for safety.

cmux is a single GUI application for the current macOS user and uses one per-user socket (`cmux-501.sock`). No isolated `--serve`, `--headless`, or alternate-instance mode was found. Restarting it would terminate the controlling Pi session and unrelated user workspaces.

This test needs a second macOS UID, an isolated macOS VM, or an out-of-band supervisor during an approved maintenance window. See `docs/cmux-restart-durability-handoff.md`.

### D. Multiline and special-character injection

PASS.

A six-line prompt containing literal newlines, quotes, backticks, dollar signs, Unicode, escape-like content, and a line beginning `/exit` was inserted as one literal prompt with `terminal.paste`. One explicit Enter produced one UserPromptSubmit; `/exit` remained inert text.

Never send untrusted multiline text through `cmux send`: cmux converts newline and carriage-return characters into Enter keypresses. Safe injection is `terminal.paste(payload)` followed by one explicit Enter.

### E. Other pre-SessionStart dialogs

PASS.

- An invalid resume ID printed `No conversation found`, exited, and emitted no SessionStart.
- Theme/onboarding was triggered with an isolated `CLAUDE_CONFIG_DIR`.
- Pre-SessionStart dialogs had no hook/store visibility and no automatic timeout.

The launcher needs a known-dialog catalog, a registration deadline, and fail-closed escalation for unknown screens. It must never blindly press Enter on an unknown dialog.

### F. Four-session recovery storm

PASS.

Four sessions were given unique codewords, terminated, and resumed. All retained the same session IDs and correct context with no cross-contamination. Sequential recovery exceeded the command deadline; creating all resume workspaces first and polling registration in parallel succeeded.

SIGKILL left stale store entries because no SessionEnd was emitted. Liveness authority is PID/process state, not store presence.

### G. Compatibility assumptions

PASS as a compatibility snapshot, not as a permanent contract.

The tested environment had 252 cmux RPC methods, `permissions.defaultMode = auto`, and no explicit allow/deny rules. Tool approval therefore depends on the live Claude auto-mode classifier. The controller must version-check required behavior and fail closed when versions, methods, or permission configuration differ.

## Oracle verdict

Oracle reviewed the initial and additional evidence and judged the design ready to build. Daemon-restart durability is a deployment gate rather than a blocker for early implementation.

The most important correction is to consume the raw cmux agent event stream. `workstream.jsonl` must never be treated as authoritative for completion because it collapses parent Stop and SubagentStop.

## Recommended components

- `CmuxClient`: typed, timeout-aware cmux/RPC wrappers
- `CompatibilityGate`: validates versions, methods, permission modes, and configuration
- `EventTail`: one reconnecting raw agent-event stream with a persistent cursor
- `SessionRegistry`: maps run, workspace, surface, session, PID, cwd, and state
- `StartupDialogGate`: recognizes only known pre-SessionStart screens
- `PromptInjector`: uses terminal paste and one explicit Enter
- `SessionController`: owns one session state machine and turn queue
- `PermissionBroker`: applies fail-closed, request-specific policy
- `Scheduler`: caps concurrent sessions and isolates working directories/worktrees
- `RecoveryCoordinator`: resumes exact session IDs in batches
- `Reconciler`: rebuilds truth after socket loss or stale state
- `Reaper`: closes workspaces and confirms PID death
- `AuditLog`: append-only structured records of commands, events, decisions, and transitions

## Session state model

```text
CREATED
  -> LAUNCHING
  -> REGISTERING
  -> READY
  -> SUBMITTING
  -> RUNNING
  <-> PERMISSION_PENDING
  -> READY
  -> EXITING
  -> TERMINATED
```

Exceptional states:

```text
REGISTERING -> TRUST_REQUIRED
any state   -> RECOVERING
any state   -> FAILED
any state   -> CLEANING
```

## Core invariants

1. Every operation targets a full, explicit UUID; inherited cmux target defaults are scrubbed.
2. Untrusted prompt content is inserted with terminal paste, never newline-bearing `cmux send`.
3. A turn is fenced by its own UserPromptSubmit sequence.
4. Only a later top-level `agent.hook.Stop` can complete the turn; SubagentStop cannot.
5. Lifecycle must return to an input-ready state, followed by a short settle/reconciliation window.
6. Unknown startup dialogs and unknown permission kinds fail closed.
7. Permission/ExitPlan requests are resolved by request ID before the approximately 125-second expiry; the watchdog should act earlier (for example, around 100 seconds).
8. `bypassPermissions`, broad permanent approvals, and blind menu input are forbidden.
9. Post-crash truth priority is PID/process state, transcript, store, then derived event state.
10. Recovery uses the exact session ID with `claude --resume`, never an accidental new session.
11. Batch recovery creates all workspaces first, then polls registrations concurrently with per-operation deadlines.
12. Socket loss triggers full reconciliation; stale refs and event assumptions cannot be trusted automatically.

## Rollout plan

1. **P1:** single-session launcher, startup gate, safe injector, and raw-event completion fence
2. **P2:** permission broker, persistent event tail, audit log, and compatibility gate
3. **P3:** concurrency scheduler, reaper, and batch recovery
4. **P4:** reconciler and restart handling

Until daemon-restart durability is tested in isolation, P4 is mandatory before unattended or destructive autonomy. Any socket disconnect must trigger a full resync from process state, transcripts, surfaces, and session metadata.
