"use strict";
/* Find tool renderer: FFF-backed file search, falling back to the SDK (fd). */
Object.defineProperty(exports, "__esModule", { value: true });
exports.registerFindTool = registerFindTool;
const config_js_1 = require("../config.js");
const helpers_js_1 = require("../helpers.js");
const render_js_1 = require("../render.js");
const tui_text_js_1 = require("../tui-text.js");
const kit = require("../kit.js");
const runs = require("../runs.js");
const metrics_js_1 = require("./metrics.js");
const node_path_1 = require("node:path");
const node_child_process_1 = require("node:child_process");
// Newline-join the text of each text block in a result. A block with no text
// and a result without a content array both contribute empty output.
function getText(result) {
    const out = [];
    for (const c of result.content ?? []) {
        if (c.type === "text")
            out.push(c.text ?? "");
    }
    return out.join("\n");
}
// Run the SDK find and stamp a findResult onto details: the raw path text, the
// search pattern, a match count (non-empty lines), and the notice list merged
// from any notices already present plus the caller-supplied extras.
async function sdkFindAsFindResult(sdkTool, tid, params, sig, ctx, pattern, extraNotices) {
    const result = (await sdkTool.execute(tid, params, sig, undefined, ctx));
    const tc = getText(result);
    const existing = result.details?.notices;
    const notices = [...(Array.isArray(existing) ? existing : []), ...extraNotices];
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
// A single expanded-list entry: kit.pathSeg (dim dir + normal basename). Git
// status (§1.3, judgment (a)) is carried ONLY by a dim "M"/"?" suffix — the
// FG_GREEN/FG_YELLOW basename tint is cut from the color budget. The basename
// itself stays default-fg; the suffix is the whole signal.
function findEntry(p, budget, status) {
    const seg = kit.pathSeg(p, budget);
    if (!status)
        return seg;
    const mark = status === "untracked" ? "?" : "M";
    return `${seg} ${config_js_1.FG_DIM}${mark}${config_js_1.RST}`;
}
// Collapsed summary: the single top directory (where the files cluster) and its
// count, as PLAIN text — the header summary is uniformly dim, so no per-seg color.
// Mirrors kit.dirHistogram's counting/ordering but returns just the top entry.
function topDirSeg(paths) {
    const perDir = new Map();
    for (const p of paths) {
        const slash = p.lastIndexOf("/");
        const dir = slash > 0 ? p.slice(0, slash) : slash === 0 ? "/" : ".";
        perDir.set(dir, (perDir.get(dir) || 0) + 1);
    }
    let bestDir = "";
    let bestN = -1;
    for (const [d, n] of perDir) {
        if (n > bestN) {
            bestN = n;
            bestDir = d;
        }
    }
    return bestN > 0 ? `${bestDir} (${bestN})` : "";
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
            // Fold registry: consecutive finds in the SAME path collapse (§1).
            runs.register("find", (0, node_path_1.resolve)(cwd, String(a.path ?? ".")), ctx);
            if (ctx.state && ctx.state.__kitFolded && !ctx.expanded)
                return kit.zeroText(ctx);
            const prev = ctx.lastComponent;
            const text = prev && !(prev instanceof kit.ZeroText) ? prev : new TC("", 0, 0);
            const err = (0, kit.isErr)(ctx);
            const pattern = a.pattern == null ? "" : String(a.pattern);
            const path = a.path == null || String(a.path).length === 0 ? "." : (0, helpers_js_1.shortPath)(cwd, home, String(a.path));
            const title = `${theme.fg(err ? "error" : "toolTitle", theme.bold("find"))} ${theme.fg("toolTitle", pattern)}${theme.fg("dim", ` in ${path}`)}`;
            const annots = a.limit !== undefined && a.limit !== null ? theme.fg("dim", `(limit ${a.limit})`) : "";
            text.setText((0, render_js_1.fillToolBackground)(`\n${kit.header(ctx, title, annots)}`, err ? config_js_1.BG_ERROR : undefined));
            return text;
        },
        renderResult(result, _opt, theme, ctx) {
            if (ctx.state && ctx.state.__kitFolded && !ctx.expanded)
                return kit.zeroText(ctx);
            (0, config_js_1.resolveBaseBackground)(theme);
            const r = result;
            const prev = ctx.lastComponent;
            const text = prev && !(prev instanceof kit.ZeroText) ? prev : new TC("", 0, 0);
            // TIER 2 — failure: host-authoritative ctx.isError routes through the
            // centralized red-tinted failure body (§4). fgError default (true).
            if (ctx.isError) {
                kit.markDone(ctx, true);
                text.setText(kit.failLines(getText(r) || "Error", theme));
                return text;
            }
            const d = r.details;
            if (d?._type === "findResult") {
                kit.markDone(ctx, false);
                const duration = (0, kit.durationSeg)(r);
                const paths = d.text.split("\n").map((s) => s.trim()).filter(Boolean);
                const count = d.matchCount || paths.length;
                const fileSeg = `${count} ${count === 1 ? "file" : "files"}`;
                // TIER 0 collapsed → summary fused into the header; zero result lines.
                // Segs are plain text (markerInner dims the whole line); empties drop,
                // so zero results yields just "0 files [· duration]".
                if (!ctx.expanded) {
                    kit.setSummary(ctx, [runs.runSeg(ctx), fileSeg, topDirSeg(paths), duration]);
                    return kit.zeroText(ctx);
                }
                // TIER 0 expanded → flat path list; each path via kit.pathSeg at the
                // BODY_INDENT spine (§1.2), no fileIcon, git status as a dim suffix.
                const noticeStr = d.notices?.length
                    ? `\n${kit.BODY_INDENT}${kit.dim(`[${d.notices.join(". ")}]`)}`
                    : "";
                const gs = d.gitStatus;
                const budget = Math.max(12, (0, config_js_1.termWidth)() - 6);
                const rendered = [];
                for (let i = 0; i < paths.length; i++) {
                    if (i >= config_js_1.MAX_PREVIEW_LINES) {
                        rendered.push(`${kit.BODY_INDENT}${config_js_1.FG_DIM}… ${(0, kit.plural)(paths.length - i, "more file")}${config_js_1.RST}`);
                        break;
                    }
                    const p = paths[i];
                    const status = gitStatusFor(gs, p);
                    rendered.push(`${kit.BODY_INDENT}${findEntry(p, budget, status)}`);
                }
                const mk = (0, kit.marker)([fileSeg, duration]);
                const body = mk ? [...rendered, mk] : rendered;
                text.setText((0, render_js_1.fillToolBackground)(`${body.join("\n")}${noticeStr}\n`));
                return text;
            }
            const fc = r.content?.[0];
            kit.markDone(ctx, false);
            text.setText((0, render_js_1.fillToolBackground)(`${kit.BODY_INDENT}${theme.fg("dim", fc?.text?.slice(0, 120) ?? "0 files")}\n`));
            return text;
        },
    });
}
//# sourceMappingURL=find.js.map