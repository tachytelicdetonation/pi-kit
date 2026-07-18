# pi-claude-cmux

A Pi extension that delegates work to **normal interactive Claude Code sessions** running in managed cmux workspaces. It does not use Claude print mode, detached mode, or a direct API path.

The implementation follows the validated rollout in [`../docs/cmux-claude-automation-validation.md`](../docs/cmux-claude-automation-validation.md):

- **P1:** single-session launcher, startup dialog gate, safe injector, and completion fence
- **P2:** fail-closed permission broker, persistent raw event tail, and compatibility gate
- **P3:** bounded fleet concurrency, PID-confirmed reaper, and batch recovery
- **P4:** topology/session reconciler and cmux boot-epoch/gap handling

## Safety model

- Every cmux operation targets an explicit workspace or surface UUID.
- Inherited `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID`, and `CMUX_TAB_ID` targets are scrubbed from child commands.
- Prompts use `terminal.paste` followed by one explicit Enter. Newline-bearing `cmux send` is rejected.
- A turn completes only after its own raw `UserPromptSubmit`, a later top-level `agent.hook.Stop` (never `SubagentStop`), input-ready lifecycle, and a settle window.
- Claude starts with `--permission-mode plan` by default.
- ExitPlan and tool permissions are routed to Pi's UI with a fail-closed timeout. The extension supports one-time approval only; bypass and permanent broad approvals are not exposed.
- Unknown questions and unknown pre-SessionStart dialogs fail closed.
- Cleanup uses `/exit`, workspace close, PID polling, verified Claude SIGTERM, then verified SIGKILL as a last resort.
- Prompt text is not written to the audit log; only length, byte count, and SHA-256 are recorded.

## Requirements

Validated compatibility range:

- cmux `>=0.64.19` and `<0.65.0`
- Claude Code `>=2.1.212` and `<2.2.0`
- Pi `0.80.10`

The compatibility gate also verifies required cmux RPC methods, `claude --permission-mode plan`, and `claude --resume` before launching work.

Claude's cmux wrapper integration must be enabled. Check with:

```bash
cmux ping
cmux capabilities
cmux docs agents
```

## Install

```bash
pi install /Users/tanmaydeshmukh/Projects/pi-kit/claude-cmux
```

For development:

```bash
pi --no-extensions -e ./claude-cmux/extensions/claude-cmux.ts
```

## Tool

The extension registers `claude_cmux`.

### One task

```json
{
  "action": "run",
  "prompt": "Review the authentication flow and propose fixes",
  "cwd": "/path/to/project",
  "permissionMode": "plan"
}
```

### Parallel fleet

```json
{
  "action": "parallel",
  "concurrency": 4,
  "tasks": [
    { "id": "tests", "prompt": "Audit the test strategy", "cwd": "/path/to/project" },
    { "id": "security", "prompt": "Review auth security", "cwd": "/path/to/project" }
  ]
}
```

The maximum accepted task list is 16; active concurrency defaults to 4 and is capped by configuration.

### Status and cleanup

```json
{ "action": "status" }
{ "action": "stop", "runId": "..." }
{ "action": "stop" }
```

Omit `runId` to stop all sessions owned by this Pi session. The extension never intentionally closes unrelated cmux workspaces.

## Commands

- `/claude-cmux <prompt>` — run one Claude task in Pi's current working directory
- `/claude-cmux-status` — inspect managed sessions
- `/claude-cmux-stop [run-id]` — stop one or all managed sessions
- `/claude-cmux-recover` — reconcile topology, hook state, PIDs, and resumable sessions

## Permission behavior

The default plan-mode flow is:

1. Claude plans in its own interactive TUI.
2. cmux publishes `PermissionRequest`/ExitPlan events.
3. Pi asks whether to continue manually, continue in Claude auto mode, or deny.
4. The extension replies by request ID through cmux Feed RPC.
5. Unanswered requests are denied by the extension watchdog before cmux's roughly 120–125 second Feed timeout.

Normal permissions expose only **Allow once** and **Deny**. AskUserQuestion choices are redacted from the raw event stream, so unsupported questions are denied rather than answered by scraping the TUI. An isolated-instance harness now exists (see `docs/cmux-restart-durability-results.md`) to validate a structured `feed.list`-based answer path before this deny-only policy is relaxed.

## Recovery and reconciliation

Each Pi session gets an isolated state/cursor directory keyed by Pi's stable session ID. Multiple Pi TUIs can subscribe to cmux events without sharing cursor files.

The event stream records a process-local sequence and `boot_id`. On a changed boot ID or `resume.gap`, the extension:

1. pauses assumptions based on old event fences,
2. snapshots cmux topology and the Claude hook session store,
3. verifies PIDs and explicit surface/workspace IDs,
4. rebinds live sessions,
5. resumes dead managed sessions by exact Claude session ID when safe,
6. fails closed if a PID is alive but its expected managed surface is missing.

