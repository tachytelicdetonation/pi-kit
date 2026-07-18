# Handoff: Pi Coding Agent — Stage-4 TUI (mission control, session view, usage footer)

## Overview
A ground-up redesign of the `pi` coding agent's terminal UI for stage-4 ("AI-native") agentic engineering: the operator steers by intent and monitors by exception. It covers the full loop — goal intake → mission control → workflow drill-in → session transcript → escalations → catch-up digest → goal closeout → background loops — plus a finalized multi-provider usage footer.

## About the Design Files
`Usage Bar Explorations.dc.html` is a **design reference created in HTML** — a visual prototype of terminal screens, not production code. The task is to **recreate these screens in the pi codebase's existing TUI environment** (its current terminal renderer / framework, whatever pi already uses for its footer and transcript), using its established patterns. HTML pixel values map to terminal cells as noted per screen. If a fresh UI layer is being chosen, any mainstream TUI stack works (e.g. ink/react for TS); the design assumes only monospace text, truecolor, and per-cell styling.

The file is a design canvas with multiple iterations. **Implement only the final set**; anything marked with an amber "superseded" badge is history:
- FINAL: `3a` (footer), `4a` (session view), `6a 6b 6c` (intake, mission control, drill-in), `7a 7b 7c 7d` (loop builder, escalation, digest, closeout), `8a 8b` (interaction spec)
- SUPERSEDED: `1a 1b 1c 2a 2b` (footer explorations → 3a), `4b` (fleet view → 6b)

## Fidelity
**High-fidelity for content, hierarchy, color, and layout structure.** Every label, glyph, color, and column shown is intended as final. Exact pixel spacing is an artifact of the HTML medium — in the terminal, use character cells: the mocks' column alignment (fixed-width label columns, right-aligned status columns) is the spec.

