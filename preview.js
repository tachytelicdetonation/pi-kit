// Multi-pass visual + correctness harness for pi-kit/pretty.
//   NODE_PATH=<pi-tui parent> node preview.js
// Drives each tool the way Pi does: renderCall THEN renderResult per pass,
// reusing components, draining ctx.invalidate() passes until stable (or LOOP).
const path = require("node:path");
const DIST = path.join(__dirname, "pretty", "dist");
const CSI = { toolTitle: "\x1b[1m", error: "\x1b[31m", dim: "\x1b[2m", muted: "\x1b[2m", toolOutput: "", accent: "\x1b[34m", warning: "\x1b[33m", success: "\x1b[32m" };
const theme = { fg: (k, s) => `${CSI[k] ?? ""}${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, bg: () => "", getBgAnsi: () => null };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
process.stdout.columns = 78; process.env.COLUMNS = "78";

function grab(register) {
  let def; register({ registerTool: (d) => { def = d; }, registerCommand: () => {} }, process.cwd(), null, { description: "", parameters: {}, execute: async () => ({}) }, undefined);
  return def;
}
// Drive to stability; returns {lines, passes, invals, loop}. state persists so
// expand/resize can reuse it. width lets us simulate a resize.
async function drive(def, { args, result, expanded }, state, comps, width) {
  let passes = 0, invals = 0, pending = true;
  while (pending && passes < 25) {
    pending = false; passes++;
    const inv = () => { invals++; pending = true; };
    const ctxC = { expanded, isError: !!result.isError, state, args, lastComponent: comps.call, invalidate: inv };
    comps.call = def.renderCall(args, theme, ctxC);
    const ctxR = { expanded, isError: !!result.isError, state, args, lastComponent: comps.res, invalidate: inv };
    comps.res = def.renderResult(result, { expanded, isPartial: false }, theme, ctxR);
    await new Promise((r) => setTimeout(r, 50));
  }
  const lines = [];
  if (comps.call?.render) lines.push(...comps.call.render(width));
  if (comps.res?.render) lines.push(...comps.res.render(width));
  return { lines, passes, invals, loop: passes >= 25 };
}
async function show(title, def, scenario) {
  const state = {}, comps = {};
  let r;
  try { r = await drive(def, scenario, state, comps, 78); }
  catch (e) { console.log(`\n### ${title}\n  !! THREW: ${e.message}`); return; }
  const glyph = strip((r.lines[1] || r.lines[0] || "")).trim()[0] || "?";
  const flag = r.loop ? " \x1b[41mLOOP!\x1b[0m" : "";
  console.log(`\n### ${title} [passes=${r.passes} invals=${r.invals} glyph=${glyph}]${flag}`);
  for (const l of r.lines) console.log("  |" + strip(l).replace(/\s+$/, ""));
  return { def, scenario, state, comps };
}

const bash = grab(require(path.join(DIST, "tools/bash.js")).registerBashTool);
const read = grab(require(path.join(DIST, "tools/read.js")).registerReadTool);
const grep = grab(require(path.join(DIST, "tools/grep.js")).registerGrepTool);
const ls = grab(require(path.join(DIST, "tools/ls.js")).registerLsTool);
const find = grab(require(path.join(DIST, "tools/find.js")).registerFindTool);
const edit = grab(require(path.join(DIST, "tools/edit.js")).registerEditTool);
const write = grab(require(path.join(DIST, "tools/write.js")).registerWriteTool);

