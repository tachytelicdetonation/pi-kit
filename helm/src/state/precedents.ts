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

/**
 * Merge closeout proposals with their durable lifecycle state. The latest proposal
 * remains authoritative for its payload; stored records contribute only lifecycle
 * fields (`declined` / `appliesTo`). Declined or handed-off records are omitted.
 */
export function canonicalProposedPrecedents(
  proposals: readonly Precedent[],
  stored: readonly Precedent[],
): Precedent[] {
  const latestProposalById = new Map(proposals.map((precedent) => [precedent.id, precedent]));
  const storedById = new Map(stored.map((precedent) => [precedent.id, precedent]));
  const orderedIds = [...new Set([...proposals.map((precedent) => precedent.id), ...stored.map((precedent) => precedent.id)])];
  const result: Precedent[] = [];
  for (const id of orderedIds) {
    const proposal = latestProposalById.get(id);
    const durable = storedById.get(id);
    const canonical = proposal && durable
      ? proposal.signature === durable.signature
        ? { ...proposal, declined: durable.declined, appliesTo: durable.appliesTo }
        : durable
      : (proposal ?? durable)!;
    if (canonical.declined || canonical.appliesTo) continue;
    result.push(canonical);
  }
  return result;
}

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
  if (escalation.resolutionClass === "permission" || escalation.resolutionClass === "approval") return escalation;
  const precedent = matchingPrecedent(escalation.signature, precedents);
  if (!precedent) return escalation;
  return {
    ...escalation,
    resolved: true,
    precedentNote: `auto-resolved by precedent: ${precedent.decision}`,
  };
}

function normalized(value: string): string {
  return value.toLowerCase().trim().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "unknown";
}

/** Stable signature for decision conflicts: source + conflict kind + normalized scope. */
export function stableDecisionSignature(escalation: Escalation): string {
  const legacyKind = escalation.signature.split(":").slice(1).join(":") || escalation.question;
  const kind = escalation.conflictKind ?? legacyKind;
  const scope = escalation.scope ?? escalation.source.label;
  return `decision:${normalized(escalation.source.kind)}:${normalized(kind)}:${normalized(scope)}`;
}
