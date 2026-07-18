#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ParentRoutedPermissionBroker } from "../src/workflows/workflow-permission-broker.js";

const packageRoot = process.env.PI_CODING_AGENT_ROOT
  ? process.env.PI_CODING_AGENT_ROOT
  : join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string };
const extensionTypes = await readFile(join(packageRoot, "dist", "core", "extensions", "types.d.ts"), "utf8");

const broker = new ParentRoutedPermissionBroker({ activeToolNames: ["read"], policy: () => "ask" });
const inactive = await broker.authorize({
  runId: "gate",
  agentId: "agent",
  toolName: "bash",
  input: {},
  cwd: process.cwd(),
});
const headlessAsk = await broker.authorize({
  runId: "gate",
  agentId: "agent",
  toolName: "read",
  input: {},
  cwd: process.cwd(),
});
const checks = {
  executableActiveToolDefinitions: /getActiveToolDefinitions\s*\(\)\s*:\s*(?:readonly\s+)?ToolDefinition\[\]/.test(
    extensionTypes,
  ),
  cwdAwareBuiltinDefinitions:
    /getWorkflowHostCapabilities\s*\(\)\s*:\s*WorkflowHostCapabilities/.test(extensionTypes) &&
    /cwdAwareBuiltinDefinitions\s*:\s*true/.test(extensionTypes),
  parentRoutedPermissionBroker: !inactive.allowed && !headlessAsk.allowed,
};
const passed = Object.values(checks).every(Boolean);

process.stdout.write(
  `${JSON.stringify(
    {
      gate: "host-capability-boundary",
      hostPackage: "@earendil-works/pi-coding-agent",
      hostVersion: packageJson.version,
      status: passed ? "PASS" : "FAIL",
      checks,
      requiredUpstreamContract: passed
        ? undefined
        : [
            "ExtensionAPI.getActiveToolDefinitions(): readonly ToolDefinition[]",
            "ExtensionAPI.getWorkflowHostCapabilities().cwdAwareBuiltinDefinitions === true",
          ],
    },
    null,
    2,
  )}\n`,
);

process.exit(passed ? 0 : 1);
