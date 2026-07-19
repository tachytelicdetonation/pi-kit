import assert from "node:assert/strict";
import test from "node:test";
import { HelmApp } from "../../src/app.js";
import { createHelmRepository } from "../../src/state/persistence.js";
import type { AuditRecord, JournalEvent } from "../../src/state/types.js";
import { fakeTui, makePersistentSource, stripLines, theme256, withTempProject } from "../conformance-v2/helpers.js";

type AuditSearchCase = {
  name: string;
  query: string;
  searchText: string;
  detailText: string;
  journal?: JournalEvent;
  audit?: AuditRecord;
};

const cases: AuditSearchCase[] = [
  {
    name: "merged work",
    query: "merge-receipt-alpha",
    searchText: "merge-receipt-alpha",
    detailText: "merged",
    journal: { id: "j-merge", kind: "merged", timestampMs: 1_700_000_000_001, label: "merge-receipt-alpha landed cleanly" },
  },
  {
    name: "PR opened",
    query: "pr-receipt-bravo",
    searchText: "pr-receipt-bravo",
    detailText: "prOpened",
    journal: { id: "j-pr", kind: "prOpened", timestampMs: 1_700_000_000_002, label: "pr-receipt-bravo opened as #42" },
  },
  {
    name: "loop firing success",
    query: "loop-success-charlie",
    searchText: "loop-success-charlie",
    detailText: "next deadline was armed",
    audit: {
      id: "a-loop-success",
      kind: "runCompleted",
      targetIds: ["loop-charlie", "run-charlie"],
      at: 1_700_000_000_003,
      summary: "loop-success-charlie completed",
      detail: "Scheduled run completed and its next deadline was armed.",
    },
  },
  {
    name: "loop firing failure",
    query: "loop-failure-delta",
    searchText: "loop-failure-delta",
    detailText: "will not auto-retry",
    audit: {
      id: "a-loop-failure",
      kind: "selfCaughtPause",
      targetIds: ["loop-delta", "run-delta"],
      at: 1_700_000_000_004,
      summary: "loop-failure-delta failed and paused",
      detail: "The loop will not auto-retry; operator review is required.",
    },
  },
  {
    name: "auto-resolved escalation via precedent",
    query: "precedent-echo-autoresolve",
    searchText: "precedent-echo-autoresolve",
    detailText: "Applied stored precedent p-echo",
    audit: {
      id: "a-auto-resolve",
      kind: "autoResolve",
      targetIds: ["e-echo", "p-echo"],
      at: 1_700_000_000_005,
      summary: "precedent-echo-autoresolve resolved without interruption",
      detail: "Applied stored precedent p-echo.",
    },
  },
  {
    name: "self-caught pause",
    query: "self-caught-foxtrot",
    searchText: "self-caught-foxtrot",
    detailText: "operator review is required",
    audit: {
      id: "a-self-caught",
      kind: "selfCaughtPause",
      targetIds: ["loop-foxtrot"],
      at: 1_700_000_000_006,
      summary: "self-caught-foxtrot paused before retry",
      detail: "Unsafe retry was suppressed; operator review is required.",
    },
  },
];

for (const scenario of cases) {
  test(`H4: / search reaches persisted ${scenario.name} detail`, async () => {
    await withTempProject(async (root) => {
      const statePath = `${root}/.helm-test/state.json`;
      const repository = createHelmRepository(root, statePath);
      const domain = repository.load();
      repository.save({
        ...domain,
        journal: scenario.journal ? [scenario.journal] : [],
        audit: scenario.audit ? [scenario.audit] : [],
      });
      const { source } = makePersistentSource(root, { deps: { repository } });
      const app = new HelmApp(fakeTui(32, 140), theme256, () => {}, source);

      app.handleInput("/");
      for (const character of scenario.query) app.handleInput(character);
      const search = stripLines(app.render(140)).join("\n");
      assert.match(search, new RegExp(scenario.searchText, "i"), "the persisted event is findable from global search");

      app.handleInput("\r");
      const detail = stripLines(app.render(140)).join("\n");
      assert.match(detail, new RegExp(scenario.detailText, "i"), "enter reaches the event's durable detail view");
      app.dispose();
    });
  });
}
