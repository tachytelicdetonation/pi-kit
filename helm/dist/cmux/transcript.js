import { open, readFile, stat } from "node:fs/promises";
export async function transcriptOffset(path) {
    if (!path)
        return 0;
    try {
        return (await stat(path)).size;
    }
    catch {
        return 0;
    }
}
export async function readAssistantOutput(path, offset = 0) {
    if (!path)
        return "";
    let content = "";
    try {
        const file = await open(path, "r");
        try {
            const size = (await file.stat()).size;
            const start = offset <= size ? offset : 0;
            const buffer = Buffer.alloc(Math.max(0, size - start));
            if (buffer.length > 0)
                await file.read(buffer, 0, buffer.length, start);
            content = buffer.toString("utf8");
        }
        finally {
            await file.close();
        }
    }
    catch {
        try {
            content = await readFile(path, "utf8");
        }
        catch {
            return "";
        }
    }
    const texts = [];
    for (const line of content.split("\n")) {
        if (!line.trim())
            continue;
        let entry;
        try {
            entry = JSON.parse(line);
        }
        catch {
            continue;
        }
        if (entry.type !== "assistant" || entry.isSidechain === true)
            continue;
        const message = asRecord(entry.message);
        const parts = Array.isArray(message?.content) ? message.content : [];
        for (const part of parts) {
            const record = asRecord(part);
            if (record?.type === "text" && typeof record.text === "string" && record.text.trim()) {
                texts.push(record.text.trim());
            }
        }
    }
    return texts.join("\n\n").trim();
}
export function truncateOutput(output, maxBytes = 50 * 1024) {
    if (Buffer.byteLength(output, "utf8") <= maxBytes)
        return { text: output, truncated: false };
    let start = Math.max(0, output.length - maxBytes);
    while (Buffer.byteLength(output.slice(start), "utf8") > maxBytes)
        start++;
    return {
        text: `[Earlier output omitted; full response remains in the Claude transcript.]\n\n${output.slice(start)}`,
        truncated: true,
    };
}
function asRecord(value) {
    return value && typeof value === "object" ? value : undefined;
}
