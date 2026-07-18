import { runCommand, scrubCmuxTargetEnv } from "./process.js";
export class CmuxClient {
    bin;
    env;
    constructor(options = {}) {
        this.bin = options.bin ?? options.env?.CMUX_BIN ?? process.env.CMUX_BIN ?? "cmux";
        this.env = scrubCmuxTargetEnv(options.env ?? process.env);
    }
    async command(args, options = {}) {
        const result = await runCommand(this.bin, args, {
            env: this.env,
            timeoutMs: options.timeoutMs ?? 10_000,
            signal: options.signal,
        });
        if (result.code !== 0) {
            throw new Error(`cmux ${args[0] ?? "command"} failed (${result.code}): ${result.stderr.trim() || result.stdout.trim()}`);
        }
        return result;
    }
    async json(args, options = {}) {
        const result = await this.command(["--id-format", "both", "--json", ...args], options);
        try {
            return JSON.parse(result.stdout);
        }
        catch (error) {
            throw new Error(`cmux returned invalid JSON for ${args.join(" ")}: ${error.message}`);
        }
    }
    async ping() {
        await this.command(["ping"]);
    }
    async capabilities() {
        return this.json(["capabilities"]);
    }
    async version() {
        return (await this.command(["version"])).stdout.trim();
    }
    async identify() {
        return this.json(["identify", "--no-caller"]);
    }
    async callerIdentity() {
        return this.json(["identify"]);
    }
    async createClaudeWorkspace(options) {
        const command = options.resumeSessionId
            ? `claude --permission-mode ${options.permissionMode} --resume ${options.resumeSessionId}`
            : `claude --permission-mode ${options.permissionMode}`;
        const result = await this.command([
            "new-workspace",
            "--name",
            options.name,
            "--cwd",
            options.cwd,
            "--command",
            command,
            "--window",
            options.windowId,
            "--focus",
            "false",
        ], { timeoutMs: 20_000, signal: options.signal });
        const match = result.stdout.match(/\b(workspace:\d+)\b/);
        if (!match)
            throw new Error(`Could not parse workspace ref from cmux: ${result.stdout.trim()}`);
        const workspaceRef = match[1];
        const listed = await this.json(["list-workspaces", "--window", options.windowId], {
            signal: options.signal,
        });
        const workspace = listed.workspaces?.find((item) => item.ref === workspaceRef);
        if (!workspace)
            throw new Error(`cmux created ${workspaceRef}, but it was absent from workspace list`);
        const tree = await this.json(["tree", "--workspace", workspace.id, "--window", options.windowId], {
            signal: options.signal,
        });
        const treeWorkspace = tree.windows?.flatMap((window) => window.workspaces ?? []).find((item) => item.id === workspace.id);
        const surface = treeWorkspace?.panes
            ?.flatMap((pane) => pane.surfaces ?? [])
            .find((item) => item.type === "terminal");
        if (!surface)
            throw new Error(`cmux created ${workspaceRef}, but no terminal surface was found`);
        return { workspaceRef, workspaceId: workspace.id, surfaceId: surface.id };
    }
    async paste(surfaceId, text, signal) {
        await this.rpc("terminal.paste", { surface_id: surfaceId, text }, { signal });
    }
    async sendKey(surfaceId, key, signal) {
        await this.command(["send-key", "--surface", surfaceId, key], { signal });
    }
    async sendText(surfaceId, text, signal) {
        if (/[\r\n]/.test(text))
            throw new Error("Refusing multiline cmux send; use terminal.paste instead");
        await this.command(["send", "--surface", surfaceId, text], { signal });
    }
    async readScreen(surfaceId, lines = 60, signal) {
        const result = await this.command(["read-screen", "--surface", surfaceId, "--lines", String(lines)], { signal });
        return result.stdout;
    }
    async closeWorkspace(workspaceId) {
        await this.command(["close-workspace", "--workspace", workspaceId], { timeoutMs: 10_000 });
    }
    async topology() {
        return this.json(["tree", "--all"]);
    }
    async rpc(method, params, options = {}) {
        const result = await this.command(["rpc", method, JSON.stringify(params)], options);
        try {
            return JSON.parse(result.stdout);
        }
        catch (error) {
            throw new Error(`cmux rpc ${method} returned invalid JSON: ${error.message}`);
        }
    }
}
export function collectSurfaceIds(tree) {
    const ids = new Set();
    for (const window of tree.windows ?? []) {
        for (const workspace of window.workspaces ?? []) {
            for (const pane of workspace.panes ?? []) {
                for (const surface of pane.surfaces ?? [])
                    ids.add(surface.id);
            }
        }
    }
    return ids;
}
export function collectWorkspaceIds(tree) {
    return new Set((tree.windows ?? []).flatMap((window) => window.workspaces ?? []).map((workspace) => workspace.id));
}
