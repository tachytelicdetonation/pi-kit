/**
 * HelmApp — the full-screen mission-control component.
 *
 * Phase 3 adds the DESCEND SPINE: `enter` descends and `esc` ascends through a
 * real nav stack (see {@link ./router.ts}). The BODY is rendered by the top-of-
 * stack screen — home → 6b mission control, drillin → 6c workflow drill-in,
 * session → 4a session view — and the header breadcrumb, footer variant and
 * per-screen keys follow the active screen. Selection is tracked PER SCREEN in a
 * map keyed by a stable screen key (e.g. `drillin:w-codemod`), and each session
 * keeps its own set of expanded activity lines (toggled by `o`).
 *
 * `render(width)` still pulls the live row count from `tui.terminal.rows` on every
 * call, emits EXACTLY that many lines with the footer pinned last, guarantees
 * every line's visibleWidth <= width, and degrades without throwing on tiny
 * terminals.
 *
 * Phase 5 completes the surface: the last three screens (6a intake, 7a loop
 * builder, 7d closeout), the global features (`/` search from anywhere, ctrl+u
 * usage popover drawn as an OVERLAY SLOT over the body, ctrl+p pause tint), a
 * per-screen `?` help hint, and a bell on a new needs-you item. Dispatch keeps the
 * Gmail-rule ordering: the popover consumes any key first, then the search screen
 * owns its keys, then the prompt buffer, then globals, then per-screen keys.
 */
import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth } from "@earendil-works/pi-tui";
import { divider, header } from "./chrome.js";
import { MockDataSource } from "./data/mock.js";
import type { DataSource } from "./data/source.js";
import { renderHelmFooter, type FooterVariant } from "./footer.js";
import { decodeKey } from "./keys.js";
import { initialStack, transition, type Screen } from "./router.js";
import { renderCloseout } from "./screens/closeout.js";
import { renderDigest } from "./screens/digest.js";
import { renderDrillIn, renderDrillInCounts } from "./screens/drill-in.js";
import { renderEscalation } from "./screens/escalation.js";
import { renderIntake } from "./screens/intake.js";
import { renderLoopBuilder } from "./screens/loop-builder.js";
import { renderMissionControl } from "./screens/mission-control.js";
import { overlayPopover, usagePopoverLines } from "./screens/popover.js";
import { renderSearch } from "./screens/search.js";
import { renderReceipts, renderSession } from "./screens/session.js";
import { activeLoopCount, needsYouCount, nextNeedsYouId, selectableCount, selectableRows } from "./state/selectors.js";
import type { HelmState, TrialState } from "./state/types.js";
import { GLYPH, paint, PALETTE, type ThemeLike } from "./theme.js";

/**
 * The slice of the host TUI helm needs: a live terminal size and a redraw hook.
 * Kept structural so the component is trivially testable with a fake tui.
 */
export interface TuiLike {
  terminal: { rows: number; columns: number };
  requestRender(): void;
}

