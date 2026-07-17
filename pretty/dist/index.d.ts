/**
 * pi-pretty — Pretty terminal output for pi built-in tools.
 *
 * Enhances read, bash, ls, find, and grep with:
 *   • Syntax-highlighted file content (Shiki)
 *   • Colored bash exit status + output
 *   • Tree-view directory listings with file-type icons
 *   • FFF-accelerated find/grep with SDK fallback
 *   • Custom ANSI rendering for all tools
 */
export { __imageInternals } from "./image.js";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { PiPrettyDeps } from "./types.js";
export type { PiPrettyDeps };
export default function piPrettyExtension(pi: ExtensionAPI, deps?: PiPrettyDeps): Promise<void>;
//# sourceMappingURL=index.d.ts.map