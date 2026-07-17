"use strict";
/**
 * pi-pretty: rendering functions for all tools.
 *
 * These produce ANSI-colored terminal output strings.
 * They are async only when Shiki syntax highlighting is involved.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.RESET_WITHOUT_BG = void 0;
exports.isLowContrastShikiFg = isLowContrastShikiFg;
exports.preserveBoxBackground = preserveBoxBackground;
exports.fillToolBackground = fillToolBackground;
exports.renderToolMetrics = renderToolMetrics;
exports.renderToolDuration = renderToolDuration;
exports.renderToolError = renderToolError;
exports.renderFileContent = renderFileContent;
exports.renderBashOutput = renderBashOutput;
exports.renderTree = renderTree;
exports.renderFindResults = renderFindResults;
exports.renderGrepResults = renderGrepResults;
exports.makeRenderCall = makeRenderCall;
exports.makeRenderResult = makeRenderResult;
const node_path_1 = require("node:path");
const cli_1 = require("@shikijs/cli");
const config_js_1 = require("./config.js");
const helpers_js_1 = require("./helpers.js");
// FIX (pi-kit): require pi-tui at the TOP LEVEL. The original "lazy import to
// avoid blocking module loading" comment is wrong for Pi's loader: jiti only
// aliases static top-level require() of @earendil-works/pi-tui, so the lazy
// function-body requires below ALWAYS threw MODULE_NOT_FOUND at render time —
// which made fillToolBackground() throw and every tool fall back to stock
// rendering. tools/read.js already requires pi-tui top-level and works.
const pi_tui_1 = require("@earendil-works/pi-tui");
/** pi-tui's truncateToWidth (ANSI/wide-char aware). */
function _truncateToWidth(text, maxWidth, ellipsis, pad) {
    return pi_tui_1.truncateToWidth(text, maxWidth, ellipsis, pad);
}
// FIX (pi-kit): map Pi's theme name to a REAL Shiki theme. Upstream fed
// settings.theme ("dark"/"light") straight to Shiki's codeToANSI — neither is a
// valid Shiki theme, so highlighting silently fell back to plain text every time.
// github-dark-default / github-light are real bundled Shiki themes.
const DEFAULT_THEME = "github-dark-default";
function resolveTheme() {
    const env = process.env.PRETTY_THEME;
    if (env)
        return env;
    try {
        const home = process.env.HOME;
        if (!home)
            return DEFAULT_THEME;
        const settings = JSON.parse(require("node:fs").readFileSync(require("node:path").join(home, ".pi/agent/settings.json"), "utf8"));
        const name = String(settings.theme ?? "").toLowerCase();
        return name === "light" ? "github-light" : DEFAULT_THEME;
    }
    catch {
        return DEFAULT_THEME;
    }
}
const THEME = resolveTheme();
const THEME_IS_DARK = !THEME.includes("light");
const _cache = new Map();
function _touch(k, v) {
    _cache.delete(k);
    _cache.set(k, v);
    while (_cache.size > config_js_1.CACHE_LIMIT) {
        const first = _cache.keys().next().value;
        if (first === undefined)
            break;
        _cache.delete(first);
    }
    return v;
}
async function hlBlock(code, language) {
    if (!code)
        return [""];
    if (!language || code.length > config_js_1.MAX_HL_CHARS)
        return code.split("\n");
    const k = `${THEME}\0${language}\0${code}`;
    const hit = _cache.get(k);
    if (hit)
        return _touch(k, hit);
    try {
        // Contrast normalization assumes a dark bg; only apply it on dark themes
        // (it would wash out legitimately-dark text on a light terminal).
        const raw = await (0, cli_1.codeToANSI)(code, language, THEME);
        const ansi = THEME_IS_DARK ? normalizeShikiContrast(raw) : raw;
        const out = (ansi.endsWith("\n") ? ansi.slice(0, -1) : ansi).split("\n");
        return _touch(k, out);
    }
    catch {
        return code.split("\n");
    }
}
const ESC_RE = "\u001b";
const ANSI_CAPTURE_RE = new RegExp(`${ESC_RE}\\[([0-9;]*)m`, "g");
const FG_MUTED = "\x1b[38;2;139;148;158m";
function isLowContrastShikiFg(params) {
    if (params === "30" || params === "90")
        return true;
    if (params === "38;5;0" || params === "38;5;8")
        return true;
    if (!params.startsWith("38;2;"))
        return false;
    const parts = params.split(";").map(Number);
    if (parts.length !== 5 || parts.some((n) => !Number.isFinite(n)))
        return false;
    const [, , r, g, b] = parts;
    const luminance = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    return luminance < 72;
}
function normalizeShikiContrast(ansi) {
    return ansi.replace(ANSI_CAPTURE_RE, (seq, params) => (isLowContrastShikiFg(params) ? FG_MUTED : seq));
}
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
function rule(w) {
    return `${config_js_1.FG_RULE}${"─".repeat(w)}${config_js_1.RST}`;
}
function lnum(n, w) {
    const v = String(n);
    return `${config_js_1.FG_LNUM}${" ".repeat(Math.max(0, w - v.length))}${v}${config_js_1.RST}`;
}
// ---------------------------------------------------------------------------
// Tool metrics line
// ---------------------------------------------------------------------------
function renderToolMetrics(result) {
    const details = result.details;
    if (!details)
        return "";
    const elapsed = (0, helpers_js_1.formatElapsedMs)(details[helpers_js_1.ELAPSED_KEY]);
    const chars = (0, helpers_js_1.formatCharCount)(details[helpers_js_1.CHARS_KEY]);
    if (!elapsed && !chars)
        return "";
    return `${config_js_1.FG_DIM}· ${[elapsed, chars].filter(Boolean).join(" · ")}${config_js_1.RST}`;
}
function renderToolDuration(result) {
    const details = result.details;
    return (0, helpers_js_1.formatElapsedMs)(details?.[helpers_js_1.ELAPSED_KEY]);
}
// ---------------------------------------------------------------------------
// Error renderer
// ---------------------------------------------------------------------------
function renderToolError(error, theme) {
    const body = (0, helpers_js_1.compactErrorLines)(error)
        .map((line) => `${config_js_1.TOOL_RESULT_INDENT}${line ? theme.fg("error", line) : ""}`)
        .join("\n");
    return fillToolBackground(body, config_js_1.BG_ERROR);
}
// ---------------------------------------------------------------------------
// Read — syntax-highlighted file content
// ---------------------------------------------------------------------------
async function renderFileContent(content, filePath, offset = 0, maxLines = config_js_1.MAX_PREVIEW_LINES, width) {
    const normalizedContent = (0, helpers_js_1.normalizeLineEndings)(content);
    const lines = normalizedContent.split("\n");
    const show = lines.slice(0, maxLines);
    const lg = (0, config_js_1.detectLang)(filePath);
    const hl = await hlBlock(show.join("\n"), lg);
    const tw = width ?? (0, config_js_1.termWidth)();
    const out = [];
    for (const line of hl) {
        out.push(_truncateToWidth(line ?? "", Math.max(1, tw), `${config_js_1.FG_DIM}›`));
    }
    return out.join("\n");
}
// ---------------------------------------------------------------------------
// Bash — colored exit status
// ---------------------------------------------------------------------------
function renderBashOutput(text) {
    const lines = text.split("\n");
    const maxShow = config_js_1.MAX_PREVIEW_LINES;
    const show = lines.slice(0, maxShow);
    const remaining = lines.length - maxShow;
    let body = show.join("\n");
    if (remaining > 0)
        body += `\n${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}… ${remaining} more lines${config_js_1.RST}`;
    return body;
}
// ---------------------------------------------------------------------------
// Ls — tree view with icons
// ---------------------------------------------------------------------------
// FIX (pi-kit): a directory listing is a FLAT set, not a tree — the old ├──/└──
// connectors implied hierarchy that isn't there. Render it like `ls -C`:
// dirs first (bold blue, trailing /), then files, each with its type icon,
// packed into columns that fit the width. `limit` caps rows for the collapsed
// preview (-1 = show all).
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
        cells.push(`${(0, config_js_1.dirIcon)()}${config_js_1.FG_BLUE}\x1b[1m${d}/${config_js_1.RST}`);
    for (const f of files)
        cells.push(`${(0, config_js_1.fileIcon)(f)}${f}`);
    return { cells, dirs: dirs.length, files: files.length, total: entries.length };
}
function renderTree(text, _basePath, limit = -1) {
    const kit = require("./kit.js");
    const { cells, total } = buildEntryCells(text);
    if (!cells.length)
        return `${config_js_1.FG_DIM}(empty directory)${config_js_1.RST}`;
    const w = Math.max(20, (0, config_js_1.termWidth)() - 2);
    const shown = limit > 0 ? cells.slice(0, limit) : cells;
    // No trailing "… more" line here — the tool's marker owns the hidden count.
    return kit.columns(shown, w, 2).join("\n");
}
exports.buildEntryCells = buildEntryCells;
// ---------------------------------------------------------------------------
// Find — grouped file list (plain, no tree characters or icons)
// ---------------------------------------------------------------------------
function renderFindResults(text, theme) {
    const lines = text.trim().split("\n").filter(Boolean);
    if (!lines.length)
        return theme ? theme.fg("dim", "(no matches)") : `${config_js_1.FG_DIM}(no matches)${config_js_1.RST}`;
    const groups = new Map();
    for (const line of lines) {
        const trimmed = line.trim();
        const dir = (0, node_path_1.dirname)(trimmed) || ".";
        const file = (0, node_path_1.basename)(trimmed);
        if (!groups.has(dir))
            groups.set(dir, []);
        const bucket = groups.get(dir);
        if (bucket)
            bucket.push(file);
    }
    const out = [];
    let count = 0;
    for (const [dir, files] of groups) {
        if (count > 0)
            out.push("");
        const dirColored = theme ? theme.fg("accent", theme.bold(`${dir}/`)) : `${config_js_1.FG_BLUE}\x1b[1m${dir}/${config_js_1.RST}`;
        out.push(dirColored);
        for (let i = 0; i < files.length; i++) {
            if (count >= config_js_1.MAX_PREVIEW_LINES) {
                const more = theme
                    ? theme.fg("dim", `… ${lines.length - count} more files`)
                    : `${config_js_1.FG_DIM}… ${lines.length - count} more files${config_js_1.RST}`;
                out.push(`${config_js_1.TOOL_RESULT_INDENT}${more}`);
                return out.join("\n");
            }
            out.push(`${config_js_1.TOOL_RESULT_INDENT}${files[i]}`);
            count++;
        }
    }
    return out.join("\n");
}
// ---------------------------------------------------------------------------
// Grep — highlighted matches with line numbers
// ---------------------------------------------------------------------------
async function renderGrepResults(text, pattern, limit = config_js_1.MAX_PREVIEW_LINES) {
    const lines = (0, helpers_js_1.normalizeLineEndings)(text).split("\n");
    if (!lines.length || (lines.length === 1 && !lines[0].trim()))
        return `${config_js_1.FG_DIM}(no matches)${config_js_1.RST}`;
    const out = [];
    let currentFile = "";
    let count = 0;
    let re = null;
    try {
        re = new RegExp(`(${pattern})`, "gi");
    }
    catch {
        /* skip highlighting */
    }
    for (const line of lines) {
        if (count >= limit) {
            out.push(`${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}… more matches (ctrl+o)${config_js_1.RST}`);
            break;
        }
        const fileMatch = line.match(/^(.+?)[:-](\d+)[:-](.*)$/);
        if (fileMatch) {
            const [, file, lineNo, content] = fileMatch;
            if (file !== currentFile) {
                if (currentFile)
                    out.push("");
                out.push(`${config_js_1.TOOL_RESULT_INDENT}${(0, config_js_1.fileIcon)(file)}${config_js_1.FG_BLUE}\x1b[1m${file}${config_js_1.RST}`);
                currentFile = file;
            }
            const nw = Math.max(3, lineNo.length);
            let display = content;
            if (re)
                display = content.replace(re, `${config_js_1.RST}${config_js_1.FG_YELLOW}\x1b[1m$1${config_js_1.RST}`);
            out.push(`${config_js_1.TOOL_RESULT_INDENT}${config_js_1.TOOL_RESULT_INDENT}${lnum(Number(lineNo), nw)} ${config_js_1.FG_RULE}│${config_js_1.RST} ${display}${config_js_1.RST}`);
            count++;
        }
        else if (line.trim() === "--") {
            out.push(`${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}  ···${config_js_1.RST}`);
        }
        else if (line.trim()) {
            out.push(line);
            count++;
        }
    }
    return out.join("\n");
}
// ---------------------------------------------------------------------------
// Generic renderCall / renderResult for custom tools
// ---------------------------------------------------------------------------
function makeRenderCall(toolName) {
    return (args, theme, ctx) => {
        (0, config_js_1.resolveBaseBackground)(theme);
        const text = ctx.lastComponent ?? new pi_tui_1.Text("", 0, 0);
        const bg = ctx.isError ? config_js_1.BG_ERROR : undefined;
        text.setText(fillToolBackground(`${theme.fg("toolTitle", theme.bold(toolName))}`, bg));
        return text;
    };
}
function makeRenderResult() {
    return (result, _opt, theme, ctx) => {
        (0, config_js_1.resolveBaseBackground)(theme);
        const text = ctx.lastComponent ?? new pi_tui_1.Text("", 0, 0);
        if (ctx.isError) {
            text.setText(renderToolError(getTextContent(result) || "Error", theme));
            return text;
        }
        const content = getTextContent(result);
        if (content) {
            const renderWidth = (0, config_js_1.termWidth)();
            const lines = content.split("\n");
            const maxShow = ctx.expanded ? lines.length : Math.min(lines.length, config_js_1.MAX_PREVIEW_LINES);
            const preview = lines.slice(0, maxShow).join("\n");
            const more = lines.length > maxShow ? `\n${config_js_1.FG_DIM}... ${lines.length - maxShow} more lines${config_js_1.RST}` : "";
            const metrics = renderToolMetrics(result);
            text.setText(fillToolBackground(`${config_js_1.TOOL_RESULT_INDENT}${preview}${more}${metrics ? `\n${config_js_1.TOOL_RESULT_INDENT}${metrics}` : ""}`, undefined, renderWidth));
        }
        else {
            text.setText(fillToolBackground(`${config_js_1.TOOL_RESULT_INDENT}${theme.fg("dim", "(no text output)")}`));
        }
        return text;
    };
}
function getTextContent(result) {
    return (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
}
//# sourceMappingURL=render.js.map