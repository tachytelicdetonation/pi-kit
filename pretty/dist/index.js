"use strict";
/**
 * pi-pretty — Pretty terminal output for pi built-in tools.
 *
 * Enhances read, bash, ls, find, and grep with:
 *   • Syntax-highlighted file content (Shiki)
 *   • Colored bash exit status + output
 *   • Tree-view directory listings with file-type icons
 *   • Custom ANSI rendering for all tools
 *
 * Search acceleration is intentionally NOT bundled here — install the separate
 * @ff-labs/pi-fff extension for FFF-backed find/grep. find/grep below render
 * whatever the host SDK search (fd/ripgrep) returns.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = piPrettyExtension;
const bash_js_1 = require("./tools/bash.js");
const find_js_1 = require("./tools/find.js");
const grep_js_1 = require("./tools/grep.js");
const ls_js_1 = require("./tools/ls.js");
const read_js_1 = require("./tools/read.js");
const edit_js_1 = require("./tools/edit.js");
const write_js_1 = require("./tools/write.js");
// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DEFAULT_DISABLED_TOOLS = new Set(["ls"]);
function envTools(name) {
    return new Set((process.env[name] ?? "")
        .split(",")
        .map((tool) => tool.trim().toLowerCase())
        .filter(Boolean));
}
async function piPrettyExtension(pi, deps) {
    const disabledTools = envTools("PRETTY_DISABLE_TOOLS");
    const enabledTools = envTools("PRETTY_ENABLE_TOOLS");
    const isToolEnabled = (name) => {
        const normalizedName = name.toLowerCase();
        return (!disabledTools.has(normalizedName) &&
            (!DEFAULT_DISABLED_TOOLS.has(normalizedName) || enabledTools.has(normalizedName)));
    };
    const cwd = process.cwd();
    // Text component for custom rendering (DI-friendly)
    const TextComp = deps?.TextComponent;
    // ------------------------------------------------------------------
    // Resolve SDK tools, if available
    // ------------------------------------------------------------------
    // The SDK import is optional. Do not return from the extension if it fails.
    let sdk = deps?.sdk ?? {};
    let createReadTool = sdk.createReadTool ?? sdk.createReadToolDefinition;
    let createBashTool = sdk.createBashTool ?? sdk.createBashToolDefinition;
    let createLsTool = sdk.createLsTool ?? sdk.createLsToolDefinition;
    let createFindTool = sdk.createFindTool ?? sdk.createFindToolDefinition;
    let createGrepTool = sdk.createGrepTool ?? sdk.createGrepToolDefinition;
    let createEditTool = sdk.createEditTool ?? sdk.createEditToolDefinition;
    let createWriteTool = sdk.createWriteTool ?? sdk.createWriteToolDefinition;
    if (!deps) {
        try {
            // Dynamic import() uses ESM resolution (not CJS interop), so it
            // correctly resolves subpath exports like @earendil-works/pi-ai/base
            // which only have "import" conditions in their exports map.
            const mod = await import("@earendil-works/pi-coding-agent");
            sdk = mod;
            createReadTool = sdk.createReadToolDefinition ?? sdk.createReadTool;
            createBashTool = sdk.createBashToolDefinition ?? sdk.createBashTool;
            createLsTool = sdk.createLsToolDefinition ?? sdk.createLsTool;
            createFindTool = sdk.createFindToolDefinition ?? sdk.createFindTool;
            createGrepTool = sdk.createGrepToolDefinition ?? sdk.createGrepTool;
            createEditTool = sdk.createEditToolDefinition ?? sdk.createEditTool;
            createWriteTool = sdk.createWriteToolDefinition ?? sdk.createWriteTool;
        }
        catch {
            createReadTool = undefined;
            createBashTool = undefined;
            createLsTool = undefined;
            createFindTool = undefined;
            createGrepTool = undefined;
            createEditTool = undefined;
            createWriteTool = undefined;
        }
    }
    // ------------------------------------------------------------------
    // Tool registration
    // ------------------------------------------------------------------
    if (isToolEnabled("read") && createReadTool) {
        (0, read_js_1.registerReadTool)(pi, cwd, null, createReadTool(cwd), TextComp);
    }
    if (isToolEnabled("bash") && createBashTool) {
        (0, bash_js_1.registerBashTool)(pi, cwd, null, createBashTool(cwd), TextComp);
    }
    if (isToolEnabled("ls") && createLsTool) {
        (0, ls_js_1.registerLsTool)(pi, cwd, null, createLsTool(cwd), TextComp);
    }
    if (isToolEnabled("find") && createFindTool) {
        (0, find_js_1.registerFindTool)(pi, cwd, null, createFindTool(cwd), TextComp);
    }
    if (isToolEnabled("grep") && createGrepTool) {
        (0, grep_js_1.registerGrepTool)(pi, cwd, null, createGrepTool(cwd), TextComp);
    }
    if (isToolEnabled("edit") && createEditTool) {
        (0, edit_js_1.registerEditTool)(pi, cwd, null, createEditTool(cwd), TextComp);
    }
    if (isToolEnabled("write") && createWriteTool) {
        (0, write_js_1.registerWriteTool)(pi, cwd, null, createWriteTool(cwd), TextComp);
    }
    // Fallback padding for SDK-rendered tool bodies. The SDK reads
    // result.content[0].text and slices collapsed output to roughly the first
    // 10 lines, so insert bottom padding inside that visible slice.
    const PADDED_TOOLS = new Set(["read", "grep", "bash"]);
    const RESULT_LEFT_PAD = "    ";
    const BOTTOM_PADDING_BY_TOOL = { read: 2, grep: 2, bash: 0 };
    pi.on("tool_result", (event, _ctx) => {
        if (!PADDED_TOOLS.has(event.toolName))
            return undefined;
        const first = event.content[0];
        if (!first || first.type !== "text")
            return undefined;
        const lines = first.text.split("\n").map((line) => `${RESULT_LEFT_PAD}${line}`);
        if (lines.length === 0)
            return undefined;
        const padCount = BOTTOM_PADDING_BY_TOOL[event.toolName] ?? 0;
        lines.push(...Array.from({ length: padCount }, () => RESULT_LEFT_PAD));
        return {
            content: [{ type: "text", text: lines.join("\n") }, ...event.content.slice(1)],
        };
    });
}
//# sourceMappingURL=index.js.map
