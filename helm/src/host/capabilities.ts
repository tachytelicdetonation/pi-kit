/**
 * capabilities — probed ONCE per session, so helm degrades gracefully instead of
 * crashing when a backend host is absent.
 *
 * The merged extension registers everything unconditionally (registration never
 * throws on stock pi); at runtime a missing capability makes the corresponding lane
 * family render "unavailable: host lacks X" rather than a crash or a hidden feature.
 *
 * `exec` is injected so the probe is testable without spawning binaries. Each binary
 * is probed at most once; the result is memoized for the session (reset on shutdown).
 */

export interface Capabilities {
  /** The cmux binary is runnable (needed for claude-cmux fleets + the native harness). */
  cmux: boolean;
  /** The codex CLI is runnable (needed for codex-search). */
  codex: boolean;
  /** The pi host exposes workflow capabilities (needed for dynamic-workflows). */
  workflowHost: boolean;
}

export interface CapabilityDeps {
  /** Probe a binary: resolve if runnable, reject/throw if absent. */
  exec: (cmd: string, args?: readonly string[]) => Promise<unknown>;
  /** Whether the pi host advertises workflow capabilities (no subprocess involved). */
  workflowHost?: boolean;
}

let cached: Promise<Capabilities> | undefined;

/** Memoized per session. Repeated calls do NOT re-probe. */
export function probeCapabilities(deps: CapabilityDeps): Promise<Capabilities> {
  if (!cached) cached = doProbe(deps);
  return cached;
}

/** Clear the memo at a session boundary so the next session re-probes. */
export function resetCapabilities(): void {
  cached = undefined;
}

async function doProbe(deps: CapabilityDeps): Promise<Capabilities> {
  const [cmux, codex] = await Promise.all([canRun(deps, "cmux"), canRun(deps, "codex")]);
  return { cmux, codex, workflowHost: deps.workflowHost ?? false };
}

async function canRun(deps: CapabilityDeps, cmd: string): Promise<boolean> {
  try {
    await deps.exec(cmd, ["--version"]);
    return true;
  } catch {
    return false;
  }
}
