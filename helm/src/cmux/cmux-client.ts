import type { CmuxCapabilities, PermissionMode } from "./types.js";
import { runCommand, scrubCmuxTargetEnv, type CommandResult } from "./process.js";

interface IdentifyResult {
  caller?: { window_id?: string; workspace_id?: string; surface_id?: string };
  focused?: { window_id?: string; workspace_id?: string; surface_id?: string };
  socket_path?: string;
}

interface WorkspaceListResult {
  window_id?: string;
  workspaces?: Array<{ id: string; ref?: string; title?: string; current_directory?: string }>;
}

interface TreeResult {
  windows?: Array<{
    id: string;
    workspaces?: Array<{
      id: string;
      panes?: Array<{
        id: string;
        surfaces?: Array<{ id: string; ref?: string; type?: string; title?: string }>;
      }>;
    }>;
  }>;
}

export interface CreatedWorkspace {
  workspaceRef: string;
  workspaceId: string;
  surfaceId: string;
}

export class CmuxClient {
  readonly bin: string;
  readonly env: NodeJS.ProcessEnv;

  constructor(options: { bin?: string; env?: NodeJS.ProcessEnv } = {}) {
    this.bin = options.bin ?? options.env?.CMUX_BIN ?? process.env.CMUX_BIN ?? "cmux";
    this.env = scrubCmuxTargetEnv(options.env ?? process.env);
  }

  async command(args: readonly string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<CommandResult> {
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

  async json<T>(args: readonly string[], options: { timeoutMs?: number; signal?: AbortSignal } = {}): Promise<T> {
    const result = await this.command(["--id-format", "both", "--json", ...args], options);
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`cmux returned invalid JSON for ${args.join(" ")}: ${(error as Error).message}`);
    }
  }

  async ping(): Promise<void> {
    await this.command(["ping"]);
  }

  async capabilities(): Promise<CmuxCapabilities> {
    return this.json<CmuxCapabilities>(["capabilities"]);
  }

  async version(): Promise<string> {
    return (await this.command(["version"])).stdout.trim();
  }

  async identify(): Promise<IdentifyResult> {
    return this.json<IdentifyResult>(["identify", "--no-caller"]);
  }

  async callerIdentity(): Promise<IdentifyResult> {
    return this.json<IdentifyResult>(["identify"]);
  }

  async createClaudeWorkspace(options: {
    cwd: string;
    name: string;
    permissionMode: PermissionMode;
    windowId: string;
    resumeSessionId?: string;
    signal?: AbortSignal;
  }): Promise<CreatedWorkspace> {
    const command = options.resumeSessionId
      ? `claude --permission-mode ${options.permissionMode} --resume ${options.resumeSessionId}`
      : `claude --permission-mode ${options.permissionMode}`;
    const result = await this.command(
      [
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
      ],
      { timeoutMs: 20_000, signal: options.signal },
    );
    const match = result.stdout.match(/\b(workspace:\d+)\b/);
    if (!match) throw new Error(`Could not parse workspace ref from cmux: ${result.stdout.trim()}`);
    const workspaceRef = match[1];
    const listed = await this.json<WorkspaceListResult>(["list-workspaces", "--window", options.windowId], {
      signal: options.signal,
    });
    const workspace = listed.workspaces?.find((item) => item.ref === workspaceRef);
    if (!workspace) throw new Error(`cmux created ${workspaceRef}, but it was absent from workspace list`);

    const tree = await this.json<TreeResult>(["tree", "--workspace", workspace.id, "--window", options.windowId], {
      signal: options.signal,
    });
    const treeWorkspace = tree.windows?.flatMap((window) => window.workspaces ?? []).find((item) => item.id === workspace.id);
    const surface = treeWorkspace?.panes
      ?.flatMap((pane) => pane.surfaces ?? [])
      .find((item) => item.type === "terminal");
    if (!surface) throw new Error(`cmux created ${workspaceRef}, but no terminal surface was found`);
    return { workspaceRef, workspaceId: workspace.id, surfaceId: surface.id };
  }

  async paste(surfaceId: string, text: string, signal?: AbortSignal): Promise<void> {
    await this.rpc("terminal.paste", { surface_id: surfaceId, text }, { signal });
  }

  async sendKey(surfaceId: string, key: string, signal?: AbortSignal): Promise<void> {
    await this.command(["send-key", "--surface", surfaceId, key], { signal });
  }

  async sendText(surfaceId: string, text: string, signal?: AbortSignal): Promise<void> {
    if (/[\r\n]/.test(text)) throw new Error("Refusing multiline cmux send; use terminal.paste instead");
    await this.command(["send", "--surface", surfaceId, text], { signal });
  }

  async readScreen(surfaceId: string, lines = 60, signal?: AbortSignal): Promise<string> {
    const result = await this.command(["read-screen", "--surface", surfaceId, "--lines", String(lines)], { signal });
    return result.stdout;
  }

  async closeWorkspace(workspaceId: string): Promise<void> {
    await this.command(["close-workspace", "--workspace", workspaceId], { timeoutMs: 10_000 });
  }

  async topology(): Promise<TreeResult> {
    return this.json<TreeResult>(["tree", "--all"]);
  }

  async rpc<T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<T> {
    const result = await this.command(["rpc", method, JSON.stringify(params)], options);
    try {
      return JSON.parse(result.stdout) as T;
    } catch (error) {
      throw new Error(`cmux rpc ${method} returned invalid JSON: ${(error as Error).message}`);
    }
  }
}

export function collectSurfaceIds(tree: TreeResult): Set<string> {
  const ids = new Set<string>();
  for (const window of tree.windows ?? []) {
    for (const workspace of window.workspaces ?? []) {
      for (const pane of workspace.panes ?? []) {
        for (const surface of pane.surfaces ?? []) ids.add(surface.id);
      }
    }
  }
  return ids;
}

export function collectWorkspaceIds(tree: TreeResult): Set<string> {
  return new Set((tree.windows ?? []).flatMap((window) => window.workspaces ?? []).map((workspace) => workspace.id));
}