const B = (t, e) => ({ _type: "bashResult", text: t, exitCode: e, command: "" });
const bigOut = Array.from({ length: 193 }, (_, i) => `line ${i + 1}`).join("\n");
const errOut = "src/x.ts:71:12 - error TS2339: bad.\n" + Array.from({ length: 22 }, (_, i) => `  detail ${i}`).join("\n") + "\nFound 1 error.";
const fileBig = Array.from({ length: 312 }, (_, i) => `const line${i} = ${i} * 2;`).join("\n");
const fileSmall = "export function add(a, b) {\n  return a + b;\n}\n";
const grepFew = "src/a.ts:12:const TextComp = x;\nsrc/a.ts:40:  TextComp.render();\nsrc/b.ts:5:import { TextComp } from './a';";
const grepMany = ["tools/bash.js","tools/read.js","tools/grep.js","tools/ls.js","index.js","config.js"].flatMap((f,fi)=>Array.from({length:Math.max(1,6-fi)},(_,i)=>`${f}:${(i+1)*3}:  const TextComp = x${i};`)).join("\n");
const grepCtx = "src/a.ts:12:HIT one\nsrc/a.ts-13-  context after\nsrc/a.ts-11-  context before\nsrc/b.ts:5:HIT two"; // 2 matches, not 4
const lsText = "tools/\nrender/\nthemes/\nconfig.ts\nhelpers.ts\nimage.ts\nindex.ts\nexpand.ts\nkit.js\nbash.js\nread.js\ngrep.js\nfind.js\nls.js\nmetrics.js\nnotices.js\npackage.json\nREADME.md\ntsconfig.json\n.gitignore";
const lsSmall = "tools/\nindex.ts\nREADME.md";
const findText = [...Array.from({length:41},(_,i)=>`src/tools/t${i}.test.ts`),...Array.from({length:23},(_,i)=>`src/render/r${i}.test.ts`),...Array.from({length:19},(_,i)=>`test/e2e${i}.test.ts`)].join("\n");

// edit small: a 3-line change to a tiny file.
const editSmallOld = "export function add(a, b) {\n  return a + b;\n}\n";
const editSmallNew = "export function add(a, b) {\n  // sum two numbers\n  return Number(a) + Number(b);\n}\n";
// edit large: ~40-line file, two changes far apart -> two separated hunks.
const editLargeOld = Array.from({ length: 40 }, (_, i) => `const line${i} = ${i} * 2; // row ${i}`).join("\n") + "\n";
const editLargeNew = editLargeOld
  .split("\n")
  .map((l, i) => (i === 2 ? "const line2 = 2 * 4; // row 2 (edited)" : i === 36 ? "const line36 = 36 * 4; // row 36 (edited)" : l))
  .join("\n");
// write: a brand-new file.
const writeContent = "import { readFile } from 'node:fs/promises';\n\nexport async function load(path) {\n  const raw = await readFile(path, 'utf8');\n  return JSON.parse(raw);\n}\n";
// bash git-diff: a real unified diff to exercise the bash diff colorizer.
const gitDiff = [
  "diff --git a/src/add.ts b/src/add.ts",
  "index 1a2b3c4..5d6e7f8 100644",
  "--- a/src/add.ts",
  "+++ b/src/add.ts",
  "@@ -1,3 +1,4 @@",
  " export function add(a, b) {",
  "-  return a + b;",
  "+  // sum two numbers",
  "+  return Number(a) + Number(b);",
  " }",
].join("\n");

// ===========================================================================
// Phase 2 (Round 3 §5) — Verify: glyph-spine + color-budget assertion helpers.
// ===========================================================================
// Exact palette SGR strings from config.js:33-47, BOTH palettes (the live
// palette is dark by default but diff.js/tools call resolveBaseBackground which
// can swap it, so we scan for either set and only flag strings actually present).
const PAL = {
  dark:  { G: "\x1b[38;2;126;186;148m", R: "\x1b[38;2;224;108;108m", Y: "\x1b[38;2;214;180;90m", B: "\x1b[38;2;110;150;230m" },
  light: { G: "\x1b[38;2;32;140;72m",   R: "\x1b[38;2;190;44;44m",   Y: "\x1b[38;2;150;110;20m", B: "\x1b[38;2;36;86;200m" },
};
// Diff add/del backgrounds (both palettes) — a line carrying one is licensed diff.
const DIFF_BG = ["\x1b[48;2;28;50;38m", "\x1b[48;2;58;34;34m", "\x1b[48;2;219;244;226m", "\x1b[48;2;250;222;222m"];
const BOLD = "\x1b[1m";
const GLYPH = new Set(["✓", "✗", "·"]); // ✓ ✗ ·

