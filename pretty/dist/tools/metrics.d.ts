/**
 * pi-pretty: tool metrics wrapper — elapsed time + output size.
 *
 * Wraps execute functions to record performance metadata in result.details.
 */
import type { AgentToolResult, ExtensionContext } from "@earendil-works/pi-coding-agent";
type ExecuteFn = (tid: string, params: any, sig: AbortSignal | undefined, _upd: unknown, ctx: ExtensionContext) => Promise<AgentToolResult<Record<string, unknown>>>;
export declare function wrapExecuteWithMetrics(execute: ExecuteFn): ExecuteFn;
export {};
//# sourceMappingURL=metrics.d.ts.map