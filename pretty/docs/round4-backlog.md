# Round 4 — ambitious backlog ("the transcript people screenshot")

Oracle-authored (Fable 5), grounded in a read of `kit.js`, `config.js`, `render.js`,
`diff.js`, `tools/read.js`, `tools/bash.js`, and the round-3 doc. This is the
build-ready spec for the next workflow. Ranked; top 3 first.

## Enabling facts (why the hard idea is even possible)
1. Historical components DO repaint — `markDone`'s microtask + `ctx.invalidate()`
   (kit.js) proves it.
2. Component-type swapping across passes is already solved — read.js swaps
   `ZeroText`↔`Text` between renderCall/renderResult.
3. `ZeroText` proves a call can contribute **zero visible lines**.

Together these mean **retroactive transcript editing** may be feasible with no
host changes. **GATED by the Phase-0 spike** (can a component ~20 entries back
still `invalidate()` and repaint / shrink-to-zero, or does Pi freeze committed
rows?). If the spike says NOT feasible, idea #1 degrades to *fold-at-renderCall*
(collapse only while the row is still un-committed) — #2/#3 are unaffected.

---

## TOP 3 — build these

### 1. Fold registry — run coalescing as retroactive collapse ★★★★★ (M–H) — BUILD FIRST
Consecutive related calls collapse into the **newest** header; older ones render
zero-height. `read kit.js · ×4 · 312 lines`. ctrl+o on the survivor unfolds the
whole run into today's exact rendering.

- New `dist/runs.js`: module-level array `{tool, key, state, invalidate}` (extension
  loads once per process → module state persists). Cap ~50 entries; wrap stale
  `invalidate` refs in try/catch (session resume tolerance).
- Each `renderCall`: register + check. If previous entry has same `(tool, key)`
  — key = resolved path for read/edit, term for grep — set
  `prev.state.__kitFolded = true` and schedule `prev.invalidate()` via ONE
  microtask (the markDone pattern). Guard at top of each tool's renderCall:
  `if (ctx.state.__kitFolded && !ctx.expanded) return kit.zeroText(ctx)`
  (also drop the leading `"\n"` read prepends).
- Survivor header gets a run seg via `setSummary`: `· ×4`.
- ctrl+o on survivor: set `__kitFolded=false` on all run members + invalidate them.
- **Two tiers:** (a) *strict run* = same tool+key consecutive, `×N` seg, ship first.
  (b) *exploration burst* = ≥4 consecutive Tier-0 successes of ANY kind fold into
  one digest: `✓ explored · read ×5 · grep ×3 · 12 files · ctrl+o`. Ship behind #1.
- **Spike hazards:** can a 20-entries-back component still invalidate? does resume
  leave stale refs? does shrink-to-zero reflow correctly?

### 2. Liveness pack — spinner + ticking elapsed ★★★★★ (M)
Static `· $ npm test` for 90s reads as hung; `⠸ $ npm test · 47s` reads as alive.
Biggest *feel* gap vs best-in-class TUIs.

- `kit.glyph()`: when status is `run`, return a frame from `⠋⠙⠹⠸⠼⠴⠦⠧` indexed by time.
- ONE shared module-level 250ms interval that invalidates only ctxs currently in
  `run` state; self-terminates when that Set empties (markDone discipline).
- `renderCall` appends a dim live-duration seg when running >3s.
- Spinner uses the new CYAN (see palette). Never tick when nothing is pending.
- **NOTE:** scripts can't call `Date.now()`/`Math.random()` — but this is runtime
  extension code, not a workflow script, so timers are fine. Verify the host allows
  `setInterval` in extension context.

### 3. Semantic verdicts — parse bash tail, promote the answer ★★★★ (L–M)
`✓ $ npm test · 84 passed · 3.2s` (green count) instead of 5 tail lines. Purest
expression of "render by consequence" — bash currently renders by *output*.

- New `dist/tools/verdicts.js`: ordered regex extractors over the last ~15 lines of
  `cleaned` (bash.js). Shapes: vitest/jest `N passed`, tsc `Found N errors`,
  cargo `test result: ok`, eslint `N problems`, pytest `N passed in`, make/exit.