function safeWidth(width: number): number {
  return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

function safeRows(rows: number): number {
  return Number.isFinite(rows) ? Math.max(0, Math.floor(rows)) : 0;
}

export class HelmApp implements Component {
  private buffer = "";
  private stack: Screen[] = initialStack();
  /** Per-screen selection index, keyed by {@link screenKey}. */
  private readonly selections = new Map<string, number>();
  /** Per-session set of expanded activity-line indices, keyed by {@link screenKey}. */
  private readonly expanded = new Map<string, Set<number>>();
  /** Per-escalation follow-up ("?") count — a marked stub (appended dim line). */
  private readonly followUps = new Map<string, number>();
  /** ctrl+u usage popover: an overlay SLOT, not a stack frame. */
  private popoverOpen = false;
  /** `?` per-screen help: a one-line dim hint shown on the prompt line. */
  private helpVisible = false;
  /** Per-loop-draft trial-gate state (7a), keyed by the loopBuilder screen key. */
  private readonly trials = new Map<string, TrialState>();
  /** Closeout screen keys whose precedents have been applied (7d `a`). */
  private readonly applied = new Set<string>();
  /** Last-seen needs-you count — drives the bell-on-new-escalation heuristic. */
  private prevEscalationCount: number;
  private readonly dataSource: DataSource;
  private readonly unsubscribe: () => void;

  constructor(
    private readonly tui: TuiLike,
    private readonly theme: ThemeLike,
    private readonly done: (result: void) => void,
    dataSource: DataSource = new MockDataSource(),
    /**
     * Optional bell sink: called when a NEW needs-you item is added. The extension
     * wires this to write BEL ("\x07"). SEAM: an OS notification when unfocused is
     * out of reach of the extension API — see the extension's marked TODO.
     */
    private readonly onBell?: () => void,
  ) {
    this.dataSource = dataSource;
    // 7c: on launch, show the catch-up digest ABOVE home when away > 30 min, so
    // esc from the digest lands on home (a one-hop descend spine). Otherwise start
    // straight at home.
    this.stack = dataSource.shouldShowDigest() ? [{ id: "home" }, { id: "digest" }] : initialStack();
    this.prevEscalationCount = this.dataSource.snapshot().escalations.length;
    // Redraw whenever the underlying state changes (pause, future ticks, …); a
    // state change that GREW the needs-you queue also rings the bell.
    this.unsubscribe = this.dataSource.subscribe(() => this.onStateChange());
  }

  /** State-change hook: ring the bell on a new needs-you item, then request a render. */
  private onStateChange(): void {
    const count = this.dataSource.snapshot().escalations.length;
    if (count > this.prevEscalationCount) this.onBell?.();
    this.prevEscalationCount = count;
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const w = safeWidth(width);
    const rows = safeRows(this.tui.terminal.rows);
    if (rows <= 0) return [];

    const top = this.top();
    const state = this.dataSource.snapshot();

    const headerLine = header(this.theme, this.contextLabel(top), this.headerRight(top, state), w);
    const dividerLine = divider(this.theme, w);
    const footerVariant: FooterVariant = top.id === "session" ? "session" : "fleet";
    const footerLine = renderHelmFooter(state.footer, this.theme, w, footerVariant, state.pausedAll);

    // The region between the body and the footer: a single prompt line for
    // home/drillin; an input box (top+bottom hairlines around the prompt) for a
    // session. The footer is always the very last line.
    const belowBody = this.belowBodyLines(top, w);
    const reserved = 2 + belowBody.length + 1; // header + divider + belowBody + footer
    const bodyHeight = Math.max(0, rows - reserved);
    let body = this.renderBody(top, state, w, bodyHeight);

    // ctrl+u usage popover: composite a centered bordered box OVER the body (an
    // overlay slot — it never touches the nav stack). Clipped to the body region.
    if (this.popoverOpen) {
      const box = usagePopoverLines(this.dataSource.getUsageDetail(), this.theme, w);
      body = overlayPopover(this.padBody(body, bodyHeight), box, w);
    }

    const full = [headerLine, dividerLine, ...body, ...belowBody, footerLine];
    if (full.length === rows) return full;
    if (full.length < rows) {
      // Pad before the below-body region so the input box + footer stay pinned.
      const pad = new Array(rows - full.length).fill("");
      return [headerLine, dividerLine, ...body, ...pad, ...belowBody, footerLine];
    }
    // Too many lines for a tiny terminal: keep the leading lines and the footer.
    return [...full.slice(0, rows - 1), footerLine];
  }

  /** Pad a body to exactly `height` blank-filled lines (so the popover centers over
   * the full body region, and the footer + prompt stay pinned last). */
  private padBody(body: string[], height: number): string[] {
    if (body.length >= height) return body.slice(0, height);
    return [...body, ...new Array(height - body.length).fill("")];
  }

  // ── Screen dispatch ────────────────────────────────────────────────────

  private top(): Screen {
    return this.stack[this.stack.length - 1] ?? { id: "home" as const };
  }

  /** Stable per-screen key for the selection / expanded maps. */
  private screenKey(top: Screen): string {
    switch (top.id) {
      case "drillin":
        return `drillin:${top.workflowId}`;
      case "session":
        return `session:${top.worktreeId}`;
      case "intake":
        return `intake:${top.draftId}`;
      case "loopBuilder":
        return `loopBuilder:${top.loopId}`;
      case "closeout":
        return `closeout:${top.goalId}`;
      default:
        return top.id;
    }
  }

  /**
   * The active screen's selection, clamped to its live row range at READ time.
   * If a DataSource shrinks a list between visits, a stale stored index would
   * otherwise highlight nothing and make `enter` a no-op — clamping here keeps
   * the highlight and the act both targeting an in-range row (0 when empty).
   */
  private getSelection(top: Screen): number {
    const stored = this.selections.get(this.screenKey(top)) ?? 0;
    const count = this.selectionCount(top, this.dataSource.snapshot());
    if (count <= 0) return 0;
    return Math.max(0, Math.min(stored, count - 1));
  }

  private setSelection(top: Screen, value: number): void {
    this.selections.set(this.screenKey(top), value);
  }

  private expandedSet(top: Screen): Set<number> {
    const key = this.screenKey(top);
    let set = this.expanded.get(key);
    if (!set) {
      set = new Set<number>();
      this.expanded.set(key, set);
    }
    return set;
  }

  /** How many selectable rows the active screen has (for clamping). */
  private selectionCount(top: Screen, state: HelmState): number {
    switch (top.id) {
      case "home":
        return selectableCount(state);
      case "drillin":
        return this.dataSource.getDrillIn(top.workflowId)?.worktrees.length ?? 0;
      case "session":
        return this.dataSource.getSession(top.worktreeId)?.lines.length ?? 0;
      case "search":
        return this.dataSource.search(top.query).length;
      default:
        // escalation (keys are 1-9 / [ ]), digest (d/enter/l), and the intake /
        // loopBuilder / closeout cards have no j/k selectable rows.
        return 0;
    }
  }

  /** Human-readable header breadcrumb per active screen. */
  private contextLabel(top: Screen): string {
    switch (top.id) {
      case "home":
        return "mission control";
      case "drillin":
        return this.dataSource.getDrillIn(top.workflowId)?.label ?? "workflow";
      case "session": {
        const session = this.dataSource.getSession(top.worktreeId);
        return session ? `task: ${session.task}` : "session";
      }
      case "escalation": {
        // `needs you <pos>/<total> · <source>` — the position within the queue.
        const list = this.dataSource.listEscalations();
        const index = list.findIndex((escalation) => escalation.id === top.escalationId);
        const pos = index >= 0 ? index + 1 : 1;
        const total = Math.max(1, list.length);
        const source = this.dataSource.getEscalation(top.escalationId)?.source.label ?? "escalation";
        return `needs you ${pos}/${total} · ${source}`;
      }
      case "digest":
        return "while you were away";
      case "intake":
        return "new goal";
      case "loopBuilder":
        return "new loop";
      case "closeout": {
        const closeout = this.dataSource.getCloseout(top.goalId);
        return closeout ? `goal complete · ${closeout.goalName}` : "goal complete";
      }
      case "search":
        return "search";
    }
  }

  /** Header right-side group per active screen. */
  private headerRight(top: Screen, state: HelmState): string {
    switch (top.id) {
      case "drillin": {
        const detail = this.dataSource.getDrillIn(top.workflowId);
        return detail ? renderDrillInCounts(this.theme, detail) : "";
      }
      case "session": {
        const session = this.dataSource.getSession(top.worktreeId);
        return session ? renderReceipts(this.theme, session.receipts) : "";
      }
      case "escalation": {
        const escalation = this.dataSource.getEscalation(top.escalationId);
        if (!escalation) return "";
        return paint(this.theme, PALETTE.dim, `blocked ${escalation.blockedMinutes} min · ${escalation.idleNote}`);
      }
      case "digest": {
        const digest = this.dataSource.getDigest();
        return paint(this.theme, PALETTE.dim, `${digest.spanText} · ${digest.spentText}`);
      }
      case "intake":
        return paint(this.theme, PALETTE.dim, "draft · nothing running");
      case "loopBuilder":
        return paint(this.theme, PALETTE.dim, "draft");
      case "closeout": {
        const closeout = this.dataSource.getCloseout(top.goalId);
        if (!closeout) return "";
        return paint(this.theme, PALETTE.dim, `${closeout.startedText} · ${closeout.landedText}`);
      }
      case "search": {
        const count = this.dataSource.search(top.query).length;
        return top.query ? paint(this.theme, PALETTE.dim, `${count} ${count === 1 ? "match" : "matches"}`) : "";
      }
      default:
        return this.headerCounts(state);
    }
  }

  /** Home header counts: `N goals · N loops · N need you`. */
  private headerCounts(state: HelmState): string {
    const goals = state.goals.length;
    const loops = activeLoopCount(state);
    const needs = needsYouCount(state);
    const parts = [`${goals} goals`, `${loops} loops`];
    if (needs > 0) parts.push(`${needs} need you`);
    return paint(this.theme, PALETTE.dim, parts.join(" · "));
  }

  /** Render the body for the active screen into at most `height` lines. */
  private renderBody(top: Screen, state: HelmState, width: number, height: number): string[] {
    switch (top.id) {
      case "drillin": {
        const detail = this.dataSource.getDrillIn(top.workflowId);
        if (!detail) return [];
        return renderDrillIn(detail, this.theme, width, height, this.getSelection(top));
      }
      case "session": {
        const session = this.dataSource.getSession(top.worktreeId);
        if (!session) return [];
        return renderSession(session, this.theme, width, height, this.getSelection(top), this.expandedSet(top));
      }
      case "escalation": {
        const escalation = this.dataSource.getEscalation(top.escalationId);
        if (!escalation) return [];
        const followUps = this.followUps.get(`escalation:${top.escalationId}`) ?? 0;
        return renderEscalation(escalation, this.theme, width, height, { followUps });
      }
      case "digest":
        return renderDigest(this.dataSource.getDigest(), this.theme, width, height);
      case "intake": {
        const draft = this.dataSource.getIntake(top.draftId);
        if (!draft) return [];
        return renderIntake(draft, this.theme, width, height);
      }
      case "loopBuilder": {
        const draft = this.dataSource.getLoopDraft(top.loopId);
        if (!draft) return [];
        return renderLoopBuilder(draft, this.theme, width, height, this.trialState(top));
      }
      case "closeout": {
        const closeout = this.dataSource.getCloseout(top.goalId);
        if (!closeout) return [];
        return renderCloseout(closeout, this.theme, width, height, { applied: this.applied.has(this.screenKey(top)) });
      }
      case "search":
        return renderSearch(
          top.query,
          this.dataSource.search(top.query),
          this.theme,
          width,
          height,
          this.getSelection(top),
        );
      default:
        return renderMissionControl(state, this.theme, width, height, this.getSelection(top));
    }
  }

  /** The 7a trial-gate state for a loopBuilder screen (defaults to idle). */
  private trialState(top: Screen): TrialState {
    return this.trials.get(this.screenKey(top)) ?? "idle";
  }

  /** The below-body region: the input box for a session, else a single prompt line. */
  private belowBodyLines(top: Screen, width: number): string[] {
    if (top.id === "session") {
      const hairline = width > 0 ? paint(this.theme, PALETTE.inputBorder, "─".repeat(width)) : "";
      return [hairline, this.renderPrompt(top, width), hairline];
    }
    return [this.renderPrompt(top, width)];
  }

  /**
   * Prompt line: caret + buffer, or a dim placeholder when the buffer is empty. When
   * `?`-help is toggled on it shows the active screen's key hint; on the search
   * screen it shows the filter hint (the query itself renders in the body).
   * ANSI-safe-truncated to width.
   */
  private renderPrompt(top: Screen, width: number): string {
    if (width <= 0) return "";
    const caret = paint(this.theme, PALETTE.inputBorder, GLYPH.prompt);
    if (this.buffer) {
      return truncateToWidth(`${caret} ${paint(this.theme, PALETTE.primary, this.buffer)}`, width, "");
    }
    if (this.helpVisible) {
      return truncateToWidth(`${caret} ${paint(this.theme, PALETTE.dim, this.helpHint(top))}`, width, "");
    }
    if (top.id === "search") {
      return truncateToWidth(`${caret} ${paint(this.theme, PALETTE.faint, "type to filter · enter open · esc close")}`, width, "");
    }
    return truncateToWidth(`${caret} ${paint(this.theme, PALETTE.faint, "new goal, or steer — …")}`, width, "");
  }

  /** A brief per-screen key hint for `?` help (no literal "?" so it never types). */
  private helpHint(top: Screen): string {
    const global = "/ search · ctrl+u usage · ctrl+p pause all · tab next needs-you";
    switch (top.id) {
      case "home":
        return `enter drill · j/k move · p pause · n new goal · N new loop · ${global}`;
      case "drillin":
        return `enter session · j/k move · p pause · r reassign · t test-race · ${global}`;
      case "session":
        return `o expand · d diff · m merge · i interrupt & steer · esc back · ${global}`;
      case "intake":
        return `g go · e edit plan · x discard · ${global}`;
      case "loopBuilder":
        return `t trial run · e edit · x discard · after a trial s/r/x · ${global}`;
      case "closeout":
        return `a apply precedents · r full report · x archive · ${global}`;
      case "search":
        return "type to filter · enter open · esc close";
      default:
        return global;
    }
  }

  handleInput(data: string): void {
    try {
      this.dispatch(data);
    } catch {
      // Never leave a stuck overlay: any thrown error closes the app cleanly.
      this.done();
    }
  }

  /** Key dispatch pipeline (Gmail rule ordering). See module and extension docs. */
  private dispatch(data: string): void {
    // (1) The usage popover is an overlay slot: ANY input closes it FIRST and is
    // consumed — even bytes that don't decode to a modelled key — so it never
    // disturbs navigation or the prompt. Checked before decode for exactly that.
    if (this.popoverOpen) {
      this.popoverOpen = false;
      this.tui.requestRender();
      return;
    }

    const key = decodeKey(data);
    if (!key) return;

    const top = this.top();

    // (2) The search screen owns its keys (typing edits the QUERY, not the pi
    // prompt buffer), so it is routed before the buffer + global pipeline.
    if (top.id === "search") return this.dispatchSearch(top, key);

    // (3) An open prompt buffer captures editing keys (on every other screen).
    if (this.buffer.length > 0) {
      if (key.t === "char") this.buffer += key.ch;
      else if (key.t === "backspace") this.buffer = this.buffer.slice(0, -1);
      else if (key.t === "esc") this.buffer = ""; // esc clears the buffer, never navigates
      // enter / arrows / etc. are consumed as no-ops while typing.
      this.tui.requestRender();
      return;
    }

    // (4) Global + per-screen keys (only while the prompt is empty — the Gmail rule).
    switch (key.t) {
      case "esc":
        return this.ascend();
      case "tab":
        return this.triageWalk();
      case "ctrlU":
        return this.togglePopover();
      case "ctrlP":
        return this.togglePauseAll();
      case "up":
        return this.moveSelection(-1);
      case "down":
        return this.moveSelection(1);
      case "enter":
        return this.descend(top);
      case "char":
        return this.handleChar(top, key.ch);
      default:
        // backspace / left / right with an empty buffer are no-ops.
        return;
    }
  }

  /**
   * Search-screen keys: typing edits the QUERY (chars/backspace), arrows move the
   * selection, enter navigates to the selected result, esc pops. The global
   * popover / pause / triage keys still work from search. `j`/`k` are literal
   * query characters here — only the arrows move the selection.
   */
  private dispatchSearch(top: Screen & { id: "search" }, key: ReturnType<typeof decodeKey>): void {
    if (!key) return;
    switch (key.t) {
      case "esc":
        return this.ascend();
      case "up":
        return this.moveSelection(-1);
      case "down":
        return this.moveSelection(1);
      case "enter":
        return this.openSearchResult(top);
      case "backspace":
        return this.setSearchQuery(top, top.query.slice(0, -1));
      case "char":
        return this.setSearchQuery(top, top.query + key.ch);
      case "ctrlU":
        return this.togglePopover();
      case "ctrlP":
        return this.togglePauseAll();
      case "tab":
        return this.triageWalk();
      default:
        return;
    }
  }

  /** Replace the search query in place, resetting the result selection to the top. */
  private setSearchQuery(top: Screen & { id: "search" }, query: string): void {
    this.stack = transition(this.stack, { t: "replaceTop", screen: { id: "search", query } });
    this.setSelection(this.top(), 0);
    this.tui.requestRender();
  }

  /** enter on a search result: navigate to its target screen; kinds with no screen
   * yet stay on search (a marked, sensible fallback). */
  private openSearchResult(top: Screen & { id: "search" }): void {
    const result = this.dataSource.search(top.query)[this.getSelection(top)];
    const screen = result?.screen;
    if (!screen) return; // not navigable yet — stay on search (pr / loopRun / deferred).
    // Guard the "auditable within two keys" promise: a result pointing at an
    // escalation that has since been resolved would open a blank card. Fall back
    // to staying on search rather than descending into nothing.
    if (screen.id === "escalation" && !this.dataSource.getEscalation(screen.escalationId)) return;
    this.push(screen);
  }

  /** `/`: push the search screen from anywhere (search is forever, archived incl.). */
  private openSearch(): void {
    this.helpVisible = false;
    this.stack = transition(this.stack, { t: "openSearch", query: "" });
    this.setSelection(this.top(), 0);
    this.tui.requestRender();
  }

  /** ctrl+u: OPEN the usage popover (the dispatch guard handles closing on any key). */
  private togglePopover(): void {
    this.popoverOpen = !this.popoverOpen;
    this.tui.requestRender();
  }

  /** `?`: toggle the per-screen key-help hint (shown on the prompt line). */
  private toggleHelp(): void {
    this.helpVisible = !this.helpVisible;
    this.tui.requestRender();
  }

  /** esc: pop the stack (never quits at home; home just no-ops). */
  private ascend(): void {
    this.helpVisible = false;
    if (this.stack.length > 1) {
      this.stack = transition(this.stack, { t: "pop" });
      this.tui.requestRender();
    }
    // At home with an empty buffer, esc is a no-op — never quits.
  }

  /** enter: descend into the selected row's screen for the active screen. */
  private descend(top: Screen): void {
    if (top.id === "home") {
      const rows = selectableRows(this.dataSource.snapshot());
      const row = rows[this.getSelection(top)];
      // A workflow row drills into 6c; a needs-you row opens its 7b card (the safe
      // choice — opening, not deciding); a loop row opens its 7a builder.
      if (row?.kind === "workflow") this.push({ id: "drillin", workflowId: row.id });
      else if (row?.kind === "escalation") this.push({ id: "escalation", escalationId: row.id });
      else if (row?.kind === "loop") this.push({ id: "loopBuilder", loopId: row.id });
      return;
    }
    if (top.id === "drillin") {
      const detail = this.dataSource.getDrillIn(top.workflowId);
      const worktree = detail?.worktrees[this.getSelection(top)];
      if (worktree) this.push({ id: "session", worktreeId: worktree.id });
      return;
    }
    if (top.id === "escalation") {
      // 7b enter: open the full session. Reuse the 4a screen; a generic session id
      // is fine when the escalation has no associated worktree.
      const escalation = this.dataSource.getEscalation(top.escalationId);
      const worktreeId = escalation?.worktreeId ?? `esc-${top.escalationId}`;
      this.push({ id: "session", worktreeId });
      return;
    }
    if (top.id === "digest") {
      // 7c enter → mission control (home). The digest only ever sits at [home,
      // digest], so ascending one hop is home.
      this.ascend();
      return;
    }
    // session: enter is a no-op (its actions are d / m / i / o).
  }

  private push(screen: Screen): void {
    this.helpVisible = false;
    this.stack = transition(this.stack, { t: "push", screen });
    this.tui.requestRender();
  }

  // ── 7b / 7c / triage walk (Phase 4) ──────────────────────────────────────

  /**
   * `tab` from ANYWHERE → the next needs-you item as `[home, escalation(next)]`
   * (replace-above-home, never grows the stack — so esc is always one hop to home).
   * From an escalation it advances to the NEXT queued item, wrapping; from anywhere
   * else it jumps to the first. No needs-you items → a no-op (stays put).
   */
  private triageWalk(): void {
    const top = this.top();
    const currentId = top.id === "escalation" ? top.escalationId : undefined;
    const nextId = nextNeedsYouId(this.dataSource.snapshot(), currentId);
    if (!nextId) return;
    this.helpVisible = false;
    this.stack = transition(this.stack, { t: "triageWalk", escalationId: nextId });
    this.tui.requestRender();
  }

  /** `1-9` on home: open the Nth needs-you card (safe: open, never decide blind). */
  private openNeedsYou(index: number): void {
    const escalation = this.dataSource.listEscalations()[index];
    if (escalation) this.push({ id: "escalation", escalationId: escalation.id });
  }

  /** 7b printable keys: `1-9` decide · `?` ask more · `[` / `]` prev/next in place. */
  private handleEscalationChar(top: Screen & { id: "escalation" }, ch: string): void {
    if (ch === "?") return this.askFollowUp(top.escalationId);
    if (ch === "[") return this.cycleEscalation(top.escalationId, -1);
    if (ch === "]") return this.cycleEscalation(top.escalationId, 1);
    if (ch >= "1" && ch <= "9") return this.decideOption(top.escalationId, ch.charCodeAt(0) - "1".charCodeAt(0));
    // Unbound printable focuses/starts the prompt (the Gmail rule).
    this.buffer += ch;
    this.tui.requestRender();
  }

  /** 7c printable keys: `d` decisions first · `l` full log (stub). */
  private handleDigestChar(ch: string): void {
    if (ch === "d") return this.digestToDecisions();
    if (ch === "l") return; // full log — Phase 5 stub. TODO(phase-5): open the log.
    // Unbound printable focuses/starts the prompt (the Gmail rule).
    this.buffer += ch;
    this.tui.requestRender();
  }

  /**
   * 6a printable keys: `g` go (locks intent / "spawns" — DISABLED while pi still has
   * open questions, a no-op that keeps it dim), `e` edit plan (stub), `x` discard.
   */
  private handleIntakeChar(top: Screen & { id: "intake" }, ch: string): void {
    if (ch === "g") return this.intakeGo(top);
    if (ch === "e") return; // edit plan — marked stub. TODO: reopen the plan editor.
    if (ch === "x") return this.ascend(); // discard = pop back to home
    // Unbound printable focuses/starts the prompt (the Gmail rule).
    this.buffer += ch;
    this.tui.requestRender();
  }

  /**
   * 6a `g`: while open questions remain this is a no-op (the action renders dim). Once
   * resolved it locks intent and "spawns" the workflows — a marked stub: a real
   * source creates the goal + lanes; here we return to mission control.
   */
  private intakeGo(top: Screen & { id: "intake" }): void {
    const draft = this.dataSource.getIntake(top.draftId);
    if (!draft || draft.openQuestions) return; // disabled while pi has open questions
    // TODO(seam): dataSource.spawnGoal(draft) — create the goal + workflows here.
    this.ascend();
  }

  /**
   * 7a printable keys. Before a trial: `t` trial run · `e` edit (stub) · `x` discard.
   * After a PASSED trial: `s` accept schedule (stub) · `r` revise (reopen builder) ·
   * `x` discard. A FAILED trial reopens the builder (via `t` to re-run).
   */
  private handleLoopBuilderChar(top: Screen & { id: "loopBuilder" }, ch: string): void {
    const trial = this.trialState(top);
    if (ch === "t") {
      if (trial === "idle" || trial === "failed") return this.trialRun(top);
      return; // already trialing / passed — `t` is not offered
    }
    if (ch === "s") {
      if (trial === "passed") return this.acceptSchedule(top);
      return;
    }
    if (ch === "r") {
      if (trial === "passed") return this.reviseLoop(top);
      return;
    }
    if (ch === "e") return; // edit — advertised action; a marked stub (consumed, not typed)
    if (ch === "x") return this.ascend(); // discard = pop
    // Unbound printable focuses/starts the prompt (the Gmail rule).
    this.buffer += ch;
    this.tui.requestRender();
  }

  /**
   * 7a `t`: run the mandatory trial under full review. On success the gate becomes
   * `passed` (s/r/x offered); on failure it becomes `failed` — the builder reopens
   * and is NEVER auto-retried. Await the (possibly async) DataSource like decide.
   */
  private trialRun(top: Screen & { id: "loopBuilder" }): void {
    const key = this.screenKey(top);
    if (this.trials.get(key) === "trialing") return;
    this.trials.set(key, "trialing");
    this.tui.requestRender();
    void Promise.resolve(this.dataSource.trialLoop(top.loopId))
      .then(({ ok }) => {
        this.trials.set(key, ok ? "passed" : "failed");
      })
      .catch(() => {
        this.trials.set(key, "failed");
      })
      .finally(() => this.tui.requestRender());
  }

  /** 7a `s`: accept the schedule (marked stub) and return to home; the loop goes live. */
  private acceptSchedule(top: Screen & { id: "loopBuilder" }): void {
    // TODO(seam): dataSource.scheduleLoop(top.loopId) — persist the live schedule.
    this.trials.delete(this.screenKey(top));
    this.ascend();
  }

  /** 7a `r`: revise — reopen the builder by resetting the trial gate to idle. */
  private reviseLoop(top: Screen & { id: "loopBuilder" }): void {
    this.trials.set(this.screenKey(top), "idle");
    this.tui.requestRender();
  }

  /**
   * 7d printable keys: `a` apply precedents (marks them applied — a confirmation
   * line), `r` full report (stub), `x` archive the goal and return home.
   */
  private handleCloseoutChar(top: Screen & { id: "closeout" }, ch: string): void {
    if (ch === "a") return this.applyPrecedents(top);
    if (ch === "r") return; // full report — marked stub.
    if (ch === "x") return this.archiveCurrentGoal(top);
    // Unbound printable focuses/starts the prompt (the Gmail rule).
    this.buffer += ch;
    this.tui.requestRender();
  }

  /** 7d `a`: apply the proposed precedents (a marked stub — shows a confirmation). */
  private applyPrecedents(top: Screen & { id: "closeout" }): void {
    // TODO(seam): dataSource.applyPrecedents(top.goalId) — persist to CLAUDE.md /
    // skills (same disk seam as the precedent store in store.ts).
    this.applied.add(this.screenKey(top));
    this.tui.requestRender();
  }

  /** 7d `x`: archive the completed goal (search still finds it) and return home. */
  private archiveCurrentGoal(top: Screen & { id: "closeout" }): void {
    this.dataSource.archiveGoal(top.goalId);
    this.ascend();
  }

  /**
   * 7b decide: record the precedent + drop the item, then advance to the next
   * unresolved escalation in place; if the queue is now empty, ascend to home.
   * Out-of-range option digits are ignored.
   */
  private decideOption(escalationId: string, index: number): void {
    const escalation = this.dataSource.getEscalation(escalationId);
    if (!escalation || index < 0 || index >= escalation.options.length) return;
    // Await the decision before recomputing the queue: a real (async) DataSource
    // may defer the store mutation, and reading listEscalations() before it lands
    // would strand the operator on the just-decided card. handleInput stays sync;
    // the advance + repaint happen when the decision resolves.
    void Promise.resolve(this.dataSource.decide(escalationId, index))
      .then(() => {
        const remaining = this.dataSource.listEscalations();
        this.stack =
          remaining.length > 0
            ? transition(this.stack, { t: "replaceTop", screen: { id: "escalation", escalationId: remaining[0].id } })
            : transition(this.stack, { t: "pop" });
      })
      .catch(() => {
        // A failed decision leaves the card in place — nothing to advance.
      })
      .finally(() => this.tui.requestRender());
  }

  /** 7b `[` / `]`: cycle to the prev/next escalation IN PLACE (replace-top, wraps). */
  private cycleEscalation(escalationId: string, direction: number): void {
    const list = this.dataSource.listEscalations();
    if (list.length === 0) return;
    const index = list.findIndex((escalation) => escalation.id === escalationId);
    const base = index < 0 ? 0 : index;
    const nextIndex = ((base + direction) % list.length + list.length) % list.length;
    this.stack = transition(this.stack, { t: "replaceTop", screen: { id: "escalation", escalationId: list[nextIndex].id } });
    this.tui.requestRender();
  }

  /** 7b `?`: append a follow-up (a marked no-op stub — a dim line on the card). */
  private askFollowUp(escalationId: string): void {
    const key = `escalation:${escalationId}`;
    this.followUps.set(key, (this.followUps.get(key) ?? 0) + 1);
    this.tui.requestRender();
  }

  /** 7c `d`: jump into the decision queue (the tab triage walk to the first item). */
  private digestToDecisions(): void {
    const nextId = nextNeedsYouId(this.dataSource.snapshot());
    if (!nextId) {
      // Nothing queued: fall back to mission control rather than dead-end.
      this.stack = transition(this.stack, { t: "pop" });
      this.tui.requestRender();
      return;
    }
    this.stack = transition(this.stack, { t: "triageWalk", escalationId: nextId });
    this.tui.requestRender();
  }

  /** Per-screen printable keys while the prompt is empty (the Gmail rule). */
  private handleChar(top: Screen, ch: string): void {
    // `q` always quits (with a non-empty buffer this branch is never reached).
    if (ch === "q") {
      this.done();
      return;
    }
    // `/` opens search from ANYWHERE (a global, before any per-screen handler).
    if (ch === "/") return this.openSearch();

    // 7b / 7c own their printable keys FIRST (so `?` is "ask pi more", not help).
    if (top.id === "escalation") return this.handleEscalationChar(top, ch);
    if (top.id === "digest") return this.handleDigestChar(ch);

    // `?` toggles the per-screen key help on every other screen (empty prompt only;
    // with a non-empty buffer it is a literal character, handled in the buffer path).
    if (ch === "?") return this.toggleHelp();

    // 6a / 7a / 7d cards own their action keys.
    if (top.id === "intake") return this.handleIntakeChar(top, ch);
    if (top.id === "loopBuilder") return this.handleLoopBuilderChar(top, ch);
    if (top.id === "closeout") return this.handleCloseoutChar(top, ch);

    // Universal empty-prompt keys (fleet screens: home / drillin / session).
    switch (ch) {
      case "j":
        return this.moveSelection(1);
      case "k":
        return this.moveSelection(-1);
    }

    // Screen-specific keys.
    if (top.id === "home") {
      switch (ch) {
        case "n":
          return this.push({ id: "intake", draftId: "d-esm" }); // new goal → 6a intake
        case "N":
          return this.push({ id: "loopBuilder", loopId: "l-draft-gh-issues" }); // new loop → 7a
        case "p":
          return this.pauseSelected(top);
      }
      // `1-9` on home acts on the Nth needs-you item — the SAFE choice is opening
      // its 7b card (never deciding blind).
      if (ch >= "1" && ch <= "9") return this.openNeedsYou(ch.charCodeAt(0) - "1".charCodeAt(0));
    } else if (top.id === "drillin") {
      switch (ch) {
        case "p":
          // pause worktree — no worktree-level pause in the data source yet.
          return; // TODO(phase-4): pause the selected worktree.
        case "r":
          return; // reassign queue slice — TODO(phase-4).
        case "t":
          return; // test-race detail — TODO(phase-4).
      }
    } else if (top.id === "session") {
      switch (ch) {
        case "o":
          return this.toggleExpand(top);
        case "d":
          return; // full diff — TODO(phase-4).
        case "m":
          return; // merge — TODO(phase-4).
        case "i":
          return; // interrupt & steer — TODO(phase-4).
      }
    }

    // Unbound printable with an empty buffer focuses/starts the prompt.
    this.buffer += ch;
    this.tui.requestRender();
  }

  /** Move the active screen's selection cursor, clamped to its row range. */
  private moveSelection(delta: number): void {
    const top = this.top();
    const count = this.selectionCount(top, this.dataSource.snapshot());
    const current = this.getSelection(top);
    this.setSelection(top, count <= 0 ? 0 : Math.min(count - 1, Math.max(0, current + delta)));
    this.tui.requestRender();
  }

  /** `o` (4a): toggle expansion of the selected activity line, if expandable. */
  private toggleExpand(top: Screen): void {
    if (top.id !== "session") return;
    const session = this.dataSource.getSession(top.worktreeId);
    const index = this.getSelection(top);
    const line = session?.lines[index];
    if (!line?.expandable) return;
    const set = this.expandedSet(top);
    if (set.has(index)) set.delete(index);
    else set.add(index);
    this.tui.requestRender();
  }

  /** Toggle global pause via the data source (drives the store's pausedAll). */
  private togglePauseAll(): void {
    if (this.dataSource.snapshot().pausedAll) this.dataSource.resumeAll();
    else this.dataSource.pauseAll();
    // The store notifies subscribers, which requests a render.
  }

  /**
   * `p` (home): pause the selected row. A workflow row pauses that lane; anything
   * else (or an empty list) falls back to pause-all — always a safe operation.
   */
  private pauseSelected(top: Screen): void {
    const rows = selectableRows(this.dataSource.snapshot());
    const row = rows[this.getSelection(top)];
    if (row?.kind === "workflow") this.dataSource.pauseWorkflow(row.id);
    else this.dataSource.pauseAll();
    // The store notifies subscribers, which requests a render.
  }

  invalidate(): void {
    // Rendering is stateless per frame and resolves colors on every render.
  }

  dispose(): void {
    // Release the data-source subscription taken in the constructor.
    this.unsubscribe();
  }
}
