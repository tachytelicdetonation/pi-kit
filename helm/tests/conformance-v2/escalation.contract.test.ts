import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { RealDataSource } from "../../src/data/real.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type { Escalation } from "../../src/state/types.js";
import { fakeTui, flush, makePersistentSource, stripAnsi, theme256, withTempProject } from "./helpers.js";

function decisionEscalation(id: string, signature = "workflow:export-conflict:pkg-api"): Escalation {
  return {
    id,
    source: { kind: "workflow", label: "goal › api" },
    question: "How should the export conflict be resolved?",
    verb: "decide",
    blockedSinceMs: 1,
    problem: "The package export map conflicts with the migration.",
    evidence: ["old: cjs", "new: esm"],
    options: [
      { text: "keep a conditional export", recommended: true },
      { text: "remove commonjs" },
    ],
    blockedMinutes: 3,
    idleNote: "one worktree idle",
    signature,
    precedentPhrase: "conditional exports for migrations",
    followUps: [],
  };
}

test("Escalation contract row: ? appends a persisted follow-up and leaves the card active", async () => {
  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({ ...repository.load(), escalations: [decisionEscalation("esc-follow-up")] });
    const deps = makePersistentSource(root, { deps: { repository } }).deps;
    const source = new RealDataSource(deps);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);
    app.handleInput("\r");
    app.handleInput("?");
    for (const ch of "Can this remain backwards compatible?") app.handleInput(ch);
    app.handleInput("\r");
    await flush();

    assert.match(stripAnsi(app.render(120)[0] ?? ""), /needs you/);
    assert.equal(source.getEscalation("esc-follow-up")?.followUps?.at(-1)?.question, "Can this remain backwards compatible?");
    const relaunched = new RealDataSource(deps);
    assert.equal(relaunched.getEscalation("esc-follow-up")?.followUps?.at(-1)?.question, "Can this remain backwards compatible?");
  });
});

test("Escalation contract row: requiresConfirm asks y/n and n cancels without deciding", async () => {
  await withTempProject(async (root) => {
    const escalation = decisionEscalation("esc-confirm");
    escalation.options[0] = { ...escalation.options[0], requiresConfirm: true };
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({ ...repository.load(), escalations: [escalation] });
    const source = new RealDataSource(makePersistentSource(root, { deps: { repository } }).deps);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);
    app.handleInput("\r");
    app.handleInput("1");
    assert.match(app.render(120).map(stripAnsi).join("\n"), /confirm.*y yes.*n no/i);
    app.handleInput("n");
    await flush();
    assert.ok(source.getEscalation("esc-confirm"), "n keeps the escalation unresolved");
    assert.equal(source.precedents().length, 0);
  });
});

test("Escalation contract row: identical decision conflict auto-resolves and writes a precedent note", async () => {
  await withTempProject(async (root) => {
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({ ...repository.load(), escalations: [decisionEscalation("esc-first")] });
    const source = new RealDataSource(makePersistentSource(root, { deps: { repository } }).deps);
    await source.decide("esc-first", 0);
    source.addEscalation(decisionEscalation("esc-repeat"));
    assert.equal(source.getEscalation("esc-repeat"), undefined);
    assert.ok(
      source.snapshot().journal.some((event) => /precedent/i.test(event.label) && /conditional/i.test(event.label)),
      "the autonomous resolution is explicitly auditable",
    );
  });
});

test("Escalation contract row: permission-class escalation never auto-resolves from stored precedent", async () => {
  await withTempProject(async (root) => {
    const permission = decisionEscalation("esc-permission", "permission:publish-release:prod");
    permission.question = "May Helm publish the production release?";
    const repository = createHelmRepository(root, `${root}/state.json`);
    repository.save({
      ...repository.load(),
      precedents: [{
        id: "permission-precedent",
        signature: permission.signature,
        question: permission.question,
        decision: "publish",
        rationale: "a previous approval",
      }],
    });
    const source = new RealDataSource(makePersistentSource(root, { deps: { repository } }).deps);
    source.addEscalation(permission);
    assert.ok(source.getEscalation(permission.id), "permission remains in needs-you");
    assert.equal(source.getEscalation(permission.id)?.resolved, false);
  });
});
