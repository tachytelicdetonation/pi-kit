"use strict";
/**
 * pi-pretty: tool metrics wrapper — elapsed time + output size.
 *
 * Wraps execute functions to record performance metadata in result.details.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.wrapExecuteWithMetrics = wrapExecuteWithMetrics;
const helpers_js_1 = require("../helpers.js");
function wrapExecuteWithMetrics(execute) {
    return async (tid, params, sig, upd, ctx) => {
        const start = performance.now();
        const result = await execute(tid, params, sig, upd, ctx);
        const elapsedMs = performance.now() - start;
        const details = (result.details ?? {});
        details[helpers_js_1.ELAPSED_KEY] = elapsedMs;
        details[helpers_js_1.CHARS_KEY] = getOutputCharCount(result);
        result.details = details;
        return result;
    };
}
function getOutputCharCount(result) {
    const content = result.content;
    if (!Array.isArray(content))
        return 0;
    let length = 0;
    for (const block of content) {
        if (block.type !== "text")
            continue;
        length += String(block.text ?? "").replace(/\r/g, "").length;
    }
    return length;
}
//# sourceMappingURL=metrics.js.map