import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { normalizeOracleFixture, ORACLE_FIXTURE_SCHEMA_VERSION } from "../../src/compat/oracle-fixtures.js";

const CONTRACT_IDS = [
  "INV-01",
  "INV-02",
  "TRG-01",
  "TRG-02",
  "EFF-01",
  "EFF-02",
  "APP-01",
  "APP-02",
  "APP-03",
  "AGT-01",
  "AGT-02",
  "RUN-01",
  "RUN-02",
  "RUN-03",
  "RUN-04",
  "RES-01",
  "RES-02",
  "RES-03",
  "RES-04",
  "SAV-01",
  "SAV-02",
  "UI-01",
  "UI-02",
  "DRS-01",
  "DRS-02",
  "DIS-01",
] as const;

interface ManifestContract {
  id: string;
  oracleVersion: string;
  provenance: string[];
}

interface Manifest {
  fixtureVersion: number;
  oracleVersion: string;
  cleanRoom: boolean;
  contracts: ManifestContract[];
}

async function loadManifest(): Promise<Manifest> {
  const path = join(process.cwd(), "tests", "compat", "fixtures", "2.1.212", "manifest.json");
  return JSON.parse(await readFile(path, "utf8")) as Manifest;
}

test("oracle manifest pins every contract ID to a version and provenance", async () => {
  const manifest = await loadManifest();
  assert.equal(manifest.fixtureVersion, ORACLE_FIXTURE_SCHEMA_VERSION);
  assert.equal(manifest.oracleVersion, "2.1.212");
  assert.equal(manifest.cleanRoom, true);
  assert.deepEqual(
    manifest.contracts.map(({ id }) => id),
    [...CONTRACT_IDS],
  );

  for (const fixture of manifest.contracts) {
    assert.equal(fixture.oracleVersion, manifest.oracleVersion, `${fixture.id} has a mismatched oracle version`);
    assert.ok(fixture.provenance.length > 0, `${fixture.id} has no provenance`);
    for (const label of fixture.provenance) {
      assert.match(label, /^(official-doc|black-box|Pi-specific)$/);
    }
  }
});

test("captures differing only in volatile IDs, times, paths, and usage normalize identically", () => {
  const first = {
    fixtureVersion: 1,
    oracleVersion: "2.1.212",
    provenance: "black-box",
    runId: "run-29f73488",
    timestamp: "2026-07-16T09:31:22.123Z",
    cwd: "/Users/alice/secret-project",
    totalTokens: 123_456,
    cost: 4.25,
    transitions: [
      { agentId: "agent-aaaaaaaa", status: "running", startedAt: 1_752_658_282_000 },
      { agentId: "agent-aaaaaaaa", status: "completed", endedAt: 1_752_658_300_000 },
    ],
    error: "run-29f73488 failed in /Users/alice/secret-project at 2026-07-16T09:31:22.123Z",
  };
  const second = {
    fixtureVersion: 1,
    oracleVersion: "2.1.212",
    provenance: "black-box",
    runId: "run-9911bbbb",
    timestamp: "2027-08-20T11:01:02.999Z",
    cwd: "/home/bob/another-project",
    totalTokens: 999,
    cost: 0.01,
    transitions: [
      { agentId: "agent-bbbbbbbb", status: "running", startedAt: 99 },
      { agentId: "agent-bbbbbbbb", status: "completed", endedAt: 101 },
    ],
    error: "run-9911bbbb failed in /home/bob/another-project at 2027-08-20T11:01:02.999Z",
  };

  assert.deepEqual(normalizeOracleFixture(first), normalizeOracleFixture(second));
});
