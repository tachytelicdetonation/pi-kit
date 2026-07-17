/**
 * FFF helper functions — extracted for testability.
 *
 * Pure functions and classes used by the FFF integration in index.ts.
 */
import type { GrepCursor, GrepMatch } from "@ff-labs/fff-node";
/**
 * Store for FFF grep pagination cursors.
 * Evicts oldest entry when exceeding maxSize.
 */
export declare class CursorStore {
    private cursors;
    private counter;
    private maxSize;
    constructor(maxSize?: number);
    store(cursor: GrepCursor): string;
    get(id: string): GrepCursor | undefined;
    get size(): number;
}
/**
 * Convert FFF GrepResult items to ripgrep-style "file:line:content" text.
 * This ensures pi-pretty's renderGrepResults works unchanged.
 */
export declare function fffFormatGrepText(items: GrepMatch[], limit: number): string;
//# sourceMappingURL=fff-helpers.d.ts.map