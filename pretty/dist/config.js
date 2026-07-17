"use strict";
/*
 * pretty: terminal color/ANSI constants, theme resolution, and environment
 * config shared by every renderer.
 *
 * The FG, BG, RST, and PALETTE values below are the public palette API — other
 * modules and the preview harness read these names directly, and several of
 * them (the FG set, BG_BASE, BG_ERROR, RST) are re-assigned at runtime once
 * the active terminal theme is known. They must therefore stay plain, mutable
 * properties on `exports`.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.applyThemePalette = applyThemePalette;
exports.detectDark = detectDark;
exports.resolveBaseBackground = resolveBaseBackground;
exports.termWidth = termWidth;
exports.envInt = envInt;
exports.getDefaultAgentDir = getDefaultAgentDir;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");

// --- foreground palette -----------------------------------------------------

// One-space left gutter for rendered tool-result lines (tighter than the older
// two-space indent, to sit flush with the surrounding TUI chrome).
exports.TOOL_RESULT_INDENT = " ";
// Full SGR reset.
exports.RST = "\x1b[0m";

// The exported FG_* values start on the dark set; applyThemePalette() overwrites
// them with the light variants when a light terminal is detected. FG_DIM is a
// mid grey rather than the barely-visible rgb(80) used historically.
exports.FG_LNUM = "\x1b[38;2;120;120;120m";
exports.FG_DIM = "\x1b[38;2;128;128;128m";
exports.FG_RULE = "\x1b[38;2;68;68;68m";
exports.FG_GREEN = "\x1b[38;2;126;186;148m";
exports.FG_RED = "\x1b[38;2;224;108;108m";
exports.FG_YELLOW = "\x1b[38;2;214;180;90m";
exports.FG_BLUE = "\x1b[38;2;110;150;230m";
exports.FG_MUTED = "\x1b[38;2;139;148;158m";
// Reserved for liveness only (spinner + ticking elapsed while a call is running);
// assertColorBudget in preview.js enforces that it never survives to completion.
exports.FG_CYAN = "\x1b[38;2;100;170;180m";

// Per-theme snapshots of the mutable palette. applyThemePalette() copies one of
// these over the live exports; the light diff backgrounds live here too.
const PALETTE = {
    dark: {
        FG_LNUM: "\x1b[38;2;120;120;120m", FG_DIM: "\x1b[38;2;128;128;128m",
        FG_RULE: "\x1b[38;2;68;68;68m", FG_GREEN: "\x1b[38;2;126;186;148m",
        FG_RED: "\x1b[38;2;224;108;108m", FG_YELLOW: "\x1b[38;2;214;180;90m",
        FG_BLUE: "\x1b[38;2;110;150;230m", FG_MUTED: "\x1b[38;2;139;148;158m",
        FG_CYAN: "\x1b[38;2;100;170;180m",
        BG_ADD: "\x1b[48;2;28;50;38m", BG_DEL: "\x1b[48;2;58;34;34m",
    },
    light: {
        FG_LNUM: "\x1b[38;2;140;140;140m", FG_DIM: "\x1b[38;2;120;120;120m",
        FG_RULE: "\x1b[38;2;190;190;190m", FG_GREEN: "\x1b[38;2;32;140;72m",
        FG_RED: "\x1b[38;2;190;44;44m", FG_YELLOW: "\x1b[38;2;150;110;20m",
        FG_BLUE: "\x1b[38;2;36;86;200m", FG_MUTED: "\x1b[38;2;90;100;110m",
        FG_CYAN: "\x1b[38;2;0;130;145m",
        BG_ADD: "\x1b[48;2;219;244;226m", BG_DEL: "\x1b[48;2;250;222;222m",
    },
};

// Remembers the palette currently installed so repeated calls are cheap and a
// no-op when the theme has not actually flipped.
let _paletteIsDark = null;
function applyThemePalette(dark) {
    if (_paletteIsDark === dark) {
        return;
    }
    _paletteIsDark = dark;
    Object.assign(exports, dark ? PALETTE.dark : PALETTE.light);
}

// --- backgrounds ------------------------------------------------------------

// "Default background" SGR — resets to the terminal's own background rather than
// tinting. BG_BASE/BG_ERROR begin here and are replaced once a theme or a user
// config supplies a concrete tint.
const BG_DEFAULT = "\x1b[49m";
exports.BG_BASE = BG_DEFAULT;
exports.BG_ERROR = BG_DEFAULT;
// Diff add/remove row tints (dark defaults; light variants come from PALETTE via
// applyThemePalette). Full 48;2 truecolor background sequences.
exports.BG_ADD = "\x1b[48;2;28;50;38m";
exports.BG_DEL = "\x1b[48;2;58;34;34m";

// --- ANSI / hex parsing helpers ---------------------------------------------

const ESC = "";

// Pull the r/g/b out of a leading 38;2 or 48;2 truecolor SGR, or null if the
// string is not one.
function parseAnsiRgb(ansi) {
    const m = ansi.match(new RegExp(`${ESC}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
    if (!m) {
        return null;
    }
    return { r: +m[1], g: +m[2], b: +m[3] };
}

// Convert a #rrggbb (or rrggbb) hex color into a 48;2 background SGR, or null on
// malformed input.
function hexToAnsiBg(hex) {
    const m = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (!m) {
        return null;
    }
    const r = Number.parseInt(m[1], 16);
    const g = Number.parseInt(m[2], 16);
    const b = Number.parseInt(m[3], 16);
    return `\x1b[48;2;${r};${g};${b}m`;
}

// Ask a Pi theme object for the background SGR of a named slot. Prefers a direct
// getBgAnsi() reading; failing that, styles a NUL marker with theme.bg() and
// slices off the leading escape that precedes it. Only truecolor results are
// accepted; any throw or non-parseable value yields null.
function getThemeBgAnsi(theme, key) {
    try {
        const direct = theme.getBgAnsi?.(key);
        if (direct && parseAnsiRgb(direct)) {
            return direct;
        }
        const marker = "\0";
        const styled = theme.bg?.(key, marker);
        const at = styled?.indexOf(marker) ?? -1;
        const prefix = at > 0 ? styled?.slice(0, at) : null;
        return prefix && parseAnsiRgb(prefix) ? prefix : null;
    }
    catch {
        return null;
    }
}

// --- user config file (pi-pretty.json) --------------------------------------

// Read and sanitize the optional pi-pretty.json in the agent dir. Background
// overrides that are not valid hex are dropped; if neither tool nor error
// override survives, the whole background block is discarded. Any I/O or parse
// failure returns an empty config.
function readPrettyConfig(agentDir) {
    if (!agentDir) {
        return {};
    }
    try {
        const raw = (0, node_fs_1.readFileSync)((0, node_path_1.join)(agentDir, "pi-pretty.json"), "utf8");
        const parsed = JSON.parse(raw);
        const bg = parsed.background;
        if (bg) {
            if (bg.tool && !hexToAnsiBg(bg.tool)) {
                bg.tool = undefined;
            }
            if (bg.error && !hexToAnsiBg(bg.error)) {
                bg.error = undefined;
            }
            if (!bg.tool && !bg.error) {
                parsed.background = undefined;
            }
        }
        return parsed;
    }
    catch {
        return {};
    }
}

// Install a user-configured tool background (and matching error background) from
// pi-pretty.json. Returns true only when a valid tool tint was applied.
function applyPrettyConfigBg(agentDir) {
    const config = readPrettyConfig(agentDir);
    const toolHex = config.background?.tool;
    if (!toolHex) {
        return false;
    }
    const toolBg = hexToAnsiBg(toolHex);
    if (!toolBg) {
        return false;
    }
    exports.BG_BASE = toolBg;
    exports.BG_ERROR = config.background.error
        ? (hexToAnsiBg(config.background.error) ?? toolBg)
        : toolBg;
    exports.RST = "\x1b[0m";
    return true;
}

// --- theme (dark/light) detection -------------------------------------------

let _isDarkCache;

// Decide whether the terminal is dark. Preferred signal is the luminance of a
// themed background color; otherwise fall back (once, cached) to the `theme`
// field of ~/.pi/agent/settings.json, defaulting to dark.
function detectDark(theme) {
    const bg = getThemeBgAnsi(theme, "background") ?? getThemeBgAnsi(theme, "toolBg");
    const rgb = bg ? parseAnsiRgb(bg) : null;
    if (rgb) {
        return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b < 128;
    }
    if (_isDarkCache === undefined) {
        try {
            const home = process.env.HOME;
            const settings = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(home, ".pi/agent/settings.json"), "utf8"));
            _isDarkCache = String(settings.theme ?? "dark").toLowerCase() !== "light";
        }
        catch {
            _isDarkCache = true;
        }
    }
    return _isDarkCache;
}

// Resolve and install the tool-surface backgrounds for the active theme. Order
// of precedence: user config file first; then themed success/tool/background
// slots; falling back to the terminal default. Also swaps the FG_* palette to
// match dark/light.
function resolveBaseBackground(theme) {
    applyThemePalette(detectDark(theme));
    const home = process.env.HOME;
    const configDir = process.env.PRETTY_CONFIG_DIR ??
        (home ? (0, node_path_1.join)(home, ".pi/agent") : undefined);
    if (applyPrettyConfigBg(configDir)) {
        return;
    }
    if (!theme?.getBgAnsi && !theme?.bg) {
        return;
    }
    exports.BG_BASE =
        getThemeBgAnsi(theme, "toolSuccessBg") ??
            getThemeBgAnsi(theme, "toolBg") ??
            getThemeBgAnsi(theme, "background") ??
            BG_DEFAULT;
    exports.BG_ERROR = getThemeBgAnsi(theme, "toolErrorBg") ?? exports.BG_BASE;
    exports.RST = "\x1b[0m";
}

// --- terminal geometry ------------------------------------------------------

// Usable render width, capped at 210 columns. Uses stdout's column count when
// available; otherwise derives from stderr / $COLUMNS (less a 4-column margin)
// or a 200-column default.
function termWidth() {
    if (process.stdout.columns) {
        return Math.max(1, Math.min(process.stdout.columns, 210));
    }
    const raw = process.stderr.columns ||
        Number.parseInt(process.env.COLUMNS ?? "", 10) ||
        200;
    return Math.max(1, Math.min(raw - 4, 210));
}

// --- environment helpers ----------------------------------------------------

// Read a positive integer from the environment, or return the fallback when the
// variable is missing / non-numeric / non-positive.
function envInt(name, fallback) {
    const v = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}

exports.MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);

// Default Pi agent directory (~/.pi/agent), or undefined when $HOME is unset.
function getDefaultAgentDir() {
    const home = process.env.HOME ?? "";
    return home ? (0, node_path_1.join)(home, ".pi/agent") : undefined;
}
//# sourceMappingURL=config.js.map