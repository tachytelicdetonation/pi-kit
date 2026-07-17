"use strict";
/* pretty: the dim "expand" hint appended to collapsed tool results. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.COLLAPSED_EXPAND_LABEL = void 0;
exports.collapsedExpandBlock = collapsedExpandBlock;
exports.collapsedExpandFooter = collapsedExpandFooter;
const config_js_1 = require("./config.js");

// Prompt text for the collapsed-result expand affordance. The underlying Pi
// keybinding remains `app.tools.expand` (Ctrl+O).
exports.COLLAPSED_EXPAND_LABEL = "ctrl+o to expand";

// Wrap a piece of hint text in the shared indent + dim color, terminated by a
// reset and newline, matching the surrounding tool-result formatting.
function dimHintLine(text) {
    return `${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}${text}${config_js_1.RST}\n`;
}

// Standalone collapsed-hint line combining a count label with the expand
// prompt, e.g. "12 lines — ctrl+o to expand".
function collapsedExpandBlock(countLabel) {
    return dimHintLine(`${countLabel} — ${exports.COLLAPSED_EXPAND_LABEL}`);
}

// Bare expand prompt for cases where counts/metrics are already shown on the
// header line (e.g. bash results).
function collapsedExpandFooter() {
    return dimHintLine(exports.COLLAPSED_EXPAND_LABEL);
}
//# sourceMappingURL=collapsed-hint.js.map