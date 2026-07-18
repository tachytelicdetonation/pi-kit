import { renderHelmFooter, type HelmFooterModel } from "../src/footer.js";

const theme = { getColorMode: () => "truecolor" as const };
const model: HelmFooterModel = {
  cwd: "~/pi-kit",
  branch: "main",
  ctxPercent: 60,
  costUsd: 0.012,
  burnRatePerMin: 41_000,
  spendTodayUsd: 18.4,
  model: "gpt-5.6-sol",
  effort: "high",
  providers: [
    { id: "codex", remaining: 90 },
    { id: "claude", remaining: 100 },
    { id: "kimi", remaining: 60 },
  ],
};

const widths = [140, 110, 109, 90, 89, 70, 69];

for (const width of widths) {
  console.log(`\n${width} columns · session`);
  console.log(renderHelmFooter(model, theme, width, "session"));
  console.log(`${width} columns · fleet`);
  console.log(renderHelmFooter(model, theme, width, "fleet"));
  console.log(`${width} columns · paused`);
  console.log(renderHelmFooter(model, theme, width, "fleet", true));
}
