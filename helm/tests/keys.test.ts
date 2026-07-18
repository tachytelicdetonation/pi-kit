import assert from "node:assert/strict";
import test from "node:test";
import { decodeKey, type Key } from "../src/keys.js";

const cases: Array<[string, Key | null, string]> = [
  ["\r", { t: "enter" }, "CR -> enter"],
  ["\n", { t: "enter" }, "LF -> enter"],
  ["\r\n", { t: "enter" }, "CRLF chunk -> enter"],
  ["\t", { t: "tab" }, "tab"],
  ["\x7f", { t: "backspace" }, "DEL -> backspace"],
  ["\x08", { t: "backspace" }, "BS -> backspace"],
  ["\x1b", { t: "esc" }, "bare ESC -> esc"],
  ["\x1b[A", { t: "up" }, "up arrow (CSI)"],
  ["\x1b[B", { t: "down" }, "down arrow (CSI)"],
  ["\x1b[C", { t: "right" }, "right arrow (CSI)"],
  ["\x1b[D", { t: "left" }, "left arrow (CSI)"],
  ["\x1bOA", { t: "up" }, "up arrow (SS3 / DECCKM)"],
  ["\x1bOB", { t: "down" }, "down arrow (SS3 / DECCKM)"],
  ["\x1bOC", { t: "right" }, "right arrow (SS3 / DECCKM)"],
  ["\x1bOD", { t: "left" }, "left arrow (SS3 / DECCKM)"],
  ["\x15", { t: "ctrlU" }, "ctrl+u"],
  ["\x10", { t: "ctrlP" }, "ctrl+p"],
  ["?", { t: "char", ch: "?" }, "question mark is a literal char, not a semantic key"],
  ["a", { t: "char", ch: "a" }, "printable a"],
  ["5", { t: "char", ch: "5" }, "printable 5"],
  [" ", { t: "char", ch: " " }, "printable space"],
  ["\x01", null, "unknown control (ctrl+a) -> null"],
  ["\x1b[Z", null, "unmodelled CSI (shift-tab) -> null"],
  ["", null, "empty chunk -> null"],
  ["ab", null, "multi-char paste -> null"],
];

for (const [input, expected, label] of cases) {
  test(label, () => {
    assert.deepEqual(decodeKey(input), expected);
  });
}

test("esc and up are disambiguated structurally, no timeout", () => {
  // A bare escape byte is esc; the same byte followed by "[A" in one chunk is up.
  assert.deepEqual(decodeKey("\x1b"), { t: "esc" });
  assert.deepEqual(decodeKey("\x1b[A"), { t: "up" });
});
