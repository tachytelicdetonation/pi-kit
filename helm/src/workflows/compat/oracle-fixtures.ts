import { isAbsolute } from "node:path";

const VOLATILE_KEYS = new Set([
  "agentId",
  "callId",
  "cost",
  "createdAt",
  "durationMs",
  "endedAt",
  "id",
  "inputTokens",
  "outputTokens",
  "runId",
  "sessionId",
  "startedAt",
  "timestamp",
  "tokenTotal",
  "totalTokens",
  "updatedAt",
]);

const ID_KEY = /(?:^|_)(?:agent|call|entry|message|request|run|session|tool)?_?id$/i;
const TIME_KEY = /(?:^|_)(?:at|date|duration|elapsed|timestamp)$/i;
const TOKEN_OR_COST_KEY = /(?:token|cost)/i;
const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z\b/g;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi;
const RUN_ID = /\b(?:run|session|call|agent)[-_][a-z0-9_-]{6,}\b/gi;
const UNIX_PATH = /(?:^|[\s"'(])\/(?:Users|home|tmp|private|var|workspace)\/[^\s"')]+/g;
const WINDOWS_PATH = /\b[A-Za-z]:\\(?:[^\\\s"']+\\)*[^\\\s"']*/g;

export const ORACLE_FIXTURE_SCHEMA_VERSION = 1;

export interface NormalizedOracleFixture {
  fixtureVersion: number;
  oracleVersion: string;
  provenance: "official-doc" | "black-box" | "Pi-specific";
  [key: string]: unknown;
}

function normalizeString(value: string): string {
  let result = value
    .replace(ISO_TIMESTAMP, "<timestamp>")
    .replace(UUID, "<id>")
    .replace(RUN_ID, "<id>")
    .replace(WINDOWS_PATH, "<absolute-path>");

  result = result.replace(UNIX_PATH, (match) => {
    const prefix = /^[\s"'(]/.exec(match)?.[0] ?? "";
    return `${prefix}<absolute-path>`;
  });

  if (isAbsolute(result)) return "<absolute-path>";
  return result;
}

function isVolatileKey(key: string): boolean {
  return VOLATILE_KEYS.has(key) || ID_KEY.test(key) || TIME_KEY.test(key) || TOKEN_OR_COST_KEY.test(key);
}

function normalizeValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeString(value);
  if (typeof value === "bigint") return "<number>";
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value === null || typeof value !== "object") return value;

  const source = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    normalized[key] = isVolatileKey(key)
      ? `<${TOKEN_OR_COST_KEY.test(key) ? "usage" : "volatile"}>`
      : normalizeValue(source[key]);
  }
  return normalized;
}

/** Removes capture-specific values while preserving contract-relevant ordering and states. */
export function normalizeOracleFixture(value: unknown): unknown {
  return normalizeValue(value);
}
