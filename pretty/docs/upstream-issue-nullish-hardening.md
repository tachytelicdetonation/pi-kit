# Draft upstream issue — file at https://github.com/earendil-works/pi/issues

**Title:** Harden nullish text sinks in the interactive renderer (+ note: extension hot-cache can serve mid-edit state)

---

## Summary

A few string sinks in the interactive renderer interpolate caller-provided text
without a nullish guard, so a `null`/`undefined` value reaches the terminal as the
literal string `"undefined"`. Separately, the session-lifetime extension cache can
keep a partially-updated extension loaded after on-disk edits, which is one way to
reach those sinks with an undefined value. Filing a small hardening request plus a
DX note.

## How I hit it

While developing a path-referenced extension (a custom tool renderer), a running
tool-call row rendered as:

```
undefined⠧ edit path/to/file.ts · 4s
```

The `undefined` was glued directly in front of the extension's spinner glyph. The
cause on my side: the renderer interpolated a module constant that a mid-edit
`config` snapshot didn't yet export, so `${THAT_CONSTANT}` stringified to
`"undefined"`. The on-disk build was already consistent — but the running session
had cached the extension factory from a mid-edit state and never reloaded it (only
`/reload`/restart clears it). So the extension appeared to "print undefined" even
though its current source was clean.

I've guarded my own extension. Two host-side changes would make this class of
mistake fail safe and/or diagnosable.

## Ask 1 — nullish guards at text sinks (defensive)

These interpolate text without `?? ""`, so any nullish caller value renders the
literal word `undefined`:

- `dist/modes/interactive/theme/theme.js:258` and `:264`
  `return \`${ansi}${text}\x1b[39m\`` → `${text ?? ""}`
- `dist/modes/interactive/interactive-mode.js:2536` and `:2541`
  `theme.fg("dim", message)` — reachable from the public `ctx.ui.notify(message)`
  API → `message ?? ""`
- pi-tui `components/loader.js`, `updateDisplay`
  `${this.messageColorFn(this.message)}` → `this.messageColorFn(this.message ?? "")`

A nullish value here almost always signals an upstream mistake, but rendering the
literal word `undefined` into the transcript is the worst way to surface it — it
looks like a corrupted render rather than a missing value.

## Ask 2 — staleness signal for cached extensions (DX)

The extension cache (`dist/core/extensions/loader.js`, ~302-329) keeps the loaded
factory for the whole session with no signal that the on-disk file changed. For
path-referenced (local-dev) extensions, a mid-edit load can render a
partially-updated extension until `/reload`. A dev-mode mtime check — or even a
one-line hint that a loaded extension's source has changed since load — would
remove a confusing class of "my fix isn't taking / it's rendering garbage"
reports.

## Environment

- pi-coding-agent: `<fill version>`
- node 25.9.0, macOS

---

### Before filing (optional confirmation)

If the artifact recurs, capture it live to confirm it's the extension-glyph path
(vs. a host sink) before filing:

```
tmux capture-pane -e -p | grep -n undefined
```

- If `undefined` is **inside** the tool-row line, right before the braille char,
  and the color escape `\x1b[38;2;...m` is **absent** from that line → it's a
  stale-loaded extension constant (Ask 2 territory); restart clears it.
- If `undefined` is a **standalone** dim-wrapped line → it's a host text sink
  (Ask 1 territory).
