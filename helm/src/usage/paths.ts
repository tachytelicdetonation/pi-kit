import { homedir } from "node:os";
import { join } from "node:path";

export interface UsagePaths {
  home: string;
  piDir: string;
  codexDir: string;
  claudeDir: string;
  claudeState: string;
  kimiDir: string;
  cacheFile: string;
}

export function resolveUsagePaths(env: NodeJS.ProcessEnv = process.env): UsagePaths {
  const home = env.HOME || homedir();
  const piDir = env.PI_CODING_AGENT_DIR || join(home, ".pi", "agent");
  const codexDir = env.CODEX_HOME || join(home, ".codex");
  const claudeDir = env.CLAUDE_CONFIG_DIR || join(home, ".claude");
  const kimiDir = env.KIMI_CODE_HOME || join(home, ".kimi-code");
  return {
    home,
    piDir,
    codexDir,
    claudeDir,
    claudeState: env.CLAUDE_STATE_FILE || join(home, ".claude.json"),
    kimiDir,
    cacheFile: join(piDir, "usage-health", "cache.json"),
  };
}
