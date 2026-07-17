/**
 * pi-pretty: Terminal image rendering (iTerm2 / Kitty / Ghostty inline image protocols).
 * Handles tmux passthrough for image protocols.
 */
type ImageProtocol = "iterm2" | "kitty" | "none";
declare function isTmuxSession(): boolean;
declare function getOuterTerminal(): string;
declare function detectImageProtocol(): ImageProtocol;
declare function tmuxAllowsPassthrough(): boolean | null;
declare function getTmuxPassthroughWarning(protocol: ImageProtocol): string | null;
declare function tmuxWrap(seq: string): string;
export declare const __imageInternals: {
    isTmuxSession: typeof isTmuxSession;
    getOuterTerminal: typeof getOuterTerminal;
    detectImageProtocol: typeof detectImageProtocol;
    tmuxWrap: typeof tmuxWrap;
    tmuxAllowsPassthrough: typeof tmuxAllowsPassthrough;
    getTmuxPassthroughWarning: typeof getTmuxPassthroughWarning;
    setTmuxClientTermOverrideForTests: (value: string | null | undefined) => void;
    setTmuxAllowPassthroughOverrideForTests: (value: boolean | null | undefined) => void;
    resetCachesForTests: () => void;
};
export {};
//# sourceMappingURL=image.d.ts.map