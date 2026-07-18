export const PROVIDER_ORDER = ["codex", "claude", "kimi"];
/** Relative plan-capacity units chosen by the user: $200 plans vs tinkering plans. */
export const PROVIDER_UNITS = {
    codex: 20,
    claude: 20,
    kimi: 1,
};
export const CELLS_PER_UNIT = 3;
export const TOTAL_UNITS = Object.values(PROVIDER_UNITS).reduce((total, units) => total + units, 0);
export const CANONICAL_BAR_CELLS = TOTAL_UNITS * CELLS_PER_UNIT;
export const PROVIDER_NAMES = {
    codex: "Codex",
    claude: "Claude",
    kimi: "Kimi",
};
export function clampPercent(value) {
    if (!Number.isFinite(value))
        return 0;
    return Math.min(100, Math.max(0, value));
}
export function providerRemaining(snapshot) {
    if (!snapshot)
        return undefined;
    const buckets = snapshot.buckets.filter((bucket) => bucket.affectsHealth !== false && Number.isFinite(bucket.usedPercent));
    if (buckets.length === 0)
        return undefined;
    return Math.min(...buckets.map((bucket) => 100 - clampPercent(bucket.usedPercent)));
}
export function aggregateRemaining(states) {
    const byProvider = new Map(states.map((state) => [state.provider, state]));
    let knownProviders = 0;
    let weightedRemaining = 0;
    for (const provider of PROVIDER_ORDER) {
        const remaining = providerRemaining(byProvider.get(provider)?.snapshot);
        if (remaining !== undefined) {
            knownProviders += 1;
            weightedRemaining += remaining * PROVIDER_UNITS[provider];
        }
        // Unknown providers deliberately contribute zero. Their allocated cells stay
        // gray rather than inventing a percentage or a token-based estimate.
    }
    if (knownProviders === 0)
        return undefined;
    return weightedRemaining / TOTAL_UNITS;
}
