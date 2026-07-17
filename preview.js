// Visual harness for pi-kit/pretty tool rendering.
//   NODE_PATH=<pi-tui parent> node preview.js
const path = require("node:path");
const DIST = path.join(__dirname, "pretty", "dist");
const CSI = { toolTitle: "\x1b[1m", error: "\x1b[31m", dim: "\x1b[2m", muted: "\x1b[2m", toolOutput: "", accent: "\x1b[34m", warning: "\x1b[33m", success: "\x1b[32m" };
const theme = { fg: (k, s) => `${CSI[k] ?? ""}${s}\x1b[0m`, bold: (s) => `\x1b[1m${s}\x1b[0m`, bg: () => "", getBgAnsi: () => null };
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, "");
const W = 78;
process.stdout.columns = W;
process.env.COLUMNS = String(W);
const tick = () => new Promise((r) => setTimeout(r, 250));

function grabTool(register) {
  let def;
  const pi = { registerTool: (d) => { def = d; }, registerCommand: () => {} };
  register(pi, process.cwd(), null, { description: "", parameters: {}, execute: async () => ({}) }, undefined);
  return def;
}
async function show(title, def, { args, result, expanded }) {
  const state = {};
  let cc, rc;
  try {
    rc = def.renderResult(result, { expanded, isPartial: false }, theme, { expanded, isError: !!result.isError, state, lastComponent: undefined, args, invalidate: () => {} });
    cc = def.renderCall(args, theme, { expanded, isError: !!result.isError, state, lastComponent: undefined, args, invalidate: () => {} });
    await tick(); // let async Shiki/regex swap in
  } catch (e) { console.log(`\n### ${title}\n  !! THREW: ${e.stack.split("\n").slice(0,3).join("\n")}`); return; }
  console.log(`\n### ${title}  (${expanded ? "expanded" : "collapsed"})`);
  const lines = [];
  if (cc?.render) lines.push(...cc.render(W));
  if (rc?.render) lines.push(...rc.render(W));
  for (const l of lines) console.log("  |" + strip(l).replace(/\s+$/, ""));
}

const bash = grabTool(require(path.join(DIST, "tools/bash.js")).registerBashTool);
const read = grabTool(require(path.join(DIST, "tools/read.js")).registerReadTool);
const grep = grabTool(require(path.join(DIST, "tools/grep.js")).registerGrepTool);
const ls = grabTool(require(path.join(DIST, "tools/ls.js")).registerLsTool);
const find = grabTool(require(path.join(DIST, "tools/find.js")).registerFindTool);

const B = (t, e) => ({ _type: "bashResult", text: t, exitCode: e, command: "" });
const bigOut = Array.from({ length: 193 }, (_, i) => `line ${i + 1}`).join("\n");
const errOut = "src/x.ts:71:12 - error TS2339: Property 'exitCode' does not exist.\n" + Array.from({ length: 22 }, (_, i) => `  detail ${i}`).join("\n") + "\nFound 1 error.";
const fileSmall = "export function add(a, b) {\n  return a + b;\n}\n";
const fileBig = Array.from({ length: 312 }, (_, i) => `const line${i} = ${i} * 2;`).join("\n");
const grepFew = "src/a.ts:12:const TextComp = x;\nsrc/a.ts:40:  TextComp.render();\nsrc/b.ts:5:import { TextComp } from './a';";
const grepMany = ["tools/bash.js", "tools/read.js", "tools/grep.js", "tools/ls.js", "index.js", "config.js"]
  .flatMap((f, fi) => Array.from({ length: 6 - fi > 0 ? 6 - fi : 1 }, (_, i) => `${f}:${(i + 1) * 3}:  const TextComp = resolve(${i});`)).join("\n");
const lsText = "tools/\nrender/\nthemes/\nconfig.ts\nhelpers.ts\nimage.ts\nindex.ts\nexpand.ts\nkit.js\nbash.js\nread.js\ngrep.js\nfind.js\nls.js\nmetrics.js\nnotices.js\npackage.json\nREADME.md\ntsconfig.json\n.gitignore";
const findText = [
  ...Array.from({ length: 41 }, (_, i) => `src/tools/t${i}.test.ts`),
  ...Array.from({ length: 23 }, (_, i) => `src/render/r${i}.test.ts`),
  ...Array.from({ length: 19 }, (_, i) => `test/e2e${i}.test.ts`),
].join("\n");

(async () => {
  await show("bash small", bash, { args: { command: "git status" }, result: { content: [{ type: "text", text: "On branch main\nnothing to commit, working tree clean" }], details: { ...B("On branch main\nnothing to commit, working tree clean", 0), __prettyElapsedMs: 120 } } });
  await show("bash large", bash, { args: { command: "npm test" }, result: { content: [{ type: "text", text: bigOut }], details: { ...B(bigOut + "\n\nTest Files 6 passed\nTests 84 passed", 0), __prettyElapsedMs: 8200 } } });
  await show("bash error", bash, { args: { command: "npm run build", timeout: 30 }, result: { isError: true, content: [{ type: "text", text: errOut }], details: { ...B(errOut, 2), __prettyElapsedMs: 3100 } } });
  await show("read small", read, { args: { path: "src/add.ts" }, result: { content: [{ type: "text", text: fileSmall }], details: { _type: "readFile", filePath: "src/add.ts", content: fileSmall, offset: 0, lineCount: 3 } } });
  await show("read large", read, { args: { path: "src/big.ts" }, result: { content: [{ type: "text", text: fileBig }], details: { _type: "readFile", filePath: "src/big.ts", content: fileBig, offset: 0, lineCount: 312 } } });
  await show("read large expanded", read, { args: { path: "src/big.ts" }, expanded: true, result: { content: [{ type: "text", text: fileBig }], details: { _type: "readFile", filePath: "src/big.ts", content: fileBig, offset: 0, lineCount: 312 } } });
  await show("grep few", grep, { args: { pattern: "TextComp" }, result: { content: [{ type: "text", text: grepFew }], details: { _type: "grepResult", text: grepFew, pattern: "TextComp", matchCount: 3 } } });
  await show("grep many", grep, { args: { pattern: "TextComp", path: "src" }, result: { content: [{ type: "text", text: grepMany }], details: { _type: "grepResult", text: grepMany, pattern: "TextComp", matchCount: 21 } } });
  await show("ls", ls, { args: { path: "src" }, result: { content: [{ type: "text", text: lsText }], details: { _type: "lsResult", text: lsText, path: "src", entryCount: 20 } } });
  await show("ls expanded", ls, { args: { path: "src" }, expanded: true, result: { content: [{ type: "text", text: lsText }], details: { _type: "lsResult", text: lsText, path: "src", entryCount: 20 } } });
  await show("find", find, { args: { pattern: "*.test.ts" }, result: { content: [{ type: "text", text: findText }], details: { _type: "findResult", text: findText, pattern: "*.test.ts", matchCount: 83, notices: [] } } });
})();
