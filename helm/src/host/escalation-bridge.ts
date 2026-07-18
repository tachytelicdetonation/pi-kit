/**
 * escalation-bridge — routes a backend permission/approval prompt INTO helm's
 * escalation queue instead of letting the backend draw its own ctx.ui surface.
 *
 * helm is the single UI owner. dynamic-workflows' permission broker and cmux's
 * permission-pending both need an operator decision; rather than each popping a
 * dialog (two owners fighting for the screen), they call this bridge. It adds a
 * needs-you escalation and returns a promise that resolves with the chosen option
 * INDEX once the operator decides it inside helm.
 *
 * The bridge takes NO ui handle — routing into helm is structural, not disciplined.
 * It recovers the chosen index without any change to `decide()`, by leaning on a
 * conformance-contract invariant: a decision records a precedent whose `decision`
 * equals the chosen option's text (datasource-contract "decide records a PRECEDENT").
 */
import type { DataSource } from "../data/source.js";
import type { Escalation } from "../state/types.js";

export interface PermissionRequest {
  /** Who is asking (workflow lane, loop, cmux session …) — becomes the card source. */
  source: Escalation["source"];
  /** The one-sentence ask, shown as the card question + problem. */
  question: string;
  /** The choices, in order; the first is treated as pi's recommendation. */
  options: string[];
  /** Optional minimal evidence block (never the full file). */
  evidence?: string[];
  /** Optional worktree this blocks, so the card can offer `enter full session`. */
  worktreeId?: string;
  /** Permission/approval choices default to the app's explicit y/n confirmation gate. */
  requiresConfirm?: boolean;
}

/** Monotonic id source — a bridged prompt needs a unique id + signature. */
let seq = 0;

/**
 * Surface `request` as a helm escalation; resolve with the chosen option index when
 * the operator decides it. Rejected/denied is just "index of the deny option" —
 * the caller maps indices back to its own allow/deny semantics.
 */
export function bridgePermissionRequest(ds: DataSource, request: PermissionRequest): Promise<number> {
  const id = `bridge-${++seq}-${Date.now()}`;
  const signature = `bridge:${id}`; // unique so it never auto-resolves against a real precedent
  const escalation: Escalation = {
    id,
    source: request.source,
    question: request.question,
    verb: "review",
    blockedSinceMs: Date.now(),
    problem: request.question,
    evidence: request.evidence ?? [],
    options: request.options.map((text, index) => ({
      text,
      recommended: index === 0,
      requiresConfirm: request.requiresConfirm ?? true,
    })),
    blockedMinutes: 0,
    idleNote: "",
    signature,
    resolutionClass: "permission",
    precedentPhrase: request.question,
    worktreeId: request.worktreeId,
  };

  return new Promise<number>((resolve) => {
    let settled = false;
    const unsubscribe = ds.subscribe(() => {
      if (settled) return;
      const current = ds.getEscalation(id);
      if (current && !current.resolved) return; // still pending in the queue
      // Gone from the queue (decided) or flagged resolved — recover the chosen index
      // from the precedent decide() recorded (contract: precedent.decision === option text).
      settled = true;
      unsubscribe();
      const precedent = ds.precedents().find((p) => p.signature === signature);
      const index = precedent ? request.options.findIndex((option) => option === precedent.decision) : -1;
      resolve(index >= 0 ? index : 0);
    });
    ds.addEscalation(escalation);
  });
}
