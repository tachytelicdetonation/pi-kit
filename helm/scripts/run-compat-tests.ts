#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function collectTests(directory: string): string[] {
  const tests: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) tests.push(...collectTests(path));
    else if (entry.isFile() && entry.name.endsWith(".test.ts")) tests.push(path);
  }
  return tests;
}

const filters = process.argv.slice(2).map((value) => value.toLowerCase());
const allTests = collectTests(resolve("tests", "compat")).sort();
const selected =
  filters.length === 0
    ? allTests
    : allTests.filter((path) => filters.some((filter) => path.toLowerCase().includes(filter)));

if (selected.length === 0) {
  process.stderr.write(`No compatibility tests matched: ${filters.join(", ")}\n`);
  process.exit(1);
}

const tsx = resolve("node_modules", ".bin", process.platform === "win32" ? "tsx.cmd" : "tsx");
const result = spawnSync(tsx, ["--test", ...selected], { stdio: "inherit" });
if (result.error) {
  process.stderr.write(`${result.error.message}\n`);
  process.exit(1);
}
process.exit(result.status ?? 1);
