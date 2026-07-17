<!--
Provenance: oracle (Fable 5) fundamental-redesign plan consult, 2026-07-16.
Executes as ROUND 3, AFTER the round-2 workflow `pretty-diff-and-polish` (diff
renderer + edit/write tools + pathSeg + git-status + gutter) has landed and been
committed. Decision to adopt the full "render by consequence" redesign as the
hard default: user, 2026-07-16 (see the output-improvements memory notes).
This doc is the spec a future multi-agent workflow executes directly.
-->

# Round 3 — Render by Consequence: Implementation Plan

**Target:** `/Users/tanmaydeshmukh/Projects/pi-kit/pretty/dist/` (compiled JS is source of truth). Harness: `/Users/tanmaydeshmukh/Projects/pi-kit/preview.js`.

> Verdict: this redesign is a re-aiming of existing kit primitives, not a rewrite — decomposed into 1 foundation task + 7 parallel per-tool tasks + verify + review, with the two genuinely novel mechanisms (result→header summary fusion via the shared `ctx.state`, and a zero-height result component) specified exactly and both riding the already-proven `markDone` deferred-redraw pattern (kit.js:54-66), so no new invalidate loops are possible.

## Executive summary

- **Shape:** Phase 0 (one agent, kit.js + config.js + render.js + tui-text.js) → Phase 1 (7 parallel agents, one per tool file) → Phase 2 (harness, one agent) → Phase 3 (adversarial review). No tool file is touched in Phase 0; no shared file is touched in Phase 1 — zero merge conflicts by construction.
- **The two new mechanisms:** (1) *header summary fusion* — `renderResult` stashes a dim summary string on the shared `ctx.state`, and `kit.header()` (called by `renderCall`) appends it; the redraw is the same single self-terminating microtask `markDone` already schedules. (2) *zero-height result* — a `ZeroText` component (render → `[]`) so Tier-0 successes contribute exactly one visible line to the stream.
- **Tier 2 is centralized:** one kit helper (`kit.failLines`) that every tool's `ctx.isError` branch (and bash's nonzero-exit branch) routes through — full body, red-tinted, tail-biased window only above 30 lines.
- **All async is removed from read.js and grep.js** (Shiki cut); the only remaining async paths are `markDone`'s microtask and diff.js's guarded progressive Shiki. Loop-safety surface shrinks.
- **Not toggleable.** Hard default per user decision (memory doc, 2026-07-16). No new env flags.

---

## 1. Design contract (read this before any task)

### 1.1 Tiering mechanism: convention + three kit helpers (NOT a monolithic `tierRender`)

A single `tierRender(ctx, {tier, headerSummary, body})` was considered and rejected: bash's width-reactive render wrapper (bash.js:117-133), read's Image branch (read.js:64-72), and edit/write's self-backgrounded diff lines (edit.js:90) make a one-size body pipeline leaky. Instead, **each `renderResult` follows a fixed decision order**, and the shared logic lives in three kit helpers:

```
renderResult(result, _opt, theme, ctx):
  1. if ctx.isError (or bash exitCode≠0)  → TIER 2: kit.markDone(ctx,true); text.setText(kit.failLines(raw, theme, opts)); return text
  2. kit.markDone(ctx,false)
  3. TIER 0 tools (read/grep/find/ls), collapsed:
       kit.setSummary(ctx, [seg, seg, kit.durationSeg(result)])   // fused into header on the deferred redraw
       return kit.zeroText(ctx)                                    // renders zero lines
  4. TIER 0 expanded (ctx.expanded): full plain body (no Shiki, no icons, no blue) + marker
  5. TIER 1 tools (edit/write/bash): evidence body (diff / tail window) + dim marker
```

**Exact signatures (Phase 0 additions):**

