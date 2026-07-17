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

  // Multi-pass: same read execution, collapse -> expand -> resize. Watch for LOOP.
  console.log("\n=== MULTI-PASS: read collapse->expand->resize ===");
  const st = {}, cm = {};
  const rs = { args: { path: "src/big.ts" }, result: { content: [{ type: "text", text: fileBig }], details: { _type: "readFile", filePath: "src/big.ts", content: fileBig, offset: 0, lineCount: 312 } } };
  let r1 = await drive(read, { ...rs, expanded: false }, st, cm, 78); console.log(`collapsed: passes=${r1.passes} invals=${r1.invals} loop=${r1.loop}`);
  let r2 = await drive(read, { ...rs, expanded: true }, st, cm, 78); console.log(`expanded:  passes=${r2.passes} invals=${r2.invals} loop=${r2.loop}`);
  let r3 = await drive(read, { ...rs, expanded: true }, st, cm, 60); console.log(`resized60: passes=${r3.passes} invals=${r3.invals} loop=${r3.loop}`);
  let r4 = await drive(read, { ...rs, expanded: false }, st, cm, 78); console.log(`collapse2: passes=${r4.passes} invals=${r4.invals} loop=${r4.loop}`);
})();