- On match: `kit.setSummary(ctx, [verdictSeg, durationSeg])` with `greenSeg`/`redSeg`
  for pass/fail counts — a *licensed* budget extension (verdicts sit on the same
  "did it work" axis as the glyph). No match → today's behavior.
- When a verdict is extracted AND exit 0, shrink tail window 5→2.

---

## QUICK WINS (independent, parallel-safe, no spike)

### 4. OSC-8 hyperlinks — every path is a link ★★★★ (L, verify first)
cmd-click any path → open file at line in editor. `kit.pathSeg` wraps in
`\x1b]8;;file://HOST/abs/path\x1b\\ … \x1b]8;;\x1b\\`; `gutterLine` links
`file://path#Ln` (editor URL scheme configurable in pi-pretty.json).
**Gate:** verify pi-tui `visibleWidth`/`truncateToWidth` treat OSC-8 as zero-width
and never split mid-sequence; `preserveBoxBackground`'s SGR-only regex leaves OSC
intact (it does). If truncation splits a link, apply links AFTER truncation.

### 5. Cross-tool narrative tags ★★★ (L, needs #1's registry)
`read kit.js · verify` after editing it; `edit kit.js · again ×2` (thrash signal).
read-after-edit → dim `verify`; grep-after-edit same term → `recheck`; edit same
file ≥2× → `again ×N`.

### 6. Diff meter — GitHub's five squares ★★★ (L)
`■■■□□ +38 −12` in edit/write markers. 5 cells from `summarizeDiff` proportions
(greenSeg/redSeg/dim). Preattentive magnitude; reuses licensed diff colors.

### 7. Symbol-context hunks ★★★ (M)
`✓ edit kit.js · header() · +3 −1` + dim `── header()` rails above hunks when
expanded. `diff.js toHunks` scans backward for nearest
`function|class|def|fn|const X = (`; `edit.js` puts hunk-1 symbol in setSummary;
`renderDiff` emits it on the `sep()` line instead of bare `···`.

### 8. Yellow for "absence is information" ★★ (trivial)
`0 matches` / `0 files` in FG_YELLOW not dim (grep/find summaries). Optional: dim
yellow `warnings` seg on bash success with `warning:` lines in tail.

### 9. Failure autopsy — first frame in failLines ★★ (M)
`kit.failLines` regexes the error body for the first `path:line:col` frame, prepends
a marker seg. With #4 the failure header becomes a clickable jump-to-cause.

---

## Palette (the "bolder color" answer) — 2 hues → 5, discipline kept

| Hue | Meaning | Fires when | Emitters |
|---|---|---|---|
| Green | confirmed good | ✓ glyph; diff adds; pass-verdicts | glyph, diff.js, verdicts |
| Red | broken | ✗ glyph; diff dels; fail-verdicts; BG_ERROR | glyph, diff.js, verdicts, failLines |
| Yellow | attention, not failure | grep term (existing); 0-result summaries; git-dirty M/?; `exit N`; durations >30s | grep, find, bash marker |
| Blue | you can act here | `ctrl+o` seg in markers — the affordance, nothing else | kit.marker (special-case the literal) |
| Cyan (new ~`38;2;100;170;180` dark / `0;130;145` light) | liveness | spinner + ticking elapsed, only while `run`; dies at completion | kit.glyph |
| Bold default-fg | the noun | basename in *mutation* headers only (edit/write/bash) — weight not hue carries hierarchy | pathSeg opt-in flag |

**Unifying rule:** color may only encode state on the consequence axis
(good/bad/attention/alive) or interactivity — never tool identity, never file type,
never decoration. Add both palettes to `config.js PALETTE`; extend
`assertColorBudget` (round-3 §5 V8) with the new emitters.

---

## SKIP
- Syntax-highlighting revival — round-3 cut it for loop-safety with a written
  rationale (diff.js:14-21); least delight per risk.
- Tool-class hue coding / nerd-font icons / boxed group frames — violate
  one-meaning-per-hue; re-add the chrome round-3 buried.
- Persistent session footer/ledger widget — needs a host TUI surface we don't own;
  the burst digest (#1b) gets 80% of it inside the transcript.

## Sequencing
Phase 0 = the #1 hazard spike (half-day, alone, GATES the top). Then #2/#3/#4/#6/#8
are mutually independent files → fan out in parallel. #5/#7/#9 follow their deps.