```js
// kit.js
exports.setSummary = (ctx, segs) => void        // stores markerInner(segs) → ctx.state.__kitSummary; NEVER invalidates
exports.failLines  = (rawText, theme, opts?) => string
//   opts = { fgError?: boolean /*default true*/, extraSegs?: string[] /* e.g. dim "exit 2" */ }
//   full body on BG_ERROR; if >30 lines: head 3 + marker("… +N lines","ctrl+o") + tail 20 (tail-biased)
exports.ERROR_WINDOW = { inlineMax: 30, head: 3, tail: 20 }
exports.BODY_INDENT  = "   "                    // 3 spaces — body column; see 1.2

// tui-text.js
exports.zeroText = (ctx) => Component           // returns cached ctx.state.__kitZero ?? new ZeroText()
// class ZeroText { setText(){}, invalidate(){}, render(_w){ return [] } }
```

`kit.header(ctx, title, annots)` (kit.js:76-79) is **modified**, same signature:

```js
header(ctx, titledPrimary, annots) →
  trunc(`${TOOL_RESULT_INDENT}${glyph(ctx)} ${titledPrimary}${annots? " "+annots:""}${summary}`, termWidth(), dim("›"))
  where summary = ctx.state?.__kitSummary ? `${dim(SEP)}${ctx.state.__kitSummary}` : ""
```

**Loop-safety argument (load-bearing):** `setSummary` writes state and returns — it never calls `ctx.invalidate`. The header repaints because `markDone` (called on the same pass) already schedules exactly one microtask redraw when `__kitDrawn !== __kit`, and that mechanism self-terminates (kit.js:59-65). On subsequent passes `setSummary` rewrites identical content — no new invalidation. Result: the summary appears on the same deferred pass as the ✓ glyph, and pass counts stay identical to today's.

### 1.2 Fixed-column glyph spine

- `TOOL_RESULT_INDENT` stays `" "` (1 col, config.js:20). Every header goes through `kit.header` → **glyph occupies column index 1 (2nd column) on every tool, always** — green ✓ / red ✗ / dim · , exactly one char.
- **Body lines move to column index 3** via `kit.BODY_INDENT = "   "` (3 spaces), so the glyph column is visually reserved for the spine. Applied centrally: `gutterLine` (kit.js:137), `marker` default indent (kit.js:148), `failLines`, and per-tool body prefixes in Phase 1. diff.js body lines must also start at BODY_INDENT (Phase 0 task F6).
- Alignment invariant (testable): after ANSI-strip, for every tool's header line `line[1] ∈ {✓,✗,·}` and `line[0]===" "`; for every body line, `line.slice(0,3)==="   "` (or the line is blank).

### 1.3 Color budget — what routes where

| Meaning | Encoding | Only emitters allowed |
|---|---|---|
| did it work | green ✓ / red ✗ / dim · at col 1 | `kit.glyph` (via `kit.header`) |
| changed content | `BG_ADD`/`BG_DEL` + diff fg | diff.js only |
| searched term | `FG_YELLOW` bold | grep expanded body only (grep.js:183) |
| machinery (dirs, line nums, │, markers, durations, counts) | `FG_DIM`/`FG_LNUM`/`FG_RULE`/`FG_MUTED` | kit helpers |
| verifiable content | default fg | tool bodies |
| failure surface | `BG_ERROR` tint | `kit.failLines` only |

