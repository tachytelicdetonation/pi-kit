"use strict";
/**
 * pi-pretty: ANSI codes, icons, theme, and environment config.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.CACHE_LIMIT = exports.MAX_PREVIEW_LINES = exports.MAX_HL_CHARS = exports.NF_DEFAULT = exports.NF_DIR = exports.USE_ICONS = exports.BG_DEL = exports.BG_ADD = exports.BG_ERROR = exports.BG_BASE = exports.FG_MUTED = exports.FG_BLUE = exports.FG_YELLOW = exports.FG_RED = exports.FG_GREEN = exports.FG_RULE = exports.FG_DIM = exports.FG_LNUM = exports.RST = exports.TOOL_RESULT_INDENT = void 0;
exports.resolveBaseBackground = resolveBaseBackground;
exports.termWidth = termWidth;
exports.fileIcon = fileIcon;
exports.dirIcon = dirIcon;
exports.detectLang = detectLang;
exports.envInt = envInt;
exports.getDefaultAgentDir = getDefaultAgentDir;
const node_fs_1 = require("node:fs");
const node_path_1 = require("node:path");
// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------
/** Left indent for rendered tool result lines (was two spaces; one matches tighter TUI layout). */
exports.TOOL_RESULT_INDENT = " ";
exports.RST = "\x1b[0m";
// Palette is theme-adaptive: applyThemePalette() (called from resolveBaseBackground)
// swaps these for the light-terminal variants. Defaults below are the dark set.
// FG_DIM bumped from the old rgb(80) — that was near-invisible on any terminal.
exports.FG_LNUM = "\x1b[38;2;120;120;120m";
exports.FG_DIM = "\x1b[38;2;128;128;128m";
exports.FG_RULE = "\x1b[38;2;68;68;68m";
exports.FG_GREEN = "\x1b[38;2;126;186;148m";
exports.FG_RED = "\x1b[38;2;224;108;108m";
exports.FG_YELLOW = "\x1b[38;2;214;180;90m";
exports.FG_BLUE = "\x1b[38;2;110;150;230m";
exports.FG_MUTED = "\x1b[38;2;139;148;158m";
const PALETTE = {
    dark: {
        FG_LNUM: "\x1b[38;2;120;120;120m", FG_DIM: "\x1b[38;2;128;128;128m",
        FG_RULE: "\x1b[38;2;68;68;68m", FG_GREEN: "\x1b[38;2;126;186;148m",
        FG_RED: "\x1b[38;2;224;108;108m", FG_YELLOW: "\x1b[38;2;214;180;90m",
        FG_BLUE: "\x1b[38;2;110;150;230m", FG_MUTED: "\x1b[38;2;139;148;158m",
        BG_ADD: "\x1b[48;2;28;50;38m", BG_DEL: "\x1b[48;2;58;34;34m",
    },
    light: {
        FG_LNUM: "\x1b[38;2;140;140;140m", FG_DIM: "\x1b[38;2;120;120;120m",
        FG_RULE: "\x1b[38;2;190;190;190m", FG_GREEN: "\x1b[38;2;32;140;72m",
        FG_RED: "\x1b[38;2;190;44;44m", FG_YELLOW: "\x1b[38;2;150;110;20m",
        FG_BLUE: "\x1b[38;2;36;86;200m", FG_MUTED: "\x1b[38;2;90;100;110m",
        BG_ADD: "\x1b[48;2;219;244;226m", BG_DEL: "\x1b[48;2;250;222;222m",
    },
};
let _paletteIsDark = null;
/** Swap the FG_* palette for dark/light. Idempotent; only touches on change. */
function applyThemePalette(dark) {
    if (_paletteIsDark === dark)
        return;
    _paletteIsDark = dark;
    Object.assign(exports, dark ? PALETTE.dark : PALETTE.light);
}
exports.applyThemePalette = applyThemePalette;
const BG_DEFAULT = "\x1b[49m";
exports.BG_BASE = BG_DEFAULT;
exports.BG_ERROR = BG_DEFAULT;
// Diff add/del backgrounds — theme-swapped by applyThemePalette (dark set is the
// default below; light variants live in PALETTE.light). Full 48;2 bg SGR strings.
exports.BG_ADD = "\x1b[48;2;28;50;38m";
exports.BG_DEL = "\x1b[48;2;58;34;34m";
const ESC_RE = "\u001b";
function parseAnsiRgb(ansi) {
    const m = ansi.match(new RegExp(`${ESC_RE}\\[(?:38|48);2;(\\d+);(\\d+);(\\d+)m`));
    return m ? { r: +m[1], g: +m[2], b: +m[3] } : null;
}
function getThemeBgAnsi(theme, key) {
    try {
        const direct = theme.getBgAnsi?.(key);
        if (direct && parseAnsiRgb(direct))
            return direct;
        const marker = "\0";
        const styled = theme.bg?.(key, marker);
        const markerIndex = styled?.indexOf(marker) ?? -1;
        const ansi = markerIndex > 0 ? styled?.slice(0, markerIndex) : null;
        return ansi && parseAnsiRgb(ansi) ? ansi : null;
    }
    catch {
        return null;
    }
}
function hexToAnsiBg(hex) {
    const m = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
    if (!m)
        return null;
    const r = Number.parseInt(m[1], 16);
    const g = Number.parseInt(m[2], 16);
    const b = Number.parseInt(m[3], 16);
    return `\x1b[48;2;${r};${g};${b}m`;
}
function readPrettyConfig(agentDir) {
    if (!agentDir)
        return {};
    try {
        const raw = (0, node_fs_1.readFileSync)((0, node_path_1.join)(agentDir, "pi-pretty.json"), "utf8");
        const parsed = JSON.parse(raw);
        if (parsed.background) {
            if (parsed.background.tool && !hexToAnsiBg(parsed.background.tool)) {
                parsed.background.tool = undefined;
            }
            if (parsed.background.error && !hexToAnsiBg(parsed.background.error)) {
                parsed.background.error = undefined;
            }
            if (!parsed.background.tool && !parsed.background.error) {
                parsed.background = undefined;
            }
        }
        return parsed;
    }
    catch {
        return {};
    }
}
function applyPrettyConfigBg(agentDir) {
    const config = readPrettyConfig(agentDir);
    if (!config.background?.tool)
        return false;
    const toolBg = hexToAnsiBg(config.background.tool);
    if (!toolBg)
        return false;
    exports.BG_BASE = toolBg;
    exports.BG_ERROR = config.background.error ? (hexToAnsiBg(config.background.error) ?? toolBg) : toolBg;
    exports.RST = "\x1b[0m";
    return true;
}
let _isDarkCache;
/** Dark vs light terminal — from a themed bg color's luminance, else settings.theme. */
function detectDark(theme) {
    const bg = getThemeBgAnsi(theme, "background") ?? getThemeBgAnsi(theme, "toolBg");
    const rgb = bg ? parseAnsiRgb(bg) : null;
    if (rgb)
        return 0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b < 128;
    if (_isDarkCache === undefined) {
        try {
            const h = process.env.HOME;
            const s = JSON.parse((0, node_fs_1.readFileSync)((0, node_path_1.join)(h, ".pi/agent/settings.json"), "utf8"));
            _isDarkCache = String(s.theme ?? "dark").toLowerCase() !== "light";
        }
        catch {
            _isDarkCache = true;
        }
    }
    return _isDarkCache;
}
exports.detectDark = detectDark;
function resolveBaseBackground(theme) {
    applyThemePalette(detectDark(theme));
    const home = process.env.HOME;
    const configDir = process.env.PRETTY_CONFIG_DIR ?? (home ? (0, node_path_1.join)(home, ".pi/agent") : undefined);
    if (applyPrettyConfigBg(configDir))
        return;
    if (!theme?.getBgAnsi && !theme?.bg)
        return;
    exports.BG_BASE =
        getThemeBgAnsi(theme, "toolSuccessBg") ??
            getThemeBgAnsi(theme, "toolBg") ??
            getThemeBgAnsi(theme, "background") ??
            BG_DEFAULT;
    exports.BG_ERROR = getThemeBgAnsi(theme, "toolErrorBg") ?? exports.BG_BASE;
    exports.RST = "\x1b[0m";
}
// ---------------------------------------------------------------------------
// Terminal
// ---------------------------------------------------------------------------
function termWidth() {
    if (process.stdout.columns)
        return Math.max(1, Math.min(process.stdout.columns, 210));
    const raw = process.stderr.columns ||
        Number.parseInt(process.env.COLUMNS ?? "", 10) ||
        200;
    return Math.max(1, Math.min(raw - 4, 210));
}
// ---------------------------------------------------------------------------
// File-type icons — Nerd Font glyphs
// ---------------------------------------------------------------------------
const ICONS_MODE = (process.env.PRETTY_ICONS ?? "nerd").toLowerCase();
exports.USE_ICONS = ICONS_MODE !== "none" && ICONS_MODE !== "off";
exports.NF_DIR = `${exports.FG_BLUE}\ue5ff${exports.RST}`;
exports.NF_DEFAULT = `${exports.FG_DIM}\uf15b${exports.RST}`;
const EXT_ICON = {
    ts: `\x1b[38;2;49;120;198m\ue628${exports.RST}`,
    tsx: `\x1b[38;2;49;120;198m\ue7ba${exports.RST}`,
    js: `\x1b[38;2;241;224;90m\ue74e${exports.RST}`,
    jsx: `\x1b[38;2;97;218;251m\ue7ba${exports.RST}`,
    mjs: `\x1b[38;2;241;224;90m\ue74e${exports.RST}`,
    cjs: `\x1b[38;2;241;224;90m\ue74e${exports.RST}`,
    py: `\x1b[38;2;55;118;171m\ue73c${exports.RST}`,
    rs: `\x1b[38;2;222;165;132m\ue7a8${exports.RST}`,
    go: `\x1b[38;2;0;173;216m\ue724${exports.RST}`,
    java: `\x1b[38;2;204;62;68m\ue738${exports.RST}`,
    swift: `\x1b[38;2;255;172;77m\ue755${exports.RST}`,
    rb: `\x1b[38;2;204;52;45m\ue739${exports.RST}`,
    kt: `\x1b[38;2;126;103;200m\ue634${exports.RST}`,
    c: `\x1b[38;2;85;154;211m\ue61e${exports.RST}`,
    cpp: `\x1b[38;2;85;154;211m\ue61d${exports.RST}`,
    cs: `\x1b[38;2;104;33;122m\ue648${exports.RST}`,
    html: `\x1b[38;2;228;77;38m\ue736${exports.RST}`,
    css: `\x1b[38;2;66;165;245m\ue749${exports.RST}`,
    scss: `\x1b[38;2;207;100;154m\ue749${exports.RST}`,
    vue: `\x1b[38;2;65;184;131m\ue6a0${exports.RST}`,
    svelte: `\x1b[38;2;255;62;0m\ue697${exports.RST}`,
    json: `\x1b[38;2;241;224;90m\ue60b${exports.RST}`,
    yaml: `\x1b[38;2;160;116;196m\ue6a8${exports.RST}`,
    yml: `\x1b[38;2;160;116;196m\ue6a8${exports.RST}`,
    toml: `\x1b[38;2;160;116;196m\ue6b2${exports.RST}`,
    xml: `\x1b[38;2;228;77;38m\ue619${exports.RST}`,
    md: `\x1b[38;2;66;165;245m\ue73e${exports.RST}`,
    mdx: `\x1b[38;2;66;165;245m\ue73e${exports.RST}`,
    sql: `\x1b[38;2;218;218;218m\ue706${exports.RST}`,
    sh: `\x1b[38;2;137;180;130m\ue795${exports.RST}`,
    bash: `\x1b[38;2;137;180;130m\ue795${exports.RST}`,
    zsh: `\x1b[38;2;137;180;130m\ue795${exports.RST}`,
    lua: `\x1b[38;2;81;160;207m\ue620${exports.RST}`,
    php: `\x1b[38;2;137;147;186m\ue73d${exports.RST}`,
    dart: `\x1b[38;2;87;182;240m\ue798${exports.RST}`,
    png: `\x1b[38;2;160;116;196m\uf1c5${exports.RST}`,
    jpg: `\x1b[38;2;160;116;196m\uf1c5${exports.RST}`,
    svg: `\x1b[38;2;255;180;50m\uf1c5${exports.RST}`,
    webp: `\x1b[38;2;160;116;196m\uf1c5${exports.RST}`,
    lock: `\x1b[38;2;130;130;130m\uf023${exports.RST}`,
    env: `\x1b[38;2;241;224;90m\ue615${exports.RST}`,
    graphql: `\x1b[38;2;224;51;144m\ue662${exports.RST}`,
    dockerfile: `\x1b[38;2;56;152;236m\ue7b0${exports.RST}`,
};
const NAME_ICON = {
    "package.json": `\x1b[38;2;137;180;130m\ue71e${exports.RST}`,
    "package-lock.json": `\x1b[38;2;130;130;130m\ue71e${exports.RST}`,
    "tsconfig.json": `\x1b[38;2;49;120;198m\ue628${exports.RST}`,
    ".gitignore": `\x1b[38;2;222;165;132m\ue702${exports.RST}`,
    ".env": `\x1b[38;2;241;224;90m\ue615${exports.RST}`,
    dockerfile: `\x1b[38;2;56;152;236m\ue7b0${exports.RST}`,
    makefile: `\x1b[38;2;130;130;130m\ue615${exports.RST}`,
    "readme.md": `\x1b[38;2;66;165;245m\ue73e${exports.RST}`,
    license: `\x1b[38;2;218;218;218m\ue60a${exports.RST}`,
};
function fileIcon(fp) {
    if (!exports.USE_ICONS)
        return "";
    const base = (0, node_path_1.basename)(fp).toLowerCase();
    if (NAME_ICON[base])
        return `${NAME_ICON[base]} `;
    const ext = (0, node_path_1.extname)(fp).slice(1).toLowerCase();
    // Default icon built from the CURRENT palette (NF_DEFAULT froze the dark one).
    return EXT_ICON[ext] ? `${EXT_ICON[ext]} ` : `${exports.FG_DIM}\uf15b${exports.RST} `;
}
function dirIcon() {
    // Built fresh so the dir-icon color follows a light/dark palette swap.
    return exports.USE_ICONS ? `${exports.FG_BLUE}\ue5ff${exports.RST} ` : "";
}
const EXT_LANG = {
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    rb: "ruby",
    rs: "rust",
    go: "go",
    java: "java",
    c: "c",
    cpp: "cpp",
    h: "c",
    hpp: "cpp",
    cs: "csharp",
    swift: "swift",
    kt: "kotlin",
    html: "html",
    css: "css",
    scss: "scss",
    less: "css",
    json: "json",
    jsonc: "jsonc",
    yaml: "yaml",
    yml: "yaml",
    toml: "toml",
    md: "markdown",
    mdx: "mdx",
    sql: "sql",
    sh: "bash",
    bash: "bash",
    zsh: "bash",
    lua: "lua",
    php: "php",
    dart: "dart",
    xml: "xml",
    graphql: "graphql",
    svelte: "svelte",
    vue: "vue",
    dockerfile: "dockerfile",
    makefile: "make",
    zig: "zig",
    nim: "nim",
    elixir: "elixir",
};
function detectLang(fp) {
    const base = (0, node_path_1.basename)(fp).toLowerCase();
    if (base === "dockerfile")
        return "dockerfile";
    if (base === "makefile" || base === "gnumakefile")
        return "make";
    return EXT_LANG[(0, node_path_1.extname)(fp).slice(1).toLowerCase()];
}
// ---------------------------------------------------------------------------
// Env helpers
// ---------------------------------------------------------------------------
function envInt(name, fallback) {
    const v = Number.parseInt(process.env[name] ?? "", 10);
    return Number.isFinite(v) && v > 0 ? v : fallback;
}
exports.MAX_HL_CHARS = envInt("PRETTY_MAX_HL_CHARS", 80_000);
exports.MAX_PREVIEW_LINES = envInt("PRETTY_MAX_PREVIEW_LINES", 80);
exports.CACHE_LIMIT = envInt("PRETTY_CACHE_LIMIT", 128);
// ---------------------------------------------------------------------------
// Agent directory helpers
// ---------------------------------------------------------------------------
function getDefaultAgentDir() {
    const home = process.env.HOME ?? "";
    return home ? (0, node_path_1.join)(home, ".pi/agent") : undefined;
}
//# sourceMappingURL=config.js.map