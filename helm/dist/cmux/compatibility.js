import { runCommand } from "./process.js";
export const REQUIRED_CMUX_METHODS = [
    // events.stream is consumed through the documented `cmux events` CLI. Some
    // cmux builds intentionally omit streaming methods from capabilities output.
    "feed.exit_plan.reply",
    "feed.permission.reply",
    "feed.question.reply",
    "surface.close",
    "surface.read_text",
    "surface.send_key",
    "terminal.paste",
    "workspace.close",
    "workspace.create",
];
export async function checkCompatibility(cmux, options = { strict: true }) {
    const warnings = [];
    const errors = [];
    let cmuxVersion;
    let claudeVersion;
    let socketPath;
    try {
        await cmux.ping();
        const capabilities = await cmux.capabilities();
        socketPath = capabilities.socket_path;
        if (capabilities.protocol !== "cmux-socket")
            errors.push(`Unexpected cmux protocol: ${capabilities.protocol ?? "missing"}`);
        if (capabilities.access_mode !== "cmuxOnly")
            warnings.push(`Unexpected cmux access mode: ${capabilities.access_mode ?? "missing"}`);
        for (const method of REQUIRED_CMUX_METHODS) {
            if (!capabilities.methods.includes(method))
                errors.push(`cmux is missing required method: ${method}`);
        }
        cmuxVersion = await cmux.version();
        const parsed = parseVersion(cmuxVersion);
        if (!parsed || !inRange(parsed, [0, 64, 19], [0, 65, 0])) {
            const message = `Untested cmux version: ${cmuxVersion}`;
            (options.strict ? errors : warnings).push(message);
        }
    }
    catch (error) {
        errors.push(`cmux compatibility check failed: ${message(error)}`);
    }
    try {
        const claudeBin = options.claudeBin ?? "claude";
        const versionResult = await runCommand(claudeBin, ["--version"], {
            env: options.env,
            timeoutMs: 10_000,
        });
        if (versionResult.code !== 0)
            throw new Error(versionResult.stderr || `exit ${versionResult.code}`);
        claudeVersion = versionResult.stdout.trim();
        const parsed = parseVersion(claudeVersion);
        if (!parsed || !inRange(parsed, [2, 1, 212], [2, 2, 0])) {
            const text = `Untested Claude Code version: ${claudeVersion}`;
            (options.strict ? errors : warnings).push(text);
        }
        const helpResult = await runCommand(claudeBin, ["--help"], { env: options.env, timeoutMs: 10_000 });
        if (helpResult.code !== 0)
            throw new Error(helpResult.stderr || `exit ${helpResult.code}`);
        const help = `${helpResult.stdout}\n${helpResult.stderr}`;
        if (!help.includes("--permission-mode"))
            errors.push("Claude Code lacks --permission-mode");
        if (!/--permission-mode[\s\S]{0,600}[\"']plan[\"']/i.test(help)) {
            errors.push("Claude Code does not advertise plan permission mode");
        }
        if (!help.includes("--resume"))
            errors.push("Claude Code lacks --resume");
    }
    catch (error) {
        errors.push(`Claude Code compatibility check failed: ${message(error)}`);
    }
    return { ok: errors.length === 0, cmuxVersion, claudeVersion, socketPath, warnings, errors };
}
export function parseVersion(value) {
    const match = value.match(/(?:^|\s)(\d+)\.(\d+)\.(\d+)(?:\s|$|\()/);
    if (!match)
        return undefined;
    return [Number(match[1]), Number(match[2]), Number(match[3])];
}
function inRange(value, minimum, exclusiveMaximum) {
    return compare(value, minimum) >= 0 && compare(value, exclusiveMaximum) < 0;
}
function compare(left, right) {
    for (let index = 0; index < 3; index++) {
        if (left[index] !== right[index])
            return left[index] - right[index];
    }
    return 0;
}
function message(error) {
    return error instanceof Error ? error.message : String(error);
}
