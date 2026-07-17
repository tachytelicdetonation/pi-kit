"use strict";
/* pretty: glob-pattern handling for the find/glob tool (repo-relative paths). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeFindGlobPattern = normalizeFindGlobPattern;
exports.isLikelyGlobPattern = isLikelyGlobPattern;

// Characters that signal a shell/glob pattern rather than a literal name.
const GLOB_META = /[*?[\]]/;

// Prepare a pattern for the repo-relative glob search. A bare glob such as
// "*.ts" is anchored under the tree with a recursive "**/" prefix; anything
// that already carries a path separator (including "**/..." forms) is passed
// through untouched, and empty/literal input is returned as-is.
function normalizeFindGlobPattern(pattern) {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.includes("/")) {
        return trimmed;
    }
    return GLOB_META.test(trimmed) ? `**/${trimmed}` : trimmed;
}

// True when the input actually contains glob metacharacters, meaning an empty
// result is worth a second look via the SDK find backend.
function isLikelyGlobPattern(pattern) {
    return GLOB_META.test(pattern.trim());
}
//# sourceMappingURL=find-glob.js.map