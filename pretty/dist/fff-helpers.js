"use strict";
/**
 * FFF helper functions — extracted for testability.
 *
 * Pure functions and classes used by the FFF integration in index.ts.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CursorStore = void 0;
exports.fffFormatGrepText = fffFormatGrepText;
function sanitizeGrepRecordContent(text) {
    let content = text;
    if (content.endsWith("\r\n"))
        content = content.slice(0, -2);
    else if (content.endsWith("\r") || content.endsWith("\n"))
        content = content.slice(0, -1);
    return content.replace(/\r\n/g, "\\n").replace(/\r/g, "\\r").replace(/\n/g, "\\n");
}
function truncateGrepRecordContent(text) {
    const content = sanitizeGrepRecordContent(text);
    return content.length > 500 ? `${content.slice(0, 500)}...` : content;
}
/**
 * Store for FFF grep pagination cursors.
 * Evicts oldest entry when exceeding maxSize.
 */
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
/**
 * Convert FFF GrepResult items to ripgrep-style "file:line:content" text.
 * This ensures pi-pretty's renderGrepResults works unchanged.
 */
function fffFormatGrepText(items, limit) {
    const capped = items.slice(0, limit);
    if (!capped.length)
        return "No matches found";
    const lines = [];
    let currentFile = "";
    for (const match of capped) {
        if (match.relativePath !== currentFile) {
            if (currentFile)
                lines.push("");
            currentFile = match.relativePath;
        }
        if (match.contextBefore?.length) {
            const startLine = match.lineNumber - match.contextBefore.length;
            for (let i = 0; i < match.contextBefore.length; i++) {
                lines.push(`${match.relativePath}-${startLine + i}-${truncateGrepRecordContent(match.contextBefore[i] ?? "")}`);
            }
        }
        lines.push(`${match.relativePath}:${match.lineNumber}:${truncateGrepRecordContent(match.lineContent)}`);
        if (match.contextAfter?.length) {
            const startLine = match.lineNumber + 1;
            for (let i = 0; i < match.contextAfter.length; i++) {
                lines.push(`${match.relativePath}-${startLine + i}-${truncateGrepRecordContent(match.contextAfter[i] ?? "")}`);
            }
        }
    }
    return lines.join("\n");
}
//# sourceMappingURL=fff-helpers.js.map