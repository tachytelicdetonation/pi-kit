"use strict";
/*
 * pretty: synchronous rendering helpers.
 *
 * Two concerns live here: the box-background machinery
 * (preserveBoxBackground / fillToolBackground) that lets a tinted tool surface
 * survive foreground styling, and the flat `ls` column layout (buildEntryCells /
 * renderTree). Per-tool renderers live in tools/*.js and the diff renderer in
 * diff.js.
 *
 * @earendil-works/pi-tui is required at module top level on purpose: Pi's jiti
 * loader only rewrites its pi-tui alias for a static top-level require(), so a
 * require() inside a function body would throw MODULE_NOT_FOUND at render time
 * and knock every tool back to stock rendering. tools/read.js does the same.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESET_WITHOUT_BG = void 0;
exports.preserveBoxBackground = preserveBoxBackground;
exports.fillToolBackground = fillToolBackground;
exports.renderTree = renderTree;
exports.buildEntryCells = buildEntryCells;
const config_js_1 = require("./config.js");
const pi_tui_1 = require("@earendil-works/pi-tui");

// Thin wrapper over pi-tui's ANSI/wide-char aware truncation.
function _truncateToWidth(text, maxWidth, ellipsis, pad) {
    return pi_tui_1.truncateToWidth(text, maxWidth, ellipsis, pad);
}

const ESC = "";
// Matches one SGR sequence, capturing its parameter list (may be empty).
const ANSI_CAPTURE_RE = new RegExp(`${ESC}\\[([0-9;]*)m`, "g");

// ---------------------------------------------------------------------------
// Box background preservation
// ---------------------------------------------------------------------------

// A reset that clears attributes and foreground but deliberately leaves the
// background untouched (no 49), so a filled tool surface is not punched through
// by an inner `\x1b[0m`. Attributes cleared: 22 23 24 25 27 28 29 and fg 39.
exports.RESET_WITHOUT_BG = "\x1b[22;23;24;25;27;28;29;39m";

// Walk one SGR parameter list, keeping foreground/attribute codes and discarding
// anything that would set or clear a background. The advance amounts mirror the
// original scanner exactly so the emitted sequences are byte-for-byte identical
// to what downstream parsers already expect:
//   - 38 (extended fg): kept; 38;5 consumes the "38;5" pair, 38;2 consumes the
//     full 5-token truecolor run.
//   - 48 (extended bg): dropped; 48;5 skips 3 tokens, 48;2 skips 6.
//   - 49 / 40-47 / 100-107 (bg color set/reset): dropped.
//   - everything else: kept verbatim.
function filterSgrParams(parts) {
    const kept = [];
    let i = 0;
    while (i < parts.length) {
        const code = Number(parts[i]);
        switch (true) {
            case code === 38: {
                kept.push(parts[i]);
                const kind = parts[i + 1];
                if (kind === "5") {
                    kept.push(kind);
                    i += 2;
                }
                else if (kind === "2") {
                    kept.push(kind, parts[i + 2], parts[i + 3], parts[i + 4]);
                    i += 5;
                }
                else {
                    i += 1;
                }
                break;
            }
            case code === 48: {
                const kind = parts[i + 1];
                if (kind === "5") {
                    i += 3;
                }
                else if (kind === "2") {
                    i += 6;
                }
                else {
                    i += 1;
                }
                break;
            }
            case code === 49:
            case code >= 40 && code <= 47:
            case code >= 100 && code <= 107:
                i += 1;
                break;
            default:
                kept.push(parts[i]);
                i += 1;
        }
    }
    return kept;
}

// Rewrite every SGR sequence in `ansi` so it can never disturb an outer
// background fill. A bare/zero reset collapses to RESET_WITHOUT_BG; other
// sequences are rebuilt from their surviving (foreground/attribute) parameters,
// or elided entirely if nothing survives.
function preserveBoxBackground(ansi) {
    return ansi.replace(ANSI_CAPTURE_RE, (_match, params) => {
        if (!params || params === "0") {
            return exports.RESET_WITHOUT_BG;
        }
        const parts = params.split(";").filter(Boolean);
        const kept = filterSgrParams(parts);
        return kept.length ? `\x1b[${kept.join(";")}m` : "";
    });
}

// Apply a background tint to each line of `text`. Without a width the line is
// only background-neutralized; with one it is first truncated/padded to that
// width (a cut line ends in a dim guillemet rather than vanishing) so the tint
// fills a clean full-width block. The default (no-tint) background makes the
// padding a visual no-op.
function fillToolBackground(text, bg = config_js_1.BG_BASE, width) {
    const lines = text.split("\n");
    const out = lines.map((line) => {
        const source = width
            ? _truncateToWidth(line, width, `${config_js_1.FG_DIM}›${config_js_1.RST}`, true)
            : line;
        const neutralized = preserveBoxBackground(source);
        return bg ? bg + neutralized : neutralized;
    });
    return out.join("\n");
}

// ---------------------------------------------------------------------------
// Flat directory listing (ls -C style columns; no tree glyphs, no icons)
// ---------------------------------------------------------------------------
//
// A directory listing is a flat set, not a hierarchy, so it is packed into
// columns rather than drawn with ├──/└── connectors. Directories sort ahead of
// files (each with a dim trailing slash); files render plain. Color is left for
// the glyph spine, diff tint, and grep term elsewhere.

// Split raw listing text into display cells. Trailing-slash entries are treated
// as directories (slash stripped, re-added dim); the rest are files. Both groups
// are locale-sorted; directories precede files. Returns the cells plus counts.
function buildEntryCells(text) {
    const entries = text
        .trim()
        .split("\n")
        .map((s) => s.trim())
        .filter(Boolean);
    const dirs = [];
    const files = [];
    for (const entry of entries) {
        if (entry.endsWith("/")) {
            dirs.push(entry.slice(0, -1));
        }
        else {
            files.push(entry);
        }
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    const cells = [
        ...dirs.map((d) => `${d}${config_js_1.FG_DIM}/${config_js_1.RST}`),
        ...files,
    ];
    return { cells, dirs: dirs.length, files: files.length, total: entries.length };
}

// Render a directory listing as gap-2 columns fitted to the terminal width.
// `limit > 0` caps the number of cells shown (the caller's marker owns any
// hidden-count note). kit.js is required lazily to avoid a load-time cycle.
function renderTree(text, _basePath, limit = -1) {
    const kit = require("./kit.js");
    const { cells } = buildEntryCells(text);
    if (!cells.length) {
        return `${config_js_1.FG_DIM}(empty directory)${config_js_1.RST}`;
    }
    const width = Math.max(20, (0, config_js_1.termWidth)() - 2);
    const shown = limit > 0 ? cells.slice(0, limit) : cells;
    return kit.columns(shown, width, 2).join("\n");
}
//# sourceMappingURL=render.js.map