import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
export class StateStore {
    path;
    constructor(path) {
        this.path = path;
    }
    async load() {
        try {
            const parsed = JSON.parse(await readFile(this.path, "utf8"));
            if (parsed.version !== 1 || !Array.isArray(parsed.sessions))
                return [];
            return parsed.sessions.filter(isManagedSession);
        }
        catch {
            return [];
        }
    }
    async save(sessions) {
        await mkdir(dirname(this.path), { recursive: true, mode: 0o700 });
        const payload = {
            version: 1,
            updatedAt: new Date().toISOString(),
            sessions: [...sessions],
        };
        const temporary = `${this.path}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        await rename(temporary, this.path);
    }
}
function isManagedSession(value) {
    if (!value || typeof value !== "object")
        return false;
    const candidate = value;
    return (typeof candidate.runId === "string" &&
        typeof candidate.cwd === "string" &&
        typeof candidate.state === "string" &&
        typeof candidate.createdAt === "number" &&
        typeof candidate.updatedAt === "number");
}
