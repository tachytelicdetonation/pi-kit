import { Theme } from "@earendil-works/pi-coding-agent";
import { renderFooter } from "../src/usage/ui.js";
import type { FooterViewModel } from "../src/usage/ui.js";

const colors = {
  accent: "#a78bfa", border: "#6b7280", borderAccent: "#a78bfa", borderMuted: "#4b5563",
  success: "#10b981", error: "#fb7185", warning: "#fbbf24", muted: "#9ca3af", dim: "#6b7280", text: "#f3f4f6",
  thinkingText: "#9ca3af", userMessageText: "#f3f4f6", customMessageText: "#f3f4f6", customMessageLabel: "#a78bfa",
  toolTitle: "#f3f4f6", toolOutput: "#d1d5db", mdHeading: "#f3f4f6", mdLink: "#60a5fa", mdLinkUrl: "#6b7280",
  mdCode: "#fbbf24", mdCodeBlock: "#d1d5db", mdCodeBlockBorder: "#4b5563", mdQuote: "#d1d5db", mdQuoteBorder: "#4b5563",
  mdHr: "#4b5563", mdListBullet: "#a78bfa", toolDiffAdded: "#10b981", toolDiffRemoved: "#fb7185", toolDiffContext: "#9ca3af",
  syntaxComment: "#6b7280", syntaxKeyword: "#c084fc", syntaxFunction: "#60a5fa", syntaxVariable: "#f3f4f6", syntaxString: "#10b981",
  syntaxNumber: "#fbbf24", syntaxType: "#22d3ee", syntaxOperator: "#9ca3af", syntaxPunctuation: "#9ca3af",
  thinkingOff: "#6b7280", thinkingMinimal: "#6b7280", thinkingLow: "#60a5fa", thinkingMedium: "#a78bfa", thinkingHigh: "#f59e0b",
  thinkingXhigh: "#fb7185", thinkingMax: "#ef4444", bashMode: "#10b981",
} as const;
const backgrounds = {
  selectedBg: "#374151", userMessageBg: "#111827", customMessageBg: "#111827", toolPendingBg: "#111827",
  toolSuccessBg: "#052e24", toolErrorBg: "#4c0519",
} as const;
const theme = new Theme(colors, backgrounds, "truecolor");
const now = Date.now();
const model: FooterViewModel = {
  now,
  cwd: "~/pi-kit",
  branch: "main",
  ctxPercent: 60,
  costUsd: 0.012,
  model: "gpt-5.6-sol",
  effort: "high",
  providers: [
    { provider: "codex", refreshing: false, snapshot: { provider: "codex", source: "live", fetchedAt: now, buckets: [{ id: "main", label: "7-day", usedPercent: 17 }] } },
    { provider: "claude", refreshing: false, snapshot: { provider: "claude", source: "provider-cache", fetchedAt: now, buckets: [{ id: "weekly", label: "7-day", usedPercent: 9 }] } },
    { provider: "kimi", refreshing: false, snapshot: { provider: "kimi", source: "live", fetchedAt: now, buckets: [{ id: "weekly", label: "Weekly", usedPercent: 84 }] } },
  ],
};

for (const width of [140, 100, 80, 60]) {
  console.log(`\n${width} columns`);
  console.log(renderFooter(model, theme, width).join("\n"));
}
