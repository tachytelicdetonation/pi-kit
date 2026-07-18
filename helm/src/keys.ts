/**
 * Raw terminal byte chunks → semantic keys.
 *
 * The host delivers `handleInput(data: string)` as raw byte chunks. This decoder
 * is pure and synchronous: it recognises complete known sequences within a single
 * chunk and has NO timeout-based state (the classic esc-vs-arrow ambiguity is
 * resolved structurally — a bare one-byte "\x1b" is esc, `"\x1b[A"` is up). That
 * relies on the terminal delivering escape sequences as a single chunk, which is
 * the norm for the paste/keypress path pi uses.
 */

/**
 * A decoded key: a named control key, or a printable character.
 *
 * Note `"?"` is intentionally NOT a semantic key — it decodes to `{t:"char"}`.
 * The per-screen help binding is context-dependent (help only when the prompt is
 * empty; otherwise `?` is literal text), so that decision lives in dispatch, not
 * here — keeping the decoder pure and letting a `?` be typed into any prompt.
 */
export type Key =
  | {
      t:
        | "enter"
        | "esc"
        | "tab"
        | "up"
        | "down"
        | "left"
        | "right"
        | "backspace"
        | "ctrlQ"
        | "ctrlU"
        | "ctrlP";
    }
  | { t: "char"; ch: string };

/**
 * Decode a single input chunk into a {@link Key}, or `null` for anything not in
 * the vocabulary (unknown control bytes, incomplete/foreign escape sequences,
 * empty input). Never throws.
 */
export function decodeKey(data: string): Key | null {
  if (!data) return null;

  // CRLF as a single chunk is still one Enter.
  if (data === "\r\n") return { t: "enter" };

  // Multi-byte escape sequences: match the exact arrow forms first. Both the CSI
  // form (ESC [ A) and the SS3 / application-cursor-key form (ESC O A) are
  // recognised — a full-screen TUI often puts the terminal in DECCKM, where
  // arrows arrive as ESC O x, so handling only CSI would leave arrows dead.
  if (data.length > 1 && data.charCodeAt(0) === 0x1b) {
    switch (data) {
      case "\x1b[A":
      case "\x1bOA":
        return { t: "up" };
      case "\x1b[B":
      case "\x1bOB":
        return { t: "down" };
      case "\x1b[C":
      case "\x1bOC":
        return { t: "right" };
      case "\x1b[D":
      case "\x1bOD":
        return { t: "left" };
      default:
        // Some other CSI/escape sequence we don't model.
        return null;
    }
  }

  const codePoints = Array.from(data);
  if (codePoints.length === 1) {
    switch (data) {
      case "\r":
      case "\n":
        return { t: "enter" };
      case "\t":
        return { t: "tab" };
      case "\x7f":
      case "\x08":
        return { t: "backspace" };
      case "\x15":
        return { t: "ctrlU" };
      case "\x10":
        return { t: "ctrlP" };
      case "\x11":
        return { t: "ctrlQ" };
      case "\x1b":
        // A BARE escape byte — this is the esc key, not the lead of an
        // (unarrived) arrow sequence. No timeout, no ambiguity.
        return { t: "esc" };
    }
    const code = data.codePointAt(0)!;
    const isControl = code < 0x20 || (code >= 0x7f && code <= 0x9f);
    const isSurrogate = code >= 0xd800 && code <= 0xdfff;
    if (!isControl && !isSurrogate) return { t: "char", ch: data };
    return null;
  }

  // Multi-character non-escape chunk (e.g. a paste). Not a single semantic key.
  return null;
}