Reconciliation runs after **every** cmux restart, because restarts always change `boot_id` and always kill managed Claude processes (verified: pty SIGHUP, never orphaned); PID liveness — not session-store presence or socket-file existence — is the authority.

In-flight prompts are never automatically resent after an epoch change because doing so could duplicate side effects. If the epoch changes or the stream reports a `resume.gap` while a turn is in flight, the fence aborts immediately and the turn's output is recovered **read-only** from the durable transcript only when the transcript gained assistant output and the hook store shows the session back at an input-ready lifecycle; otherwise the turn fails closed.

## State and audit files

Under `${PI_CODING_AGENT_DIR:-~/.pi/agent}/claude-cmux/`:

```text
audit.jsonl
instances/<pi-session-id>/events.seq
instances/<pi-session-id>/state.json
```

Claude's authoritative session mapping remains in:

```text
~/.cmuxterm/claude-hook-sessions.json
```

The extension reads Claude output from the transcript path recorded in that store. Tool-visible output is capped at 50 KiB; the complete response remains in Claude's transcript.

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `PI_CLAUDE_CMUX_CONCURRENCY` | `4` | Maximum active fleet workers (hard cap 8) |
| `PI_CLAUDE_CMUX_REGISTRATION_TIMEOUT_MS` | `45000` | SessionStart/startup-dialog deadline |
| `PI_CLAUDE_CMUX_TURN_TIMEOUT_MS` | `600000` | Default turn deadline |
| `PI_CLAUDE_CMUX_SETTLE_MS` | `750` | Post-Stop settle window |
| `PI_CLAUDE_CMUX_PERMISSION_TIMEOUT_MS` | `100000` | Fail-closed permission watchdog (capped at 110s) |
| `PI_CLAUDE_CMUX_RECOVERY_GRACE_MS` | `35000` | Grace for cmux to restore/re-register Claude before reconciliation |
| `PI_CLAUDE_CMUX_MAX_RESUMES` | `3` | Resume attempts per managed session |
| `PI_CLAUDE_CMUX_STRICT_COMPAT` | `true` | Reject untested cmux/Claude versions |
| `PI_CLAUDE_CMUX_AUTO_RECOVER` | `true` | Resume safely recoverable managed sessions |
| `PI_CLAUDE_CMUX_STATE_DIR` | Pi agent dir | Override state/audit root |
| `CMUX_BIN` | `cmux` | Override cmux CLI path |

## Development

```bash
cd claude-cmux
npm install --ignore-scripts
npm test
```

The test suite covers raw parent/subagent event fencing, boot-epoch reset, in-flight epoch rejection, same-boot gap abort, non-ack boot-change detection, transcript-based turn recovery (with fail-closed on unconfirmed completion), bounded fleet scheduling, permission correlation/deduplication, transcript extraction, state persistence, startup dialog classification, request-ID extraction, version parsing, and multiline-send rejection.

A live smoke test was also run against the validated local versions. It launched an interactive Claude workspace, safely submitted a prompt, observed raw completion hooks, read `EXTENSION-SMOKE-OK` from the transcript, exited Claude, and removed the workspace.

## Known limitations

- AskUserQuestion selections are denied fail-closed. This is now **harness-verified**: the tool's options are genuinely redacted from the raw event stream (`tool_input: null`, `redacted_fields: ["tool_input"]`), and `feed.permission.reply {mode:"deny"}` declines the question cleanly in ~50 ms (the question UI dismisses and the agent continues) — it is fail-*closed*, not fail-*slow*. A structured-answer adapter remains gated on a future `feed.list`-style RPC that exposes the options without scraping the TUI.
- Restart durability has been **empirically validated** against an isolated cmux instance (`docs/cmux-restart-durability-results.md`): `boot_id` changes on every boot; graceful restarts preserve the sequence counter (seamless `gap:false` reconnect) while crashes roll it back to the last durable checkpoint (post-checkpoint events are lost, signalled by `resume.gap`); cmux restarts kill child Claude PIDs (pty SIGHUP, never orphaned); workspace UUIDs regenerate each boot while surfaces may keep theirs; `claude --resume <sessionId>` fully restores session context from the durable transcript.
- **cmux auto-resumes managed sessions on restart**: it restores each surface and respawns `claude --resume <sessionId>` (same session id) within a few seconds, re-registering in the hook store. Reconciliation therefore rebinds to cmux's restored instance rather than resuming a duplicate — this is why the recovery grace (`PI_CLAUDE_CMUX_RECOVERY_GRACE_MS`) is load-bearing and must stay comfortably longer than cmux's restore time. (cmux can itself spawn duplicate resumes when one session had several surfaces; reconciliation binds to one and should treat the rest as stale.)
- Compatibility ranges are intentionally narrow. Upgrade the tested range only after rerunning unit and live smoke tests.
