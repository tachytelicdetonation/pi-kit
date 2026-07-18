/**
 * Save and load reusable workflow commands.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths, workflowUserSavedDir } from "./workflow-paths.js";
export function isSafeSavedWorkflowName(name) {
    return (name.length > 0 &&
        name.length <= 128 &&
        name.trim() === name &&
        name !== "." &&
        name !== ".." &&
        !/[/\\\0]/.test(name));
}
export function assertSafeSavedWorkflowName(name) {
    if (!isSafeSavedWorkflowName(name)) {
        throw new Error("Saved workflow name must be a non-empty path-safe name without slashes.");
    }
}
export function createWorkflowStorage(cwd) {
    const paths = workflowProjectPaths(cwd);
    const projectDir = paths.savedDir;
    const legacyProjectDir = paths.legacySavedDir;
    const userDir = workflowUserSavedDir();
    const ensureDir = (dir) => {
        if (!existsSync(dir)) {
            mkdirSync(dir, { recursive: true });
        }
    };
    const workflowPath = (name, location) => {
        assertSafeSavedWorkflowName(name);
        const dir = location === "project" ? projectDir : userDir;
        return join(dir, `${name}.json`);
    };
    const legacyProjectWorkflowPath = (name) => {
        assertSafeSavedWorkflowName(name);
        return join(legacyProjectDir, `${name}.json`);
    };
    const loadFromFile = (path, location) => {
        try {
            if (!existsSync(path))
                return null;
            const data = JSON.parse(readFileSync(path, "utf-8"));
            if (!data || typeof data !== "object" || !isSafeSavedWorkflowName(data.name ?? "")) {
                return null;
            }
            return {
                ...data,
                location,
                path,
            };
        }
        catch {
            return null;
        }
    };
    return {
        save(workflow, location = "project") {
            assertSafeSavedWorkflowName(workflow.name);
            const dir = location === "project" ? projectDir : userDir;
            ensureDir(dir);
            const path = workflowPath(workflow.name, location);
            const saved = {
                ...workflow,
                location,
                path,
                savedAt: new Date().toISOString(),
            };
            writeFileSync(path, JSON.stringify(saved, null, 2));
            return saved;
        },
        load(name) {
            if (!isSafeSavedWorkflowName(name))
                return null;
            // Project takes precedence over user
            const projectPath = workflowPath(name, "project");
            const project = loadFromFile(projectPath, "project");
            if (project)
                return project;
            const legacyProject = loadFromFile(legacyProjectWorkflowPath(name), "project");
            if (legacyProject)
                return legacyProject;
            const userPath = workflowPath(name, "user");
            return loadFromFile(userPath, "user");
        },
        list() {
            const workflows = [];
            const seen = new Set();
            const addDir = (dir, location) => {
                if (!existsSync(dir))
                    return;
                for (const file of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
                    const wf = loadFromFile(join(dir, file), location);
                    if (wf && !seen.has(wf.name)) {
                        seen.add(wf.name);
                        workflows.push(wf);
                    }
                }
            };
            // Priority order mirrors load(): project > legacy project > user.
            addDir(projectDir, "project");
            addDir(legacyProjectDir, "project");
            addDir(userDir, "user");
            return workflows.sort((a, b) => a.name.localeCompare(b.name));
        },
        delete(name, location) {
            if (!isSafeSavedWorkflowName(name))
                return false;
            const locations = location ? [location] : ["project", "user"];
            let deleted = false;
            for (const loc of locations) {
                const path = workflowPath(name, loc);
                if (existsSync(path)) {
                    unlinkSync(path);
                    deleted = true;
                }
                if (loc === "project") {
                    const legacyPath = legacyProjectWorkflowPath(name);
                    if (existsSync(legacyPath)) {
                        unlinkSync(legacyPath);
                        deleted = true;
                    }
                }
            }
            return deleted;
        },
    };
}
