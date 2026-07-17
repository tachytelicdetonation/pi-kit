"use strict";
// Wraps a tool's execute function so every run reports its own cost: the
// wrapper times the call and stamps the result's `details` with elapsed
// milliseconds and the character volume of the emitted text, which the
// renderers later surface to the user.
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapExecuteWithMetrics = wrapExecuteWithMetrics;
const helpers_js_1 = require("../helpers.js");
// Total printable characters across the result's text blocks. Carriage
// returns are dropped so counts stay stable regardless of line endings.
function countTextChars(result) {
    const blocks = result?.content;
    if (!Array.isArray(blocks))
        return 0;
    return blocks.reduce((total, block) => {
        if (block?.type !== "text")
            return total;
        return total + String(block.text ?? "").replace(/\r/g, "").length;
    }, 0);
}
function wrapExecuteWithMetrics(execute) {
    return async (tid, params, sig, upd, ctx) => {
        const startedAt = performance.now();
        const result = await execute(tid, params, sig, upd, ctx);
        const details = result.details ?? {};
        details[helpers_js_1.ELAPSED_KEY] = performance.now() - startedAt;
        details[helpers_js_1.CHARS_KEY] = countTextChars(result);
        result.details = details;
        return result;
    };
}
//# sourceMappingURL=metrics.js.map
