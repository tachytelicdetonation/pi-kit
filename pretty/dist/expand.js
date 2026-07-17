"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.previewLineCount = previewLineCount;
const config_js_1 = require("./config.js");
/** Lines to show in tool result body when collapsed vs expanded. */
function previewLineCount(ctx, totalLines) {
    if (ctx.expanded)
        return totalLines;
    return Math.min(totalLines, config_js_1.MAX_PREVIEW_LINES);
}
//# sourceMappingURL=expand.js.map