import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
function emptyDomain(cwd) {
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
export function helmStatePath(cwd, home = homedir()) {
    const absolute = resolve(cwd);
    const slug = basename(absolute).replace(/[^a-zA-Z0-9._-]+/g, "-") || "project";
    const digest = createHash("sha256").update(absolute).digest("hex").slice(0, 12);
    return join(home, ".pi", "agent", "helm", "projects", `${slug}-${digest}`, "state.json");
}
export function createHelmRepository(cwd, path = helmStatePath(cwd)) {
    const absoluteCwd = resolve(cwd);
    return {
        path,
        load() {
            if (!existsSync(path))
                return emptyDomain(absoluteCwd);
            try {
                const parsed = JSON.parse(readFileSync(path, "utf8"));
                if (parsed.version !== 1 || parsed.cwd !== absoluteCwd)
                    return emptyDomain(absoluteCwd);
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
            }
            catch {
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
