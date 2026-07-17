"use strict";
/**
 * pi-pretty: FFF-backed @-mention autocomplete provider.
 *
 * Wraps the built-in autocomplete provider and replaces the @-mention file
 * suggestions with FFF frecency-ranked file search results.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.createFffAutocompleteProvider = createFffAutocompleteProvider;
/** How many @-mention suggestions to show at most. */
const MAX_SUGGESTIONS = 20;
/**
 * Extract the query after a `@` character before the cursor.
 * Returns the query string (empty string if bare `@`), or undefined if no `@` trigger.
 */
function extractAtPrefix(textBeforeCursor) {
    const match = textBeforeCursor.match(/(?:^|[ \t])@([^\s@]*)$/);
    return match?.[1];
}
function createFffAutocompleteProvider(current, getFinder) {
    return {
        async getSuggestions(lines, cursorLine, cursorCol, options) {
            const currentLine = lines[cursorLine] ?? "";
            const textBeforeCursor = currentLine.slice(0, cursorCol);
            const query = extractAtPrefix(textBeforeCursor);
            // Not an @-mention — delegate
            if (query === undefined) {
                return current.getSuggestions(lines, cursorLine, cursorCol, options);
            }
            const finder = getFinder();
            if (!finder) {
                // FFF not available — delegate to built-in
                return current.getSuggestions(lines, cursorLine, cursorCol, options);
            }
            try {
                const result = finder.fileSearch(query, {
                    pageSize: MAX_SUGGESTIONS,
                });
                if (result.ok) {
                    const items = result.value.items.map((item) => ({
                        value: toMentionValue(item.relativePath),
                        label: item.fileName,
                        description: item.relativePath.slice(0, -(item.fileName.length + 1)),
                    }));
                    if (items.length > 0) {
                        return { items, prefix: `@${query}` };
                    }
                }
            }
            catch {
                // FFF search failed — fall through to built-in
            }
            // FFF returned no results or failed — let built-in handle it
            return current.getSuggestions(lines, cursorLine, cursorCol, options);
        },
        applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
            return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
        },
        shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
            return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
        },
    };
}
function toMentionValue(path) {
    return /\s/.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`;
}
//# sourceMappingURL=autocomplete.js.map