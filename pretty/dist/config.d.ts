/**
 * pi-pretty: ANSI codes, icons, theme, and environment config.
 */
/** Left indent for rendered tool result lines (was two spaces; one matches tighter TUI layout). */
export declare const TOOL_RESULT_INDENT = " ";
export declare let RST: string;
export declare const FG_LNUM = "\u001B[38;2;100;100;100m";
export declare const FG_DIM = "\u001B[38;2;80;80;80m";
export declare const FG_RULE = "\u001B[38;2;50;50;50m";
export declare const FG_GREEN = "\u001B[38;2;100;180;120m";
export declare const FG_RED = "\u001B[38;2;200;100;100m";
export declare const FG_YELLOW = "\u001B[38;2;220;180;80m";
export declare const FG_BLUE = "\u001B[38;2;100;140;220m";
export declare const FG_MUTED = "\u001B[38;2;139;148;158m";
export declare let BG_BASE: string;
export declare let BG_ERROR: string;
type BgThemeLike = {
    getBgAnsi?: (key: string) => string;
    bg?: (key: string, text: string) => string;
};
export declare function resolveBaseBackground(theme: BgThemeLike | null | undefined): void;
export declare function termWidth(): number;
export declare const USE_ICONS: boolean;
export declare const NF_DIR: string;
export declare const NF_DEFAULT: string;
export declare function fileIcon(fp: string): string;
export declare function dirIcon(): string;
import type { BundledLanguage } from "shiki";
export declare function detectLang(fp: string): BundledLanguage | undefined;
export declare function envInt(name: string, fallback: number): number;
export declare const MAX_HL_CHARS: number;
export declare const MAX_PREVIEW_LINES: number;
export declare const CACHE_LIMIT: number;
export declare function getDefaultAgentDir(): string | undefined;
export {};
//# sourceMappingURL=config.d.ts.map