**Violations to delete in Phase 1** (each is an acceptance criterion of its file's task): `greenSeg`/`redSeg` in edit marker (edit.js:86-87); `redSeg("exit N")` (bash.js:81 → dim); git-status green/yellow tint (find.js:96 → keep dim `M`/`?` suffix only); `theme.fg("warning", …)` notices (find.js:172 → dim); `FG_BLUE`+bold dirs (render.js:266 → default fg + dim `/`); `theme.fg("accent", path)` (ls.js:39 → `kit.pathSeg`). `kit.warnSeg` (kit.js:89) loses all callers — leave exported, mark deprecated in its comment. Syntax highlighting: **Shiki call sites removed from read.js and grep.js entirely; diff.js keeps its guarded progressive Shiki untouched.**

---

## 2. Phase 0 — Foundation (single agent; everything else depends on this)

All in `/Users/tanmaydeshmukh/Projects/pi-kit/pretty/dist/`. Do not touch `tools/*`.

- [ ] **F1 — `tui-text.js`: `ZeroText` + `zeroText(ctx)`.** Class with `setText` no-op, `invalidate` no-op (host calls it on resize — must exist, see StubText comment tui-text.js:27-30), `render(_w) → []`. `zeroText(ctx)` caches the instance on `ctx.state.__kitZero` so `ctx.lastComponent` identity is stable across passes. *AC:* `new ZeroText().render(80)` returns a length-0 array; instance reused across two calls with same ctx.state.
- [ ] **F2 — `kit.js`: `setSummary` + summary-aware, width-truncating `header`.** Per signatures in 1.1. Header truncation uses `trunc(..., termWidth())` — never wraps. *AC:* driving any registered tool through the harness `drive()` twice shows the summary fused after annots on the header line by the final pass, pass count unchanged from a no-summary run, `invals` increase ≤ 1.
- [ ] **F3 — `kit.js`: `failLines(rawText, theme, opts)` + `ERROR_WINDOW`.** Body = `compactErrorLines` (as renderToolError does today, render.js:209-214), each line `BODY_INDENT`-prefixed, `theme.fg("error", …)` when `opts.fgError !== false`, whole block through `fillToolBackground(…, BG_ERROR)`. >30 lines → head 3, `marker(["… +"+plural(hidden,"line"), ...extraSegs, "ctrl+o"])`, tail 20. ≤30 → full body, extraSegs marker appended only if extraSegs nonempty. *AC:* 50-line input renders 3+1+20 lines with the hidden count correct; 10-line input renders 10 lines and no marker; every line carries BG_ERROR.
- [ ] **F4 — `kit.js`: `BODY_INDENT`; re-point `gutterLine` (kit.js:137) and `marker` default indent (kit.js:148) to it.** *AC:* stripped `gutterLine(12,3,"x")` starts with exactly 3 spaces.
- [ ] **F5 — `render.js`: retarget shared renderers.** (a) `buildEntryCells` (render.js:252-270): remove `dirIcon()`/`fileIcon()` calls; dirs render `name` default fg + `dim("/")` suffix — no FG_BLUE, no bold. (b) `renderToolMetrics` (render.js:192-201): drop the chars segment; drop sub-second elapsed (reuse the ≥1s rule). (c) `renderFileContent` (render.js:218-230) and `renderGrepResults` (render.js:324-368): mark header comments "LEGACY — no callers after round 3"; do not delete (blast-radius control). *AC:* no `FG_BLUE`, `\x1b[1m`, `fileIcon`, or `dirIcon` in `buildEntryCells` output; `renderToolMetrics` never emits a char count.
- [ ] **F6 — `diff.js`: body-column alignment.** Locate the line-prefix/indent construction (grep for `TOOL_RESULT_INDENT`) and route through `kit.BODY_INDENT` so edit/write/diff bodies share the col-3 left edge with bash/read bodies. Do NOT touch the Shiki guard or hunk logic. *AC:* `renderDiff` output lines, stripped, start at column 3.
- [ ] **F7 — probe.** Add a temporary node one-liner (scratchpad, not committed) confirming pi-tui `Text("")` vs `ZeroText` line counts under `NODE_PATH` as preview.js uses. *AC:* documented in the task hand-off which component yields zero lines (justifies F1).

---

## 3. Phase 1 — Per-tool re-defaulting (7 parallel agents; each depends on Phase 0 only)

Common acceptance criteria for **every** task below: (i) `ctx.isError` branch routes through `kit.failLines`; (ii) no `FG_GREEN`/`FG_RED`/`FG_YELLOW`/`FG_BLUE` emitted except as licensed in §1.3; (iii) no `fileIcon`/`dirIcon` call remains; (iv) header glyph at col 1 after strip; (v) harness scenario for the tool passes with bounded passes and no LOOP.

### T-READ (`tools/read.js`) — Tier 0
1. Delete the entire async highlight block (read.js:106-127) including `__hlKey`/`__hlText`/`__seq` usage and the `renderFileContent` import usage (render.js import may remain for nothing else — remove the binding). **read.js must contain zero `.then(` after this task.**
2. Collapsed success (`readFile`): `kit.setSummary(ctx, [plural(total,"line"), durationSeg(result)])`; return `zeroText(ctx)`. Drop `humanSize(bytes)` (char-count cut).
3. Expanded: plain (unhighlighted) `gutterLine` body for ALL lines (respect `MAX_PREVIEW_LINES` cap with a `… +N lines` tail marker), width-truncated per line as today (read.js:114).
4. Image branch (read.js:64-72): unchanged, but call `kit.setSummary(ctx, ["image"])` before returning the Image component so the header still reads complete.
5. *AC:* collapsed = header line only (result component renders 0 lines); expanded shows gutter body; no Shiki import used; multi-pass collapse→expand→resize→collapse stabilizes ≤3 passes each, no LOOP.

### T-GREP (`tools/grep.js`) — Tier 0
1. Make `renderGrepGrouped` synchronous (it already is internally — grep.js:149-152 note); delete the `.then` guard block (grep.js:105-126) and `__hlKey`/`__seq` keys.
2. Collapsed success: `setSummary(ctx, [countSeg, topSeg, durationSeg])` where `countSeg` = `"{matches} in {files} files"` (files>0) else `"{matches} matches"` (incl. `0 matches` for the empty branch, grep.js:129-133); `topSeg` = `"{topFile} ({k})"` from max of `grepStats().perFile` — plain text, no pathSeg color (summary is uniformly dim). Return `zeroText(ctx)`.
3. Expanded: grouped body via sync `renderGrepGrouped` — keep `pathSeg` file headers and `gutterLine` rows, **keep** the yellow-bold term highlight (grep.js:183), **remove** `fileIcon` (grep.js:177). Marker: `[countStr, duration]`.
4. Delete the collapsed per-file strip path (grep.js:85-93) and local `grepFileStrip` (grep.js:140-146); the header summary replaces it.
5. *AC:* collapsed grep-many = exactly one visible line reading like `✓ grep /TextComp/ in src · 21 in 6 files · tools/bash.js (6)`; expanded shows yellow only on the term; zero `.then(` in file.

### T-FIND (`tools/find.js`) — Tier 0
1. Collapsed success: `setSummary(ctx, ["{N} files", "{topDir} ({k})", durationSeg])` (top dir from the existing histogram counting, find.js:107-122; zero results → `"0 files"`). Return `zeroText(ctx)`. Delete the collapsed histogram body branch (find.js:183-192).
2. Expanded: flat `pathSeg` list as today (find.js:193-209) minus `fileIcon` (find.js:204); git status renders **dim `M`/`?` suffix only** — remove the FG_GREEN/FG_YELLOW basename tint in `findEntry` (find.js:96-101). Keep `collectGitStatus` in execute untouched.
3. Notices (find.js:171-173): render dim, not `theme.fg("warning")`.
4. *AC:* collapsed = one line; expanded entries end with dim status letters where applicable and carry no green/yellow SGR.

### T-LS (`tools/ls.js`) — Tier 0
1. Collapsed success: `setSummary(ctx, ["{N} entries", info.dirs ? plural(dirs,"dir") : "", durationSeg])`; return `zeroText(ctx)`. Delete the 12-row preview branch (ls.js:57-72 collapsed path).
2. Expanded: full `renderTree` columns (now icon-free, blue-free via Phase-0 F5) + marker `[entries, dirs, duration]`.
3. renderCall title: replace `theme.fg("accent", path)` (ls.js:39) with `kit.pathSeg(path)`.
4. *AC:* collapsed = one line `✓ ls src · 20 entries · 3 dirs`; expanded dirs show `name/` with dim slash, no bold-blue anywhere.

### T-BASH (`tools/bash.js`) — Tier 1 + Tier 2
1. Success collapsed windowing (bash.js:86-88): change to **tail-biased** — `previewWindow(displayLines, { inlineMax: 6, head: 0, tail: 5 })`; body order = marker line (`… +N lines · duration · ctrl+o`) THEN tail lines. (previewWindow already supports head:0 — kit.js:158-170.)
2. Failure (ctx.isError OR `exitCode !== 0`, bash.js:71): route to `kit.failLines(output, theme, { fgError: false, extraSegs: [dim("exit "+d.exitCode)] })` — BG_ERROR tint, default fg (bash output is not prose to paint red), exit code as a dim marker seg. Delete the head2/tail6 error window and `redSeg` exit (bash.js:81, 88).
3. Keep: `colorizeDiffLines` (bash.js:154-184 — this IS licensed diff coloring), the width-reactive `__kitWrapped` wrapper (bash.js:117-133) for the success path, `stripBashExitStatusLine`, duration.
4. Empty-output success: keep the `marker(["done", duration])` line (bash.js:107-109) — bash is Tier 1, the marker is its evidence floor.
5. *AC:* 193-line success output shows header + marker + last 5 lines (assert "Tests 84 passed" visible collapsed); nonzero exit shows red-tinted body without pressing ctrl+o, tail (e.g. "Found 1 error.") visible; resize does not stack render wrappers (single `__kitWrapped`).

### T-EDIT (`tools/edit.js`) — Tier 1
1. Keep the evidence default (first hunk, `COLLAPSED_CAP` 14, edit.js:20-27) and full diff expanded — this already matches the tier.
2. Markers (edit.js:86-87): replace `kit.greenSeg("+"+added)` / `kit.redSeg("-"+removed)` with plain dim `+{a} −{r}` segments. Counts must survive both collapsed and expanded markers ("counts never lost").
3. Confirm bodies start at BODY_INDENT (arrives free from Phase-0 F6 — verify only).
4. Degraded no-diff branch (edit.js:72-75): unchanged.
5. *AC:* collapsed marker reads `… 2 hunks · +12 −4 · ctrl+o` with all segs dim; diff lines still carry BG_ADD/BG_DEL; no green/red SGR outside diff body lines.

### T-WRITE (`tools/write.js`) — Tier 1
1. Keep head-8 all-additions diff default (write.js:71-73).
2. Marker (write.js:74-80): drop `humanSize(bytes)`; becomes `["new file", plural(lineCount,"line"), duration, hidden>0 ? "ctrl+o" : ""]`.
3. *AC:* marker has no byte size; diff body at BODY_INDENT; hidden-count math unchanged.

---

## 4. Tier 2 failure path — centralization answer

**Yes, centralize: `kit.failLines` (Phase-0 F3) is the single implementation; all 7 tools call it.** Today all 7 already funnel through `renderToolError` (render.js:209-214) in their `ctx.isError` branch, so the change per tool is a one-line swap plus bash adding its `exitCode !== 0` route. `renderToolError` itself becomes a thin wrapper over `failLines` (kept for the generic `makeRenderResult` path, render.js:386). Semantics: **auto-full body (no ctrl+o needed), BG_ERROR tint, tail-biased above 30 lines** — the tail-bias preserves "never hide why it broke" while keeping a 400-line stack trace bounded; ctrl+o still reveals the elided middle. The ✗ glyph turns red on the FIRST pass already because `statusOf` reads host-authoritative `ctx.isError` (kit.js:36-41) — no new mechanism needed.

---

## 5. Phase 2 — Verify (one agent; extends `/Users/tanmaydeshmukh/Projects/pi-kit/preview.js`)

Add scenarios + programmatic assertions (harness already reports `passes/invals/LOOP`, preview.js:32-41). New assertions helper: `assertGlyphCol(lines)` (§1.2 invariant) and `assertColorBudget(lines)` — scan raw ANSI for the palette's exact FG_GREEN/FG_RED/FG_YELLOW/FG_BLUE SGR strings (config.js:28-31, both palettes) and fail if found outside (a) header col-1 glyph, (b) lines containing BG_ADD/BG_DEL, (c) BG_ERROR blocks, (d) grep-expanded term highlight.

- [ ] **V1 — THE STREAM:** run read→grep→find→ls→edit→bash(success) sequentially, print the concatenated stripped output. *AC:* each Tier-0 tool contributes exactly 1 visible line + 1 blank; glyph column uniform; total stream for 6 tools ≤ ~25 lines.
- [ ] **V2 — failing tool auto-expands:** read with `isError:true` and a 12-line error; bash with `exitCode:2` and 50-line stderr. *AC:* full/red body with `expanded:false`; bash tail line visible; head3/tail20 window on the 50-liner.
- [ ] **V3 — bash tail:** 193-line success. *AC:* last-line content visible collapsed; marker ABOVE tail; hidden count = 188.
- [ ] **V4 — edit evidence default:** reuse an oldText→newText pair. *AC:* first hunk visible collapsed; dim `+N −N` in marker; expanded shows all hunks; multi-pass expand/collapse no LOOP (diff Shiki guard intact).
- [ ] **V5 — large grep collapses to one line:** `grepMany`. *AC:* single header line with `21 in 6 files · tools/bash.js (6)`; expanded shows grouped body, yellow only on term.
- [ ] **V6 — multi-pass torture:** read and grep collapse→expand→resize60→collapse (mirroring preview.js:78-84). *AC:* every leg `passes ≤ 3`, `loop=false` — stricter than today because read/grep have no async left.
- [ ] **V7 — empties:** grep 0 matches, find 0 files, bash empty output, write empty file. *AC:* one line each (bash: header+done marker), no crashes, no "in 0 files".
- [ ] **V8 — color budget:** run `assertColorBudget` over all scenario outputs. *AC:* zero violations.

---

## 6. Phase 3 — Adversarial review (must specifically check)

1. **Loop-safety post-Shiki-removal:** grep read.js/grep.js for any residual `.then(`, `__hlKey`, `__seq`, `renderFileContent`, `renderGrepGrouped`-async; confirm the ONLY `ctx.invalidate` callers in the package are kit.js:63 (markDone microtask) and diff.js's guarded path. Confirm `setSummary` cannot invalidate.
2. **ZeroText contract:** `invalidate()` exists (resize crash otherwise — tui-text.js:27 precedent); component identity stable across passes; collapsed→expanded→collapsed swaps ZeroText↔Text without stale `lastComponent` writes (check owner guards where retained).
3. **Glyph column:** across all 7 headers incl. bash's `$ `-prefixed title and error state — strip ANSI, assert col 1.
4. **Color budget:** V8 plus manual scan of both palettes (light variant SGRs too, config.js:41-47); check nothing re-introduces `theme.fg("accent"/"warning")`.
5. **Width/theme:** fused headers at width 60 truncate with `›`, never wrap (kit.header truncation); light palette; `PRETTY_ICONS` env now moot — confirm no icon call sites; StubText degradation still renders text.
6. **Tier-2 tail-bias:** verify the verdict line of a synthetic 100-line compile error is visible collapsed.
7. **Spec-vs-diff audit:** every CUT (Shiki-on-read/grep, icons, bold-blue, observation bodies, char counts, sub-second durations, humanSize in write, green/red marker segs) has a corresponding deletion; every KEEP (diff Shiki, grep yellow term, colorizeDiffLines, git-status collection, width wrapper) is untouched.

---

## 7. Risks & sequencing

| Risk | Blast radius | Mitigation |
|---|---|---|
| `ZeroText` breaks a host assumption (Pi calls a method we stubbed, or dislikes 0-line children) | All 4 Tier-0 tools | F7 probe + V1/V6; fallback (pre-agreed): result component renders the summary as its own single dim line instead of header fusion — one-line change in the 4 tools, spine survives |
| Summary redraw missed when `markDone` doesn't schedule (state restored mid-session with `__kit` already `ok`) | Stale header until next natural repaint | `header()` reads state directly, so any repaint heals; review item 1 confirms no scenario renders result-before-call |
| Stale `ctx.state.__hlText` from pre-round-3 sessions | None — no code reads the keys anymore | grep in review item 1 |
| diff.js indent change (F6) misaligns hunk gutters or trips its Shiki content-key | edit/write bodies | F6 touches prefix only; V4 multi-pass guards the key |
| bash `__kitWrapped` wrapper interacting with `failLines` (error path no longer width-reactive) | bash errors at odd widths | acceptable: fillToolBackground without width behaves as today's non-bash tools; review item 5 |
| Header overflow with long grep patterns + summary | cosmetics | kit.header truncation (F2) — summary is rightmost, so it truncates first |

**Ordering constraints:** F1-F6 strictly before all Phase 1 tasks (every tool imports the new kit surface; ls additionally needs F5, edit/write need F6). The 7 Phase-1 tasks are mutually independent — no shared files. Phase 2 after all Phase 1. **Flags: none** — hard default per the recorded decision; the only surviving knob is the pre-existing `PRETTY_THEME` for diff Shiki.

---

## 8. Done = all of:

- [ ] Tier-0 success (read/grep/find/ls) = exactly one visible line each, summary fused into the header; body only on ctrl+o.
- [ ] Tier-1: edit/write show diff evidence by default with counts never lost; bash shows the tail, verdict visible collapsed.
- [ ] Tier-2: any failure shows a red-tinted body without ctrl+o; tail-biased above 30 lines; all 7 tools via `kit.failLines`.
- [ ] Glyph spine: ✓/✗/· at column 1 on every header; bodies at column 3.
- [ ] Color budget holds under `assertColorBudget` on the full harness suite (dark + light palettes).
- [ ] Zero `.then(` in read.js/grep.js; diff.js guard intact; harness: no LOOP, `passes ≤ 3` everywhere.
- [ ] All CUTs verifiably deleted (review item 7 checklist clean).
- [ ] V1 stream output is attached to the review as the visual artifact the user signs off on.

---

## Judgment calls encoded above (cheap to veto BEFORE build)

- **(a)** git-status loses its green/yellow tint in find-expanded (strict budget) — dim `M`/`?` survives.
- **(b)** edit's `+N −N` marker counts go dim (counts are metadata, not diff content).
- **(c)** Tier-2 uses a tail-biased 30-line cap rather than literally unbounded output.
- **(d)** body indent moves from 1→3 columns to clear the spine — the one deliberate layout change beyond the spec's letter.

---

## Carried-over review findings (round-2 adversarial pass, low severity — fold into round-3)

Round-2 review verdict was **ship**; 2 mediums were fixed at commit (diff.js word-span ANSI sanitization + explicit diff code-text fg). These 3 lows were deferred because round-3 reworks the same files:
- **[low] diff.js:~267** — when a word-highlighted line truncates *inside* the strong middle span, the right-edge padding fills with the STRONG tint instead of the base tint (one row a shade off; `RST` still prevents bleed). Cosmetic. Fix when touching `wordLine` in F6: re-emit `baseBg` before the pad region, or pre-truncate the mid span so the closing `baseBg` is never dropped.
- **[low] edit.js:~22 (`firstHunk`)** — collapsed-hunk detection uses `l.includes('···')`, which false-positives if edited content contains a literal `···` line. T-EDIT should have `renderDiff` tag separator rows with a content-independent sentinel (or return structured hunk indices) and match on that. Cheap; the separator line lacks a `│`, so an interim guard is `l.includes('···') && !l.includes('│')`.
- **[low] diff.js:~80 (`diffMiddle`)** — LCS `n*m` cap doesn't bound `n+1` typed-array row allocation, so a tall-thin diff (millions of lines) can OOM; and edit/write always pass `expanded:true`, materializing the full diff before the collapsed caller slices to 8–14 lines. Not reachable on normal edits. Fix: also cap on `max(n,m)`/total lines, and let the tools pass a bounded line budget into `renderDiff` instead of unconditional `expanded:true`.
