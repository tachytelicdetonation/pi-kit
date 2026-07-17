/**
 * Glob normalization for FFF glob() (repo-relative paths).
 * Aligns with Pi SDK find: bare *.ts searches under cwd recursively.
 */
/** Do not collapse double-star-slash-star to single star. */
export declare function normalizeFindGlobPattern(pattern: string): string;
/** Patterns where an empty FFF result is suspicious — try SDK find (fd). */
export declare function isLikelyGlobPattern(pattern: string): boolean;
//# sourceMappingURL=find-glob.d.ts.map