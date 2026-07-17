import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { FffServiceWithCursor, SdkToolDef } from "../types.js";
export declare function registerGrepTool(pi: ExtensionAPI, cwd: string, fffService: FffServiceWithCursor | null | undefined, sdkTool: SdkToolDef, TextComp?: new (t?: string, x?: number, y?: number) => {
    setText(v: string): void;
}): void;
//# sourceMappingURL=grep.d.ts.map