/**
 * pi-pretty: utility helpers.
 */
export declare function normalizeLineEndings(text: string): string;
export declare function shortPath(cwd: string, home: string, p: string): string;
export declare function trimToUndefined(value: string | undefined): string | undefined;
export declare function escapeRegexLiteral(text: string): string;
export declare function buildLiteralAlternationPattern(patterns: string[]): string;
export declare function shouldIgnoreCaseForPatterns(patterns: string[]): boolean;
export declare function getConstraintBackedPath(constraints: string | undefined): string | undefined;
export declare function getErrorMessage(error: unknown): string;
export declare function humanSize(bytes: number): string;
export declare function countRipgrepMatches(text: string): number;
export declare function stripBashExitStatusLine(text: string): string;
export declare function formatElapsedMs(ms: number | undefined): string;
export declare function formatCharCount(chars: number | undefined): string;
export declare const ELAPSED_KEY = "__prettyElapsedMs";
export declare const CHARS_KEY = "__prettyOutputChars";
export declare function inferBashExitCode(text: string, fallback: number | null): number | null;
export declare function compactErrorLines(error: string): string[];
//# sourceMappingURL=helpers.d.ts.map