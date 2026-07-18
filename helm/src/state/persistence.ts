import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import type { Closeout, Escalation, Goal, IntakeDraft, JournalEvent, Loop, LoopDraft, Precedent } from "./types.js";

export interface PersistedHelmDomain {
  version: 1;
  cwd: string;
  goals: Goal[];
  loops: Loop[];
  escalations: Escalation[];
  precedents: Precedent[];
  journal: JournalEvent[];
  intakes: IntakeDraft[];
  loopDrafts: LoopDraft[];
  closeouts: Closeout[];
  lastSeenAt?: number;
}

export interface HelmRepository {
  readonly path: string;
  load(): PersistedHelmDomain;
  save(domain: PersistedHelmDomain): void;
}

function emptyDomain(cwd: string): PersistedHelmDomain {
  return {
    version: 1,
    cwd,
    goals: [],
    loops: [],
    escalations: [],
    precedents: [],
    journal: [],
    intakes: [],
    loopDrafts: [],
    closeouts: [],
  };
}

export function helmStatePath(cwd: string, home = homedir()): string {
  const absolute = resolve(cwd);
  const slug = basename(absolute).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
  const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
  return join(home, ".pi", "agent", "helm", "projects", `${slug}-${digest}`, "state.json");
}

export function createHelmRepository(cwd: string, path = helmStatePath(cwd)): HelmRepository {
  const absoluteCwd = resolve(cwd);
  return {
    path,
    load() {
      if (!existsSync(path)) return emptyDomain(absoluteCwd);
      try {
        const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PersistedHelmDomain>;
        if (parsed.version !== 1 || parsed.cwd !== absoluteCwd) return emptyDomain(absoluteCwd);
        return {
          ...emptyDomain(absoluteCwd),
          ...parsed,
          version: 1,
          cwd: absoluteCwd,
          goals: Array.isArray(parsed.goals) ? parsed.goals : [],
          loops: Array.isArray(parsed.loops) ? parsed.loops : [],
          escalations: Array.isArray(parsed.escalations) ? parsed.escalations : [],
          precedents: Array.isArray(parsed.precedents) ? parsed.precedents : [],
          journal: Array.isArray(parsed.journal) ? parsed.journal : [],
          intakes: Array.isArray(parsed.intakes) ? parsed.intakes : [],
          loopDrafts: Array.isArray(parsed.loopDrafts) ? parsed.loopDrafts : [],
          closeouts: Array.isArray(parsed.closeouts) ? parsed.closeouts : [],
        };
      } catch {
        return emptyDomain(absoluteCwd);
      }
    },
    save(domain) {
      const dir = dirname(path);
      mkdirSync(dir, { recursive: true });
      const temp = `${path}.${process.pid}.tmp`;
      writeFileSync(temp, `${JSON.stringify(domain, null, 2)}\n`, { mode: 0o600 });
      renameSync(temp, path);
    },
  };
}
