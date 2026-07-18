import { MockDataSource } from "../../src/data/mock.js";
import { runDataSourceContract } from "./datasource-contract.js";

// GREEN-NOW: MockDataSource is the reference implementation the contract was derived from.
runDataSourceContract("MockDataSource", () => new MockDataSource(), {
  failingTrialLoopId: "l-contract-fail",
  // search() indexes live (decided) precedents, so a freshly-recorded decision is
  // auditable within two keys (design README:89). Finding 2 — resolved.
  strictLiveSearch: true,
});
