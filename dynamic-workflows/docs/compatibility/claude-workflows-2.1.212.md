# Claude Code dynamic workflows compatibility contract

- **Oracle:** Claude Code 2.1.212
- **Observation date:** 2026-07-17
- **Contract status:** pinned; changes require an intentional re-baseline
- **Implementation:** clean-room behavioral compatibility
- **Fixture schema:** 1

This document records observable behavior only. No proprietary implementation source, decompilation, binary-derived text, credentials, secret-bearing prompts, or raw transcripts are used or retained.

## Provenance labels

- `official-doc`: stated in Anthropic's public documentation or announcement.
- `black-box`: observed through a licensed local Claude Code installation using sanitized inputs and normalized outputs.
- `Pi-specific`: a Pi namespace, migration, or host-policy decision rather than a claim about Claude Code internals.

A row can have more than one label. The executable fixture manifest repeats the oracle version and provenance on every contract entry.

## Acceptance matrix

| ID | Contract | Pass condition | Provenance |
|---|---|---|---|
| INV-01 | Workflow accepts at least one of `scriptPath`, `script`, or `name` with documented precedence. | Missing sources fail before execution; precedence is `scriptPath` then `script` then `name`. | `official-doc`, `black-box` |
| INV-02 | `args` is exposed unchanged as global `args`. | Object, array, scalar, null, and omitted fixtures pass. | `official-doc`, `black-box` |
| TRG-01 | Literal `ultracode` opts in only from human interactive input. | Interactive triggers; print, RPC, and extension origins do not. | `black-box` |
| TRG-02 | Direct natural-language workflow requests work. | Model guidance exposes the tool without a keyword-only gate. | `official-doc`, `black-box` |
| EFF-01 | `/effort ultracode` sets `xhigh` for only the current session. | Pi reports `xhigh`; a fresh session returns to its configured default. | `black-box` |
| EFF-02 | Ultracode lets the model decide whether and how many workflows are warranted. | The prompt-eval corpus meets the orchestration rubric; no length heuristic forces every request. | `official-doc`, `black-box` |
| APP-01 | Default and accept-edits modes ask on every untrusted launch. | Once, always, view script, edit prompt, and deny paths pass. | `official-doc`, `black-box` |
| APP-02 | Auto mode asks only on first launch; Ultracode skips launch approval. | State survives session restart at user-setting scope. | `official-doc`, `black-box` |
| APP-03 | Headless and bypass runs never display UI. | Configured permission checks still apply to agent tools. | `black-box` |
| AGT-01 | Subagents use accept-edits posture and inherit the parent allowlist. | Read, edit, and write plus denied bash, web, and MCP fixtures match. | `official-doc`, `black-box` |
| AGT-02 | Agent options include `label`, `phase`, `schema`, `model`, `effort`, `isolation`, and `agentType`. | Every option independently affects the run and journal hash. | `official-doc`, `black-box` |
| RUN-01 | The runtime exposes only Claude-compatible orchestration globals. | The contract snapshot has no accidental Pi-only globals. | `official-doc`, `black-box` |
| RUN-02 | Scripts have no direct filesystem, shell, network, imports, or mid-run user input. | Negative scripts fail with stable error categories. | `official-doc`, `black-box` |
| RUN-03 | Limits are 16 concurrent and 1,000 total agents. | Boundary and over-limit tests pass without oversubscription. | `official-doc`, `black-box` |
| RUN-04 | Sandboxed code-generation and bridge-escape probes fail. | Function, constructor-chain, dynamic import, wasm, and host-object probes are blocked. | `black-box` |
| RES-01 | Pause and relaunch replay completed agents and rerun in-flight agents. | Token and call counters prove only eligible results replay. | `official-doc`, `black-box` |
| RES-02 | Editing call N reuses calls before N and reruns N onward. | Insert, delete, reorder, prompt, option, schema, and agent-definition fixtures pass. | `official-doc`, `black-box` |
| RES-03 | Edited-script relaunch works after completion. | A new run references the source journal without mutating it. | `official-doc`, `black-box` |
| RES-04 | Default resume scope is the current session. | A new session starts fresh; Pi cross-session recovery is separately named. | `black-box`, `Pi-specific` |
| SAV-01 | Project and user workflows are JavaScript files with project precedence. | Collision and invalid-file tests pass. | `official-doc`, `black-box`, `Pi-specific` |
| SAV-02 | Monorepos choose the closest workflow directory. | The nested-cwd fixture passes. | `black-box`, `Pi-specific` |
| UI-01 | `/workflows` supports drill-down, filtering, run pause/resume, focused-agent stop/restart, and save. | Keyboard state-machine tests cover every view. | `official-doc`, `black-box` |
| UI-02 | Large-workflow warning appears above 25 agents or 1.5M projected tokens. | Threshold tests pass; warning is advisory and suppressed under Ultracode. | `black-box` |
| DRS-01 | `/deep-research` is a normal background managed workflow. | It appears in `/workflows`, can pause/resume, and delivers one final report. | `black-box` |
| DRS-02 | Research extracts claims, tracks sources, votes, and marks unverifiable claims. | Rate-limit and tool-failure fixtures distinguish unverified from refuted. | `official-doc`, `black-box` |
| DIS-01 | User, environment, and managed disable switches remove all workflow entry points. | Tool, keyword, effort option, and bundled command are absent. | `official-doc`, `black-box`, `Pi-specific` |

## Compatibility boundaries

The table is the source of truth for Claude-compatible defaults. Pi additions such as cross-session recovery, checkpoints, quality helpers, model tiers, hard budgets, and cost accounting must live under an explicit `pi` extension namespace and cannot weaken the compatible core.

Runtime behavior and state transitions are exact compatibility targets. Model-authored scripts and orchestration judgments are evaluated with pinned rubrics and repeated trials, not literal text snapshots.

## Capture and normalization

`CLAUDE_WORKFLOW_ORACLE=1 npm run compat:capture -- --claude-version 2.1.212 --confirm-paid-calls` is the only supported capture entry point. It verifies the installed version, displays the maximum paid-call estimate, requires the environment opt-in and confirmation flag, and writes only normalized JSON. IDs, timestamps, absolute paths, token totals, and costs are replaced before persistence.

Oracle runs are optional and paid. They must use public, synthetic prompts. Review the applicable Anthropic terms before every re-baseline; stop if the planned method is not permitted.

## Primary public references

- [Dynamic workflows documentation](https://code.claude.com/docs/en/workflows)
- [Introducing dynamic workflows in Claude Code](https://claude.com/blog/introducing-dynamic-workflows-in-claude-code)
- [A harness for every task: dynamic workflows in Claude Code](https://claude.com/blog/a-harness-for-every-task-dynamic-workflows-in-claude-code)
