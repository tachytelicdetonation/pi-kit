import { StringEnum } from "@earendil-works/pi-ai";
import { truncateHead, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { runCodexSearch } from "./search.js";
import type { CodexSearchInput, CodexSearchResult } from "./types.js";

const MAX_CONCURRENCY = Math.min(Math.max(Number(process.env.PI_CODEX_SEARCH_MAX_CONCURRENCY) || 2, 1), 4);
let activeSearches = 0;

const optionalStrings = (description: string) =>
  Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 20, description }));

const searchParameters = Type.Object({
  query: Type.String({ minLength: 2, maxLength: 8_000, description: "The question or topic to research." }),
  effort: Type.Optional(
    StringEnum(["auto", "low", "medium", "high"] as const, {
      description: "Reasoning effort. Auto scores query complexity; low is the economical default for simple research.",
    }),
  ),
  depth: Type.Optional(
    StringEnum(["auto", "low", "medium", "high"] as const, {
      description: "Native Codex web-search context depth. Auto follows effort.",
    }),
  ),
  mode: Type.Optional(
    StringEnum(["live", "cached", "indexed"] as const, {
      description: "Search freshness mode. Live is the default.",
    }),
  ),
  freshness: Type.Optional(
    StringEnum(["day", "week", "month", "year"] as const, {
      description: "Best-effort relative publication-date filter.",
    }),
  ),
  dateFrom: Type.Optional(Type.String({ description: "Best-effort inclusive start date in YYYY-MM-DD format." })),
  dateTo: Type.Optional(Type.String({ description: "Best-effort inclusive end date in YYYY-MM-DD format." })),
  language: Type.Optional(Type.String({ minLength: 2, maxLength: 80, description: "Preferred result and answer language." })),
  location: Type.Optional(
    Type.Object({
      country: Type.Optional(Type.String({ maxLength: 100, description: "Country name or ISO code." })),
      region: Type.Optional(Type.String({ maxLength: 100 })),
      city: Type.Optional(Type.String({ maxLength: 100 })),
      timezone: Type.Optional(Type.String({ maxLength: 100, description: "IANA timezone such as America/New_York." })),
    }),
  ),
  includeDomains: optionalStrings("Domains to include. Enforced on returned source URLs."),
  excludeDomains: optionalStrings("Domains to exclude. Enforced on returned source URLs."),
  exactTerms: optionalStrings("Exact words or phrases that should occur in results (best effort)."),
  excludeTerms: optionalStrings("Words or phrases to exclude from results (best effort)."),
  fileTypes: optionalStrings("Preferred file extensions such as pdf, docx, or csv (best effort)."),
  maxResults: Type.Optional(Type.Integer({ minimum: 1, maximum: 10, description: "Maximum returned sources. Default 5." })),
  safeSearch: Type.Optional(
    StringEnum(["strict", "moderate", "off"] as const, {
      description: "Requested content filtering level. This is best effort because Codex exposes no hard SafeSearch switch.",
    }),
  ),
  timeoutSeconds: Type.Optional(
    Type.Integer({ minimum: 15, maximum: 600, description: "Hard subprocess timeout. Defaults vary by effort." }),
  ),
});

function formatNumber(value: number | undefined): string {
  if (value === undefined) return "unknown";
  return new Intl.NumberFormat("en-US").format(value);
}

