# Host capability gate report

- **Date:** 2026-07-17
- **Workflow baseline:** `@quintinshaw/pi-dynamic-workflows` 2.14.1, commit `e459fe62d3ef126fabfa89dbd59b49d68c998583`
- **Pi SDK inspected:** `@earendil-works/pi-coding-agent` 0.80.6
- **Result:** **STOP — FAIL**

## Required checks

| Check | Result | Evidence |
|---|---:|---|
| Parent extension can obtain executable definitions for every active built-in, extension, custom, and MCP tool. | FAIL | Public `ExtensionAPI` exposes `getActiveTools(): string[]` and metadata-only `getAllTools(): ToolInfo[]`; it has no `getActiveToolDefinitions()`. |
| Child `createAgentSession` can delegate permission decisions to the active parent session/UI. | FAIL | Public `CreateAgentSessionOptions` has no `PermissionBroker` or equivalent session-scoped authorization callback. |
| A denied parent tool is absent while active custom and MCP-like tools remain executable. | BLOCKED | The compatibility-side immutable snapshot and fake definitions pass, but the real host cannot populate that snapshot without reconstructing executable tools from metadata, which the plan forbids. |
| Background prompts can safely route to the active parent UI/session. | BLOCKED | No child-session permission-broker contract exists to preserve parent routing and lifecycle. |

Run the reproducible check with:

```bash
npm run check:host-capabilities
```

The command exits non-zero and reports both missing contracts. The public Pi extension and SDK documentation were also checked in full. `pi.getAllTools()` intentionally returns descriptive metadata, while `createAgentSession({ customTools })` accepts definitions only when the caller already possesses them.

## Minimum upstream contract needed

1. `ExtensionAPI.getActiveToolDefinitions(): readonly ToolDefinition[]`, returning the exact executable definitions selected in the current parent session, including built-in overrides, extension tools, SDK custom tools, and MCP tools.
2. A session-scoped `PermissionBroker` accepted by `createAgentSession`, with safe parent UI/session routing, abort behavior, and fail-closed behavior after parent shutdown.
3. Defined rebinding semantics for cwd-sensitive built-in/worktree tools that preserve executable custom tools and never increase privileges.
4. Tests proving launch-time snapshots do not observe later parent allowlist changes.

## Why no fallback was used

Recreating tools from `ToolInfo`, loading a second copy of parent extensions, or giving children the default coding tools would either lose custom/MCP behavior or silently broaden privileges. Any of those would violate the security contract and the explicit STOP conditions.

Phase 0 artifacts and the compatibility-side host snapshot are retained. No phase after the permission hard gate has been started, and no Claude parity claim is made.
