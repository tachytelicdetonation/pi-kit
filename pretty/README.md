# pi-kit-pretty

Pretty, information-dense terminal output for Pi's built-in `read` / `bash` /
`ls` / `find` / `grep` tools.

The extension ships as compiled JS in `dist/` (the source of truth) and installs
as a local path ref so its rendering survives `pi install`/update, which wipes
`node_modules` edits.

## 1. pi-tui require resolution

`@earendil-works/pi-tui` is required at module top level on purpose. Pi's loader
(jiti) only rewrites its pi-tui alias for a **static, top-level** `require()`, so
resolving pi-tui inside a function body throws `MODULE_NOT_FOUND` at render time.
Keeping the requires at the top level (and giving the `StubText` fallback a real
`render()`/`invalidate()`) is what makes every tool render reliably and keeps a
terminal resize from crashing the TUI.

## 2. The output design

A user-centered design built on a shared design system (`dist/kit.js`). The
principle: **the default view answers "did it work · how big · do I care" at a
glance**, with one fused marker line as the only expand affordance.

- **Header grammar** — every tool: `{✓/✗/·} {title} {primary} {dim annotations}`.
- **Progressive disclosure** — inline when small; head/tail window when big;
  full on `ctrl+o`. One dim marker line: `… +N lines · counts · duration · ctrl+o`
  (shown only when something is hidden).
- **bash** — inline ≤6 lines, else head 4 / tail 2 (errors tail-biased, on error bg);
  real exit code, no substring guessing.
- **read** — file peek (≤8 lines whole, else 4) with a line-number gutter and
  Shiki syntax highlighting; size in the marker.
- **grep** — ≤8 matches shown grouped + highlighted; more → a per-file count strip.
- **ls** — `ls -C` columns, dirs first, with file-type icons.
- **find** — directory histogram showing where matches cluster.
- **Shiki** highlighting with a valid theme name so highlighting actually applies.
- **Theme-adaptive** palette (dark/light) and full-width background fill.

Env knobs: `PRETTY_THEME`, `PRETTY_ICONS=none`, `PRETTY_DISABLE_TOOLS`,
`PRETTY_ENABLE_TOOLS`, `PRETTY_MAX_PREVIEW_LINES`.

## Install

```bash
pi install /Users/tanmaydeshmukh/Projects/pi-kit/pretty
```

Run `/reload` in Pi. Preview the rendering without Pi via `node ../preview.js`.
