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
let cached;
/** Memoized per session. Repeated calls do NOT re-probe. */
export function probeCapabilities(deps) {
    if (!cached)
        cached = doProbe(deps);
    return cached;
}
/** Clear the memo at a session boundary so the next session re-probes. */
export function resetCapabilities() {
    cached = undefined;
}
async function doProbe(deps) {
    const [cmux, codex] = await Promise.all([canRun(deps, "cmux"), canRun(deps, "codex")]);
    return { cmux, codex, workflowHost: deps.workflowHost ?? false };
}
async function canRun(deps, cmd) {
    try {
        await deps.exec(cmd, ["--version"]);
        return true;
    }
    catch {
        return false;
    }
}
