export type FetchLike = (input: string | URL, init?: RequestInit) => Promise<Response>;

export async function fetchJson(
  url: string,
  init: RequestInit,
  options: { timeoutMs?: number; fetchImpl?: FetchLike } = {},
): Promise<unknown> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeout = AbortSignal.timeout(options.timeoutMs ?? 8_000);
  const signals = [timeout];
  if (init.signal) signals.push(init.signal);
  const response = await fetchImpl(url, { ...init, signal: AbortSignal.any(signals) });
  if (!response.ok) {
    throw new HttpError(response.status, `HTTP ${response.status} from ${new URL(url).hostname}`);
  }
  return response.json() as Promise<unknown>;
}

export class HttpError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

export function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function finiteNumber(value: unknown): number | undefined {
  const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isFinite(number) ? number : undefined;
}

export function parseTimestamp(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 10_000_000_000 ? value : value * 1_000;
  }
  if (typeof value !== "string" || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}
