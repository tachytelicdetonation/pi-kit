/** The first non-declined precedent matching `signature`, or `undefined`. */
export function matchingPrecedent(signature, precedents) {
    return precedents.find((precedent) => !precedent.declined && precedent.signature === signature);
}
/**
 * Build the precedent recorded when `escalation` is decided with option `index`.
 * The rationale distinguishes accepting pi's recommendation from an operator
 * override — meaningful, deterministic, and searchable.
 */
export function buildPrecedent(escalation, index) {
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
export function autoResolve(escalation, precedents) {
    const precedent = matchingPrecedent(escalation.signature, precedents);
    if (!precedent)
        return escalation;
    return {
        ...escalation,
        resolved: true,
        precedentNote: `auto-resolved by precedent: ${precedent.decision}`,
    };
}
