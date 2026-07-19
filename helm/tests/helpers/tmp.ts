import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { withFakeHomeAsync } from "../workflows/helpers/fake-home.js";

const exitCleanup = new Set<string>();
process.once("exit", () => {
  for (const directory of exitCleanup) rmSync(directory, { recursive: true, force: true });
});

export interface TempDirOptions {
  prefix?: string;
  /** Install a second temporary directory as HOME for the callback. */
  fakeHome?: boolean;
  homePrefix?: string;
}

/**
 * Allocate a worker-scoped temporary directory. Prefer withTempDir for one test;
 * this form supports fixtures whose lifetime spans callbacks and cleans at exit.
 */
export function tempDir(prefix = "helm-test-"): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  exitCleanup.add(directory);
  return directory;
}

/** Remove a shared temporary directory early and unregister exit cleanup. */
export function removeTempDir(directory: string): void {
  rmSync(directory, { recursive: true, force: true });
  exitCleanup.delete(directory);
}

/** Create one isolated directory, run the callback, and always remove it. */
export async function withTempDir<T>(
  run: (directory: string) => Promise<T> | T,
  options: TempDirOptions = {},
): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), options.prefix ?? "helm-test-"));
  const home = options.fakeHome
    ? mkdtempSync(join(tmpdir(), options.homePrefix ?? "helm-test-home-"))
    : undefined;
  try {
    return home
      ? await withFakeHomeAsync(home, () => Promise.resolve(run(directory)))
      : await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
    if (home) rmSync(home, { recursive: true, force: true });
  }
}

/** Project-oriented alias with project/home prefixes and optional fake HOME. */
export function withTempProject<T>(
  run: (cwd: string) => Promise<T> | T,
  options: Omit<TempDirOptions, "prefix"> & { prefix?: string } = {},
): Promise<T> {
  return withTempDir(run, {
    prefix: options.prefix ?? "helm-project-",
    fakeHome: options.fakeHome,
    homePrefix: options.homePrefix ?? "helm-project-home-",
  });
}

/** Curried node:test body for suites that need isolated cwd and HOME. */
export function tempProjectTest<T>(
  run: (cwd: string) => Promise<T> | T,
  options: Omit<TempDirOptions, "prefix"> & { prefix?: string } = {},
): () => Promise<T> {
  return () => withTempProject(run, { fakeHome: true, ...options });
}

/** Allocate a directory whose cleanup is owned by the current node:test case. */
export function tempDirForTest(context: TestContext, options: TempDirOptions = {}): string {
  const directory = mkdtempSync(join(tmpdir(), options.prefix ?? "helm-test-"));
  context.after(() => rmSync(directory, { recursive: true, force: true }));
  return directory;
}
