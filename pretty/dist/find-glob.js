"use strict";
/**
 * Glob normalization for FFF glob() (repo-relative paths).
 * Aligns with Pi SDK find: bare *.ts searches under cwd recursively.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.normalizeFindGlobPattern = normalizeFindGlobPattern;
exports.isLikelyGlobPattern = isLikelyGlobPattern;
/** Do not collapse double-star-slash-star to single star. */
function normalizeFindGlobPattern(pattern) {
    const p = pattern.trim();
    if (!p)
        return p;
    if (p === "**/*")
        return "**/*";
    if (p.includes("/") || p.startsWith("**/"))
        return p;
    if (/[*?[\]]/.test(p))
        return `**/${p}`;
    return p;
}
/** Patterns where an empty FFF result is suspicious — try SDK find (fd). */
function isLikelyGlobPattern(pattern) {
    const p = pattern.trim();
    if (!p)
        return false;
    return /[*?[\]]/.test(p) || p === "**/*" || p.startsWith("**/");
}
//# sourceMappingURL=find-glob.js.map