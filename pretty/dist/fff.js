"use strict";
/**
 * pi-pretty: FFF lifecycle management.
 *
 * Manages the FFF file finder lifecycle: create, wait for scan, destroy.
 * Tools check `isAvailable` and use `finder` directly for search operations.
 * Graceful fallback: if FFF is not installed or fails, tools degrade to SDK.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.FffService = exports.CursorStore = void 0;
exports.getSharedFffService = getSharedFffService;
exports.resetSharedFffServiceForTests = resetSharedFffServiceForTests;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
// ---------------------------------------------------------------------------
// Cursor store — pagination cursors for grep
// ---------------------------------------------------------------------------
class CursorStore {
    cursors = new Map();
    counter = 0;
    maxSize;
    constructor(maxSize = 200) {
        this.maxSize = maxSize;
    }
    store(cursor) {
        const id = `fff_c${++this.counter}`;
        this.cursors.set(id, cursor);
        if (this.cursors.size > this.maxSize) {
            const first = this.cursors.keys().next().value;
            if (first)
                this.cursors.delete(first);
        }
        return id;
    }
    get(id) {
        return this.cursors.get(id);
    }
    get size() {
        return this.cursors.size;
    }
}
exports.CursorStore = CursorStore;
// ---------------------------------------------------------------------------
// FffService — wraps a single FileFinder instance
// ---------------------------------------------------------------------------
const SHARED_FFF_SERVICE_KEY = Symbol.for("pi-pretty.fff-service");
function getSharedFffService(fffModule, agentDir) {
    const sharedGlobal = globalThis;
    const existing = sharedGlobal[SHARED_FFF_SERVICE_KEY];
    if (existing) {
        existing.service.configure(fffModule, agentDir);
        return existing.service;
    }
    const service = new FffService(fffModule, agentDir);
    sharedGlobal[SHARED_FFF_SERVICE_KEY] = { service };
    return service;
}
function resetSharedFffServiceForTests() {
    const sharedGlobal = globalThis;
    sharedGlobal[SHARED_FFF_SERVICE_KEY]?.service.destroy();
    delete sharedGlobal[SHARED_FFF_SERVICE_KEY];
}
class FffService {
    finder = null;
    partialIndex = false;
    cursorStore = new CursorStore();
    fffModule = null;
    dbDir = null;
    finderPromise = null;
    constructor(fffModule, agentDir) {
        this.configure(fffModule, agentDir);
    }
    configure(fffModule, agentDir) {
        if (fffModule)
            this.fffModule = fffModule;
        if (agentDir) {
            this.dbDir = (0, node_path_1.join)(agentDir, "pi-pretty", "fff");
            try {
                (0, node_fs_1.mkdirSync)(this.dbDir, { recursive: true });
            }
            catch {
                // FFF can still run without persistent frecency/history paths.
            }
        }
    }
    /** Returns true if the FFF native module is loaded (installed). */
    isModuleLoaded() {
        return this.fffModule !== null;
    }
    get isAvailable() {
        return this.finder !== null && !this.finder.isDestroyed;
    }
    /** Attempt to load FFF module dynamically (called during session_start if not injected). */
    async tryLoadModule() {
        if (this.fffModule)
            return true;
        try {
            const mod = await import("@ff-labs/fff-node");
            this.fffModule = mod;
            if (!this.dbDir && process.env.HOME) {
                this.dbDir = (0, node_path_1.join)(process.env.HOME, ".pi/agent", "pi-pretty", "fff");
                try {
                    (0, node_fs_1.mkdirSync)(this.dbDir, { recursive: true });
                }
                catch {
                    /* ignore */
                }
            }
            return true;
        }
        catch {
            return false;
        }
    }
    async ensureFinder(cwd) {
        if (this.finder && !this.finder.isDestroyed)
            return;
        if (this.finderPromise)
            return this.finderPromise;
        const promise = this._createFinder(cwd);
        this.finderPromise = promise;
        try {
            await promise;
        }
        finally {
            if (this.finderPromise === promise)
                this.finderPromise = null;
        }
    }
    async _createFinder(cwd) {
        if (!this.fffModule)
            return;
        if (this.finder && !this.finder.isDestroyed) {
            this.finder.destroy();
            this.finder = null;
        }
        const result = this.createFinder(cwd, this.dbDir);
        if (!result.ok) {
            throw new Error(`FFF init failed: ${result.error}`);
        }
        this.finder = result.value;
        const scan = await this.finder.waitForScan(15_000);
        this.partialIndex = scan.ok && !scan.value;
    }
    createFinder(cwd, dbDir) {
        if (!this.fffModule)
            throw new Error("FFF module is not loaded");
        const result = this.fffModule.FileFinder.create({
            basePath: cwd,
            frecencyDbPath: dbDir ? (0, node_path_1.join)(dbDir, "frecency.mdb") : "",
            historyDbPath: dbDir ? (0, node_path_1.join)(dbDir, "history.mdb") : "",
            aiMode: true,
        });
        if (result.ok || !isAlreadyOpenError(result.error) || !dbDir)
            return result;
        const isolatedDir = (0, node_path_1.join)(dbDir, `runtime-${process.pid}-${Date.now()}`);
        try {
            (0, node_fs_1.mkdirSync)(isolatedDir, { recursive: true });
        }
        catch {
            return result;
        }
        return this.fffModule.FileFinder.create({
            basePath: cwd,
            frecencyDbPath: (0, node_path_1.join)(isolatedDir, "frecency.mdb"),
            historyDbPath: (0, node_path_1.join)(isolatedDir, "history.mdb"),
            aiMode: true,
        });
    }
    destroy() {
        if (this.finder && !this.finder.isDestroyed) {
            this.finder.destroy();
            this.finder = null;
        }
        this.partialIndex = false;
        this.finderPromise = null;
    }
    getFinder() {
        return this.finder;
    }
    getCursorStore() {
        return this.cursorStore;
    }
}
exports.FffService = FffService;
function isAlreadyOpenError(error) {
    return /environment already open/i.test(error);
}
//# sourceMappingURL=fff.js.map