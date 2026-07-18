import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { MockDataSource } from "../../src/data/mock.js";
import { usagePopoverLines } from "../../src/screens/popover.js";
import { fakeTui, flush, makePersistentSource, stripLines, theme256, withTempProject } from "./helpers.js";

test("Search row: archived goals, decisions, loop runs, and PR events are all findable", () => {
  const source = new MockDataSource();
  assert.ok(source.search("auth v2").some((result) => result.kind === "goal" && /archived/.test(result.sublabel ?? "")));
  assert.ok(source.search("4312").some((result) => result.kind === "decision"));
  assert.ok(source.search("run #88").some((result) => result.kind === "loopRun"));
  assert.ok(source.search("4301").some((result) => result.kind === "pr"));
});

test("Search row: an autonomous action is auditable with / then enter", () => {
  class RecentAuditSource extends MockDataSource {
    override search(query: string) {
      if (!query) return [{ kind: "loopRun" as const, label: "autonomous cleanup run", sublabel: "completed safely" }];
      return super.search(query);
    }
  }
  const app = new HelmApp(fakeTui(), theme256, () => {}, new RecentAuditSource());
  app.handleInput("/");
  app.handleInput("\r");
  assert.match(stripLines(app.render(120))[0] ?? "", /loopRun · autonomous cleanup run/);
});

test("Popover row: real today/week spend and per-goal costs render without seed placeholders", async () => {
  await withTempProject(async (root) => {
    const usage = {
      providers: [
        { id: "codex" as const, remaining: 47, resetText: "resets tomorrow" },
        { id: "claude" as const, remaining: 82, resetText: "resets friday" },
        { id: "kimi" as const, remaining: 100, resetText: "resets monday" },
      ],
      spendToday: "$12.34",
      spendWeek: "$56.78",
      perGoal: [
        { name: "goal alpha", cost: "$7.01" },
        { name: "goal beta", cost: "$5.33" },
      ],
    };
    const { source } = makePersistentSource(root, { usage });
    const rendered = stripLines(usagePopoverLines(source.getUsageDetail(), theme256, 120)).join("\n");
    assert.match(rendered, /today \$12\.34 · week \$56\.78/);
    assert.match(rendered, /goal alpha\s+\$7\.01/);
    assert.match(rendered, /goal beta\s+\$5\.33/);
  });
});

test("Intake row: vague intent derives only un-inferable questions and no workflow starts before g", async () => {
  await withTempProject(async (root) => {
    const { source, spies } = makePersistentSource(root);
    const app = new HelmApp(fakeTui(), theme256, () => {}, source);
    for (const ch of "improve it") app.handleInput(ch);
    app.handleInput("\r");
    await flush();
    const created = source.getIntake("goal-improve-it");
    assert.ok(created);
    assert.equal(created.openQuestions, true);
    assert.ok(created.questions.length > 0);
    assert.equal(spies.started.length, 0);
    app.handleInput("g");
    await flush();
    assert.equal(spies.started.length, 0, "g remains disabled while questions are open");
  });
});

test("Intake row: answering clarification re-derives the structured plan before launch", async () => {
  await withTempProject(async (root) => {
    const { source, spies } = makePersistentSource(root);
    const created = await source.execute({ type: "goal.createDraft", prompt: "improve it", draftId: "goal-rederive" });
    const before = structuredClone(source.getIntake(created.id!)?.planWorkflows);
    const answered = await source.execute({
      type: "goal.answer",
      draftId: created.id!,
      text: "Improve API latency below 100ms for authenticated reads; do not change writes.",
    });
    assert.equal(answered.ok, true);
    const after = source.getIntake(created.id!);
    assert.equal(after?.openQuestions, false);
    assert.notDeepEqual(after?.planWorkflows, before);
    assert.ok(after?.planWorkflows.length);
    assert.equal(spies.started.length, 0, "answering still spawns zero workflows");
  });
});
