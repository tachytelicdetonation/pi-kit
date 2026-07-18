/**
 * Precedent capture + auto-resolve — the pure core of the 7b decision memory.
 *
 * A DECISION on an escalation is recorded as a {@link Precedent} keyed by the
 * escalation's normalized {@link Escalation.signature}. A subsequently-seen
 * escalation whose signature matches a NON-`declined` precedent auto-resolves and
 * is flagged, so "identical future conflicts auto-resolve and note it" (the design)
 * without asking the operator twice. Declined precedents are never auto-applied.
 *
 * Everything here is pure (no wall-clock, no IO); the store wires it into mutations
 * and the mock seeds it. Disk persistence is a Phase-5 seam (see {@link ./store.ts}).
 */
import type { Escalation, Precedent } from "./types.js";

/** The first non-declined precedent matching `signature`, or `undefined`. */
export function matchingPrecedent(signature: string, precedents: readonly Precedent[]): Precedent | undefined {
  return precedents.find((precedent) => !precedent.declined && precedent.signature === signature);
}

/**
 * Build the precedent recorded when `escalation` is decided with option `index`.
 * The rationale distinguishes accepting pi's recommendation from an operator
 * override — meaningful, deterministic, and searchable.
 */
export function buildPrecedent(escalation: Escalation, index: number): Precedent {
  const option = escalation.options[index];
  return {
    id: `p-${escalation.id}-${index}`,
    signature: escalation.signature,
    question: escalation.question,
    decision: option?.text ?? "",
    rationale: option?.recommended ? "accepted pi's recommendation" : "operator override",
  };
}

/**
 * If a non-declined precedent matches `escalation.signature`, return a COPY flagged
 * as auto-resolved (with a note quoting the remembered decision); otherwise return
 * the escalation unchanged. Never mutates the input.
 */
export function autoResolve(escalation: Escalation, precedents: readonly Precedent[]): Escalation {
  const precedent = matchingPrecedent(escalation.signature, precedents);
  if (!precedent) return escalation;
  return {
    ...escalation,
    resolved: true,
    precedentNote: `auto-resolved by precedent: ${precedent.decision}`,
  };
}
