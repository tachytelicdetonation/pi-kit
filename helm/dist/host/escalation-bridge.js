/** Monotonic id source — a bridged prompt needs a unique id + signature. */
let seq = 0;
/**
 * Surface `request` as a helm escalation; resolve with the chosen option index when
 * the operator decides it. Rejected/denied is just "index of the deny option" —
 * the caller maps indices back to its own allow/deny semantics.
 */
export function bridgePermissionRequest(ds, request) {
    const id = `bridge-${++seq}-${Date.now()}`;
    const signature = `bridge:${id}`; // unique so it never auto-resolves against a real precedent
    const escalation = {
        id,
        source: request.source,
        question: request.question,
        verb: "review",
        blockedSinceMs: Date.now(),
        problem: request.question,
        evidence: request.evidence ?? [],
        options: request.options.map((text, index) => ({ text, recommended: index === 0 })),
        blockedMinutes: 0,
        idleNote: "",
        signature,
        precedentPhrase: request.question,
        worktreeId: request.worktreeId,
    };
    return new Promise((resolve) => {
        let settled = false;
        const unsubscribe = ds.subscribe(() => {
            if (settled)
                return;
            const current = ds.getEscalation(id);
            if (current && !current.resolved)
                return; // still pending in the queue
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