// §1.2 fixed-column glyph spine. After ANSI-strip: the first non-blank line is a
// header (col 0 === " ", col 1 ∈ {✓,✗,·}); every other non-blank line is a body
// line and must start at column 3 (kit.BODY_INDENT). Returns violation strings.
function assertGlyphCol(lines) {
  const bad = [];
  let sawHeader = false;
  lines.forEach((raw, i) => {
    const s = strip(raw);
    if (s.trim() === "") return; // blank lines are permitted anywhere
    const isHeader = s[0] === " " && GLYPH.has(s[1]);
    if (isHeader) { sawHeader = true; return; }
    if (s.slice(0, 3) !== "   ") bad.push(`L${i} body not at col3: ${JSON.stringify(s.slice(0, 6))}`);
  });
  if (!sawHeader) bad.push("no header line with a col-1 glyph");
  return bad;
}

// §1.3 color budget. Scan raw ANSI for palette FG_GREEN/RED/YELLOW/BLUE outside
// their licensed contexts:
//   GREEN/RED — header col-1 glyph, OR a diff line (BG_ADD/BG_DEL present, or a
//               raw +/-/@@/diff line from bash's colorizeDiffLines).
//   YELLOW    — grep-expanded term highlight ONLY (FG_YELLOW immediately + BOLD).
//   BLUE      — never (all blue emitters removed in round 3).
function assertColorBudget(lines) {
  const bad = [];
  lines.forEach((raw, i) => {
    const s = strip(raw);
    const isHeader = s[0] === " " && GLYPH.has(s[1]);
    const hasDiffBg = DIFF_BG.some((bg) => raw.includes(bg));
    const body = s.replace(/^\s+/, "");
    const isDiffLine = /^[+-]/.test(body) || body.startsWith("@@") || body.startsWith("diff ");
    const greenRedOk = isHeader || hasDiffBg || isDiffLine;
    for (const name of ["dark", "light"]) {
      const p = PAL[name];
      if (!greenRedOk && raw.includes(p.G)) bad.push(`L${i} FG_GREEN(${name}) off-budget: ${JSON.stringify(s)}`);
      if (!greenRedOk && raw.includes(p.R)) bad.push(`L${i} FG_RED(${name}) off-budget: ${JSON.stringify(s)}`);
      if (raw.includes(p.Y)) {
        // licensed only as grep's term highlight: FG_YELLOW immediately followed by BOLD.
        const bare = raw.split(p.Y).slice(1).some((seg) => !seg.startsWith(BOLD));
        if (bare && !hasDiffBg) bad.push(`L${i} FG_YELLOW(${name}) off-budget: ${JSON.stringify(s)}`);
      }
      if (raw.includes(p.B)) bad.push(`L${i} FG_BLUE(${name}) off-budget: ${JSON.stringify(s)}`);
    }
  });
  return bad;
}

