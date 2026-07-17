"use strict";
// How many body lines a tool result should reveal: the full count when the
// block is expanded, otherwise clamped to the configured preview ceiling.
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewLineCount = previewLineCount;
const config_js_1 = require("./config.js");
function previewLineCount(ctx, totalLines) {
    if (!ctx.expanded && totalLines > config_js_1.MAX_PREVIEW_LINES) {
        return config_js_1.MAX_PREVIEW_LINES;
    }
    return totalLines;
}
//# sourceMappingURL=expand.js.map
