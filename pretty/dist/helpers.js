"use strict";
/* pretty: path/size/text/metric helpers used across the tool renderers. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.ELAPSED_KEY = exports.CHARS_KEY = void 0;
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

// --- text normalization -----------------------------------------------------

// Collapse every CRLF and lone CR into a single LF so downstream line splits
// behave identically regardless of the source platform.
function normalizeLineEndings(text) {
    return text.split(/\r\n?/).join("\n");
}

// --- filesystem path display ------------------------------------------------

// Render an absolute path for humans: prefer a path relative to `cwd` when it
// stays inside the tree, otherwise fold the home prefix down to "~".
function shortPath(cwd, home, p) {
    if (!p) {
        return "";
    }
    const rel = (0, node_path_1.relative)(cwd, p);
    const escapesCwd = rel.startsWith("..") || rel.startsWith("/");
    return escapesCwd ? p.replace(home, "~") : rel;
}

// --- small string utilities -------------------------------------------------

// Trim and hand back the result, mapping "nothing left" (or a nullish input)
// to undefined so callers can use `?? fallback`.
function trimToUndefined(value) {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
}

// Backslash-escape any character that carries meaning inside a RegExp so the
// text can be embedded as a literal.
function escapeRegexLiteral(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Turn a list of literal terms into a single alternation. Longer terms are
// placed first so the regex engine prefers the most specific match.
function buildLiteralAlternationPattern(patterns) {
    const escaped = patterns.map((pattern) => escapeRegexLiteral(pattern));
    escaped.sort((a, b) => b.length - a.length);
    return escaped.join("|");
}

// Case can be ignored only when no term carries an explicit uppercase letter.
function shouldIgnoreCaseForPatterns(patterns) {
    return patterns.every((pattern) => pattern === pattern.toLowerCase());
}

// Accept a constraint string only when it looks like a single concrete path:
// non-empty, no whitespace, no negation, no trailing slash, no glob syntax.
function getConstraintBackedPath(constraints) {
    const candidate = trimToUndefined(constraints);
    if (!candidate) {
        return undefined;
    }
    const looksLikePattern = /\s/.test(candidate) ||
        candidate.includes("!") ||
        candidate.endsWith("/") ||
        /[*?[{]/.test(candidate);
    return looksLikePattern ? undefined : candidate;
}

// Pull a readable message out of anything thrown.
function getErrorMessage(error) {
    if (error instanceof Error) {
        return error.message;
    }
    return String(error);
}

// --- byte sizes -------------------------------------------------------------

// Compact byte-size label: raw bytes below 1 KiB, then one decimal of KB or MB.
function humanSize(bytes) {
    const KIB = 1024;
    const MIB = KIB * KIB;
    if (bytes < KIB) {
        return `${bytes}B`;
    }
    if (bytes < MIB) {
        return `${(bytes / KIB).toFixed(1)}KB`;
    }
    return `${(bytes / MIB).toFixed(1)}MB`;
}

// --- ripgrep / bash output parsing ------------------------------------------

// Count ripgrep "path:line:" style hits by tallying lines that carry a
// `<something><:|->=<digits><:|->` locator.
function countRipgrepMatches(text) {
    const locator = /^.+?[:-]\d+[:-]/;
    let hits = 0;
    for (const line of text.trim().split("\n")) {
        if (locator.test(line)) {
            hits += 1;
        }
    }
    return hits;
}

// Drop the synthetic "Command exited with code N" status line some shells
// append, leaving the genuine command output.
function stripBashExitStatusLine(text) {
    const statusLine = /^Command exited with code \d+$/i;
    const kept = normalizeLineEndings(text)
        .split("\n")
        .filter((line) => !statusLine.test(line.trim()));
    return kept.join("\n");
}

// --- tool metric formatting -------------------------------------------------

// Human-friendly duration: milliseconds under a second, otherwise seconds with
// one decimal below 10s and whole seconds beyond. Non-finite input yields "".
function formatElapsedMs(ms) {
    if (typeof ms !== "number" || !Number.isFinite(ms)) {
        return "";
    }
    if (ms < 1000) {
        return `${Math.round(ms)}ms`;
    }
    const seconds = ms / 1000;
    if (seconds < 10) {
        return `${seconds.toFixed(1)}s`;
    }
    return `${Math.round(seconds)}s`;
}

// Human-friendly character count: raw below 1k, one decimal of "k" up to 10k,
// then rounded "k". Non-positive or non-finite input yields "".
function formatCharCount(chars) {
    if (typeof chars !== "number" || !Number.isFinite(chars) || chars <= 0) {
        return "";
    }
    if (chars < 1000) {
        return `${chars} chars`;
    }
    if (chars < 10_000) {
        return `${(chars / 1000).toFixed(1)}k chars`;
    }
    return `${Math.round(chars / 1000)}k chars`;
}

exports.ELAPSED_KEY = "__prettyElapsedMs";
exports.CHARS_KEY = "__prettyOutputChars";

// --- exit-code inference ----------------------------------------------------

// Best-effort exit code for a bash result: honor an explicit exit-code phrase,
// treat classic "not found" failures as 1, else defer to the caller's fallback.
function inferBashExitCode(text, fallback) {
    const explicit = text.match(/(?:exit code|exited with(?: code)?|exit status)[:\s]*(\d+)/i);
    if (explicit) {
        return Number(explicit[1]);
    }
    if (text.includes("command not found") || text.includes("No such file")) {
        return 1;
    }
    return fallback;
}

// --- error text compaction --------------------------------------------------

// Normalize line endings, strip surrounding whitespace, and collapse runs of
// blank lines down to a single blank line. Returns the resulting line array.
function compactErrorLines(error) {
    const lines = normalizeLineEndings(error).trim().split("\n");
    const result = [];
    let lastWasBlank = false;
    for (const line of lines) {
        const blank = line.trim() === "";
        if (blank && lastWasBlank) {
            continue;
        }
        result.push(line);
        lastWasBlank = blank;
    }
    return result;
}
//# sourceMappingURL=helpers.js.map