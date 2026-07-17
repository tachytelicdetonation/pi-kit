#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const packageRoot = join(process.cwd(), "node_modules", "@earendil-works", "pi-coding-agent");
const packageJson = JSON.parse(await readFile(join(packageRoot, "package.json"), "utf8")) as { version: string };
const extensionTypes = await readFile(join(packageRoot, "dist", "core", "extensions", "types.d.ts"), "utf8");
const sdkTypes = await readFile(join(packageRoot, "dist", "core", "sdk.d.ts"), "utf8");

const checks = {
  executableActiveToolDefinitions: /getActiveToolDefinitions\s*\(\)\s*:\s*(?:readonly\s+)?ToolDefinition\[\]/.test(
    extensionTypes,
  ),
  childPermissionBroker: /PermissionBroker/.test(sdkTypes) && /permissionBroker\s*\?\s*:/.test(sdkTypes),
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
            "createAgentSession({ permissionBroker }) with parent-session UI routing",
          ],
    },
    null,
    2,
  )}\n`,
);

process.exit(passed ? 0 : 1);
