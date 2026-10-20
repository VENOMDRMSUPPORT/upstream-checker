# Documentation index

Every document in this repository, what it covers, and how far to trust it.

| Document | What it covers | Status |
| --- | --- | --- |
| [../README.md](../README.md) | What the app is, how to install and run it, the built-in provider list, the pages | Hand-written |
| [../AGENTS.md](../AGENTS.md) | The entry point for any coding agent: reading order, commands, where things live, the non-negotiables | Hand-written, binding |
| [../CLAUDE.md](../CLAUDE.md) | Binding workflow rules: one checkout, `main` only, the owner's data folder is off-limits, when a release may run | Hand-written, binding |
| [../CHANGELOG.md](../CHANGELOG.md) | What shipped, per version, in Keep-a-Changelog format | Hand-written, append-only |
| [ARCHITECTURE.md](ARCHITECTURE.md) | Boot order, the two databases, the request lifecycle, the router plane, the IPC surface, the renderer's units, what proves what | Hand-written; keep it synchronized with the code |
| [CODE_MAP.md](CODE_MAP.md) | Generated index of every file under `src/`, `scripts/` and `test/`, with its purpose, top-level names, IPC channels and line landmarks | **Generated** — regenerate with `npm run repo:map` |
| [COOKBOOK.md](COOKBOOK.md) | Recipes for the changes that come up most often, each with the files to touch and the command that proves it | Hand-written |
| [AGENT_TASK_TEMPLATE.md](AGENT_TASK_TEMPLATE.md) | The task card used to delegate work without paying for discovery twice | Hand-written |
| [LOCAL_GATEWAY.md](LOCAL_GATEWAY.md) | The local multi-account gateway: the three routing profiles, the endpoint contract, the port setting, key tiers, what it does not prove | Hand-written |
| [integrations/](integrations/) | Per-provider reference material: endpoints, hooks, quotas, and the evidence level behind each claim | Hand-written — see [its README](integrations/README.md) for the evidence rules |

## Reading order

- **A person who wants to use the app:** [../README.md](../README.md), then
  [LOCAL_GATEWAY.md](LOCAL_GATEWAY.md) if you want to point an external client at
  the local endpoint.
- **An agent or developer who has to change something:**
  [../AGENTS.md](../AGENTS.md) → [../CLAUDE.md](../CLAUDE.md) →
  [ARCHITECTURE.md](ARCHITECTURE.md) → the relevant recipe in
  [COOKBOOK.md](COOKBOOK.md) → the generated [CODE_MAP.md](CODE_MAP.md) for the
  exact file and line.
- **Someone delegating work:** [AGENT_TASK_TEMPLATE.md](AGENT_TASK_TEMPLATE.md).

## What is deliberately not here

Designs, plans, research notes, handoffs and task reports for work that has
already shipped were removed from the repository. They described the state of
the code at one moment in the past; keeping them next to live documentation is
how a reader ends up trusting a stale number. The history they told is still
available:

- `git log --oneline` — what changed, and when.
- `git show <commit>:<path>` — the document as it was when that change landed.
- [../CHANGELOG.md](../CHANGELOG.md) — what shipped, per version.

New design notes belong in a pull request description or in the changelog,
not in a parallel set of files that nothing keeps in sync.