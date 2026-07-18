/**
 * Workflow run state persistence for pause/resume support.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./workflow-paths.js";
export function createRunPersistence(cwd, fsOverride) {
    const _existsSync = fsOverride?.existsSync ?? existsSync;
    const _mkdirSync = fsOverride?.mkdirSync ?? mkdirSync;
    const _readdirSync = fsOverride?.readdirSync ?? readdirSync;
    const _readFileSync = fsOverride?.readFileSync ?? readFileSync;
    const _renameSync = fsOverride?.renameSync ?? renameSync;
    const _unlinkSync = fsOverride?.unlinkSync ?? unlinkSync;
    const _writeFileSync = fsOverride?.writeFileSync ?? writeFileSync;
    const paths = workflowProjectPaths(cwd);
    const runsDir = paths.runsDir;
    const legacyRunsDir = paths.legacyRunsDir;
    const ensureDir = () => {
        if (!_existsSync(runsDir)) {
            _mkdirSync(runsDir, { recursive: true });
        }
    };
    const runPath = (dir, runId) => join(dir, `${runId}.json`);
    const primaryRunPath = (runId) => runPath(runsDir, runId);
    const legacyRunPath = (runId) => runPath(legacyRunsDir, runId);
    const lockPath = (dir, runId) => join(dir, `${runId}.lock`);
    const primaryLockPath = (runId) => lockPath(runsDir, runId);
    const legacyLockPath = (runId) => lockPath(legacyRunsDir, runId);
    const candidateRunPaths = (runId) => [primaryRunPath(runId), legacyRunPath(runId)];
    const pidIsAlive = (pid) => {
        if (!Number.isInteger(pid) || pid <= 0)
            return false;
        try {
            process.kill(pid, 0);
            return true;
        }
        catch (err) {
            if (err.code === "EPERM")
                return true;
            return false;
        }
    };
    const readLockAt = (path) => {
        try {
            return JSON.parse(_readFileSync(path, "utf-8"));
        }
        catch {
            return null;
        }
    };
    const readLock = (runId) => readLockAt(primaryLockPath(runId));
    const removeStaleLegacyLock = (runId) => {
        const lock = legacyLockPath(runId);
        const existing = readLockAt(lock);
        if (existing?.runId === runId && pidIsAlive(existing.pid))
            return false;
        try {
            if (_existsSync(lock))
                _unlinkSync(lock);
        }
        catch {
            return false;
        }
        return true;
    };
    return {
        save(state) {
            ensureDir();
            state.updatedAt = new Date().toISOString();
            const path = primaryRunPath(state.runId);
            const json = JSON.stringify(state, null, 2);
            // Atomic write: a crash mid-write can't corrupt the live file (tmp+rename is
            // atomic on the same filesystem). A .bak from the previous good save is the
            // recovery fallback if the primary is somehow truncated.
            _writeFileSync(`${path}.tmp`, json);
            _renameSync(`${path}.tmp`, path);
            try {
                _writeFileSync(`${path}.bak`, json);
            }
            catch {
                // backup is best-effort; the primary write already succeeded
            }
        },
        load(runId) {
            // Try the primary, then the .bak — so a corrupt primary doesn't lose the run.
            for (const path of candidateRunPaths(runId)) {
                for (const candidate of [path, `${path}.bak`]) {
                    try {
                        if (!_existsSync(candidate))
                            continue;
                        return JSON.parse(_readFileSync(candidate, "utf-8"));
                    }
                    catch {
                        // corrupt candidate -> fall through to the next candidate
                    }
                }
            }
            return null;
        },
        list() {
            const byRunId = new Map();
            for (const dir of [runsDir, legacyRunsDir]) {
                try {
                    if (!_existsSync(dir))
                        continue;
                    const files = _readdirSync(dir).filter((f) => f.endsWith(".json"));
                    for (const file of files) {
                        try {
                            const state = JSON.parse(_readFileSync(join(dir, file), "utf-8"));
                            if (!byRunId.has(state.runId))
                                byRunId.set(state.runId, state);
                        }
                        catch {
                            // Skip corrupted files
                        }
                    }
                }
                catch {
                    // Skip unreadable directories; another storage location may still work.
                }
            }
            return [...byRunId.values()].sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
        },
        delete(runId) {
            let deleted = false;
            try {
                for (const path of candidateRunPaths(runId)) {
                    const dir = path === primaryRunPath(runId) ? runsDir : legacyRunsDir;
                    // Best-effort cleanup of the sidecar files alongside the primary.
                    for (const sidecar of [`${path}.bak`, `${path}.tmp`, lockPath(dir, runId)]) {
                        try {
                            if (_existsSync(sidecar))
                                _unlinkSync(sidecar);
                        }
                        catch {
                            // ignore sidecar cleanup failures
                        }
                    }
                    try {
                        if (_existsSync(path)) {
                            _unlinkSync(path);
                            deleted = true;
                        }
                    }
                    catch {
                        // ignore per-file cleanup failures
                    }
                }
                return deleted;
            }
            catch {
                return deleted;
            }
        },
        acquireRunLease(runId) {
            ensureDir();
            const path = primaryRunPath(runId);
            const lock = primaryLockPath(runId);
            if (!removeStaleLegacyLock(runId))
                return null;
            for (let attempt = 0; attempt < 2; attempt++) {
                const token = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
                const payload = {
                    runId,
                    runPath: path,
                    pid: process.pid,
                    startedAt: new Date().toISOString(),
                    token,
                };
                try {
                    _writeFileSync(lock, JSON.stringify(payload, null, 2), { flag: "wx" });
                    return { runId, token };
                }
                catch (err) {
                    const code = err.code;
                    if (code !== "EEXIST")
                        throw err;
                    const existing = readLock(runId);
                    if (existing && existing.runPath === path && pidIsAlive(existing.pid)) {
                        return null;
                    }
                    try {
                        _unlinkSync(lock);
                    }
                    catch {
                        return null;
                    }
                }
            }
            return null;
        },
        releaseRunLease(lease) {
            try {
                const existing = readLock(lease.runId);
                if (existing?.token === lease.token)
                    _unlinkSync(primaryLockPath(lease.runId));
            }
            catch {
                // Best-effort cleanup only.
            }
        },
        getRunsDir() {
            return runsDir;
        },
    };
}
/**
 * Generate a unique run ID.
 */
export function generateRunId() {
    const timestamp = Date.now().toString(36);
    const random = Math.random().toString(36).slice(2, 8);
    return `${timestamp}-${random}`;
}
