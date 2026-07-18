import assert from "node:assert/strict";
import test from "node:test";
import { runDataSourceContract } from "./datasource-contract.js";

// Non-analyzable specifier so `tsc --noEmit` stays green before src/data/real.ts exists.
const load = (rel: string): Promise<any> => import(rel).catch(() => undefined);
const realModule = await load("../../src/data/real.js");

test("RealDataSource module exists (RED until the composite real source lands)", () => {
  assert.ok(
    realModule?.createTestRealDataSource,
    "helm/src/data/real.ts must export createTestRealDataSource(fakes) — a factory over injected " +
      "manager fakes (usage service, workflow manager, fleet manager) so the contract runs hermetically",
  );
});

if (realModule?.createTestRealDataSource) {
  runDataSourceContract("RealDataSource", () => realModule.createTestRealDataSource(), {
    failingTrialLoopId: "l-contract-fail", // real factory must wire a deterministically-failing trial
    strictLiveSearch: true, // the real source has NO excuse on two-keys auditability
  });
}
