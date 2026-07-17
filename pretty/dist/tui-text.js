"use strict";
/**
 * pi-tui Text component helpers.
 *
 * ZeroText / zeroText are our own zero-height result component. StubText and the
 * Text-constructor resolver below cover the case where @earendil-works/pi-tui is
 * not reachable, so tool registration and rendering degrade instead of crashing.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.getTextCtor = getTextCtor;
exports.resolveTextCtor = resolveTextCtor;
exports.zeroText = zeroText;
/**
 * Zero-height result component (Round 3 F1).
 *
 * A Tier-0 collapsed success contributes exactly ONE visible line to the stream
 * (its header, with the summary fused in). The result component must therefore
 * render nothing at all. ZeroText.render() returns a length-0 array so the
 * container emits no rows for it.
 *
 * setText/invalidate are no-ops but MUST exist: the host calls setText on
 * re-render and invalidate on resize (StubText comment above documents the same
 * resize-crash precedent). render(_w) → [] for any width.
 */
class ZeroText {
    setText() {
        // no-op: this component intentionally has no content
    }
    invalidate() {
        // no-op: exists so Container.invalidate() on resize doesn't crash
    }
    render(_width) {
        return [];
    }
}
exports.ZeroText = ZeroText;
/**
 * Returns a stable ZeroText instance cached on ctx.state.__kitZero so
 * ctx.lastComponent identity stays constant across passes (the host keeps a
 * single child; a fresh instance each pass would churn lastComponent).
 */
function zeroText(ctx) {
    const state = ctx && ctx.state;
    if (!state)
        return new ZeroText();
    return (state.__kitZero ??= new ZeroText());
}

// Minimal component that satisfies the pi-tui Text interface. Used only as the
// fallback when the real Text class cannot be loaded; it keeps output visible
// (unstyled) rather than blank, and its invalidate() exists so a resize doesn't
// crash the container.
class StubText {
    constructor(text = "") {
        this._text = text;
    }
    setText(value) {
        this._text = value ?? "";
    }
    render(_width) {
        return String(this._text).split("\n");
    }
    invalidate() {
        // no-op: Container.invalidate() calls this on every resize
    }
}

// pi-tui is resolved once, at module top level. Pi's jiti loader only rewrites
// its @earendil-works/pi-tui alias for a static top-level require(); a require()
// inside a function body would fail with MODULE_NOT_FOUND in a published install
// and silently strand every caller on StubText. When the module (or its Text
// export) is missing we fall back to StubText.
const pi_tui_1 = require("@earendil-works/pi-tui");
const TEXT_CTOR = pi_tui_1.Text ?? StubText;

/** The resolved Text constructor; always a valid class. */
function getTextCtor() {
    return TEXT_CTOR;
}

/** `TextComp` when the caller supplies one, otherwise the resolved constructor. */
function resolveTextCtor(TextComp) {
    return TextComp ?? TEXT_CTOR;
}
//# sourceMappingURL=tui-text.js.map