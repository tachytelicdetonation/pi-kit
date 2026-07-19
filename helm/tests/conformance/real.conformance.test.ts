import { runDataSourceContract } from "./datasource-contract.js";

// Non-analyzable specifier so `tsc --noEmit` stays green before src/data/real.ts exists.
const load = (rel: string): Promise<any> => import(rel).catch(() => undefined);
const realModule = await load("../../src/data/real.js");

if (realModule?.createTestRealDataSource) {
  runDataSourceContract("RealDataSource", () => realModule.createTestRealDataSource(), {
    failingTrialLoopId: "l-contract-fail", // real factory must wire a deterministically-failing trial
    strictLiveSearch: true, // the real source has NO excuse on two-keys auditability
  });
}
