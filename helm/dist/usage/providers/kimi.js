import { randomBytes } from "node:crypto";
import { mkdir, open, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import lockfile from "proper-lockfile";
import { asRecord, finiteNumber, parseTimestamp } from "../http.js";
import { clampPercent } from "../types.js";
const KIMI_BASE_URL = "https://api.kimi.com/coding/v1";
const KIMI_OAUTH_HOST = "https://auth.kimi.com";
const KIMI_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
export async function fetchKimiUsage(options) {
    const now = options.now ?? Date.now;
    const fetchImpl = options.fetchImpl ?? fetch;
    const credential = options.apiKey ??
        process.env.KIMI_API_KEY ??
        (await ensureFreshKimiCredential(options.paths, now, fetchImpl, options.timeoutMs));
    if (!credential)
        throw new Error("Kimi Code is not authenticated");
    const baseUrl = (options.baseUrl ?? process.env.KIMI_CODE_BASE_URL ?? KIMI_BASE_URL).replace(/\/+$/, "");
    const response = await fetchImpl(`${baseUrl}/usages`, {
        headers: { Authorization: `Bearer ${credential}`, Accept: "application/json" },
        signal: AbortSignal.timeout(options.timeoutMs ?? 8_000),
    });
    if (!response.ok)
        throw new Error(`Kimi usage returned HTTP ${response.status}`);
    return parseKimiUsagePayload(await response.json(), now());
}
export function parseKimiUsagePayload(payload, fetchedAt = Date.now()) {
    const root = asRecord(payload);
    if (!root)
        throw new Error("Kimi usage response was not an object");
    const buckets = [];
    addUsageRow(buckets, root.usage, "weekly", "Weekly", true);
    if (Array.isArray(root.limits)) {
        root.limits.forEach((item, index) => {
            const record = asRecord(item);
            if (!record)
                return;
            const detail = asRecord(record.detail) ?? record;
            const window = asRecord(record.window);
            const label = stringValue(record.name) ?? stringValue(detail.name) ?? windowLabel(window) ?? `Limit ${index + 1}`;
            addUsageRow(buckets, { ...detail, resetAt: detail.resetAt ?? detail.reset_at ?? record.resetAt ?? record.reset_at }, `limit-${index + 1}`, label, true, window);
        });
    }
    if (buckets.length === 0)
        throw new Error("Kimi usage response contained no quota windows");
    return { provider: "kimi", source: "live", fetchedAt, buckets };
}
export async function ensureFreshKimiCredential(paths, now, fetchImpl, timeoutMs = 8_000) {
    const tokenPath = join(paths.kimiDir, "credentials", "kimi-code.json");
    const initial = await readKimiToken(tokenPath);
    if (!initial)
        return undefined;
    if (initial.expires_at * 1_000 > now() + 5 * 60_000)
        return initial.access_token;
    const oauthDirectory = join(paths.kimiDir, "oauth");
    const lockTarget = join(oauthDirectory, "kimi-code");
    await mkdir(oauthDirectory, { recursive: true, mode: 0o700 });
    await writeFile(lockTarget, "", { flag: "a", mode: 0o600 });
    const release = await lockfile.lock(lockTarget, {
        retries: { retries: 12, factor: 1, minTimeout: 250, maxTimeout: 500 },
        stale: 5_000,
        realpath: false,
    });
    try {
        // Match Kimi's own OAuth manager: re-read after taking its cross-process lock
        // so a concurrent CLI refresh wins without rotating the same token twice.
        const current = (await readKimiToken(tokenPath)) ?? initial;
        if (current.expires_at * 1_000 > now() + 5 * 60_000)
            return current.access_token;
        if (!current.refresh_token)
            throw new Error("Kimi OAuth credential has no refresh token; run /login in Kimi Code");
        const oauthHost = (process.env.KIMI_CODE_OAUTH_HOST ?? process.env.KIMI_OAUTH_HOST ?? KIMI_OAUTH_HOST).replace(/\/+$/, "");
        const response = await fetchImpl(`${oauthHost}/api/oauth/token`, {
            method: "POST",
            headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
            body: new URLSearchParams({
                client_id: KIMI_CLIENT_ID,
                grant_type: "refresh_token",
                refresh_token: current.refresh_token,
            }).toString(),
            signal: AbortSignal.timeout(timeoutMs),
        });
        if (!response.ok)
            throw new Error(`Kimi OAuth refresh returned HTTP ${response.status}; run /login in Kimi Code`);
        const payload = asRecord(await response.json());
        const accessToken = typeof payload?.access_token === "string" ? payload.access_token : undefined;
        const refreshToken = typeof payload?.refresh_token === "string" ? payload.refresh_token : undefined;
        const expiresIn = finiteNumber(payload?.expires_in);
        if (!accessToken || !refreshToken || expiresIn === undefined || expiresIn <= 0) {
            throw new Error("Kimi OAuth refresh returned an invalid token payload");
        }
        const refreshed = {
            access_token: accessToken,
            refresh_token: refreshToken,
            expires_at: Math.floor(now() / 1_000) + Math.floor(expiresIn),
            scope: typeof payload?.scope === "string" ? payload.scope : current.scope,
            token_type: typeof payload?.token_type === "string" ? payload.token_type : "Bearer",
            expires_in: Math.floor(expiresIn),
        };
        await writeKimiToken(tokenPath, refreshed);
        return refreshed.access_token;
    }
    finally {
        await release().catch(() => { });
    }
}
async function readKimiToken(path) {
    try {
        const root = asRecord(JSON.parse(await readFile(path, "utf8")));
        const expiresAt = finiteNumber(root?.expires_at);
        const expiresIn = finiteNumber(root?.expires_in);
        if (typeof root?.access_token !== "string" ||
            typeof root.refresh_token !== "string" ||
            expiresAt === undefined ||
            expiresIn === undefined) {
            return undefined;
        }
        return {
            access_token: root.access_token,
            refresh_token: root.refresh_token,
            expires_at: expiresAt,
            scope: typeof root.scope === "string" ? root.scope : "",
            token_type: typeof root.token_type === "string" ? root.token_type : "Bearer",
            expires_in: expiresIn,
        };
    }
    catch {
        return undefined;
    }
}
async function writeKimiToken(path, token) {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    const temporary = `${path}.tmp.${process.pid}.${randomBytes(4).toString("hex")}`;
    const handle = await open(temporary, "w", 0o600);
    try {
        await handle.writeFile(`${JSON.stringify(token, null, 2)}\n`, "utf8");
        await handle.sync();
    }
    finally {
        await handle.close();
    }
    await rename(temporary, path);
}
function addUsageRow(target, value, id, defaultLabel, affectsHealth, window) {
    const record = asRecord(value);
    const limit = finiteNumber(record?.limit);
    let used = finiteNumber(record?.used);
    if (used === undefined && limit !== undefined) {
        const remaining = finiteNumber(record?.remaining);
        if (remaining !== undefined)
            used = limit - remaining;
    }
    if (!record || limit === undefined || limit <= 0 || used === undefined)
        return;
    const resetsAt = parseTimestamp(record.reset_at ?? record.resetAt ?? record.reset_time ?? record.resetTime);
    const duration = finiteNumber(window?.duration);
    const unit = stringValue(window?.timeUnit)?.toUpperCase();
    const windowMinutes = duration === undefined ? undefined : toMinutes(duration, unit);
    target.push({
        id,
        label: stringValue(record.name) ?? stringValue(record.title) ?? defaultLabel,
        usedPercent: clampPercent((used / limit) * 100),
        ...(resetsAt !== undefined ? { resetsAt } : {}),
        ...(windowMinutes !== undefined ? { windowMinutes } : {}),
        ...(affectsHealth ? {} : { affectsHealth: false }),
    });
}
function windowLabel(window) {
    const duration = finiteNumber(window?.duration);
    const unit = stringValue(window?.timeUnit)?.toUpperCase();
    if (duration === undefined)
        return undefined;
    if (unit?.includes("MINUTE"))
        return duration >= 60 && duration % 60 === 0 ? `${duration / 60}-hour` : `${duration}-minute`;
    if (unit?.includes("HOUR"))
        return `${duration}-hour`;
    if (unit?.includes("DAY"))
        return `${duration}-day`;
    return `${duration}-second`;
}
function toMinutes(duration, unit) {
    if (unit?.includes("MINUTE"))
        return duration;
    if (unit?.includes("HOUR"))
        return duration * 60;
    if (unit?.includes("DAY"))
        return duration * 1_440;
    if (unit?.includes("SECOND"))
        return duration / 60;
    return undefined;
}
function stringValue(value) {
    return typeof value === "string" && value.trim().length > 0 ? value.trim().slice(0, 160) : undefined;
}
