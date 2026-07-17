# Handoff: Isolated cmux Restart-Durability Test

## Scope

This handoff is intentionally limited to one unresolved question:

> What happens to cmux agent-event sequences, cursor files, sessions, and surface references across a full cmux application restart?

All other interactive Claude-through-cmux findings are recorded in `docs/cmux-claude-automation-validation.md` and should be treated as established context rather than reopened here.

## Why the test is isolated

The current Pi controller runs inside the same per-user cmux application that would be restarted. The application uses the current user's socket (`cmux-501.sock`) and also owns unrelated active workspaces. Restarting it from this session would terminate the observer and disrupt unrelated work.

No supported alternate-instance, headless-server, or arbitrary-socket launch mode was found during validation.

## Safety constraints

- Do not restart the current user's cmux while unrelated workspaces are active.
- Do not target or close workspaces that were not created by the test harness.
- Do not use detached, print, or API-mode Claude sessions.
- Use only disposable directories and harmless prompts.
- Run restart orchestration from outside the cmux instance under test.
- Record resource identifiers before each destructive action.
- Confirm cleanup by PID/process liveness, not session-store presence.

## Acceptable harness options

### Option A: second macOS user

Run a separate logged-in user with its own UID, cmux state, and socket. Keep the observer under the primary user or another out-of-band process.

### Option B: isolated macOS VM

Install the tested cmux and Claude versions in the VM. Run the observer from the host or from a supervisor that is not owned by the cmux process being restarted.

### Option C: approved maintenance window

Close or save all real cmux work, then run an external supervisor from Terminal.app or launchd under the same user. This is disruptive and should not be attempted casually.

## Versions to reproduce first

- cmux `0.64.19 (99)`
- Claude Code `2.1.212`
- Claude launched interactively with `--permission-mode plan`

## Questions the harness must answer

1. Does the cmux event sequence remain monotonic after restart, or reset?
2. Does `cmux events --reconnect --cursor-file ...` recover automatically?
3. Are events emitted shortly before shutdown durable after restart?
4. What happens to events that would occur while cmux is unavailable?
5. Are workspace, pane, surface, and session references restored or replaced?
6. Are Claude PIDs killed, preserved, or orphaned by the restart?
7. Does session-store state become stale, clear, or self-heal?
8. Can exact Claude sessions be resumed and correlated after restart?
9. What events indicate socket loss and restoration to the controller?
10. What minimum reconciliation sources are sufficient after reconnect?

## Proposed experiment

1. Start the out-of-band supervisor and timestamped JSONL audit log.
2. Launch isolated cmux and one interactive Claude session in a disposable directory.
3. Record cmux version, socket path, process IDs, workspace/surface UUIDs, Claude session ID, event cursor, and latest raw event sequence.
4. Submit a harmless prompt and prove the normal UserPromptSubmit -> top-level Stop fence.
5. Stop the event reader while preserving its cursor.
6. Submit or complete another harmless turn, then capture the last known sequence.
7. Terminate the cmux application using the exact restart method under test.
8. Record process/socket disappearance from the external supervisor.
9. Relaunch cmux and wait for socket readiness with a bounded deadline.
10. Restart the event reader from the saved cursor.
11. Determine whether sequences continued, reset, replayed, or developed a gap.
12. Inspect restored workspaces/surfaces and PID/session-store state.
13. Resume the exact Claude session interactively and ask it to recall a planted codeword.
14. Run one new turn and verify event correlation after restart.
15. Exit Claude normally, close all disposable resources, and verify PID death.

## Required output

Produce a PASS/FAIL report with:

- Before/after event sequence values
- Cursor-file contents and replay/gap behavior
- Socket-down and socket-ready timestamps
- Before/after workspace, surface, session, and PID identities
- Transcript/context recovery result
- Any stale state and the source that corrected it
- Exact controller behavior required on socket loss

## Acceptance criteria

The test passes for unattended automation only if the controller can deterministically detect restart, reject stale event assumptions, reconstruct session truth, and either continue or fail closed without cross-targeting another surface.

If event sequence continuity is not guaranteed, the implementation must treat every socket restoration as a new event epoch and perform a full reconciliation before sending any prompt.

## Prompt for a separate chat

```text
Read docs/cmux-restart-durability-handoff.md. Focus only on designing and safely executing the isolated cmux restart-durability harness. Do not reopen the already validated automation architecture except where restart evidence requires a change. Start by selecting the safest available isolation option and identifying prerequisites; do not restart my current cmux instance.
```
