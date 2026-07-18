export async function fetchJson(url, init, options = {}) {
    const fetchImpl = options.fetchImpl ?? fetch;
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 8_000);
    const signals = [timeout];
    if (init.signal)
        signals.push(init.signal);
    const response = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
    if (!response.ok) {
        throw new HttpError(response.status, `HTTP ${response.status} from ${new URL(url).hostname}`);
    }
    return response.json();
}
export class HttpError extends Error {
    status;
    constructor(status, message) {
        super(message);
        this.status = status;
        this.name = "HttpError";
    }
}
export function asRecord(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value)
        ? value
        : undefined;
}
export function finiteNumber(value) {
    const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
    return Number.isFinite(number) ? number : undefined;
}
export function parseTimestamp(value) {
    if (typeof value === "number" && Number.isFinite(value)) {
        return value > 10_000_000_000 ? value : value * 1_000;
    }
    if (typeof value !== "string" || value.length === 0)
        return undefined;
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
