"use strict";
/* pi-pretty: find tool -- FFF-backed file search with SDK (fd) fallback. */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFindTool = registerFindTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const metrics_js_1 = require("./metrics.js");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
function getText(result) {
    return (result.content ?? [])
        .filter((c) => c.type === "text")
        .map((c) => c.text ?? "")
        .join("\n");
}
async function sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, extraNotices) {
    const result = (await sdkTool.execute(tid, params, sig, undefined, ctx));
    const tc = getText(result);
    const prev = result.details?.notices ?? [];
    const notices = [...(Array.isArray(prev) ? prev : []), ...extraNotices];
    result.details = {
        _type: "findResult",
        text: tc,
        pattern,
        matchCount: tc ? tc.trim().split("\n").filter(Boolean).length : 0,
        notices,
    };
    return result;
}
// --- git status annotation (best-effort, never blocks a find result) -------
// Runs `git status --porcelain -z` ONCE in the execute wrapper (bounded by a
// short timeout) and returns a serializable { root, base, entries } map keyed by
// git's repo-root-relative paths → "modified" | "untracked". Degrades SILENTLY
// (returns undefined) when the dir is not a git repo, git is missing, or the
// call times out. -z gives NUL-separated, un-quoted paths; rename/copy records
// carry a trailing source-path chunk which we skip.
function collectGitStatus(gitCwd) {
    const opts = { cwd: gitCwd, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 1 << 20 };
    let root;
    try {
        root = node_child_process_1
            .execFileSync("git", ["rev-parse", "--show-toplevel"], { ...opts, timeout: 120 })
            .toString("utf8")
            .trim();
    }
    catch {
        root = undefined; // no toplevel → fall back to plain repo-root-relative matching
    }
    let buf;
    try {
        buf = node_child_process_1.execFileSync("git", ["status", "--porcelain", "-z"], { ...opts, timeout: 150 });
    }
    catch {
        return undefined; // not a repo / git missing / timed out → no annotation
    }
    const entries = {};
    const parts = buf.toString("utf8").split("\0");
    for (let i = 0; i < parts.length; i++) {
        const rec = parts[i];
        if (!rec || rec.length < 4)
            continue; // need "XY <space> path"
        const x = rec[0];
        const y = rec[1];
        entries[rec.slice(3)] = x === "?" && y === "?" ? "untracked" : "modified";
        if (x === "R" || x === "C" || y === "R" || y === "C")
            i++; // skip the rename/copy source-path chunk
    }
    return { root: root || undefined, base: gitCwd, entries };
}
// Look up a found path's git status. Tries the raw (repo-root-relative) key
// first, then resolves via the repo root so paths found from a subdir still map.
function gitStatusFor(gs, fp) {
    if (!gs)
        return null;
    const norm = fp.replace(/^\.\//, "").replace(/\/+$/, "");
    if (gs.entries[norm])
        return gs.entries[norm];
    if (gs.root) {
        const abs = node_path_1.isAbsolute(norm) ? norm : node_path_1.resolve(gs.base, norm);
        const rel = node_path_1.relative(gs.root, abs);
        if (rel && !rel.startsWith("..") && gs.entries[rel])
            return gs.entries[rel];
    }
    return null;
}
// A single expanded-list entry: kit.pathSeg (dim dir + normal basename), with the
// basename tinted by git status when present. pathSeg emits `FG_DIM dir RST base`,
// so we re-color everything after the final RST (the basename) — truncation-safe.
// A dim "M"/"?" suffix carries the signal when color is unavailable (icon-off).
function findEntry(p, budget, status) {
    let seg = kit.pathSeg(p, budget);
    if (status) {
        const col = status === "untracked" ? config_js_1.FG_GREEN : config_js_1.FG_YELLOW;
        const mark = status === "untracked" ? "?" : "M";
        const idx = seg.lastIndexOf(config_js_1.RST);
        const head = idx >= 0 ? seg.slice(0, idx + config_js_1.RST.length) : "";
        const base = idx >= 0 ? seg.slice(idx + config_js_1.RST.length) : seg;
        seg = `${head}${col}${base}${config_js_1.RST} ${config_js_1.FG_DIM}${mark}${config_js_1.RST}`;
    }
    return seg;
}
// Collapsed dir histogram — dirs rendered via kit.pathSeg (dim parent + normal
// leaf) instead of a flat dim. Mirrors kit.dirHistogram's counting/ordering.
function findHistogram(paths, topN) {
    const perDir = new Map();
    for (const p of paths) {
        const slash = p.lastIndexOf("/");
        const dir = slash > 0 ? p.slice(0, slash) : slash === 0 ? "/" : ".";
        perDir.set(dir, (perDir.get(dir) || 0) + 1);
    }
    const entries = [...perDir.entries()].sort((a, b) => b[1] - a[1]);
    const top = entries.slice(0, topN);
    const segs = top.map(([d, n]) => `${kit.pathSeg(d)} ${config_js_1.FG_MUTED}(${n})${config_js_1.RST}`);
    const rest = entries.length - top.length;
    if (rest > 0)
        segs.push(`${config_js_1.FG_DIM}… ${(0, kit.plural)(rest, "more dir")}${config_js_1.RST}`);
    const sep = `${config_js_1.FG_DIM}${kit.SEP}${config_js_1.RST}`;
    return { line: segs.join(sep), dirs: perDir.size };
}
function registerFindTool(pi, cwd, _fffService, sdkTool, TextComp) {
    const TC = (0, tui_text_js_1.resolveTextCtor)(TextComp);
    const home = process.env.HOME ?? "";
    pi.registerTool({
        name: "find",
        label: "Find",
        description: sdkTool.description ?? "Find files matching a glob pattern",
        parameters: sdkTool.parameters,
        renderShell: "self",
        execute: (0, metrics_js_1.wrapExecuteWithMetrics)(async (tid, params, sig, _upd, ctx) => {
            const pattern = String(params.pattern ?? "");
            const result = await sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, [
                "Search engine: SDK find (fd).",
            ]);
            try {
                const gs = collectGitStatus(cwd);
                if (gs && result.details && result.details._type === "findResult")
                    result.details.gitStatus = gs;
            }
            catch {
                /* git annotation is best-effort — never block or fail a find result */
            }
            return result;
        }),
        renderCall(args, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const a = args;
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const pattern = a.pattern == null ? "" : String(a.pattern);
            const path = a.path == null || String(a.path).length === 0 ? "." : (0, helpers_js_1.shortPath)(cwd, home, String(a.path));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("find"))} ${theme.fg("toolTitle", pattern)}${theme.fg("dim", ` in ${path}`)}`;
            const annots = a.limit !== undefined && a.limit !== null ? theme.fg("dim", `(limit ${a.limit})`) : "";
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title, annots)}`, err ? config_js_1.BG_ERROR : undefined));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            (0, config_js_1.resolveBaseBackground)(theme);
            const r = result;
            const text = ctx.lastComponent ?? new TC("", 0, 0);
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText((0, render_js_1.renderToolError)(getText(r) || "Error", theme));
                return text;
            }
            const d = r.details;
            if (d?._type === "findResult") {
                kit.markDone(ctx, false);
                const noticeStr = d.notices?.length
                    ? `\n${config_js_1.TOOL_RESULT_INDENT}${theme.fg("warning", `[${d.notices.join(". ")}]`)}`
                    : "";
                const duration = (0, kit.durationSeg)(r);
                const paths = d.text.split("\n").map((s) => s.trim()).filter(Boolean);
                const count = d.matchCount || paths.length;
                const fileSeg = `${count} ${count === 1 ? "file" : "files"}`;
                if (!paths.length) {
                    const mk = (0, kit.marker)([fileSeg, duration]);
                    text.setText((0, render_js_1.fillToolBackground)(`${mk}${noticeStr}\n`));
                    return text;
                }
                if (!ctx.expanded) {
                    // Collapsed → dir histogram (where the files cluster); dirs via pathSeg.
                    const hist = findHistogram(paths, 3);
                    const body = [`${config_js_1.TOOL_RESULT_INDENT}${hist.line}`];
                    const mk = (0, kit.marker)([`… ${fileSeg}`, (0, kit.plural)(hist.dirs, "dir"), duration, "ctrl+o"]);
                    if (mk)
                        body.push(mk);
                    text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}${noticeStr}\n`));
                    return text;
                }
                // Expanded → flat path list; each path via kit.pathSeg, git-tinted.
                const gs = d.gitStatus;
                const budget = Math.max(12, (0, config_js_1.termWidth)() - 6);
                const rendered = [];
                for (let i = 0; i < paths.length; i++) {
                    if (i >= config_js_1.MAX_PREVIEW_LINES) {
                        rendered.push(`${config_js_1.TOOL_RESULT_INDENT}${config_js_1.FG_DIM}… ${(0, kit.plural)(paths.length - i, "more file")}${config_js_1.RST}`);
                        break;
                    }
                    const p = paths[i];
                    const status = gitStatusFor(gs, p);
                    rendered.push(`${config_js_1.TOOL_RESULT_INDENT}${(0, config_js_1.fileIcon)(p)}${findEntry(p, budget, status)}`);
                }
                const mk = (0, kit.marker)([fileSeg, duration]);
                const body = mk ? [...rendered, mk] : rendered;
                text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}${noticeStr}\n`));
                return text;
            }
            const fc = r.content?.[0];
            kit.markDone(ctx, false);
            text.setText((0, render_js_1.fillToolBackground)(`${config_js_1.TOOL_RESULT_INDENT}${theme.fg("dim", fc?.text?.slice(0, 120) ?? "0 files")}\n`));
            return text;
        },
    });
}
//# sourceMappingURL=find.js.map