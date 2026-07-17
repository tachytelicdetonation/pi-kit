/**
 * pi-pretty: FFF lifecycle management.
 *
 * Manages the FFF file finder lifecycle: create, wait for scan, destroy.
 * Tools check `isAvailable` and use `finder` directly for search operations.
 * Graceful fallback: if FFF is not installed or fails, tools degrade to SDK.
 */
import type { FileFinder as FffFileFinder, GrepCursor } from "@ff-labs/fff-node";
export declare class CursorStore {
    private cursors;
    private counter;
    private maxSize;
    constructor(maxSize?: number);
    store(cursor: GrepCursor): string;
    get(id: string): GrepCursor | undefined;
    get size(): number;
}
export declare function getSharedFffService(fffModule?: typeof import("@ff-labs/fff-node"), agentDir?: string): FffService;
export declare function resetSharedFffServiceForTests(): void;
export declare class FffService {
    finder: FffFileFinder | null;
    partialIndex: boolean;
    cursorStore: CursorStore;
    private fffModule;
    private dbDir;
    private finderPromise;
    constructor(fffModule?: typeof import("@ff-labs/fff-node"), agentDir?: string);
    configure(fffModule?: typeof import("@ff-labs/fff-node"), agentDir?: string): void;
    /** Returns true if the FFF native module is loaded (installed). */
    isModuleLoaded(): boolean;
    get isAvailable(): boolean;
    /** Attempt to load FFF module dynamically (called during session_start if not injected). */
    tryLoadModule(): Promise<boolean>;
    ensureFinder(cwd: string): Promise<void>;
    private _createFinder;
    private createFinder;
    destroy(): void;
    getFinder(): import("@ff-labs/fff-node").FileFinder | null;
    getCursorStore(): CursorStore;
}
//# sourceMappingURL=fff.d.ts.map