(async () => {
  await show("bash small ok", bash, { args: { command: "git status" }, result: { content: [{ type: "text", text: "On branch main\nnothing to commit" }], details: { ...B("On branch main\nnothing to commit", 0), __prettyElapsedMs: 120 } } });
  await show("bash large ok", bash, { args: { command: "npm test" }, result: { content: [{ type: "text", text: bigOut }], details: { ...B(bigOut + "\nTest Files 6 passed\nTests 84 passed", 0), __prettyElapsedMs: 8200 } } });
  await show("bash error", bash, { args: { command: "npm run build", timeout: 30 }, result: { isError: true, content: [{ type: "text", text: errOut }], details: { ...B(errOut, 2), __prettyElapsedMs: 3100 } } });
  await show("read small", read, { args: { path: "src/add.ts" }, result: { content: [{ type: "text", text: fileSmall }], details: { _type: "readFile", filePath: "src/add.ts", content: fileSmall, offset: 0, lineCount: 3 } } });
  await show("read large", read, { args: { path: "src/big.ts" }, result: { content: [{ type: "text", text: fileBig }], details: { _type: "readFile", filePath: "src/big.ts", content: fileBig, offset: 0, lineCount: 312 } } });
  await show("grep few", grep, { args: { pattern: "TextComp" }, result: { content: [{ type: "text", text: grepFew }], details: { _type: "grepResult", text: grepFew, pattern: "TextComp", matchCount: 3 } } });
  await show("grep many", grep, { args: { pattern: "TextComp", path: "src" }, result: { content: [{ type: "text", text: grepMany }], details: { _type: "grepResult", text: grepMany, pattern: "TextComp", matchCount: 21 } } });
  await show("grep +context (count=2 not 4)", grep, { args: { pattern: "HIT" }, result: { content: [{ type: "text", text: grepCtx }], details: { _type: "grepResult", text: grepCtx, pattern: "HIT", matchCount: 4 } } });
  await show("ls small (zero-chrome)", ls, { args: { path: "." }, result: { content: [{ type: "text", text: lsSmall }], details: { _type: "lsResult", text: lsSmall, path: ".", entryCount: 3 } } });
  await show("ls big", ls, { args: { path: "src" }, result: { content: [{ type: "text", text: lsText }], details: { _type: "lsResult", text: lsText, path: "src", entryCount: 20 } } });
  await show("find", find, { args: { pattern: "*.test.ts" }, result: { content: [{ type: "text", text: findText }], details: { _type: "findResult", text: findText, pattern: "*.test.ts", matchCount: 83, notices: [] } } });

  await show("edit small (collapsed)", edit, { args: { filePath: "src/add.ts", oldText: editSmallOld, newText: editSmallNew }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/add.ts", oldText: editSmallOld, newText: editSmallNew, __prettyElapsedMs: 40 } } });
  await show("edit small (expanded)", edit, { args: { filePath: "src/add.ts", oldText: editSmallOld, newText: editSmallNew }, expanded: true, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/add.ts", oldText: editSmallOld, newText: editSmallNew, __prettyElapsedMs: 40 } } });
  await show("edit large 2-hunk (collapsed)", edit, { args: { filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew, __prettyElapsedMs: 1400 } } });
  await show("edit large 2-hunk (expanded)", edit, { args: { filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew }, expanded: true, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew, __prettyElapsedMs: 1400 } } });
  await show("write new file", write, { args: { filePath: "src/load.ts", content: writeContent }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "writeResult", filePath: "src/load.ts", content: writeContent, __prettyElapsedMs: 60 } } });
  await show("write new file (expanded)", write, { args: { filePath: "src/load.ts", content: writeContent }, expanded: true, result: { content: [{ type: "text", text: "OK" }], details: { _type: "writeResult", filePath: "src/load.ts", content: writeContent, __prettyElapsedMs: 60 } } });
  await show("bash git-diff", bash, { args: { command: "git diff src/add.ts" }, result: { content: [{ type: "text", text: gitDiff }], details: { ...B(gitDiff, 0), __prettyElapsedMs: 90 } } });

  // Multi-pass: same read execution, collapse -> expand -> resize. Watch for LOOP.
  console.log("\n=== MULTI-PASS: read collapse->expand->resize ===");
  const st = {}, cm = {};
  const rs = { args: { path: "src/big.ts" }, result: { content: [{ type: "text", text: fileBig }], details: { _type: "readFile", filePath: "src/big.ts", content: fileBig, offset: 0, lineCount: 312 } } };
  let r1 = await drive(read, { ...rs, expanded: false }, st, cm, 78); console.log(`collapsed: passes=${r1.passes} invals=${r1.invals} loop=${r1.loop}`);
  let r2 = await drive(read, { ...rs, expanded: true }, st, cm, 78); console.log(`expanded:  passes=${r2.passes} invals=${r2.invals} loop=${r2.loop}`);
  let r3 = await drive(read, { ...rs, expanded: true }, st, cm, 60); console.log(`resized60: passes=${r3.passes} invals=${r3.invals} loop=${r3.loop}`);
  let r4 = await drive(read, { ...rs, expanded: false }, st, cm, 78); console.log(`collapse2: passes=${r4.passes} invals=${r4.invals} loop=${r4.loop}`);

  // Multi-pass: same edit execution, collapse -> expand -> resize -> collapse. Watch for LOOP.
  console.log("\n=== MULTI-PASS: edit collapse->expand->resize ===");
  const est = {}, ecm = {};
  const es = { args: { filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew, __prettyElapsedMs: 1400 } } };
  let e1 = await drive(edit, { ...es, expanded: false }, est, ecm, 78); console.log(`collapsed: passes=${e1.passes} invals=${e1.invals} loop=${e1.loop}`);
  let e2 = await drive(edit, { ...es, expanded: true }, est, ecm, 78); console.log(`expanded:  passes=${e2.passes} invals=${e2.invals} loop=${e2.loop}`);
  let e3 = await drive(edit, { ...es, expanded: true }, est, ecm, 60); console.log(`resized60: passes=${e3.passes} invals=${e3.invals} loop=${e3.loop}`);
  let e4 = await drive(edit, { ...es, expanded: false }, est, ecm, 78); console.log(`collapse2: passes=${e4.passes} invals=${e4.invals} loop=${e4.loop}`);

  // =========================================================================
  // Phase 2 — Round 3 §5: V1–V8 verify scenarios + programmatic assertions.
  // =========================================================================
  console.log("\n\n######################## PHASE 2 — VERIFY (§5) ########################");
  const V = { maxPasses: 0, loop: false, spine: [], budget: [], notes: [], all: [] };
  function record(label, r) {
    V.maxPasses = Math.max(V.maxPasses, r.passes);
    if (r.loop) { V.loop = true; V.notes.push(`${label}: LOOP`); }
    V.all.push(...r.lines);
    const g = assertGlyphCol(r.lines); if (g.length) V.spine.push(`${label}: ${g[0]}`);
    const b = assertColorBudget(r.lines); if (b.length) V.budget.push(`${label}: ${b[0]}`);
  }
  // Every render carries a leading blank line (header is prefixed with "\n"), so
  // "one visible line" means one NON-BLANK stripped line. headerLine = first one.
  const visLines = (r) => r.lines.map(strip).filter((l) => l.trim() !== "");
  const headerLine = (r) => visLines(r)[0] || "";
  function pr(label, r) {
    const glyph = strip(r.lines[0] || "").trim()[0] || "?";
    console.log(`  ${label} [passes=${r.passes} loop=${r.loop} glyph=${glyph} lines=${r.lines.length}]`);
    for (const l of r.lines) console.log("    |" + strip(l).replace(/\s+$/, ""));
  }
  async function vtool(label, def, scenario, width = 78) {
    const r = await drive(def, scenario, {}, {}, width);
    record(label, r); pr(label, r); return r;
  }

  // ---- V-suite data ----
  const err12 = Array.from({ length: 12 }, (_, i) => `  at frame ${i} (src/mod.ts:${i * 3})`).join("\n");
  const stderr50 = "tsc --noEmit\n" + Array.from({ length: 48 }, (_, i) => `src/f${i}.ts:${i + 1}:1 - error TS2345: bad arg ${i}.`).join("\n") + "\nFound 48 errors.";
  const bash193 = Array.from({ length: 192 }, (_, i) => `line ${i + 1}`).join("\n") + "\nTests 84 passed";

  // ---- V1 — THE STREAM: read→grep→find→ls→edit→bash(success), one flow. ----
  console.log("\n### V1 — THE STREAM (read→grep→find→ls→edit→bash success) ###");
  const v1 = [];
  async function v1tool(label, def, scenario) {
    const r = await drive(def, scenario, {}, {}, 78);
    record(`V1/${label}`, r);
    for (const l of r.lines) v1.push(strip(l).replace(/\s+$/, ""));
    v1.push(""); // Pi's inter-tool blank line
    return r;
  }
  const s1read = await v1tool("read", read, { args: { path: "src/add.ts" }, result: { content: [{ type: "text", text: fileSmall }], details: { _type: "readFile", filePath: "src/add.ts", content: fileSmall, offset: 0, lineCount: 3 } } });
  const s1grep = await v1tool("grep", grep, { args: { pattern: "TextComp", path: "src" }, result: { content: [{ type: "text", text: grepMany }], details: { _type: "grepResult", text: grepMany, pattern: "TextComp", matchCount: 21 } } });
  const s1find = await v1tool("find", find, { args: { pattern: "*.test.ts" }, result: { content: [{ type: "text", text: findText }], details: { _type: "findResult", text: findText, pattern: "*.test.ts", matchCount: 83, notices: [] } } });
  const s1ls = await v1tool("ls", ls, { args: { path: "src" }, result: { content: [{ type: "text", text: lsText }], details: { _type: "lsResult", text: lsText, path: "src", entryCount: 20 } } });
  await v1tool("edit", edit, { args: { filePath: "src/add.ts", oldText: editSmallOld, newText: editSmallNew }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/add.ts", oldText: editSmallOld, newText: editSmallNew, __prettyElapsedMs: 40 } } });
  await v1tool("bash", bash, { args: { command: "npm test" }, result: { content: [{ type: "text", text: bash193 }], details: { ...B(bash193, 0), __prettyElapsedMs: 8200 } } });
  const streamOut = v1.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/,"");
  console.log("----- V1 STREAM (stripped) -----");
  for (const l of streamOut.split("\n")) console.log("  |" + l);
  console.log("----- END V1 STREAM -----");
  for (const [nm, r] of [["read", s1read], ["grep", s1grep], ["find", s1find], ["ls", s1ls]])
    if (visLines(r).length !== 1) V.notes.push(`V1 Tier-0 ${nm} rendered ${visLines(r).length} visible lines (want 1)`);
  if (streamOut.split("\n").filter((l) => l.trim()).length > 25) V.notes.push(`V1 stream ${streamOut.split("\n").filter((l) => l.trim()).length} visible lines (> ~25)`);

  // ---- V2 — failing tool auto-expands (no ctrl+o). ----
  console.log("\n### V2 — failing tool auto-expands ###");
  const v2read = await vtool("V2 read isError(12)", read, { args: { path: "src/x.ts" }, expanded: false, result: { isError: true, content: [{ type: "text", text: err12 }], details: { _type: "readFile", filePath: "src/x.ts", content: err12, offset: 0, lineCount: 12 } } });
  const v2bash = await vtool("V2 bash exit2(50)", bash, { args: { command: "npm run build" }, expanded: false, result: { isError: true, content: [{ type: "text", text: stderr50 }], details: { ...B(stderr50, 2), __prettyElapsedMs: 3100 } } });
  {
    const rb = v2bash.lines.map(strip);
    if (headerLine(v2read)[1] !== "✗") V.notes.push("V2 read glyph not ✗");
    if (visLines(v2read).length < 12) V.notes.push("V2 read did not show full 12-line body");
    if (!rb.some((l) => /Found 48 errors\./.test(l))) V.notes.push("V2 bash tail 'Found 48 errors.' not visible collapsed");
    if (!rb.some((l) => /27 lines/.test(l))) V.notes.push("V2 bash hidden count (27) missing");
    if (!rb.some((l) => /exit 2/.test(l))) V.notes.push("V2 bash 'exit 2' seg missing");
  }

  // ---- V3 — bash tail: 193-line success, marker above tail, hidden=188. ----
  console.log("\n### V3 — bash tail (193-line success) ###");
  const v3 = await vtool("V3 bash 193", bash, { args: { command: "npm test" }, expanded: false, result: { content: [{ type: "text", text: bash193 }], details: { ...B(bash193, 0), __prettyElapsedMs: 8200 } } });
  {
    const s = v3.lines.map(strip);
    const mkIdx = s.findIndex((l) => /188 lines/.test(l));
    const tailIdx = s.findIndex((l) => /Tests 84 passed/.test(l));
    if (tailIdx < 0) V.notes.push("V3 verdict 'Tests 84 passed' not visible collapsed");
    if (mkIdx < 0) V.notes.push("V3 hidden count (188) missing");
    if (mkIdx >= 0 && tailIdx >= 0 && mkIdx > tailIdx) V.notes.push("V3 marker not ABOVE tail");
  }

  // ---- V4 — edit evidence default; multi-pass expand/collapse, no LOOP. ----
  console.log("\n### V4 — edit evidence default (multi-pass) ###");
  const est4 = {}, ecm4 = {};
  const es4 = { args: { filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "editResult", filePath: "src/config.ts", oldText: editLargeOld, newText: editLargeNew, __prettyElapsedMs: 1400 } } };
  const e4a = await drive(edit, { ...es4, expanded: false }, est4, ecm4, 78); record("V4 collapsed", e4a); pr("V4 collapsed", e4a);
  const e4b = await drive(edit, { ...es4, expanded: true }, est4, ecm4, 78); record("V4 expanded", e4b); console.log(`  V4 expanded [passes=${e4b.passes} loop=${e4b.loop} lines=${e4b.lines.length}]`);
  const e4c = await drive(edit, { ...es4, expanded: false }, est4, ecm4, 78); record("V4 collapse2", e4c);
  {
    const collapsedMk = e4a.lines.map(strip).find((l) => /[+]\d/.test(l) && /·|−|-\d/.test(l));
    if (!e4a.lines.map(strip).some((l) => /\+\d/.test(l))) V.notes.push("V4 collapsed marker missing +count");
    if (e4b.lines.length <= e4a.lines.length) V.notes.push("V4 expanded not larger than collapsed");
  }

  // ---- V5 — large grep collapses to one line; expanded yellow only on term. ----
  // Per §5 V5 these are two standalone assertions (collapsed / expanded), so each
  // renders on FRESH state. (Expand-after-collapse on SHARED state is V6's job.)
  console.log("\n### V5 — large grep collapses to one line ###");
  const gs5 = { args: { pattern: "TextComp", path: "src" }, result: { content: [{ type: "text", text: grepMany }], details: { _type: "grepResult", text: grepMany, pattern: "TextComp", matchCount: 21 } } };
  const g5a = await drive(grep, { ...gs5, expanded: false }, {}, {}, 78); record("V5 collapsed", g5a); pr("V5 collapsed", g5a);
  const g5b = await drive(grep, { ...gs5, expanded: true }, {}, {}, 78); record("V5 expanded", g5b); console.log(`  V5 expanded [passes=${g5b.passes} loop=${g5b.loop} visible=${visLines(g5b).length}]`);
  {
    if (visLines(g5a).length !== 1) V.notes.push(`V5 collapsed ${visLines(g5a).length} visible lines (want 1)`);
    const h = headerLine(g5a);
    if (!/21 in 6 files/.test(h)) V.notes.push("V5 header missing '21 in 6 files'");
    if (!/bash\.js \(6\)/.test(h)) V.notes.push("V5 header missing top file 'bash.js (6)'");
    const hasTermHl = g5b.lines.some((l) => l.includes(PAL.dark.Y + BOLD) || l.includes(PAL.light.Y + BOLD));
    if (!hasTermHl) V.notes.push("V5 expanded term highlight (yellow+bold) not found");
  }

  // ---- V6 — multi-pass torture: read & grep collapse→expand→resize60→collapse. ----
  // Faithful resize: kit.header reads config.termWidth() (= process.stdout.columns),
  // NOT the width passed to render(); to simulate a real resize we must move
  // process.stdout.columns too, else the header truncates to the stale width and
  // pi-tui wraps it. Also asserts the EXPAND leg (shared state) actually shows a
  // body — the ZeroText-reuse regression (§6 review-item-2 / §7 risk-2).
  console.log("\n### V6 — multi-pass torture (read & grep) ###");
  const legs = [["collapse", false, 78], ["expand", true, 78], ["resize60", true, 60], ["collapse2", false, 78]];
  const savedCols = process.stdout.columns;
  async function torture(name, def, scenario) {
    const st = {}, cm = {};
    const byLeg = {};
    for (const [lbl, exp, w] of legs) {
      process.stdout.columns = w; process.env.COLUMNS = String(w);
      const r = await drive(def, { ...scenario, expanded: exp }, st, cm, w);
      record(`V6 ${name} ${lbl}`, r);
      byLeg[lbl] = r;
      if (r.passes > 3 || r.loop) V.notes.push(`V6 ${name} ${lbl}: passes=${r.passes} loop=${r.loop}`);
      console.log(`  ${name} ${lbl}: passes=${r.passes} invals=${r.invals} loop=${r.loop} visible=${visLines(r).length}`);
    }
    // After a collapsed pass, expanding must reveal a body (header + ≥1 body line).
    if (visLines(byLeg.expand).length <= 1)
      V.notes.push(`V6 ${name}: EXPAND-AFTER-COLLAPSE lost body — result stayed ZeroText (${visLines(byLeg.expand).length} visible line)`);
    return byLeg;
  }
  const rr6 = { args: { path: "src/big.ts" }, result: { content: [{ type: "text", text: fileBig }], details: { _type: "readFile", filePath: "src/big.ts", content: fileBig, offset: 0, lineCount: 312 } } };
  await torture("read", read, rr6);
  const gg6 = { args: { pattern: "TextComp", path: "src" }, result: { content: [{ type: "text", text: grepMany }], details: { _type: "grepResult", text: grepMany, pattern: "TextComp", matchCount: 21 } } };
  await torture("grep", grep, gg6);
  process.stdout.columns = savedCols; process.env.COLUMNS = String(savedCols);

  // ---- V7 — empties: grep 0, find 0, bash empty, write empty. ----
  console.log("\n### V7 — empties ###");
  const v7g = await vtool("V7 grep 0", grep, { args: { pattern: "zzz" }, result: { content: [{ type: "text", text: "" }], details: { _type: "grepResult", text: "", pattern: "zzz", matchCount: 0 } } });
  const v7f = await vtool("V7 find 0", find, { args: { pattern: "*.none" }, result: { content: [{ type: "text", text: "" }], details: { _type: "findResult", text: "", pattern: "*.none", matchCount: 0, notices: [] } } });
  const v7b = await vtool("V7 bash empty", bash, { args: { command: "true" }, result: { content: [{ type: "text", text: "" }], details: { ...B("", 0), __prettyElapsedMs: 20 } } });
  const v7w = await vtool("V7 write empty", write, { args: { filePath: "src/empty.ts", content: "" }, result: { content: [{ type: "text", text: "OK" }], details: { _type: "writeResult", filePath: "src/empty.ts", content: "", __prettyElapsedMs: 15 } } });
  {
    const all7 = [v7g, v7f, v7b, v7w].flatMap((r) => r.lines.map(strip));
    if (all7.some((l) => /in 0 files/.test(l))) V.notes.push("V7 leaked 'in 0 files'");
    if (visLines(v7g).length !== 1) V.notes.push(`V7 grep-empty ${visLines(v7g).length} visible lines (want 1)`);
    if (visLines(v7f).length !== 1) V.notes.push(`V7 find-empty ${visLines(v7f).length} visible lines (want 1)`);
  }

  // ---- V8 — color budget over the entire V-suite. ----
  console.log("\n### V8 — color budget over full V-suite ###");
  const budgetAll = assertColorBudget(V.all);
  console.log(`  scanned ${V.all.length} raw lines; violations=${budgetAll.length}`);
  for (const v of budgetAll.slice(0, 12)) console.log("   ! " + v);

  // ---- Phase 2 summary ----
  const colorBudgetClean = V.budget.length === 0 && budgetAll.length === 0;
  const glyphSpineAligned = V.spine.length === 0;
  const allBounded = V.maxPasses <= 3 && !V.loop;
  console.log("\n========================= PHASE 2 SUMMARY =========================");
  console.log(`indexLoads        : (checked separately via require index.js)`);
  console.log(`allBounded        : ${allBounded}  (maxPasses=${V.maxPasses}, loop=${V.loop})`);
  console.log(`glyphSpineAligned : ${glyphSpineAligned}${V.spine.length ? " -> " + V.spine.join(" | ") : ""}`);
  console.log(`colorBudgetClean  : ${colorBudgetClean}${V.budget.length ? " perScenario-> " + V.budget.join(" | ") : ""}${budgetAll.length ? " aggregate-> " + budgetAll.slice(0, 4).join(" | ") : ""}`);
  console.log(`problems          : ${V.notes.length ? V.notes.join(" | ") : "none"}`);
})();
