export type SearchEffort = "auto" | "low" | "medium" | "high";
export type ResolvedEffort = Exclude<SearchEffort, "auto">;
export type SearchMode = "live" | "cached" | "indexed";
export type SearchDepth = "auto" | "low" | "medium" | "high";
export type SafeSearch = "strict" | "moderate" | "off";
export type Freshness = "day" | "week" | "month" | "year";

export interface SearchLocation {
  country?: string;
  region?: string;
  city?: string;
  timezone?: string;
}

export interface CodexSearchInput {
  query: string;
  effort?: SearchEffort;
  depth?: SearchDepth;
  mode?: SearchMode;
  freshness?: Freshness;
  dateFrom?: string;
  dateTo?: string;
  language?: string;
  location?: SearchLocation;
  includeDomains?: string[];
  excludeDomains?: string[];
  exactTerms?: string[];
  excludeTerms?: string[];
  fileTypes?: string[];
  maxResults?: number;
  safeSearch?: SafeSearch;
  timeoutSeconds?: number;
}

export interface SearchSource {
  title: string;
  url: string;
  publishedAt: string;
  summary: string;
  claims: string[];
}

export interface SearchPayload {
  answer: string;
  sources: SearchSource[];
  queries: string[];
  limitations: string[];
}

export interface CodexSearchResult extends SearchPayload {
  meta: {
    model: string;
    effort: ResolvedEffort;
    depth: ResolvedEffort;
    mode: SearchMode;
    elapsedMs: number;
    tokensUsed?: number;
    searchEvents: number;
    filteredSources: number;
  };
}
