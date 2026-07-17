"use strict";
/*
 * pi-pretty: bash semantic verdicts (round-4 §3).
 *
 * "Render by CONSEQUENCE." The consequence of `npm test` is a VERDICT, not a
 * tail of stdout. These ordered regex extractors scan the LAST ~15 lines of the
 * cleaned bash output and, on the first match, return a structured verdict
 * { ok, seg } where `seg` is already colored via kit.greenSeg / kit.redSeg.
 * bash.js promotes that seg into the header (setSummary) so the user reads
 * `✓ $ npm test · 84 passed · 3.2s` instead of five tail lines.
 *
 * Color budget: only the count/verdict token is colored (greenSeg/redSeg wrap a
 * single token and return to dim). A pass/fail count sits on the same "did it
 * work" consequence axis as the status glyph, so green/red here is a LICENSED
 * extension, not decoration.
 *
 * Plain + synchronous. Order matters: more-specific patterns first.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.extractVerdict = extractVerdict;
const kit = require("../kit.js"); // reuse greenSeg/redSeg/plural — never mutate kit

const greenSeg = kit.greenSeg;
const redSeg = kit.redSeg;
const plural = kit.plural;

// Cap the scan to the last ~15 non-trailing-blank lines so we never regex
// megabytes. Test/build runners print their summary at the very end.
const SCAN_LINES = 15;
function scanLines(text) {
    const all = String(text ?? "").split("\n");
    while (all.length && all[all.length - 1].trim() === "")
        all.pop();
    return all.slice(Math.max(0, all.length - SCAN_LINES));
}

// "passed"/"failed" are invariant past-tense verbs — never pluralize them.
// plural() is only for nouns (error/problem/warning).

// --- cargo test ----------------------------------------------------------
// "test result: ok. 12 passed; 0 failed; 0 ignored; ..."
// "test result: FAILED. 8 passed; 2 failed; ..."
function cargo(lines) {
    for (const l of lines) {
        const m = l.match(/test result:\s*(?:ok|FAILED)\.\s*(\d+)\s+passed;\s*(\d+)\s+failed/i);
        if (m) {
            const passed = +m[1], failed = +m[2];
            return failed > 0
                ? { ok: false, seg: redSeg(`${failed} failed`) }
                : { ok: true, seg: greenSeg(`${passed} passed`) };
        }
    }
    return null;
}

// --- pytest --------------------------------------------------------------
// "12 passed in 3.4s" | "2 failed, 10 passed in 3.4s"
// "1 failed, 2 passed, 3 skipped in 0.50s". The "in <n>s" tail disambiguates
// pytest from vitest/jest (which never append it to the count line).
function pytest(lines) {
    for (const l of lines) {
        if (!/\bin\s+[\d.]+\s*s(?:econds?)?\b/.test(l))
            continue;
        const p = l.match(/(\d+)\s+passed/);
        const f = l.match(/(\d+)\s+failed/);
        const e = l.match(/(\d+)\s+error/i);
        if (!p && !f && !e)
            continue;
        const failed = f ? +f[1] : 0;
        const errored = e ? +e[1] : 0;
        if (failed > 0)
            return { ok: false, seg: redSeg(`${failed} failed`) };
        if (errored > 0)
            return { ok: false, seg: redSeg(plural(errored, "error")) };
        if (p)
            return { ok: true, seg: greenSeg(`${p[1]} passed`) };
    }
    return null;
}

// --- vitest / jest -------------------------------------------------------
// "Tests: 84 passed, 90 total" (jest)
// "Tests  84 passed | 2 failed | 1 skipped (87)" (vitest)
// "Tests  2 failed | 84 passed (86)"
// "Tests 84 passed"  |  bare "84 passed (90)"
function jestVitest(lines) {
    // "Test Files"/"Test Suites" lines ALSO say "N passed"; the aggregate test
    // count is the one we want and is always printed last. Keep the last
    // non-file/suite match, falling back to a file/suite match only if that is
    // all there is.
    let best = null, fileFallback = null;
    for (const l of lines) {
        const p = l.match(/(\d+)\s+passed/);
        const f = l.match(/(\d+)\s+failed/);
        if (!p && !f)
            continue;
        // Guard against unrelated prose that happens to say "passed": require a
        // Tests-summary label, a pipe-delimited count line, or a line that is
        // essentially just a leading count.
        const looksLikeSummary = /tests?[:\s]/i.test(l) || /\|/.test(l) || /^\s*\d+\s+(?:passed|failed)/.test(l);
        if (!looksLikeSummary)
            continue;
        const failed = f ? +f[1] : 0;
        const v = failed > 0
            ? { ok: false, seg: redSeg(`${failed} failed`) }
            : (p ? { ok: true, seg: greenSeg(`${p[1]} passed`) } : null);
        if (!v)
            continue;
        if (/test\s+files|test\s+suites|^\s*suites?[:\s]/i.test(l))
            fileFallback = fileFallback || v;
        else
            best = v; // last aggregate line wins
    }
    return best || fileFallback;
}

// --- tsc -----------------------------------------------------------------
// "Found 0 errors." | "Found 3 errors." | "Found 1 error in src/x.ts:4"
function tsc(lines) {
    for (const l of lines) {
        const m = l.match(/Found\s+(\d+)\s+error/i);
        if (m) {
            const n = +m[1];
            return n === 0
                ? { ok: true, seg: greenSeg("no errors") }
                : { ok: false, seg: redSeg(plural(n, "error")) };
        }
    }
    return null;
}

// --- eslint --------------------------------------------------------------
// "✖ 5 problems (2 errors, 3 warnings)". errors>0 → failure. warnings-only
// (errors===0) is not a failure → green "no errors".
function eslint(lines) {
    for (const l of lines) {
        const m = l.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/i);
        if (m) {
            const errors = +m[2];
            return errors > 0
                ? { ok: false, seg: redSeg(plural(errors, "error")) }
                : { ok: true, seg: greenSeg("no errors") };
        }
    }
    return null;
}

// --- generic exit --------------------------------------------------------
// No pattern matched. exit 0 → no verdict (fall through to today's behavior).
// exit≠0 → red "exit N".
function genericExit(_lines, exitCode) {
    if (typeof exitCode !== "number" || exitCode === 0)
        return null;
    return { ok: false, seg: redSeg(`exit ${exitCode}`) };
}

// Ordered: more-specific first. cargo/pytest carry unique anchors; jestVitest is
// the broad "N passed" case; tsc/eslint match error-count shapes; genericExit is
// the exit-code fallback tried last.
const EXTRACTORS = [cargo, pytest, jestVitest, tsc, eslint];

// extractVerdict — try extractors in order; return the first match or null.
function extractVerdict(cleanedText, exitCode) {
    const lines = scanLines(cleanedText);
    for (const fn of EXTRACTORS) {
        const v = fn(lines, exitCode);
        if (v)
            return v;
    }
    return genericExit(lines, exitCode);
}
