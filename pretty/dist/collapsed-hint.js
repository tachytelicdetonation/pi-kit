"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.COLLAPSED_EXPAND_LABEL = void 0;
exports.collapsedExpandBlock = collapsedExpandBlock;
exports.collapsedExpandFooter = collapsedExpandFooter;
const config_js_1 = require("./config.js");
/** Shown in collapsed tool results; Pi keybinding is still `app.tools.expand` (Ctrl+O). */
exports.COLLAPSED_EXPAND_LABEL = "ctrl+o to expand";
/** Collapsed hint line (no extra blank lines above/below). */
function collapsedExpandBlock(countLabel) {
    return `${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}${countLabel} — ${exports.COLLAPSED_EXPAND_LABEL}${config_js_1.RST}\n`;
}
/** When line count / metrics already appear on the header line (bash). */
function collapsedExpandFooter() {
    return `${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}${exports.COLLAPSED_EXPAND_LABEL}${config_js_1.RST}\n`;
}
//# sourceMappingURL=collapsed-hint.js.map