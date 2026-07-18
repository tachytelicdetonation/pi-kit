# Pi workflow host patch

`pi-coding-agent-0.80.10-active-tool-definitions.patch` is a clean-room patch against:

- Repository: `https://github.com/earendil-works/pi.git`
- Commit: `216e672e7c9fc65682553394b74e483c0c9e47f7`
- Coding-agent version: `0.80.10`

It adds:

```ts
ExtensionAPI.getActiveToolDefinitions(): readonly ToolDefinition[]
ExtensionAPI.getWorkflowHostCapabilities(): {
  executableActiveToolDefinitions: true
  cwdAwareBuiltinDefinitions: true
}
```

The definition method returns a new array in current active-tool order. Custom, override, SDK, and MCP definitions retain executable identity. Genuine built-ins are wrapped at snapshot time so execution rebinds them to `ctx.cwd`, including worktree agents. Later active-tool changes do not mutate an earlier array snapshot.

Build and test a package locally:

```bash
npm run build:workflow-host
```

The resulting tarball is written under `.artifacts/pi-workflow-host/`. It can be tested without publishing:

```bash
npm install --global .artifacts/pi-workflow-host/earendil-works-pi-coding-agent-0.80.10.tgz
pi --version
```

Review the patch before installing. A custom Pi package replaces the executable host and therefore has full user privileges.
