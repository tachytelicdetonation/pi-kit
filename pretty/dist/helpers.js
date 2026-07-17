"use strict";
/**
 * pi-pretty: utility helpers.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CHARS_KEY = exports.ELAPSED_KEY = void 0;
exports.normalizeLineEndings = normalizeLineEndings;
exports.shortPath = shortPath;
exports.trimToUndefined = trimToUndefined;
exports.escapeRegexLiteral = escapeRegexLiteral;
exports.buildLiteralAlternationPattern = buildLiteralAlternationPattern;
exports.shouldIgnoreCaseForPatterns = shouldIgnoreCaseForPatterns;
exports.getConstraintBackedPath = getConstraintBackedPath;
exports.getErrorMessage = getErrorMessage;
exports.humanSize = humanSize;
exports.countRipgrepMatches = countRipgrepMatches;
exports.stripBashExitStatusLine = stripBashExitStatusLine;
exports.formatElapsedMs = formatElapsedMs;
exports.formatCharCount = formatCharCount;
exports.inferBashExitCode = inferBashExitCode;
exports.compactErrorLines = compactErrorLines;
const node_path_1 = require("node:path");
// ---------------------------------------------------------------------------
// String / normalization
// ---------------------------------------------------------------------------
function normalizeLineEndings(text) {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}
function shortPath(cwd, home, p) {
    if (!p)
        return "";
    const r = (0, node_path_1.relative)(cwd, p);
    if (!r.startsWith("..") && !r.startsWith("/"))
        return r;
    return p.replace(home, "~");
}
function trimToUndefined(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}
function escapeRegexLiteral(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
function buildLiteralAlternationPattern(patterns) {
    return patterns
        .map(escapeRegexLiteral)
        .sort((a, b) => b.length - a.length)
        .join("|");
}
function shouldIgnoreCaseForPatterns(patterns) {
    return patterns.every((pattern) => pattern.toLowerCase() === pattern);
}
function getConstraintBackedPath(constraints) {
    const trimmed = trimToUndefined(constraints);
    if (!trimmed || /\s/.test(trimmed) || trimmed.includes("!") || trimmed.endsWith("/") || /[*?[{]/.test(trimmed)) {
        return undefined;
    }
    return trimmed;
}
function getErrorMessage(error) {
    return error instanceof Error ? error.message : String(error);
}
function humanSize(bytes) {
    if (bytes < 1024)
        return `${bytes}B`;
    if (bytes < 1024 * 1024)
        return `${(bytes / 1024).toFixed(1)}KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}
// ---------------------------------------------------------------------------
// Ripgrep match detection
// ---------------------------------------------------------------------------
function countRipgrepMatches(text) {
    return text
        .trim()
        .split("\n")
        .filter((line) => /^.+?[:-]\d+[:-]/.test(line)).length;
}
function stripBashExitStatusLine(text) {
    return normalizeLineEndings(text)
        .split("\n")
        .filter((line) => !/^Command exited with code \d+$/i.test(line.trim()))
        .join("\n");
}
// ---------------------------------------------------------------------------
// Tool metrics
// ---------------------------------------------------------------------------
function formatElapsedMs(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms))
        return "";
    if (ms < 1000)
        return `${Math.round(ms)}ms`;
    const s = ms / 1000;
    return s < 10 ? `${s.toFixed(1)}s` : `${Math.round(s)}s`;
}
function formatCharCount(chars) {
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0)
        return "";
    if (chars < 1000)
        return `${chars} chars`;
    if (chars < 10_000)
        return `${(chars / 1000).toFixed(1)}k chars`;
    return `${Math.round(chars / 1000)}k chars`;
}
exports.ELAPSED_KEY = "__prettyElapsedMs";
exports.CHARS_KEY = "__prettyOutputChars";
// ---------------------------------------------------------------------------
// Infer bash exit code
// ---------------------------------------------------------------------------
function inferBashExitCode(text, fallback) {
    const exitMatch = text.match(/(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i);
    if (exitMatch)
        return Number(exitMatch[1]);
    if (text.includes("command not found") || text.includes("No such file"))
        return 1;
    return fallback;
}
// ---------------------------------------------------------------------------
// Compact error lines
// ---------------------------------------------------------------------------
function compactErrorLines(error) {
    const compactedLines = [];
    let previousBlank = false;
    for (const line of normalizeLineEndings(error).trim().split("\n")) {
        const isBlank = line.trim() === "";
        if (isBlank && previousBlank)
            continue;
        compactedLines.push(line);
        previousBlank = isBlank;
    }
    return compactedLines;
}
//# sourceMappingURL=helpers.js.map