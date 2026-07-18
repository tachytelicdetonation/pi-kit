# Pi Codex Search

A standalone Pi extension that delegates complex web research to an isolated, ephemeral Codex CLI session running `gpt-5.6-sol`.

## Features

- `codex_search` tool for complex, current, comparative, and multi-source research
- `/codex-search <question>` for direct interactive searches
- Automatic low/medium/high reasoning and search-depth routing
- Google-like controls for dates, language, location, domains, terms, file types, result count, and safe search
- Strict structured output, URL validation, source deduplication, cancellation, timeouts, concurrency limits, and output caps
- Empty temporary cwd with Codex user config, project rules, shell tools, and unified execution disabled

Codex natively supports search mode, context depth, location, and included domains. Date ranges, language, excluded terms, file types, and safe search are best-effort controls and are reported as such.

## Requirements

- Pi `0.80.10` or newer
- A locally installed and authenticated Codex CLI
- Access to `gpt-5.6-sol`

Check the setup inside Pi:

```text
/codex-search-doctor
```

## Installation

From this repository:

```bash
pi install /absolute/path/to/pi-kit/codex-search
```

Then start a new Pi session or run `/reload` in an existing session.

## Usage

Ask Pi to use `codex_search`, or run:

```text
/codex-search compare the current capabilities of three TypeScript runtimes
```

The tool accepts:

- `effort`: `auto`, `low`, `medium`, or `high`
- `depth`: `auto`, `low`, `medium`, or `high`
- `mode`: `live`, `cached`, or `indexed`
- freshness and explicit date bounds
- language and country/region/city/timezone
- included/excluded domains
- exact/excluded terms
- preferred file types
- maximum result count
- requested safe-search level
- timeout override

## Configuration

Environment variables:

| Variable | Default | Purpose |
|---|---:|---|
| `PI_CODEX_SEARCH_BIN` | `codex` | Codex executable path |
| `PI_CODEX_SEARCH_MODEL` | `gpt-5.6-sol` | Codex model identifier |
| `PI_CODEX_SEARCH_MAX_CONCURRENCY` | `2` | Maximum concurrent searches, clamped to 1–4 |

Default timeouts are 90 seconds for low effort, 180 seconds for medium, and 360 seconds for high.

## Security model

The extension uses `spawn()` with an argument array and `shell: false`; the query is supplied over stdin. Codex runs with:

- an empty temporary working directory
- `--ephemeral`
- `--ignore-user-config`
- `--ignore-rules`
- a read-only sandbox
- approval policy `never`
- shell and unified-exec features disabled
- no inherited shell environment for model-generated commands

The child process is retained and terminated on cancellation or timeout. Search pages remain untrusted input, and returned HTTP(S) URLs are validated before reaching Pi.
