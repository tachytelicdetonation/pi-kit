# Host capability gate report

- **Date:** 2026-07-17
- **Workflow baseline:** `@tachytelicdetonation/pi-dynamic-workflows` 2.14.1, commit `e459fe62d3ef126fabfa89dbd59b49d68c998583`
- **Pi SDK inspected:** `@earendil-works/pi-coding-agent` 0.80.6
- **Result:** **STOP — FAIL**

## Required checks

| Check | Result | Evidence |
|---|---:|---|
| Parent extension can obtain executable definitions for every active built-in, extension, custom, and MCP tool. | FAIL (Pi 0.80.6) / PASS (workflow host 0.80.10) | Public Pi 0.80.6 has no executable-definition API. The pinned workflow host exposes executable snapshots plus an explicit cwd-aware capability contract. |
| Child tool calls delegate permission decisions to the active parent session/UI. | PASS | `ParentRoutedPermissionBroker` retains the parent UI, serializes concurrent prompts, validates the immutable active-tool set, and denies on policy/UI failure. |
| Subagent tools execute outside the child process. | PASS | `ProcessWorkflowAgent` registers schema-only proxies; `InheritedToolHost` authorizes and executes the snapshotted parent definitions. Ambient child extensions are disabled. Built-ins rebind to the child/worktree cwd and custom tools receive a cwd-overridden execution context. |
| A denied parent tool is absent while active custom and MCP-like tools remain executable. | PASS (compatibility host) / BLOCKED (Pi 0.80.6) | Executable fake custom and MCP-like tools pass `HOST-01`/`HOST-02`; Pi 0.80.6 cannot populate the snapshot. |
| Background prompts route to the active parent UI/session. | PASS | The broker is created from the invocation context and remains attached to background runs. Missing UI fails closed. |
| Orchestration JavaScript is process isolated. | PASS | Scripts run in a separate Node process with code generation disabled, an empty environment, memory bounds, and Node filesystem/network/child-process permissions denied. All bridges use validated IPC methods. |

Run the reproducible check with:

```bash
npm run check:host-capabilities
```

The command exits non-zero against Pi 0.80.6. It passes against the pinned workflow host built by `npm run build:workflow-host`; that host advertises and tests both executable snapshots and cwd-aware built-in definitions. The permission broker and process host are package-owned rather than requiring `createAgentSession({ permissionBroker })`.

## Minimum upstream contract still needed

1. `ExtensionAPI.getActiveToolDefinitions(): readonly ToolDefinition[]`, returning the exact executable definitions selected in the current parent session, including built-in overrides, extension tools, SDK custom tools, and MCP tools.
2. `ExtensionAPI.getWorkflowHostCapabilities().cwdAwareBuiltinDefinitions === true`, backed by defined rebinding semantics for cwd-sensitive built-in/worktree tools.
3. Tests proving launch-time snapshots do not observe later parent allowlist changes and built-in execution honors the supplied child cwd.

## Fail-closed behavior

The extension requires both `getActiveToolDefinitions()` and the explicit cwd-aware capability marker. It never reconstructs executable tools from `ToolInfo`. On unsupported Pi hosts it retains the legacy agent path so existing installations continue to work, but that path is not considered compatibility mode and cannot pass the parity gate.

No Claude parity claim is made while the executable-definition host check remains red.
