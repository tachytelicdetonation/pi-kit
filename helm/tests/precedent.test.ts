import assert from "node:assert/strict";
import test from "node:test";
import { HelmStore } from "../src/state/store.js";
import { autoResolve, buildPrecedent, canonicalProposedPrecedents, matchingPrecedent } from "../src/state/precedents.js";
import { MockDataSource, seedApiRenameEscalation, seedExportMapEscalation, seedState } from "../src/data/mock.js";
import type { Precedent } from "../src/state/types.js";

// ── pure helpers ──────────────────────────────────────────────────────────────

test("buildPrecedent captures question + decision + rationale for the chosen option", () => {
  const esc = seedExportMapEscalation();
  const rec = buildPrecedent(esc, 0); // the recommended option
  assert.equal(rec.signature, esc.signature);
  assert.equal(rec.question, esc.question);
  assert.match(rec.decision, /keep both: conditional exports block/);
  assert.equal(rec.rationale, "accepted pi's recommendation");

  const override = buildPrecedent(esc, 2); // a non-recommended option
  assert.match(override.decision, /pause pkg\/api entirely/);
  assert.equal(override.rationale, "operator override");
});

test("autoResolve flags an escalation whose signature matches a non-declined precedent", () => {
  const esc = seedExportMapEscalation();
  const precedent = buildPrecedent(esc, 0);
  const seen = autoResolve({ ...esc, id: "e-later", precedentNote: undefined, resolved: undefined }, [precedent]);
  assert.equal(seen.resolved, true, "auto-resolved");
  assert.match(seen.precedentNote ?? "", /auto-resolved by precedent/, "flagged with a note");
  assert.match(seen.precedentNote ?? "", /keep both/, "the note quotes the remembered decision");
});

test("autoResolve leaves a non-matching escalation untouched", () => {
  const precedent = buildPrecedent(seedExportMapEscalation(), 0);
  const other = seedApiRenameEscalation(); // a different signature
  const seen = autoResolve(other, [precedent]);
  assert.equal(seen.resolved, undefined, "different signatures do not auto-resolve");
  assert.equal(seen.precedentNote, undefined);
});

test("DECLINED precedents are never auto-applied", () => {
  const esc = seedExportMapEscalation();
  const declined: Precedent = { ...buildPrecedent(esc, 0), declined: true };
  assert.equal(matchingPrecedent(esc.signature, [declined]), undefined, "a declined precedent does not match");
  const seen = autoResolve(esc, [declined]);
  assert.equal(seen.resolved, undefined, "a declined precedent does not auto-resolve");
});

test("canonical proposals never inherit lifecycle from a same-id record with a different signature", () => {
  const durable: Precedent = {
    id: "shared-id",
    signature: "decision:durable",
    question: "Durable question",
    decision: "durable answer",
    rationale: "persisted identity",
    declined: true,
  };
  const mismatched: Precedent = {
    ...durable,
    signature: "decision:observed",
    question: "Observed question",
    decision: "observed answer",
    declined: undefined,
  };
  const unrelated: Precedent = {
    id: "unrelated",
    signature: "decision:unrelated",
    question: "Unrelated question",
    decision: "unrelated answer",
    rationale: "separate identity",
  };

  assert.deepEqual(canonicalProposedPrecedents([mismatched, unrelated], [durable]), [unrelated]);
});

// ── store integration (decide records; a second identical escalation auto-resolves) ──

test("store.decide records a precedent and drops the escalation from the queue", () => {
  const store = new HelmStore(seedState());
  assert.equal(store.getState().precedents.length, 0);
  store.decide("e-export-map", 0);
  const state = store.getState();
  assert.equal(state.precedents.length, 1, "one precedent recorded");
  assert.equal(state.precedents[0].signature, "workflow:export-map-conflict");
  assert.ok(!state.escalations.some((e) => e.id === "e-export-map"), "resolved escalation left the queue");
});

test("a second identical-signature escalation is auto-resolved and flagged", () => {
  const store = new HelmStore(seedState());
  store.decide("e-export-map", 0); // records the precedent
  const seen = store.addEscalation({
    ...seedExportMapEscalation(),
    id: "e-export-map-again",
    resolved: undefined,
    precedentNote: undefined,
  });
  assert.equal(seen.resolved, true, "auto-resolved by the stored precedent");
  assert.match(seen.precedentNote ?? "", /auto-resolved by precedent/);
  // Auto-resolved items never join the blocking queue.
  assert.ok(!store.getState().escalations.some((e) => e.id === "e-export-map-again"));
});

test("a NEW-signature escalation joins the queue normally (not auto-resolved)", () => {
  const store = new HelmStore(seedState());
  store.decide("e-export-map", 0);
  const fresh = { ...seedApiRenameEscalation(), id: "e-fresh", signature: "loop:brand-new" };
  const seen = store.addEscalation(fresh);
  assert.equal(seen.resolved, undefined);
  assert.ok(store.getState().escalations.some((e) => e.id === "e-fresh"), "joined the queue");
});

test("store.decide is a no-op for an unknown id or out-of-range option", () => {
  const store = new HelmStore(seedState());
  store.decide("nope", 0);
  store.decide("e-export-map", 99);
  assert.equal(store.getState().precedents.length, 0, "nothing recorded");
  assert.equal(store.getState().escalations.length, 2, "queue unchanged");
});

test("MockDataSource.decide resolves and surfaces the precedent", async () => {
  const source = new MockDataSource();
  await source.decide("e-export-map", 0);
  assert.equal(source.precedents().length, 1);
  assert.equal(source.getEscalation("e-export-map"), undefined, "removed from the queue");
});

test("MockDataSource refuses decline changes after a precedent is handed off", async () => {
  const source = new MockDataSource();
  source.getCloseout("g-esm");
  await source.execute({ type: "goal.applyPrecedents", goalId: "g-esm" });

  source.declinePrecedent("pc-export-map");
  const precedent = source.precedents().find((item) => item.id === "pc-export-map");
  assert.equal(precedent?.appliesTo, "handoff");
  assert.equal(precedent?.declined, false);
});
