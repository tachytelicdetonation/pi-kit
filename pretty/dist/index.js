"use strict";
/*
 * pretty — richer terminal rendering for Pi's built-in file tools.
 *
 * At load time the extension locates the host SDK's tool factories — either the
 * ones injected through `deps` (tests / DI) or, failing that, the ones exposed
 * by a dynamic import of the coding-agent package — and re-registers read, bash,
 * ls, find, grep, edit and write with pretty renderers. A tool_result hook then
 * left-pads (and bottom-pads) the few tools whose bodies the host slices for its
 * collapsed preview.
 *
 * No search backend ships here: find/grep only render whatever the host search
 * (fd/ripgrep) returns. Install @ff-labs/pi-fff separately for FFF-backed search.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = piPrettyExtension;
const read_js_1 = require("./tools/read.js");
const bash_js_1 = require("./tools/bash.js");
const ls_js_1 = require("./tools/ls.js");
const find_js_1 = require("./tools/find.js");
const grep_js_1 = require("./tools/grep.js");
const edit_js_1 = require("./tools/edit.js");
const write_js_1 = require("./tools/write.js");
// Tools that stay off unless the operator opts in via PRETTY_ENABLE_TOOLS.
const OPT_IN_TOOLS = new Set(["ls"]);
// Parse a comma-separated env var into a set of lowercased tool names.
function parseToolNames(envName) {
    return new Set((process.env[envName] ?? "")
        .split(",")
        .map((entry) => entry.trim().toLowerCase())
        .filter(Boolean));
}
// Pick a factory from the SDK, tolerating both the `createXTool` and the
// `createXToolDefinition` naming. `preferDefinition` selects which name wins
// when the SDK happens to expose both.
function pickFactory(sdk, base, preferDefinition) {
    const plain = sdk["create" + base + "Tool"];
    const definition = sdk["create" + base + "ToolDefinition"];
    return preferDefinition ? (definition ?? plain) : (plain ?? definition);
}
async function piPrettyExtension(pi, deps) {
    const disabled = parseToolNames("PRETTY_DISABLE_TOOLS");
    const enabled = parseToolNames("PRETTY_ENABLE_TOOLS");
    const isToolEnabled = (name) => {
        const key = name.toLowerCase();
        if (disabled.has(key))
            return false;
        // Opt-in tools require an explicit entry in PRETTY_ENABLE_TOOLS.
        if (OPT_IN_TOOLS.has(key))
            return enabled.has(key);
        return true;
    };
    const cwd = process.cwd();
    const TextComp = deps?.TextComponent;
    // Resolve the SDK. When deps are supplied we trust deps.sdk as-is; otherwise
    // we import the host package. The import is best-effort — a failure simply
    // leaves an empty SDK so no tools register, rather than aborting the load.
    // The `create*ToolDefinition` names take precedence on the imported SDK,
    // whereas the injected SDK favours the plain `create*Tool` names.
    let sdk = deps?.sdk ?? {};
    let preferDefinition = false;
    if (!deps) {
        try {
            // A dynamic import() follows ESM resolution, which is required for the
            // package's subpath "import"-only conditions to resolve correctly.
            sdk = await import("@earendil-works/pi-coding-agent");
            preferDefinition = true;
        }
        catch {
            sdk = {};
        }
    }
    // read/bash/ls/find/grep/edit/write, each paired with its register function.
    const toolTable = [
        ["Read", read_js_1.registerReadTool],
        ["Bash", bash_js_1.registerBashTool],
        ["Ls", ls_js_1.registerLsTool],
        ["Find", find_js_1.registerFindTool],
        ["Grep", grep_js_1.registerGrepTool],
        ["Edit", edit_js_1.registerEditTool],
        ["Write", write_js_1.registerWriteTool],
    ];
    for (const [base, register] of toolTable) {
        const factory = pickFactory(sdk, base, preferDefinition);
        if (isToolEnabled(base) && factory) {
            register(pi, cwd, null, factory(cwd), TextComp);
        }
    }
    // Padding for SDK-rendered bodies. The host reads content[0].text and keeps
    // roughly the first ten lines for its collapsed view, so any bottom spacing
    // has to sit inside that visible slice. Each padded line also gets a fixed
    // left indent.
    const PADDED_TOOLS = new Set(["read", "grep", "bash"]);
    const LEFT_PAD = "    ";
    const BOTTOM_PAD_LINES = { read: 2, grep: 2, bash: 0 };
    pi.on("tool_result", (event) => {
        if (!PADDED_TOOLS.has(event.toolName))
            return undefined;
        const [firstBlock, ...restBlocks] = event.content;
        if (!firstBlock || firstBlock.type !== "text")
            return undefined;
        const lines = firstBlock.text.split("\n").map((line) => LEFT_PAD + line);
        if (lines.length === 0)
            return undefined;
        const extra = BOTTOM_PAD_LINES[event.toolName] ?? 0;
        for (let i = 0; i < extra; i++) {
            lines.push(LEFT_PAD);
        }
        return {
            content: [{ type: "text", text: lines.join("\n") }, ...restBlocks],
        };
    });
}
//# sourceMappingURL=index.js.map
