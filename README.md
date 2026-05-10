# hyperclaude

> Push Claude Code beyond stock. Skills, agents, Codex collab — opinionated and personal.

> 🚧 **Early development.** Currently in design phase. Layout, naming, and APIs will change.

## Why

A Claude Code plugin built around a deliberate division of labor between two AI coding agents:

- **Claude** implements — planning, coding, subagents, agent teams
- **Codex** reviews — pre-implementation research, plan critique (and later, code review)

Thesis: **Claude is the builder, Codex is the critic.** You get better software with a smarter cost split.

## Architecture (v0.1)

```
    ┌───────────────────────────────────────────────────────┐
    │                User in Claude Code                    │
    └───────────────────────┬───────────────────────────────┘
                            │
    ┌───────────────────────┼─────────────────────────┐
    │                       │                         │
┌───▼─────────────┐ ┌───────▼──────────────┐ ┌────────▼────────┐
│ /hyperclaude:   │ │ /hyperclaude:        │ │     Claude      │
│  hyper-research │ │  hyper-plan-review   │ │   impl arm      │
│      Codex      │ │       Codex          │ │                 │
└────────┬────────┘ └─────────┬────────────┘ │   agents/       │
         │                    │              │   skills/       │
         └──────────┬─────────┘              └─────────────────┘
                    │
        ┌───────────▼─────────────┐
        │   .hyperclaude/         │
        │     research/*.md       │
        │     plans/*.md          │
        │     reviews/*.md        │
        └─────────────────────────┘
```

Three layers:

1. **Slash commands** — `/hyperclaude:hyper-research`, `/hyperclaude:hyper-plan-review` (plugin-namespaced per Claude Code's contract)
2. **Skills** — gate behaviors (`hyper-research`, `hyper-plan-review`) + implementation discipline (`hyper-tdd`, `hyper-debug`)
3. **Agents** — Claude implementation arm (`planner`, `implementer`, `verifier`)

The earlier nudge / `UserPromptSubmit` hook layer is deferred to v0.2 — heuristic intent detection across English/Korean and cooldown state are non-trivial enough to wait for real gate-usage data.

Codex is always invoked under `--sandbox read-only`: its role in hyperclaude is *critic*, never *editor*.

External dependencies: Claude Code plugin runtime, `codex-cli >= 0.128.0`, Node 18+. Nothing else (no npm bin, no tmux, no MCP servers).

## Conventions

- **Plan files** — when Claude writes a plan that you intend to review, save it under `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`. `/hyperclaude:hyper-plan-review` auto-discovers the most recent file there. You can also pass an explicit path: `/hyperclaude:hyper-plan-review path/to/plan.md`.
- **Artifacts** — `.hyperclaude/{research,plans,reviews}/` is created in the consumer project. Add `.hyperclaude/` to your `.gitignore` if you don't want artifacts committed.
- **Slug** — lowercase kebab-case, ≤5 words, ASCII only. Same slug links a research → plan → review trio.

For the full design rationale, see [docs/specs/2026-05-10-v0.1-design.md](docs/specs/2026-05-10-v0.1-design.md).

## Status

Personal customization project, open-sourced. Not yet released. Use at your own risk.

## Acknowledgements

Structural inspiration from:

- [superpowers](https://github.com/obra/superpowers) by Jesse Vincent
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo

No code ported from either; references only.

## License

[MIT](LICENSE)
