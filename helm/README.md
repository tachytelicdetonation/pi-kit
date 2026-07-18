# helm

A full-screen **mission-control UI** for the Pi coding agent — one place to steer
goals, workflows and background loops, triage the decisions that need you, and read
what pi did while you were away. Registered as the `helm` command; it takes over the
whole viewport (`ctx.ui.custom` without overlay), reads the live terminal size on
every frame, and restores the host footer on exit.

Run it from the Pi TUI:

```
/helm
```

## The screen set

`enter` descends, `esc` ascends — a real nav stack with **no dead ends** (home is
the floor; esc at home clears the prompt, never quits). The body, header breadcrumb,
footer variant and per-screen keys all follow the top-of-stack screen.

| id  | screen | what it is |
| --- | ------ | ---------- |
| 6b  | **mission control** (home) | three strata — `▲ needs you`, `◆ goals` + tree-indented top-level workflows, `∞ loops`. Never anything tool-level. |
| 6c  | **workflow drill-in** | work-queue burn-down + worktree rows (fix→review→apply chips, race-to-green strips). `enter` a worktree → its session. |
| 4a  | **session view** | a per-worktree transcript: context / parallel / edit / verify activity lines, receipts, closing claim. `o` expands a line. |
| 7b  | **escalation card** | a decision, pre-chewed: one-sentence problem → minimal evidence → numbered options with pi's pick green. Decisions become **precedents**. |
| 7c  | **catch-up digest** | "while you were away" in four line types; shown on launch only when away > 30 min. |
| 6a  | **intent intake** | plain conversation, **zero agents until "go"**: pi asks only un-inferable questions (numbered), then a plan block. `g go` is dim while questions are open. |
| 7a  | **loop builder** | prose → structured `trigger / steps / skips / guardrails`. A loop goes live **only after one trial run under full review**; a failed trial reopens the builder (never auto-retries). |
| 7d  | **goal closeout** | the receipt (what landed, what it cost, how much of *your* attention it took, why the estimate slipped) → proposed **precedents** for CLAUDE.md / skills. |
| —   | **search** (`/`) | search everything — goals, workflows, loops, PRs, decisions, precedents, loop runs — **archived included (search is forever)**. `enter` navigates to the hit. |

## Keys

**Global** (Gmail rule — a bound key executes while the prompt is empty; any unbound
printable focuses the prompt and types to pi):

- `j`/`k` or `↑`/`↓` move · `enter` drill · `esc` back · `1`–`9` act on numbered items
- `tab` — jump to the next needs-you item from anywhere (the triage walk)
- `/` — **search** everything (archived too); typing filters, `enter` opens a hit
- `ctrl+u` — **usage popover**: an overlay drawn *over* the body (per-provider % +
  reset dates, spend today/week, per-goal cost split). Any key closes it first; it
  never touches the nav stack.
- `ctrl+p` — **pause all** (freeze every lane mid-step; again resumes). The footer
  turns yellow with a `⏸ paused` indicator while paused.
- `?` — a brief per-screen key-help hint on the prompt line
- `q` — quit

**Per-screen:** 6b `enter p n N` (`n` new goal → 6a, `N` new loop → 7a) · 6c `enter p r t` ·
4a `d m i o` · 6a `g` go / `e` edit plan / `x` discard · 7a `t` trial, then `s`/`r`/`x` ·
7b `1-9 ? [ ] enter` · 7c `d enter l` · 7d `a` apply precedents / `r` full report / `x` archive.

**Navigation choices worth noting:** a home **loop row** opens its 7a builder; a
**complete/archived goal** is reached through `/` search (home lists only running
goals) → its 7d closeout; `n`/`N` push fresh intake / loop-builder drafts.

## Runtime architecture

Everything the UI shows comes through one interface — **`DataSource`**
(`src/data/source.ts`). Production uses **`RealDataSource`**: it persists goals,
drafts, loops, escalations, precedents, journal events, and closeouts per project at
`~/.pi/agent/helm/projects/<project-hash>/state.json`; projects never share intent.
Goal launch and supervised loop trials run through the real dynamic-workflows
`WorkflowManager`. Its persisted runs are projected back into home lanes, drill-in
worktrees, session activity, receipts, pause/resume state, and goal completion.
Accepted loop schedules support `every N minutes/hours/days` and `daily at HH:MM`;
they run through WorkflowManager, persist their next deadline, re-arm on Pi startup,
and pause after a failed run for operator review.

Repository-judgment actions (`d` full diff, `m` merge, `r` reassign, `i` steer, and
`a` apply precedents) close Helm and hand a scoped request to Pi's normal agent so
they retain Pi's tools, approvals, and conversational result. Destructive actions
show an in-Helm `y/n` confirmation first. New needs-you items ring terminal BEL.

`MockDataSource` remains only as deterministic fixture data for tests and previews;
the installed extension never constructs it.

## Layout & safety invariants

Held by every screen and enforced by tests:

- `render(width)` emits **exactly** `terminal.rows` lines with the footer pinned
  last; every line's `visibleWidth <= width`; tiny/zero terminals degrade without
  throwing; a thrown error closes the app cleanly rather than stranding an overlay.
- All layout is **ANSI-safe** (`chrome.ts` measures with `visibleWidth` / truncates
  with `truncateToWidth`, never raw `.length` / `.slice`), so color codes never
  corrupt width. The popover composites as full rows and is clipped to the body.
- Colors emit truecolor with a **256-color fallback** (`theme.ts`) — no truecolor
  escape leaks when the host reports `256color`.
- Lists **re-sort only on state change** (the store caches order); nothing jitters on
  a progress tick.

## Develop

```
npm run check     # tsc --noEmit
npm test          # type-check + node:test (tests/**/*.test.ts)
npm run preview   # render every screen + both footer variants (paused & normal)
```

Sources: `src/app.ts` (component + key dispatch), `src/router.ts` (nav stack),
`src/chrome.ts` (layout primitives), `src/footer.ts` (usage footer), `src/theme.ts`
(tokens), `src/screens/*` (one renderer per screen), `src/state/*` (store, selectors,
precedents, persistence, types), `src/data/*` (the command boundary, real source,
and test-only mock), `src/host/adapters.ts` (live workflow and usage projections).
