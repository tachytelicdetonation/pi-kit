/**
 * Pure navigation state machine for helm.
 *
 * The nav stack models "enter descends, esc ascends, no dead ends": the bottom
 * frame is ALWAYS home, and every transition returns a fresh array (the input is
 * never mutated). Phase 1 only exercises `home`, but the full screen union and
 * action set are declared now so later phases plug in without reshaping this.
 *
 * Discriminant convention: a Screen is tagged by `id`; a NavAction is tagged by
 * `t`. They never collide, so both read unambiguously at call sites.
 */

/** Every screen in the stage-4 flow. Only `home` is reachable in Phase 1. */
export type Screen =
  | { id: "home" }
  | { id: "digest" }
  | { id: "intake"; draftId: string }
  | { id: "drillin"; workflowId: string }
  | { id: "session"; worktreeId: string }
  | { id: "escalation"; escalationId: string }
  | { id: "loopBuilder"; loopId: string }
  | { id: "closeout"; goalId: string }
  | { id: "search"; query: string };

/** A navigation intent applied to the stack by {@link transition}. */
export type NavAction =
  | { t: "push"; screen: Screen }
  | { t: "pop" }
  | { t: "triageWalk"; escalationId: string }
  | { t: "openSearch"; query: string }
  | { t: "replaceTop"; screen: Screen };

/** The initial stack: home at the bottom, nothing above it. */
export function initialStack(): Screen[] {
  return [{ id: "home" }];
}

/**
 * Apply `action` to `stack`, returning a NEW array (never mutates the input).
 *
 * Invariants preserved by every branch:
 * - the bottom frame is always `{ id: "home" }`;
 * - `pop` never removes the last (home) frame;
 * - `triageWalk` yields exactly `[home, escalation(id)]` regardless of prior depth;
 * - `push` appends; `replaceTop` swaps the top frame.
 */
export function transition(stack: Screen[], action: NavAction): Screen[] {
  const base = stack.length > 0 ? stack : initialStack();

  switch (action.t) {
    case "push":
      return [...base, action.screen];

    case "pop":
      // Never empty the stack: home is the floor.
      return base.length > 1 ? base.slice(0, -1) : [...base];

    case "replaceTop":
      // Replacing home's frame is a no-op on the floor invariant: keep home if
      // the stack is only home, otherwise swap the top.
      return base.length > 1
        ? [...base.slice(0, -1), action.screen]
        : [{ id: "home" }, action.screen];

    case "triageWalk":
      // The triage walk always resets to home → this escalation, whatever the
      // prior depth.
      return [{ id: "home" }, { id: "escalation", escalationId: action.escalationId }];

    case "openSearch":
      return [...base, { id: "search", query: action.query }];
  }
}
