# pi-kit

My personal collection of Pi extensions — vendored (with fixes) and/or custom.
Each subfolder is a **self-contained, independently installable Pi package**, so
they can be worked on and installed in parallel.

| Folder | What it is | Upstream |
|---|---|---|
| `helm/` | Helm — mission-control TUI with dynamic workflows, Claude-cmux fleets, usage health, and Codex search folded in as one Pi extension. | Custom |

Vendored extensions keep the upstream `LICENSE` file and credit the original
author in their own README; see each folder. Fixes are marked with
`FIX (pi-kit):` comments so they survive an upstream re-sync.

## Install one

```bash
pi install /Users/tanmaydeshmukh/Projects/pi-kit/<folder>
```
