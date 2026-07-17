#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { normalizeOracleFixture, ORACLE_FIXTURE_SCHEMA_VERSION } from "../src/compat/oracle-fixtures.js";

const EXPECTED_ENV_VALUE = "1";
const DEFAULT_VERSION = "2.1.212";
const MAX_PAID_CALLS = 3;
const TRANSCRIPT_KEYS = new Set(["content", "message", "prompt", "response", "text", "thinking", "transcript"]);

interface Probe {
  id: string;
  prompt: string;
  input: Record<string, unknown>;
}

const PROBES: Probe[] = [
  {
    id: "INV-02-object",
    prompt:
      'Use the Workflow tool once with a one-agent synthetic workflow. Pass args {"kind":"oracle-public-fixture"}. Return only the tool outcome.',
    input: { source: "script", argsKind: "object", synthetic: true },
  },
  {
    id: "APP-03-headless",
    prompt:
      "Use a one-agent synthetic dynamic workflow to answer: what is 2 + 2? This is a public compatibility probe with no project data.",
    input: { origin: "print", permissionMode: "default", synthetic: true },
  },
  {
    id: "TRG-02-natural-language",
    prompt:
      "Delegate two independent public arithmetic checks using a dynamic workflow, then report whether their answers agree.",
    input: { origin: "print", requestKind: "natural-language", synthetic: true },
  },
];

function fail(message: string): never {
  process.stderr.write(`compat:capture: ${message}\n`);
  process.exit(1);
}

function readOption(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) fail(`${name} requires a value`);
  return value;
}

function installedClaudeVersion(): string {
  const result = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
  if (result.error) fail(`cannot execute claude --version: ${result.error.message}`);
  if (result.status !== 0) fail(`claude --version exited ${result.status ?? "without a status"}`);
  const match = `${result.stdout}\n${result.stderr}`.match(/\b\d+\.\d+\.\d+\b/);
  if (!match) fail("could not parse claude --version output");
  return match[0];
}

function parseEvents(stdout: string): unknown[] {
  const trimmed = stdout.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const events: unknown[] = [];
    for (const line of trimmed.split("\n")) {
      try {
        events.push(JSON.parse(line) as unknown);
      } catch {
        // Plain model output is deliberately discarded; raw transcripts are never persisted.
      }
    }
    return events;
  }
}

function errorCategory(value: string): string {
  if (/permission|denied|not allowed/i.test(value)) return "PERMISSION_DENIED";
  if (/validation|invalid|required|exactly one/i.test(value)) return "INVALID_INVOCATION";
  if (/timeout|timed out/i.test(value)) return "TIMEOUT";
  if (/rate|usage|quota|limit/i.test(value)) return "PROVIDER_USAGE_LIMIT";
  if (/abort|cancel/i.test(value)) return "ABORTED";
  return "ORACLE_ERROR";
}

function summarizeEvents(events: unknown[]): Record<string, unknown> {
  const eventTypes = new Set<string>();
  const toolNames = new Set<string>();
  const statuses: string[] = [];
  const errorCategories = new Set<string>();
  const schemas: string[][] = [];

  const visit = (value: unknown, parentKey?: string): void => {
    if (typeof value === "string") {
      if (parentKey === "type") eventTypes.add(value);
      if (parentKey === "toolName" || parentKey === "name") toolNames.add(value);
      if (parentKey === "status" || parentKey === "state" || parentKey === "stopReason") statuses.push(value);
      if (parentKey && /error|reason/i.test(parentKey)) errorCategories.add(errorCategory(value));
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) visit(item, parentKey);
      return;
    }
    if (value === null || typeof value !== "object") return;

    const record = value as Record<string, unknown>;
    if (record.input && typeof record.input === "object" && !Array.isArray(record.input)) {
      schemas.push(Object.keys(record.input as Record<string, unknown>).sort());
    }
    for (const [key, child] of Object.entries(record)) {
      if (!TRANSCRIPT_KEYS.has(key)) visit(child, key);
    }
  };

  visit(events);
  return {
    eventTypes: [...eventTypes].sort(),
    toolNames: [...toolNames].sort(),
    stateTransitions: statuses,
    optionSchemas: schemas,
    errorCategories: [...errorCategories].sort(),
  };
}

async function main(): Promise<void> {
  if (process.env.CLAUDE_WORKFLOW_ORACLE !== EXPECTED_ENV_VALUE) {
    fail("refusing to run unless CLAUDE_WORKFLOW_ORACLE=1");
  }

  const expectedVersion = readOption("--claude-version") ?? DEFAULT_VERSION;
  const actualVersion = installedClaudeVersion();
  if (actualVersion !== expectedVersion) {
    fail(`oracle version drift: expected ${expectedVersion}, installed ${actualVersion}; re-baseline deliberately`);
  }

  process.stderr.write(`Oracle capture can make at most ${MAX_PAID_CALLS} paid Claude calls.\n`);
  if (!process.argv.includes("--confirm-paid-calls")) {
    fail("add --confirm-paid-calls after reviewing the estimate and applicable Anthropic terms");
  }

  const fixtureRoot = resolve("tests", "compat", "fixtures", expectedVersion);
  const outputPath = resolve(readOption("--output") ?? join(fixtureRoot, "capture.normalized.json"));
  if (dirname(outputPath) !== fixtureRoot) fail(`output must be directly inside ${fixtureRoot}`);

  const manifest = JSON.parse(await readFile(join(fixtureRoot, "manifest.json"), "utf8")) as {
    oracleVersion?: string;
  };
  if (manifest.oracleVersion !== expectedVersion) fail("fixture manifest does not match the requested oracle version");

  const observations: unknown[] = [];
  for (const probe of PROBES) {
    const result = spawnSync("claude", ["--print", "--output-format", "stream-json", "--verbose", probe.prompt], {
      encoding: "utf8",
      maxBuffer: 16 * 1024 * 1024,
      timeout: 10 * 60_000,
    });
    observations.push({
      id: probe.id,
      oracleVersion: expectedVersion,
      provenance: "black-box",
      input: probe.input,
      exitCode: result.status,
      signal: result.signal,
      observation: summarizeEvents(parseEvents(result.stdout ?? "")),
      processErrorCategory: result.error ? errorCategory(result.error.message) : undefined,
    });
  }

  const capture = normalizeOracleFixture({
    fixtureVersion: ORACLE_FIXTURE_SCHEMA_VERSION,
    oracleVersion: expectedVersion,
    provenance: "black-box",
    capturedWith: "licensed-local-claude-cli",
    maximumPaidCalls: MAX_PAID_CALLS,
    observations,
  });

  await mkdir(fixtureRoot, { recursive: true });
  const temporaryPath = `${outputPath}.${process.pid}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(capture, null, 2)}\n`, { mode: 0o600 });
  await rename(temporaryPath, outputPath);
  process.stdout.write(`${outputPath}\n`);
}

await main();