export function formatSearchResult(result: CodexSearchResult): string {
  const sections = [result.answer.trim()];
  if (result.sources.length) {
    const sources = result.sources.map((source) => {
      const published = source.publishedAt ? ` — ${source.publishedAt}` : "";
      const summary = source.summary ? `\n  ${source.summary}` : "";
      return `- [${source.title || source.url}](${source.url})${published}${summary}`;
    });
    sections.push(`## Sources\n${sources.join("\n")}`);
  } else {
    sections.push("## Sources\nNo source URLs survived validation. Treat the answer as unverified.");
  }
  if (result.limitations.length) sections.push(`## Limitations\n${result.limitations.map((item) => `- ${item}`).join("\n")}`);
  sections.push(
    `_Codex ${result.meta.model} · ${result.meta.effort} effort · ${result.meta.depth} search depth · ${(
      result.meta.elapsedMs / 1_000
    ).toFixed(1)}s · ${formatNumber(result.meta.tokensUsed)} tokens_`,
  );

  const rendered = sections.join("\n\n");
  const truncated = truncateHead(rendered, { maxBytes: 45 * 1024, maxLines: 600 });
  return truncated.truncated
    ? `${truncated.content}\n\n[Output truncated to ${formatNumber(truncated.outputBytes)} bytes; structured details retain the validated result.]`
    : truncated.content;
}

async function searchWithLimit(
  input: CodexSearchInput,
  signal: AbortSignal | undefined,
  onProgress?: (message: string) => void,
): Promise<CodexSearchResult> {
  if (activeSearches >= MAX_CONCURRENCY) {
    throw new Error(`Codex search concurrency limit reached (${MAX_CONCURRENCY}). Wait for an active search to finish.`);
  }
  activeSearches += 1;
  try {
    return await runCodexSearch(input, { signal, onProgress });
  } finally {
    activeSearches -= 1;
  }
}

export function registerCodexSearch(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "codex_search",
    label: "Codex Search",
    description:
      "Perform complex, current, or multi-source web research in an isolated ephemeral Codex CLI session using GPT-5.6 Sol. Supports Google-like filters; date, language, file type, term, and SafeSearch controls are best effort. Returned URLs are validated and output is limited to 45KB.",
    promptSnippet: "Research complex web questions with isolated Codex search",
    promptGuidelines: [
      "Use codex_search for complex, current, comparative, or multi-source web research; use ordinary web_fetch when the user already supplied a URL.",
      "Treat codex_search safe-search, date, language, term, and file-type filters as best effort, and preserve reported limitations.",
    ],
    parameters: searchParameters,
    async execute(_toolCallId, params, signal, onUpdate) {
      const result = await searchWithLimit(params as CodexSearchInput, signal, (message) => {
        onUpdate?.({ content: [{ type: "text", text: message }], details: { status: message } });
      });
      return {
        content: [{ type: "text", text: formatSearchResult(result) }],
        details: result,
      };
    },
  });

  pi.registerCommand("codex-search", {
    description: "Search the web directly through an ephemeral GPT-5.6 Sol Codex session",
    handler: async (args, ctx) => {
      const query = args.trim();
      if (!query) {
        ctx.ui.notify("Usage: /codex-search <question>", "warning");
        return;
      }
      ctx.ui.setStatus("codex-search", "Codex search: starting…");
      try {
        const result = await searchWithLimit({ query, effort: "auto", depth: "auto", mode: "live" }, undefined, (message) => {
          ctx.ui.setStatus("codex-search", message);
        });
        pi.sendMessage({ customType: "codex-search", content: formatSearchResult(result), display: true, details: result });
      } catch (error) {
        ctx.ui.notify(`Codex search failed: ${error instanceof Error ? error.message : String(error)}`, "error");
      } finally {
        ctx.ui.setStatus("codex-search", undefined);
      }
    },
  });

  pi.registerCommand("codex-search-doctor", {
    description: "Check whether the Codex CLI needed by codex_search is available",
    handler: async (_args, ctx) => {
      const executable = process.env.PI_CODEX_SEARCH_BIN?.trim() || "codex";
      try {
        const result = await pi.exec(executable, ["--version"], { timeout: 10_000 });
        if (result.code === 0) {
          ctx.ui.notify(`Codex search ready: ${result.stdout.trim() || executable}`, "info");
        } else {
          ctx.ui.notify(`Codex search unavailable: ${result.stderr.trim() || `exit ${result.code}`}`, "error");
        }
      } catch (error) {
        ctx.ui.notify(`Codex search unavailable: ${error instanceof Error ? error.message : String(error)}`, "error");
      }
    },
  });
}
