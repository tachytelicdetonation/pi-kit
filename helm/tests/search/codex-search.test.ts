import assert from "node:assert/strict";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  buildCodexArgs,
  normalizeDomain,
  resolveEffort,
  runCodexSearch,
  validateAndFilterPayload,
} from "../../src/search/search.js";

const basePayload = {
  answer: "A sourced answer.",
  sources: [
    {
      title: "Primary",
      url: "https://docs.example.com/report",
      publishedAt: "2026-01-01",
      summary: "Primary source",
      claims: ["A claim"],
    },
    {
      title: "Excluded",
      url: "https://ads.example.net/tracker",
      publishedAt: "",
      summary: "Excluded source",
      claims: [],
    },
  ],
  queries: ["test query"],
  limitations: [],
};

test("auto effort routes simple, comparative, and high-stakes research", () => {
  assert.equal(resolveEffort({ query: "OpenAI Codex documentation" }), "low");
  assert.equal(resolveEffort({ query: "Compare the current pricing and tradeoffs of three hosted databases" }), "medium");
  assert.equal(
    resolveEffort({
      query: "Research and cross-check the latest security vulnerability timeline and compare conflicting reports",
      maxResults: 8,
    }),
    "high",
  );
  assert.equal(resolveEffort({ query: "anything", effort: "high" }), "high");
});

test("Codex arguments use strict isolated search configuration", () => {
  const args = buildCodexArgs(
    {
      query: "ignored in argv",
      includeDomains: ["https://OpenAI.com/docs", "openai.com"],
      location: { country: "US", timezone: "America/New_York" },
      mode: "live",
    },
    { cwd: "/tmp/work", schema: "/tmp/schema.json", output: "/tmp/output.json" },
    { model: "gpt-5.6-sol", effort: "medium", depth: "high" },
  );
  const joined = args.join(" ");
  assert.match(joined, /--search/);
  assert.match(joined, /--disable shell_tool/);
  assert.match(joined, /--disable unified_exec/);
  assert.match(joined, /--ephemeral/);
  assert.match(joined, /--ignore-user-config/);
  assert.match(joined, /--ignore-rules/);
  assert.match(joined, /--sandbox read-only/);
  assert.match(joined, /model_reasoning_effort="medium"/);
  assert.match(joined, /tools\.web_search\.context_size="high"/);
  assert.match(joined, /tools\.web_search\.allowed_domains=\["openai.com"\]/);
  assert.match(joined, /tools\.web_search\.location=\{country="US",timezone="America\/New_York"\}/);
  assert.ok(!joined.includes("ignored in argv"));

  const cachedArgs = buildCodexArgs(
    { query: "cached", mode: "cached" },
    { cwd: "/tmp/work", schema: "/tmp/schema.json", output: "/tmp/output.json" },
    { model: "gpt-5.6-sol", effort: "low", depth: "low" },
  );
  assert.ok(!cachedArgs.includes("--search"), "--search would force live mode over cached mode");
  assert.ok(cachedArgs.includes('web_search="cached"'));
});

test("domain normalization and result filtering fail closed", () => {
  assert.equal(normalizeDomain("https://WWW.Example.com/path"), "example.com");
  assert.equal(normalizeDomain("not a domain"), undefined);
  assert.throws(
    () => validateAndFilterPayload(basePayload, { query: "test", includeDomains: ["not a domain"] }),
    /Invalid includeDomains/,
  );

  const result = validateAndFilterPayload(basePayload, {
    query: "test",
    includeDomains: ["example.com"],
    excludeDomains: ["ads.example.net"],
    maxResults: 5,
  });
  assert.deepEqual(result.sources.map((source) => source.url), ["https://docs.example.com/report"]);
  assert.equal(result.filteredSources, 1);
  assert.match(result.limitations.at(-1) ?? "", /removed/);
});

async function createFakeCodex(body: string): Promise<{ dir: string; executable: string }> {
  const dir = await mkdtemp(join(tmpdir(), "fake-codex-"));
  const executable = join(dir, "codex");
  await writeFile(executable, `#!/usr/bin/env node\n${body}\n`, "utf8");
  await chmod(executable, 0o755);
  return { dir, executable };
}

test("runner sends the prompt over stdin and parses schema output", async () => {
  const fake = await createFakeCodex(`
let prompt = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { prompt += chunk; });
process.stdin.on("end", async () => {
  if (!prompt.includes("Untrusted search request JSON")) process.exit(3);
  const outputIndex = process.argv.indexOf("-o");
  const payload = ${JSON.stringify(basePayload)};
  await import("node:fs/promises").then(fs => fs.writeFile(process.argv[outputIndex + 1], JSON.stringify(payload)));
  process.stderr.write("web search: test\\ntokens used\\n1,234\\n");
});`);
  try {
    const result = await runCodexSearch({ query: "test query", maxResults: 1 }, { executable: fake.executable });
    assert.equal(result.answer, "A sourced answer.");
    assert.equal(result.sources.length, 1);
    assert.equal(result.meta.tokensUsed, 1234);
    assert.equal(result.meta.searchEvents, 1);
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});

test("runner terminates an aborted Codex subprocess", async () => {
  const fake = await createFakeCodex(`process.stdin.resume(); setTimeout(() => {}, 30_000);`);
  const controller = new AbortController();
  const started = Date.now();
  setTimeout(() => controller.abort(), 50);
  try {
    await assert.rejects(
      runCodexSearch({ query: "cancel me" }, { executable: fake.executable, signal: controller.signal }),
      /cancelled/,
    );
    assert.ok(Date.now() - started < 3_000);
  } finally {
    await rm(fake.dir, { recursive: true, force: true });
  }
});
