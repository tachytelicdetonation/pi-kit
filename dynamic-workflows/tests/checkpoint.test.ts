import assert from "node:assert/strict";
import test from "node:test";
import type { JournalEntry } from "../src/workflow.js";
import { runWorkflow } from "../src/workflow.js";

const noopAgent = {
  async run() {
    return "ok";
  },
};

test("checkpoint(): headless takes the declared default and journals it", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const ok = await checkpoint('Approve plan?', { default: true })
const name = await checkpoint('Pick a name', { default: 'fallback' })
return { ok, name }`;
  const res = await runWorkflow<{ ok: boolean; name: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(res.result.ok, true);
  assert.equal(res.result.name, "fallback");
  assert.equal(journal.length, 2, "both checkpoints journaled");
});

test("checkpoint(): headless 'abort' throws when no UI is threaded in", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('Approve?', { headless: 'abort' })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false }), /human input|headless/i);
});

test("checkpoint(): uses the threaded confirm when present", async () => {
  let asked = "";
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', { kind: 'confirm' })`;
  const res = await runWorkflow<string>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async (p) => {
      asked = p;
      return "yes";
    },
  });
  assert.equal(res.result, "yes");
  assert.equal(asked, "Proceed?");
});

test("checkpoint(): replays the journaled reply on resume (no re-prompt)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const r = await checkpoint('Approve?', {})
return { r }`;
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "approved",
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.result.r, "approved");

  let calledAgain = false;
  const second = await runWorkflow<{ r: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
    confirm: async () => {
      calledAgain = true;
      return "DIFFERENT";
    },
  });
  assert.equal(second.result.r, "approved", "reply replays from the journal");
  assert.equal(calledAgain, false, "confirm is not called again on resume");
});

test("checkpoint(): counts against maxAgents (no tokens, but bounded)", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
await checkpoint('a', { default: 1 })
await checkpoint('b', { default: 1 })
await checkpoint('c', { default: 1 })
return 1`;
  await assert.rejects(() => runWorkflow(script, { agent: noopAgent, persistLogs: false, maxAgents: 2 }), /limit/i);
});

test("checkpoint(): headless auto-approvals are recorded and marked in the journal", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const a = await checkpoint('Delete the table?', { default: true })
const b = await checkpoint('Pick a name', { default: 'fallback' })
return { a, b }`;
  const res = await runWorkflow<{ a: boolean; b: string }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(res.result.a, true);
  assert.equal(res.autoCheckpoints?.length, 2, "both headless gates recorded");
  assert.equal(res.autoCheckpoints?.[0]?.prompt, "Delete the table?");
  assert.equal(res.autoCheckpoints?.[0]?.reply, true);
  assert.ok(journal.length === 2 && journal.every((e) => e.auto === true), "journal marks them as auto-resolved");
});

test("checkpoint(): human-confirmed gates are not marked auto", async () => {
  const journal: JournalEntry[] = [];
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
return await checkpoint('Proceed?', {})`;
  const res = await runWorkflow<string>(script, {
    agent: noopAgent,
    persistLogs: false,
    confirm: async () => "yes",
    onAgentJournal: (e) => journal.push(e),
  });
  assert.equal(res.result, "yes");
  assert.equal(res.autoCheckpoints, undefined, "nothing auto-resolved");
  assert.equal(journal[0]?.auto, undefined, "a human reply is not marked auto");
});

test("checkpoint(): the auto-approval tally survives a journaled resume", async () => {
  const script = `export const meta = { name: 'c', description: 'checkpoint' }
const a = await checkpoint('First?', { default: true })
const b = await checkpoint('Second?', { default: true })
return { a, b }`;
  const journal = new Map<number, JournalEntry>();
  const first = await runWorkflow<{ a: boolean; b: boolean }>(script, {
    agent: noopAgent,
    persistLogs: false,
    onAgentJournal: (e) => journal.set(e.index, e),
  });
  assert.equal(first.autoCheckpoints?.length, 2);

  const second = await runWorkflow<{ a: boolean; b: boolean }>(script, {
    agent: noopAgent,
    persistLogs: false,
    resumeJournal: journal,
  });
  assert.equal(second.autoCheckpoints?.length, 2, "replayed auto-approvals re-record");
  assert.equal(second.autoCheckpoints?.[1]?.prompt, "Second?");
});