## Design Tokens
Colors (truecolor; degrade to nearest 256-color):
- Background `#17181c` · panel dividers `#26282f` · input-box border `#4a4258`
- Text tiers: bright `#e6e9ef` / primary `#d4d8e0` / label `#aeb4c0` / mid `#8d93a1` / dim `#6b7280` / faint `#4d5158` / ghost `#3d4048`
- Providers: codex `#4c9df0` (blue) · claude `#f0954c` (orange) · kimi `#2dd4bf` (teal) · new providers: oklch(0.72 0.15 h), h += 90° each
- Semantic: success `#3ecf6e` · error/red `#f05c5c` · warning `#e8c35a` · model-tag purple `#a78bfa` · pi brand `#8ab4f8` · spent/empty cells `#33363e`
- Never reuse success green for a provider (that's why kimi is teal).

Glyphs: bar cell `▮` (U+25AE) · test tick `▊` · pipeline chip `▪` · needs-you `▲` · goal `◆` · running `●` · verifying `◌` · queued `⏸` · loops `∞` · parallel `⣿` · collapsed/expanded `▸ ▾` · prompt `❯` · tree `├ └ │`

Layout rules (all screens):
- Header row: `pi · <context>` left, status/counts right, then a full-width divider.
- Left column = names/verbs (fixed width), middle = description, right column = status/proof/timing only, never controls.
- Right-aligned groups use a flexible spring; nothing wraps mid-hotkey (hotkey+label are atomic).
- Model tags (purple) appear ONLY where a workflow/lane runs a model different from the main session model.

## Screens

### 3a — Usage footer (final; the "vanilla 2b" stacked bar)
One row: `cwd branch │ <30-cell stacked bar> NN% │ ctx <8-cell bar> NN% │ …spring… $cost · model effort`
- Bar = combined subscription budget: 30 cells, provider i gets `round(remaining_i / N / 100 * 30)` colored cells, in fixed provider order; spent budget renders `#33363e`. No box border. No low-quota blink/chip (explicitly removed).
- Total % = avg(remaining_i), dim.
- ctx meter: 8 cells, fg `#8d93a1`, empty `#33363e`.
- Truncation: <110 cols drop cwd → <90 drop cost + bar shrinks to 20 cells → <70 drop ctx.
- Fleet screens (6b) swap ctx for `burn 41k tok/min` and cost becomes `$NN.NN today`.
- Second stats line (tokens/cache) may be kept as-is or folded into the right group.

### 4a — Session view (per-worktree transcript)
Activity lines, not tool logs. Each action is one aligned line: `▸/▾ | verb (9-char col) | target | …spring… | result/timing`.
- Verbs: `context` (all reads/greps/bash that only gather context collapse into ONE line: "9 files · dirs · skill used · 2.1s"), `parallel` (`⣿` + joined summaries), `edit` (target file, right side `+N −N`), `verify` (tests/build/lint — first-class, never shown as bash).
- Expanded edit shows a 3-line peek with line numbers + `… 45 more · d full diff`. Never stream full file contents.
- Turn ends with: claim sentence + right-aligned one-key actions (`review diff d · merge m`).
- Header right side: verification receipts `✓ build ✓ lint ✓ 142 tests`.
- Input box (top+bottom hairline borders) then the 3a footer.

### 6a — Intent intake
Plain conversation; zero agents until go. Pi asks ONLY un-inferable questions (numbered). Then a plan block: one line per workflow (`name | description`, purple model tag if non-default). Last line: `est wall · est $ · escalation rule …spring… g go · e edit plan · x discard`. `g` renders dim/disabled while pi has open questions.

### 6b — Mission control (home)
Three strata in fixed order, never anything tool-level:
1. `▲ needs you (N)` — rows: `source (goal›workflow or loop) | one-line question | …spring… verb + number key`
2. `◆ goal <name> …spring… <8-cell progress bar> NN% · ~ETA` with tree-indented top-level workflows only (`├ └`): `name | status summary | …spring… state glyph + text (+ model tag if different)`. Subagent trees NEVER render here — folded behind enter.
3. `∞ loops (N active)` — rows: `name | trigger→pipeline summary | …spring… yield today · cost` or `idle · last fired` / `next run`.
Prompt placeholder: "new goal, or steer — …". Footer = fleet variant.
Behavior: rows re-sort only on state change (no jitter); needs-you raises bell + OS notification if unfocused >60s.

### 6c — Workflow drill-in
Header: `pi · goal › workflow …spring… 16 lanes × 4 worktrees · 64 agents` ("lanes" = internal pipelines; the word "loops" is reserved for 6b background loops).
- Work-queue burn-down: big count `1,204` + `imports left · from 16,000 · burn 410/hr · done ~03:40`.
- Worktree rows: `wt-N | package | ▪ → ▪▪ → ▪ (fix→review→apply chips, one per agent; yellow/purple/green) | …spring… applied count · test state`.
- Race-to-green strips: per package, a row of `▊` ticks (red/green per test run) + right status (`✓ time` / `wobbling` / `red`).
- Enter on a worktree opens its 4a session.

### 7a — Loop builder
User describes loop in prose → pi structures: `trigger / steps / skips / guardrails` rows (guardrails include merge rights, $/day cap, concurrency, per-step model). Footer: trial statement + `t trial run · e edit · x discard`. A loop only goes live after one trial run under full review; a failed trial reports and reopens the builder — never auto-retries.

### 7b — Escalation card
Header: which item + `blocked N min · what's idle`. Body: one-sentence problem → minimal evidence block (e.g. the 4-line conflict, never the full file) → numbered options with pi's recommendation highlighted green. Keys: `1-9 decide · ? ask more · [ ] prev/next · enter full session`. Decisions + rationale are stored as **precedents**; identical future conflicts auto-resolve and note it.

### 7c — Catch-up digest
Shown on launch only if away >30 min. Header: time span + $ spent. Exactly four line types in order: `✓` shipped (goals), `✓` shipped by loops, `▲` decisions queued (with note that nothing is hard-blocked), `✕` failed-and-handled (self-caught, auto-reverted). Footer line: `d decisions first · enter mission control · l full log …spring… overnight quota drain per provider`.

### 7d — Goal closeout
Receipt: big `17/17 packages` + `+N −N · commits · 100% green …spring… $actual (est was ~$N)`. Rows: `your time` (decisions count + total attention minutes), `interventions`, `overrun why`. Then `precedents` (same store as 7b) proposed for CLAUDE.md/skills, numbered. Keys: `a apply precedents · r full report · x archive`. Declined precedents are never re-proposed.

## Interactions & Behavior (from 8a/8b — the authoritative spec)
Navigation: digest → mission control (home) → {intake, escalation card → session, workflow drill-in → session, loop drill-in → builder, closeout}. **enter descends, esc ascends, no dead ends**; esc at home clears prompt, never quits.

Global keys (Gmail rule: bound keys execute while the prompt is empty; any unbound printable focuses the prompt and types to pi):
- `j/k ↓↑` move · `enter` drill · `1-9` act on numbered items · `tab` next needs-you item anywhere (the triage walk) · `/` search everything (goals, PRs, decisions, precedents, loop runs — archived included, forever) · `ctrl+u` usage popover (per-provider %, reset dates, spend today/week, per-goal cost split) · `ctrl+p` PAUSE ALL (freeze mid-step; again resumes; footer turns yellow while paused) · `?` per-screen key help

Per-screen keys: 6a `g/e/x`; 6b `enter p n N`; 6c `enter p r t`; 4a `d m i o` (i = interrupt & steer: agent finishes current write then listens; o expands one collapsed action); 7a `t`, post-trial `s/r/x`; 7b `1-9 ? [ ] enter`; 7c `d enter l`; 7d `a r x`.

Guarantees: nothing destructive without confirm except pause (always safe); lists re-sort only on state change; anything pi did autonomously is auditable within two keys (`/` + enter).

## State Management
- Goal: draft → running → complete → archived. Workflow: running / verifying / queued / paused. Loop: draft → trial → scheduled (healthy / idle / paused-with-reason).
- Escalations: queue with per-item source, age, and idle-cost; answers append to a precedent store (also written by 7d).
- Usage: per-provider remaining %, reset dates; session ctx %; fleet burn rate + daily spend.
- Digest requires an activity journal (events: merged, PR opened, escalated, self-caught revert) with timestamps.

## Assets
None — pure text/color. Font in mocks: JetBrains Mono (any monospace terminal font works).

## Screenshots
`screenshots/` contains one capture per final panel (named by panel id). They show each panel with its annotation; the viewport crop may clip card bottoms — the HTML canvas is the complete reference.

## Files
- `Usage Bar Explorations.dc.html` — the full design canvas (open in a browser; newest work at top; sections labeled Turn 8 → Turn 1; amber badges mark superseded options).
