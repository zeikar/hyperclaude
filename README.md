# hyperclaude

> Push Claude Code beyond stock. Skills, agents, Codex collab — opinionated and personal.

> 🚧 **Early development.** Currently in design phase. Layout, naming, and APIs will change.

## Why

A Claude Code plugin built around a deliberate division of labor between two AI coding agents:

- **Claude** implements — planning, coding, subagents, agent teams
- **Codex** reviews — pre-implementation research, plan critique, code review

Thesis: **Claude is the builder, Codex is the critic.** You get better software with a smarter cost split.

## Architecture (v0.2)

```
    ┌────────────────────────────────────────────────────────────────────┐
    │                      User in Claude Code                           │
    └──────────────────────────────┬─────────────────────────────────────┘
                                   │
    ┌──────────────────────────────┼──────────────────────────────────┐
    │                              │                                  │
┌───▼─────────────┐ ┌──────────────▼──────────┐ ┌────────────────────▼──────┐ ┌────────▼────────┐
│ /hyperclaude:    │ │ /hyperclaude:            │ │ /hyperclaude:             │ │     Claude      │
│   hyper-research │ │   hyper-plan-review      │ │   hyper-code-review       │ │   impl arm      │
│       Codex      │ │       Codex              │ │       Codex               │ │                 │
└────────┬─────────┘ └──────────────┬──────────┘ └────────────────────┬──────┘ │   agents/       │
         │                          │                                  │        │   skills/       │
         └───────────────┬──────────┴──────────────────────────────────┘        └─────────────────┘
                         │
         ┌───────────────▼─────────────┐
         │   .hyperclaude/             │
         │     research/*.md           │
         │     plans/*.md              │
         │     reviews/*.md            │
         │     code-reviews/*.md       │
         └─────────────────────────────┘
```

Three layers:

1. **Slash commands** — `/hyperclaude:hyper-research`, `/hyperclaude:hyper-plan-review`, `/hyperclaude:hyper-code-review` (plugin-namespaced per Claude Code's contract)
2. **Skills** — gate behaviors (`hyper-research`, `hyper-plan-review`, `hyper-code-review`) + implementation discipline (`hyper-tdd`, `hyper-debug`) + plan execution (`hyper-implement`)
3. **Agents** — Claude implementation arm (`planner`, `implementer`, `verifier`)

The earlier nudge / `UserPromptSubmit` hook layer is deferred to a future release.

When hyperclaude invokes `codex exec` (research, plan-review), it always passes `--sandbox read-only`. When it invokes `codex review` (code review), it relies on the subcommand's review-only design — `codex review` analyzes diffs and does not author patches; the bridge keeps the argv minimal and auditable (no `-c` overrides). In both cases, Codex's role in hyperclaude is *critic*, never *editor*.

External dependencies: Claude Code plugin runtime, `codex-cli >= 0.128.0`, Node 18+. Nothing else (no npm bin, no tmux, no MCP servers).

## Conventions

- **Plan files** — when Claude writes a plan that you intend to review, save it under `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`. `/hyperclaude:hyper-plan-review` auto-discovers the most recent file there. You can also pass an explicit path: `/hyperclaude:hyper-plan-review path/to/plan.md`.
- **Artifacts** — `.hyperclaude/{research,plans,reviews}/` is created in the consumer project. Add `.hyperclaude/` to your `.gitignore` if you don't want artifacts committed.
- **Slug** — lowercase kebab-case, ≤5 words, ASCII only. Same slug links a research → plan → review trio.

For the full design rationale, see [docs/specs/2026-05-10-v0.1-design.md](docs/specs/2026-05-10-v0.1-design.md).

## Quick start

1. Install the plugin via Claude Code:

   ```bash
   /plugin marketplace add https://github.com/zeikar/hyperclaude
   /plugin install hyperclaude
   ```

2. Make sure `codex-cli >= 0.128.0` is on your PATH:

   ```bash
   codex --version
   ```

3. In a Claude Code session inside any project, try a gate:

   ```text
   /hyperclaude:hyper-research add OAuth login to the API
   ```

   The first invocation creates `.hyperclaude/research/<timestamp>-add-oauth-login-to-the.md` with Codex's prior-art / pitfalls / recommendations. Read it; plan accordingly.

4. After Claude writes a plan to `.hyperclaude/plans/<slug>.md`, critique it:

   ```text
   /hyperclaude:hyper-plan-review
   ```

5. After implementing, review the code changes:

   ```text
   /hyperclaude:hyper-code-review
   ```

   - Default: reviews the current branch vs `main`.
   - For working-tree changes (staged + unstaged + untracked): `/hyperclaude:hyper-code-review uncommitted`
   - For a specific commit: `/hyperclaude:hyper-code-review <commit-sha>`

## Development

```bash
node --test tests/*.mjs            # unit tests for the bridge
bash scripts/test/smoke.sh         # acceptance smoke checks
```

Zero npm dependencies. Node 18+ stdlib only.

## Status

**v0.2 (alpha).** Personal customization project, open-sourced. Use at your own risk; expect breaking changes between minor versions until v1.0.

## Acknowledgements

Structural inspiration from:

- [superpowers](https://github.com/obra/superpowers) by Jesse Vincent
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo

No code ported from either; references only.

## License

[MIT](LICENSE)
