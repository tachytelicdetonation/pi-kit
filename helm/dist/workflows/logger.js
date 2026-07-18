/**
 * Workflow logger with file persistence.
 */
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { workflowProjectPaths } from "./workflow-paths.js";
export function createWorkflowLogger(options = {}) {
    const logs = [];
    const persistLogs = options.persist ?? true;
    const cwd = options.cwd ?? process.cwd();
    const runId = options.runId ?? `run-${Date.now()}`;
    const runsDir = workflowProjectPaths(cwd).runsDir;
    let logFile = null;
    const write = (level, message) => {
        const timestamp = new Date().toISOString();
        const entry = `[${timestamp}] [${level}] ${message}`;
        logs.push(entry);
        options.onLog?.(message);
        if (persistLogs && logFile) {
            try {
                appendFileSync(logFile, `${entry}\n`);
            }
            catch {
                // Silent fail for log persistence
            }
        }
    };
    const logger = {
        log(message) {
            write("INFO", message);
        },
        error(message) {
            write("ERROR", message);
        },
        warn(message) {
            write("WARN", message);
        },
        getLogs() {
            return [...logs];
        },
        persist() {
            if (!persistLogs)
                return null;
            try {
                mkdirSync(runsDir, { recursive: true });
                logFile = join(runsDir, `${runId}.log`);
                writeFileSync(logFile, `${logs.join("\n")}\n`);
                return logFile;
            }
            catch {
                return null;
            }
        },
    };
    // Initialize log file if persisting
    if (persistLogs) {
        try {
            mkdirSync(runsDir, { recursive: true });
            logFile = join(runsDir, `${runId}.log`);
        }
        catch {
            // Silent fail
        }
    }
    return logger;
}
