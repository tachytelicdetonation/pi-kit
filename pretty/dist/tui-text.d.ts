/**
 * Lazy resolver for pi-tui Text constructor.
 *
 * Returns the real Text class from @earendil-works/pi-tui, or a stub when
 * pi-tui is unavailable (e.g. not in jiti's alias map). This avoids crashing
 * during tool registration when pi-tui isn't aliased.
 *
 * The resolution is cached — the require() call happens at most once.
 */
type TextCtor = new (t?: string, x?: number, y?: number) => {
    setText(v: string): void;
    [k: string]: any;
};
/**
 * Returns a Text constructor, always valid. Falls back to StubText if
 * @earendil-works/pi-tui is unavailable (caught and cached).
 */
export declare function getTextCtor(): TextCtor;
/**
 * Returns TextComp if provided, otherwise the lazy-resolved Text constructor.
 * Always returns a valid constructor (never undefined/null).
 */
export declare function resolveTextCtor(TextComp?: TextCtor): TextCtor;
export {};
//# sourceMappingURL=tui-text.d.ts.map