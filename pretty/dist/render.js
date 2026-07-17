"use strict";
/**
 * pi-pretty: shared rendering helpers.
 *
 * Box-background helpers (fillToolBackground / preserveBoxBackground) and the
 * `ls` entry-cell + column layout. All synchronous — round 3 removed Shiki, so
 * there is no async rendering path here anymore. The per-tool renderers live in
 * tools/*.js; the diff renderer in diff.js.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESET_WITHOUT_BG = void 0;
exports.preserveBoxBackground = preserveBoxBackground;
exports.fillToolBackground = fillToolBackground;
exports.renderTree = renderTree;
exports.buildEntryCells = buildEntryCells;
const config_js_1 = require("./config.js");
// FIX (pi-kit): require pi-tui at the TOP LEVEL. Pi's loader (jiti) only aliases
// a static top-level require() of @earendil-works/pi-tui — a lazy function-body
// require throws MODULE_NOT_FOUND at render time, which made fillToolBackground
// throw and every tool fall back to stock rendering. tools/read.js does the same.
const pi_tui_1 = require("@earendil-works/pi-tui");
/** pi-tui's truncateToWidth (ANSI/wide-char aware). */
function _truncateToWidth(text, maxWidth, ellipsis, pad) {
    return pi_tui_1.truncateToWidth(text, maxWidth, ellipsis, pad);
}
const ESC_RE = String.fromCharCode(27); // ESC (0x1b)
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
// ---------------------------------------------------------------------------
// Box background helpers
// ---------------------------------------------------------------------------
exports.RESET_WITHOUT_BG = "\x1b[22;23;24;25;27;28;29;39m";
function preserveBoxBackground(ansi) {
    return ansi.replace(ANSI_CAPTURE_RE, (_seq, params) => {
        if (!params || params === "0")
            return exports.RESET_WITHOUT_BG;
        const parts = params.split(";").filter(Boolean);
        const kept = [];
        let i = 0;
        while (i < parts.length) {
            const code = Number(parts[i]);
            if (code === 38) {
                // Foreground extended — keep entire sequence
                kept.push(parts[i]);
                if (parts[i + 1] === "5") {
                    kept.push(parts[i + 1]);
                    i += 2;
                }
                else if (parts[i + 1] === "2") {
                    kept.push(parts[i + 1], parts[i + 2], parts[i + 3], parts[i + 4]);
                    i += 5;
                }
                else {
                    i++;
                }
            }
            else if (code === 48) {
                // Background extended — skip entirely
                if (parts[i + 1] === "5")
                    i += 3;
                else if (parts[i + 1] === "2")
                    i += 6;
                else
                    i++;
            }
            else if (code === 49 || (code >= 40 && code <= 47) || (code >= 100 && code <= 107)) {
                i++;
            }
            else {
                kept.push(parts[i]);
                i++;
            }
        }
        return kept.length ? `\x1b[${kept.join(";")}m` : "";
    });
}
function fillToolBackground(text, bg = config_js_1.BG_BASE, width) {
    return text
        .split("\n")
        .map((line) => {
        if (!width) {
            const stripped = preserveBoxBackground(line);
            return bg ? bg + stripped : stripped;
        }
        // FIX (pi-kit): always pad to full width when a width is given. The old
        // skipPad sentinel (line starts with the 1-space indent) matched EVERY
        // body line, so padding was always skipped → a configured/themed tool
        // background never filled the row. Pad unconditionally so the surface is
        // a clean full-width block; with the default (no-tint) bg it's a no-op.
        // A cut line ends in a dim › rather than silently vanishing at the edge.
        const fitted = _truncateToWidth(line, width, `${config_js_1.FG_DIM}›${config_js_1.RST}`, true);
        const stripped = preserveBoxBackground(fitted);
        return bg ? bg + stripped : stripped;
    })
        .join("\n");
}
// ---------------------------------------------------------------------------
// Ls — flat directory listing packed into `ls -C` columns (no tree, no icons)
// ---------------------------------------------------------------------------
// FIX (pi-kit): a directory listing is a FLAT set, not a tree — the old ├──/└──
// connectors implied hierarchy that isn't there. Round 3 (F5a): no icons, no
// FG_BLUE, no bold — dirs are default-fg names with a dim trailing slash, files
// plain; the green/red/blue budget is reserved for the glyph spine, diff tint,
// and grep term (§1.3).
function buildEntryCells(text) {
    const entries = text.trim().split("\n").map((s) => s.trim()).filter(Boolean);
    const dirs = [];
    const files = [];
    for (const e of entries) {
        if (e.endsWith("/"))
            dirs.push(e.slice(0, -1));
        else
            files.push(e);
    }
    dirs.sort((a, b) => a.localeCompare(b));
    files.sort((a, b) => a.localeCompare(b));
    const cells = [];
    for (const d of dirs)
        cells.push(`${d}${config_js_1.FG_DIM}/${config_js_1.RST}`);
    for (const f of files)
        cells.push(f);
    return { cells, dirs: dirs.length, files: files.length, total: entries.length };
}
function renderTree(text, _basePath, limit = -1) {
    const kit = require("./kit.js");
    const { cells } = buildEntryCells(text);
    if (!cells.length)
        return `${config_js_1.FG_DIM}(empty directory)${config_js_1.RST}`;
    const w = Math.max(20, (0, config_js_1.termWidth)() - 2);
    const shown = limit > 0 ? cells.slice(0, limit) : cells;
    // No trailing "… more" line here — the tool's marker owns the hidden count.
    return kit.columns(shown, w, 2).join("\n");
}
//# sourceMappingURL=render.js.map
