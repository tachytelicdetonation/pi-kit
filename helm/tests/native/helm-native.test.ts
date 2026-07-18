/**
 * NATIVE GOLDEN HARNESS: drives the REAL pi inside a REAL cmux surface end-to-end.
 *
 * Opt-in only: `HELM_NATIVE=1 npx tsx --test tests/native/helm-native.test.ts`.
 * Auto-skips inside the hermetic `npm test` (env unset) or when cmux / pi are absent,
 * so it NEVER runs in CI. `cmux read-screen` returns PLAIN TEXT (ANSI stripped):
 * assert LAYOUT / text (header at top, no leftover pi footer, q exits), never color —
 * color fidelity is already covered by the render-layer unit tests.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const HELM_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const CMUX =
  [process.env.CMUX_BIN, "/Applications/cmux.app/Contents/Resources/bin/cmux"]
    .filter((p): p is string => !!p)
    .find((p) => existsSync(p)) ?? null;

async function hasPi(): Promise<boolean> {
  try {
    await run("pi", ["--version"], { timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

const optIn = process.env.HELM_NATIVE === "1";
// Short-circuit keeps `pi --version` from spawning during the hermetic suite.
const enabled = optIn && CMUX !== null && (await hasPi());
const skipReason = !optIn
  ? "opt-in: set HELM_NATIVE=1"
  : CMUX === null
    ? "cmux binary not found"
    : "pi not on PATH";

const cmux = async (...args: string[]) => (await run(CMUX!, args, { timeout: 15_000 })).stdout;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Poll read-screen until two consecutive non-empty frames are identical (render settled). */
async function stableScreen(surface: string, timeoutMs = 30_000): Promise<string> {
  let prev = "";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = await cmux("read-screen", "--surface", surface);
    if (frame.trim() && frame === prev) return frame;
    prev = frame;
    await sleep(400);
  }
  throw new Error(`screen never settled; last frame:\n${prev}`);
}

async function waitFor(surface: string, pattern: RegExp, timeoutMs = 45_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let frame = "";
  while (Date.now() < deadline) {
    frame = await cmux("read-screen", "--surface", surface);
    if (pattern.test(frame)) return frame;
    await sleep(500);
  }
  throw new Error(`timed out waiting for ${pattern}; last frame:\n${frame}`);
}

/** Find the first terminal surface id of a workspace via `cmux tree --json`. */
function findSurfaceId(node: unknown): string | undefined {
  if (node == null || typeof node !== "object") return undefined;
  const o = node as Record<string, unknown>;
  if (
    (o.type === "surface" || o.kind === "surface" || "surfaceId" in o) &&
    typeof (o.id ?? o.surfaceId) === "string"
  ) {
    return (o.id ?? o.surfaceId) as string;
  }
  for (const value of Object.values(o)) {
    if (Array.isArray(value)) {
      for (const child of value) {
        const hit = findSurfaceId(child);
        if (hit) return hit;
      }
    } else if (typeof value === "object") {
      const hit = findSurfaceId(value);
      if (hit) return hit;
    }
  }
  return undefined;
}

test(
  "native: /helm takes over the whole viewport and q returns to the pi REPL",
  { skip: enabled ? false : skipReason, timeout: 180_000 },
  async () => {
    const created = await cmux(
      "new-workspace", "--cwd", HELM_DIR, "--command", "pi",
      "--focus", "false", "--name", "helm-native-test", "--id-format", "uuids",
    );
    const ws =
      created.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i)?.[0] ??
      created.match(/workspace:\d+/)?.[0];
    assert.ok(ws, `could not parse workspace id from:\n${created}`);

    try {
      const tree = JSON.parse(await cmux("tree", "--workspace", ws!, "--json", "--id-format", "uuids"));
      const surface = findSurfaceId(tree);
      assert.ok(surface, `no surface found in cmux tree for ${ws}`);

      // Wait for the pi prompt, then open helm.
      await waitFor(surface!, /❯/);
      await cmux("send", "--surface", surface!, "--", "/helm");
      await cmux("send-key", "--surface", surface!, "enter");

      // Settle, then assert the takeover (LAYOUT/TEXT only — read-screen strips ANSI).
      const frame = await stableScreen(surface!);
      const lines = frame.replace(/\n+$/, "").split("\n");
      const top = lines.find((l) => l.trim().length > 0) ?? "";
      assert.match(top, /^\s*pi · /, "helm header row is the TOP line (design: 'Header row: pi · <context>')");

      const body = lines.map((l) => l.trim());
      assert.ok(body.some((l) => l.includes("needs you")), "6b stratum 1 present (needs you)");
      assert.ok(body.some((l) => l.includes("loops")), "6b stratum 3 present (loops)");

      const bottom = [...lines].reverse().find((l) => l.trim().length > 0) ?? "";
      assert.ok(
        /burn/.test(bottom) && /today/.test(bottom),
        `bottom line must be helm's FLEET footer (burn + $ today), not pi's built-in footer; got: ${bottom}`,
      );

      // q exits back to the REPL — and the USAGE footer (not helm's, not blank) is restored.
      await cmux("send-key", "--surface", surface!, "q");
      const after = await waitFor(surface!, /❯/);
      assert.ok(!/needs you/.test(after), "helm's mission-control is gone after q");
      // RED until FooterController lands: the restored footer is the usage stacked bar (▮ cells),
      // not pi's built-in footer (regression guard on the exit path).
      assert.ok(after.includes("▮"), "after exit the USAGE footer's stacked bar must be on screen");
    } finally {
      await cmux("close-workspace", "--workspace", ws!).catch(() => {});
    }
  },
);
