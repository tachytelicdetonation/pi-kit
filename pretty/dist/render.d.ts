/**
 * pi-pretty: rendering functions for all tools.
 *
 * These produce ANSI-colored terminal output strings.
 * They are async only when Shiki syntax highlighting is involved.
 */
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import type { RenderCtxLike as RenderContext, ThemeLike } from "./types.js";
export declare function isLowContrastShikiFg(params: string): boolean;
export declare const RESET_WITHOUT_BG = "\u001B[22;23;24;25;27;28;29;39m";
export declare function preserveBoxBackground(ansi: string): string;
export declare function fillToolBackground(text: string, bg?: string, width?: number): string;
export declare function renderToolMetrics(result: AgentToolResult<Record<string, unknown>>): string;
export declare function renderToolDuration(result: AgentToolResult<Record<string, unknown>>): string;
export declare function renderToolError(error: string, theme: ThemeLike): string;
export declare function renderFileContent(content: string, filePath: string, offset?: number, maxLines?: number, width?: number): Promise<string>;
export declare function renderBashOutput(text: string): string;
export declare function renderTree(text: string, _basePath: string): string;
export declare function renderFindResults(text: string, theme?: ThemeLike): string;
export declare function renderGrepResults(text: string, pattern: string): Promise<string>;
export declare function makeRenderCall(toolName: string): (args: Record<string, unknown>, theme: ThemeLike, ctx: RenderContext) => any;
export declare function makeRenderResult(): (result: AgentToolResult<Record<string, unknown>>, _opt: unknown, theme: ThemeLike, ctx: RenderContext) => any;
//# sourceMappingURL=render.d.ts.map