"use strict";
/**
 * Lazy resolver for pi-tui Text constructor.
 *
 * Returns the real Text class from @earendil-works/pi-tui, or a stub when
 * pi-tui is unavailable (e.g. not in jiti's alias map). This avoids crashing
 * during tool registration when pi-tui isn't aliased.
 *
 * The resolution is cached — the require() call happens at most once.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTextCtor = getTextCtor;
exports.resolveTextCtor = resolveTextCtor;
/** No-op stub that satisfies the Text interface so rendering doesn't crash. */
class StubText {
    constructor(text = "") {
        this._text = text;
    }
    setText(v) {
        this._text = v ?? "";
    }
    render(_width) {
        // Container.render() calls child.render(); return the stored text as
        // lines so degradation is unstyled-but-visible instead of blank/crashing.
        return String(this._text).split("\n");
    }
    invalidate() {
        // Container.invalidate() calls child.invalidate() on resize; must exist
        // or the TUI crashes on the next resize.
    }
}
// FIX (pi-kit): resolve pi-tui at the TOP LEVEL, not inside resolve().
// Pi's loader (jiti) only rewrites its `@earendil-works/pi-tui` alias for static
// top-level require() calls — never for function-body require(). The original
// lazy resolve() therefore hit MODULE_NOT_FOUND in EVERY published install and
// silently fell back to StubText (blank output / the render crash we hit). This
// matches the working top-level require in tools/read.js.
const pi_tui_1 = require("@earendil-works/pi-tui");
const _ctor = pi_tui_1.Text ?? StubText;
function resolve() {
    return _ctor;
}
/**
 * Returns a Text constructor, always valid. Falls back to StubText if
 * @earendil-works/pi-tui is unavailable (caught and cached).
 */
function getTextCtor() {
    return resolve();
}
/**
 * Returns TextComp if provided, otherwise the lazy-resolved Text constructor.
 * Always returns a valid constructor (never undefined/null).
 */
function resolveTextCtor(TextComp) {
    return TextComp ?? resolve();
}
//# sourceMappingURL=tui-text.js.map