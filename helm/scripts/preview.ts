/**
 * Visual smoke preview: renders 6b mission control at a few sizes and both footer
 * variants at several widths, so the screens can be eyeballed without launching
 * pi. Uses a fake tui (live rows via a mutable object), a seeded MockDataSource,
 * and a truecolor theme.
 */
import { HelmApp } from '../src/app.js';
import type { TuiLike } from '../src/app.js';
import {
  MockDataSource,
  seedCloseout,
  seedCodemodDrillIn,
  seedDigest,
  seedExportMapEscalation,
  seedIntake,
  seedLoopDraft,
  seedSession,
  seedState,
  seedUsageDetail,
} from "../src/data/mock.js";
import { renderHelmFooter } from '../src/footer.js';
import { renderCloseout } from "../src/screens/closeout.js";
import { renderDigest } from "../src/screens/digest.js";
import { renderDrillIn } from "../src/screens/drill-in.js";
import { renderEscalation } from "../src/screens/escalation.js";
import { renderIntake } from "../src/screens/intake.js";
import { renderLoopBuilder } from "../src/screens/loop-builder.js";
import { overlayPopover, usagePopoverLines } from "../src/screens/popover.js";
import { renderSearch } from "../src/screens/search.js";
import { renderSession } from "../src/screens/session.js";

const theme = { getColorMode: () => "truecolor" as const };

const SIZES = [
  [120, 34],
  [90, 26],
  [70, 20],
] as const;

console.log("════════ 6b — MISSION CONTROL ════════");
for (const [columns, rows] of SIZES) {
  const tui: TuiLike = { terminal: { rows, columns }, requestRender() {} };
  const app = new HelmApp(tui, theme, () => {}, new MockDataSource());
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(app.render(columns).join("\n"));
}

console.log("\n\n════════ 6c — WORKFLOW DRILL-IN ════════");
const detail = seedCodemodDrillIn();
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(renderDrillIn(detail, theme, columns, rows, 0).join("\n"));
}

console.log("\n\n════════ 4a — SESSION VIEW ════════");
const session = seedSession("wt-3");
// Expand the ratelimit edit (index 2) and the verify (index 4) to match the mock.
const expanded = new Set<number>([2, 4]);
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(renderSession(session, theme, columns, rows, 2, expanded).join("\n"));
}

console.log("\n\n════════ 7b — ESCALATION CARD ════════");
const escalation = seedExportMapEscalation();
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(renderEscalation(escalation, theme, columns, rows).join("\n"));
}

console.log("\n\n════════ 7c — CATCH-UP DIGEST ════════");
const digest = seedDigest();
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(renderDigest(digest, theme, columns, rows).join("\n"));
}

console.log("\n\n════════ 6a — INTENT INTAKE ════════");
const intake = seedIntake();
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(renderIntake(intake, theme, columns, rows).join("\n"));
}

console.log("\n\n════════ 7a — LOOP BUILDER ════════");
const loopDraft = seedLoopDraft();
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} (idle) ===`);
  console.log(renderLoopBuilder(loopDraft, theme, columns, rows, "idle").join("\n"));
}
console.log(`\n=== 90×26 (passed trial) ===`);
console.log(renderLoopBuilder(loopDraft, theme, 90, 26, "passed").join("\n"));
console.log(`\n=== 90×26 (failed trial) ===`);
console.log(renderLoopBuilder(loopDraft, theme, 90, 26, "failed").join("\n"));

console.log("\n\n════════ 7d — GOAL CLOSEOUT ════════");
const source = new MockDataSource();
// getCloseout() filters DECLINED precedents (so the seed's `pc-deps` is dropped).
const closeout = source.getCloseout("g-esm") ?? seedCloseout();
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(renderCloseout(closeout, theme, columns, rows).join("\n"));
}

console.log("\n\n════════ / — SEARCH ════════");
for (const [columns, rows] of SIZES) {
  console.log(`\n=== ${columns}×${rows} — query "esm" ===`);
  console.log(renderSearch("esm", source.search("esm"), theme, columns, rows, 0).join("\n"));
}
console.log(`\n=== 90×26 — query "auth" (archived, search is forever) ===`);
console.log(renderSearch("auth", source.search("auth"), theme, 90, 26, 0).join("\n"));

console.log("\n\n════════ ctrl+u — USAGE POPOVER (composited over 6b) ════════");
for (const [columns, rows] of SIZES) {
  const tui: TuiLike = { terminal: { rows, columns }, requestRender() {} };
  const app = new HelmApp(tui, theme, () => {}, new MockDataSource());
  const body = app.render(columns); // draw home first
  const box = usagePopoverLines(seedUsageDetail(), theme, columns);
  console.log(`\n=== ${columns}×${rows} ===`);
  console.log(overlayPopover(body, box, columns).join("\n"));
}

console.log("\n\n════════ FOOTER — session & fleet · normal & paused ════════");
const footer = seedState().footer;
for (const width of [140, 110, 90, 89, 70, 60] as const) {
  console.log(`\n--- ${width} cols ---`);
  console.log(`session      : ${renderHelmFooter(footer, theme, width, "session")}`);
  console.log(`fleet        : ${renderHelmFooter(footer, theme, width, "fleet")}`);
  console.log(`fleet paused : ${renderHelmFooter(footer, theme, width, "fleet", true)}`);
}
