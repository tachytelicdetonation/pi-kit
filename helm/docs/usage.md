# Pi Usage Health

A standalone Pi extension that **replaces Pi's built-in footer** with a single-row usage footer: cwd + branch, a stacked Codex / Claude Code / Kimi Code quota bar, the session context meter, and cost · model · effort. This is the "3a footer" from the pi TUI design.

```text
~/pi-kit main  │  ▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮▮ 83%  │  ctx ▮▮▮▮▮▮▮▮ 60%        $0.012 · gpt-5.6-sol high
```

The provider bar is a 30-cell combined subscription budget (20 cells on narrow terminals). Each provider is weighted equally: provider *i* gets `round(remaining_i / N / 100 × cells)` colored cells in fixed order (codex blue, claude orange, kimi teal); spent budget is gray. The total percentage is the plain average of the providers' remaining percentages.

Each provider's remaining health is the lowest remaining percentage among its active quota windows (for example, five-hour or weekly). The extension uses provider-reported percentages only—there is no token-based usage estimation. A provider whose data is missing or corrupt contributes zero (gray cells, no fabricated value); when *no* provider has data the total reads `--` rather than a misleading `0%`.

Truncation drops content as the terminal narrows: `<110` drops the cwd, `<90` drops the cost and shrinks the bar to 20 cells, `<70` drops the context meter.

## Data sources

- **Codex:** authenticated ChatGPT Codex usage percentages, with Codex app-server `account/rateLimits/read` as a fallback
- **Claude Code:** Anthropic OAuth usage percentages when the existing access token is current; otherwise Claude Code's own `~/.claude.json` percentage cache
- **Kimi Code:** managed Kimi Code `/usages` percentages

The extension never logs credentials or stores them in its cache. Codex token refresh is delegated to Codex app-server. Kimi token rotation uses Kimi Code's official lock and atomic credential update. Claude credentials are never refreshed or modified. The extension cache contains normalized percentages, reset times, and provider check timestamps only.

## Installation

```bash
pi install /absolute/path/to/pi-kit/usage-health
```

Start a new Pi session or run `/reload`.

## Commands

- `/usage-health` — show every quota window, reset countdown, data source, and refresh error
- `/usage-refresh` — explicitly refresh all supported providers immediately

Automatic refresh has no background timer. Session starts and settled turns only check the shared cache age. A provider is contacted at most once per configured interval across Pi processes; failed attempts are throttled too. A cross-process lock prevents simultaneous sessions from making overlapping requests. `/usage-refresh` is the only bypass.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PI_USAGE_HEALTH_REFRESH_MINUTES` | `30` | Minimum automatic provider-check interval, clamped to 5–60 minutes |
| `PI_USAGE_HEALTH_CODEX_BIN` | `codex` | Codex executable used by the app-server fallback |
| `PI_CODING_AGENT_DIR` | `~/.pi/agent` | Pi auth and sanitized cache root |
| `CODEX_HOME` | `~/.codex` | Codex CLI auth directory |
| `CLAUDE_CONFIG_DIR` | `~/.claude` | Claude Code credential directory |
| `CLAUDE_STATE_FILE` | `~/.claude.json` | Claude Code percentage-cache file |
| `KIMI_CODE_HOME` | `~/.kimi-code` | Kimi Code credential directory |
| `KIMI_CODE_BASE_URL` | `https://api.kimi.com/coding/v1` | Managed Kimi base URL |

Wide terminals use a header plus the weighted bar. Smaller widths proportionally compress the bar and use a compact legend.

## Development

```bash
npm install
npm test
npm run preview
```
