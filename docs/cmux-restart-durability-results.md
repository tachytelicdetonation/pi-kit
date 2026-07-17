# cmux Restart-Durability Test — Results

Executed against an **isolated second cmux instance** (same user, same machine) while the
live cmux (PID 40491, `cmux-501.sock`) ran untouched throughout. Versions: cmux `0.64.19 (99)`,
binary `com.cmuxterm.harness` (re-signed copy of the stable build).

## Verdict

**PASS** for unattended automation *only if the controller keys on `boot_id` + `resume.gap`
and fully reconciles workspace/surface UUIDs on every reconnect.* Sequence continuity is **not**
guaranteed across a crash — the handoff's fail-closed requirement (line 94) is empirically confirmed.

All 10 questions answered (Q6/Q8 via an interactive Claude session driven inside the isolated
instance through `terminal.paste` + `surface.send_key` RPCs).

## The isolation harness (this is the reusable result)

The handoff/validation doc claimed "no alternate-instance/socket mode exists." **False.** A fully
isolated same-user instance is possible with four knobs the docs missed:

1. **Distinct bundle id + ad-hoc re-sign.** macOS is bundle-id-singleton: a second copy of
   `com.cmuxterm.app` silently hands off to the live app and exits. Rename `CFBundleIdentifier`
   → `com.cmuxterm.harness` and `codesign --force --deep --sign - --options runtime`.
2. **`CFFIXED_USER_HOME`** (not `$HOME`/XDG). cmux resolves `~/Library/Application Support/cmux`
   via Foundation `homeDirectoryForCurrentUser`, which ignores `$HOME`. Without this the second
   instance opens the **live** `search.db` read-write (SQLite WAL corruption risk). The canary
   caught this on the first launch attempt.
3. **`open -n --env`** (not direct-exec). Direct-exec of the Mach-O gets no LaunchServices
   registration, so the control socket never binds. `open -n` registers it; `--env` injects the
   isolation vars (base env is launchd's, so live `CMUX_*` leak vars don't propagate).
4. **Short socket path + `allowAll`.** `CMUX_SOCKET_PATH` must be < 104 bytes (`sun_path` limit) —
   a deep scratchpad path silently fails `bind()` (only the `.lock` appears). Use `/tmp/mxh.sock`.
   `CMUX_SOCKET_MODE=allowAll` + `automation.socketControlMode:allowAll` in the isolated config so
   the external supervisor can drive it (`cmuxOnly` rejects non-cmux-spawned callers).

Enable flags: `CMUX_ALLOW_SOCKET_OVERRIDE=1 CMUX_SOCKET_ENABLE=1`.

### Safety mechanisms used
- **Guarded kill**: signal only if `PID != 40491` AND `ps command` contains the scratch bundle path
  AND `ps eww` contains the harness sentinel UUID. Never `killall`/`pkill -f`/AppleScript-quit
  (bundle-id-scoped → could hit live).
- **Canary gate**: after each launch, `lsof -p <pid>` must show **zero** fds under real
  `~/Library/Application Support/cmux`, `~/.local/state/cmux`, `~/.config/cmux`. Abort on any leak.
- **Discovery restore**: each test-instance start rewrites `/tmp/cmux-last-socket-path` to point at
  the test socket. Restored to the live socket after every (re)start. (Live-side CLI calls are also
  independently protected — they pin `CMUX_SOCKET_PATH`.)

Live integrity verified byte-identical (lstart, socket inode, config sha, `search.db PRAGMA quick_check=ok`)
before and after the entire run.

## Findings per question

Event protocol carries first-class restart detection: every event id is `<boot_id>-<seq>`, and the
subscription **ack** includes `boot_id` + `resume{gap, gap_reason, latest_seq, oldest_seq, next_seq}`.

**Q1 — seq monotonic or reset?** Monotonic within a boot. **Graceful restart:** counter *persists*
and continues (37 → 38..43), history retained (`oldest_seq:1`). **Crash:** counter *rolls back* to
last durable checkpoint (pre-crash 48 → post 43); events 44–48 lost.

**Q2 — does `events --reconnect --cursor-file` recover?** **Yes, automatically.** The reader resumed
from cursor 37 with no manual intervention; got a fresh ack with the new `boot_id` and advanced.

**Q3 — events just before shutdown durable?** **Graceful: yes** (seq 36/37 emitted right before
SIGTERM were replayed post-restart). **Crash: no** — events after the last checkpoint are lost.

