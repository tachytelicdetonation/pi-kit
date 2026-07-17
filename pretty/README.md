# pi-kit-pretty

Pretty, information-dense terminal output for Pi's built-in `read` / `bash` /
`ls` / `find` / `grep` tools.

This is a **vendored fork** of
[`@heyhuynhgiabuu/pi-pretty`](https://github.com/heyhuynhgiabuu/pi-pretty)
(v0.6.17, MIT © huynhgiabuu) — all credit for the original design and rendering
work goes to the author; see [`LICENSE-pi-pretty`](./LICENSE-pi-pretty). It's
forked so local fixes/redesign survive `pi install`/update (which wipes
`node_modules` edits) and because the tools didn't actually render on a stock
install (see below).

Every change vs upstream is marked with a `FIX (pi-kit):` comment in `dist/`.

## 1. The crash / no-render fix (why the fork exists)

Upstream resolved pi-tui with **function-body `require("@earendil-works/pi-tui")`**
in `dist/tui-text.js` and `dist/render.js`. Pi's loader (jiti) only rewrites its
pi-tui alias for **static, top-level** `require()`, so those lazy requires threw
`MODULE_NOT_FOUND` in every published install →

- `read`/`ls`/`find`/`grep` fell back to a stub component and rendered **nothing**;
- `bash`'s `fillToolBackground()` threw, so it silently fell back to stock rendering;
- a terminal resize could crash the whole TUI (`child.render is not a function`).

Fixed by moving those requires to the top level (matching upstream's own working
`tools/read.js`) and completing the `StubText` fallback with `render()`/`invalidate()`.

## 2. The output redesign

A user-centered redesign built on a shared design system (`dist/kit.js`). The
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
- **Shiki** now actually highlights (upstream fed Pi's theme name to Shiki, which
  isn't a valid Shiki theme → it always fell back to plain text).
- **Theme-adaptive** palette (dark/light) and full-width background fill fixed.

Env knobs: `PRETTY_THEME`, `PRETTY_ICONS=none`, `PRETTY_DISABLE_TOOLS`,
`PRETTY_ENABLE_TOOLS`, `PRETTY_MAX_PREVIEW_LINES`.

## Install

```bash
pi install /Users/tanmaydeshmukh/Projects/pi-kit/pretty
pi remove npm:@heyhuynhgiabuu/pi-pretty   # drop the broken direct install
```

Run `/reload` in Pi. Preview the rendering without Pi via `node ../preview.js`.

## Re-syncing from upstream

Re-copy upstream `dist/` over `./dist/`, then re-apply the `FIX (pi-kit):`-marked
edits (grep for them). Keeping the fork as a plain `dist/` copy makes that a diff.