**Q4 — events while cmux unavailable?** None. No server = no emission, no queueing. The counter
resumes from persisted state on next boot.

**Q5 — workspace/pane/surface/session refs restored or replaced?** **Window UUID persists**
(`F7594FAD…` across all restarts). **Workspace UUIDs regenerate every boot**
(`7BBA5203`→`C6AEAA4C`→`93365F6A`). Count restored. *Surfaces*, by contrast, can be restored with
their **original UUID** from the persisted store on a graceful restart (surface `7B2D6CE5` reappeared
identical). Net: a controller must not trust workspace-level UUIDs across restart; re-fetch via
`list-windows` and re-correlate.

**Q6 — Claude PIDs killed/preserved/orphaned?** **KILLED, not orphaned.** Process tree was
claude → zsh → login → test-cmux. On cmux SIGTERM the child claude stayed alive at t≈0 (ppid
unchanged) then died within ~1s as cmux closed the pty (SIGHUP). It never reparented to launchd
(ppid never became 1). ⇒ After a cmux restart, Claude processes are **dead**; any session-store PID
entries are stale (confirms: PID/process liveness is the authority, not store presence).

**Q7 — session-store stale/clear/self-heal?** Store (`session-com.cmuxterm.harness.json`) persists
to disk on graceful shutdown and repopulates workspaces/surfaces on boot (workspace UUIDs regenerated,
surface UUIDs can be preserved). Crash durability follows the seq rollback (last-checkpoint semantics):
anything after the last checkpoint is lost.

**Q8 — resume exact Claude session + correlate?** **Yes, fully.** After the restart killed the
original claude (PID 59168), `claude --resume 0a25943a-…` in a disposable terminal restored the exact
session — full context (ctx 41.5k, unchanged) — and, asked cold "what codeword did I ask you to
remember," answered **"ZEBRA-7391."** Correlation: **same session id, new PID** (65290). The transcript
under real `~/.claude/projects/…` is the durable recovery source; cmux surface/workspace UUIDs are not.

**Q9 — signals of socket loss/restoration?** `boot_id` change is the epoch marker. `resume.gap:true`
+ `gap_reason:"requested sequence is newer than this cmux process; cmux probably restarted"` is the
loss signal. **The socket file is a stale artifact after shutdown** (persists on disk, no listener) —
socket-file presence is NOT a liveness signal; use PID/process liveness.

**Q10 — minimum reconciliation sources after reconnect?** (a) `boot_id` (detect epoch change),
(b) `resume.gap` flag (detect discontinuity), (c) fresh `list-windows`/surface enumeration
(re-map replaced workspace/surface UUIDs). Do not trust pre-restart UUIDs or cursor continuity blindly.

## Follow-up verifications (controller-driven)

Two open items from the `claude-cmux` review were checked on the same harness:

**AskUserQuestion is genuinely fail-closed (not fail-slow).** Drove a managed Claude to invoke
AskUserQuestion with distinctive option labels. The raw event stream redacts the options
(`agent.hook.AskUserQuestion` / `PreToolUse` carry `tool_input: null`, `redacted_fields:
["tool_input"]`; the labels appear in **no** payload) but exposes the `request_id`. Calling
`feed.permission.reply {request_id, mode:"deny"}` returned `{delivered:true}` in ~50 ms, dismissed
the question UI, and the agent continued — a clean decline, not a stall. Deny-only is correct.

**cmux auto-resumes managed sessions on restart.** After a restart, cmux restored each surface with
its original UUID and respawned `claude --resume <sessionId>` (same session id) within seconds, which
re-registered in the hook store. Consequence for reconciliation: prefer rebinding to cmux's restored
instance over issuing a second resume; the recovery grace must stay longer than cmux's restore time
(do not shrink it). cmux can itself produce duplicate resumes when one session owned several surfaces —
the controller should bind one and treat the rest as stale.

## Controller requirement (confirmed)

Treat every socket restoration as a **potential new event epoch**: on reconnect, compare `boot_id`;
if changed OR `resume.gap` is true, discard cached workspace/surface UUIDs and fully reconcile from
process state + fresh enumeration before sending any prompt. Fail closed otherwise.

## Reproduce

Harness scripts + audit log live in the session scratchpad under `cmux-restart/`
(`env.sh`, `launch.sh`, `tcmux`, `sentinel`, `events.jsonl`, `audit.jsonl`, `preflight-baseline.txt`).
The re-signed bundle is `cmux-restart/cmux.app`. Not committed — regenerate per the recipe above.
