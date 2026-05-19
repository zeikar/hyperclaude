# HyperClaude

> Push Claude Code beyond stock. Claude builds, Codex critiques.
> A gated research → plan → review → ship pipeline, with autonomous multi-agent revise loops that self-converge.

> 🚧 **Early alpha.** v0.14 is implemented and dogfooded daily. Layout, naming, and APIs may change between minor versions until v1.0.

![Claude builds, Codex critiques](assets/hero.jpg)

## Why

A Claude Code plugin built around a deliberate division of labor between two AI coding agents:

- **Claude** implements — planning, coding, subagents, agent teams
- **Codex** reviews — pre-implementation research, plan critique, code review, documentation accuracy review

Thesis: **Claude is the builder, Codex is the critic.** You get better software with a smarter cost split.

## The cycle

```
            ┌─ refine ─┐            ┌──── fix ───┐            ┌──── fix ───┐
            ▼          │            ▼            │            ▼            │
research → plan → plan-review → implement → code-review → docs-sync → docs-review → ship
   │         │         │            │            │            │            │           │
Codex+Claude  Claude   Codex   Claude(+agents)  Codex      Claude       Codex        user
```

The `refine` / `fix` arcs are exactly what `hyper-plan-loop` and `hyper-implement-loop` automate — a Claude-side teammate (`planner` / `fixer`) revises while Codex stays the reviewer, looping until it converges.

Most gates write trace artifacts under `.hyperclaude/` (research's parallel default writes a Codex + Claude pair sharing one slug). `hyper-docs-sync` edits docs directly, and `hyper-implement` changes the working tree while updating the plan checklist. Skip any step a small change doesn't need — only `code-review` is non-negotiable for behavioral changes. See [docs/workflow.md](docs/workflow.md) for triggers, skip rules, and `--resume`.

## Architecture

```
            User in Claude Code
                    │
   ┌────────────────┼───────────────┐
   │                │               │
Commands          Skills ────────► Agents
hyper-setup   gates + orchestr.   planner / implementer
(no spawn)          │             verifier / documenter
                    ▼             researcher / fixer
              codex-bridge.mjs
          (only Codex-spawning code;
           always read-only sandbox)
                    │
                    ▼
   .hyperclaude/{research,plans,plan-reviews,
                 code-reviews,docs-reviews}/

Hooks — SessionStart reminder, fires independently
```

Four layers:

1. **Commands** (`commands/`) — explicitly-invoked slash commands, distinct from description-triggered skills. Auto-discovered; no manifest entry. Currently one: `hyper-setup` (`/hyperclaude:hyper-setup`) — a local prerequisite doctor that never spawns Codex or agents.
2. **Skills** (`skills/`) — Codex gates (`hyper-research`, `hyper-plan-review`, `hyper-code-review`, `hyper-docs-review`) + Claude orchestrators (`hyper-plan`, `hyper-docs-sync`) + autonomous loops (`hyper-plan-loop`, `hyper-implement-loop`) + plan execution (`hyper-implement`) + implementation discipline (`hyper-tdd`, `hyper-debug`). All surface via Claude Code's description-triggered dispatch.
3. **Agents** (`agents/`) — Claude implementation arm (`planner`, `implementer`, `verifier`, `documenter`, `researcher`, `fixer`).
4. **Hooks** (`hooks/`) — SessionStart reminder (workflow router + `.hyperclaude/` snapshot footer).

When hyperclaude invokes a fresh `codex exec` (research, plan-review, docs-review, **and code review**), it always passes `--sandbox read-only`. Code review is a regular `codex exec --sandbox read-only -` spawn with a code-review prompt template — Codex runs the target git commands itself to collect the diff but cannot write the workspace. When it invokes `codex exec resume` (`--resume` for plan-review / code-review / docs-review), the resume subcommand does not expose `--sandbox`, so the bridge passes `-c sandbox_mode=read-only` as a config override instead. In every mode, Codex's role in hyperclaude is *critic*, never *editor*. Every Codex invocation (all modes, fresh and resume) also runs with live web search enabled (`codex --search …`), so Codex may fetch external content while it reviews your code or docs — this does NOT relax the read-only sandbox.

External dependencies: Claude Code plugin runtime, `codex-cli >= 0.130.0` with the global `--search` flag, Node 18+, and `git` (for diff-backed gates: code-review, docs-sync, docs-review with `--diff-base`). Nothing else (no npm bin, no tmux, no MCP servers).

## Conventions

- **Plan files** — when Claude writes a plan that you intend to review, save it under `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`. `/hyperclaude:hyper-plan-review` auto-discovers the most recent file there. You can also pass an explicit path: `/hyperclaude:hyper-plan-review path/to/plan.md`.
- **Artifacts** — `.hyperclaude/{research,plans,plan-reviews,code-reviews,docs-reviews}/` is created in the consumer project. Add `.hyperclaude/` to your `.gitignore` if you don't want artifacts committed.
- **Slug** — lowercase kebab-case, ≤5 words, ASCII only. Same slug links a research → plan → plan-review trio.

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, bridge details, plugin layout, output contract.
- [docs/gates-and-agents.md](docs/gates-and-agents.md) — what each skill and agent does, when to invoke.
- [docs/workflow.md](docs/workflow.md) — the end-to-end research → ship cycle this plugin is built around.
- [docs/development.md](docs/development.md) — local install, tests, release flow.
- [docs/decisions.md](docs/decisions.md) — non-obvious "why" notes and active deferrals (UserPromptSubmit hook, recursive docs-dir, etc.).

Per-feature plans for later versions live in `.hyperclaude/plans/` (gitignored — working artifacts, lifted into the docs above when load-bearing).

## Quick start

1. Install the plugin via Claude Code:

   ```bash
   /plugin marketplace add zeikar/hyperclaude
   /plugin install hyperclaude
   ```

2. Verify prerequisites with the built-in doctor command:

   ```text
   /hyperclaude:hyper-setup
   ```

   This checks Node 18+, codex-cli >= 0.130.0, the `codex --search` global flag, git, and (optionally) the `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var needed by `hyper-plan-loop` and `hyper-implement-loop`. Report-only; nothing is installed automatically.

3. Run the cycle inside any project. Invoke the gates explicitly; Claude's planning and implementation happen between them:

   ```text
   /hyperclaude:hyper-research add OAuth login to the API   # Codex+Claude prior-art / pitfalls
   /hyperclaude:hyper-plan                                  # Claude writes .hyperclaude/plans/<slug>.md
   /hyperclaude:hyper-plan-review                            # Codex critiques the plan
   /hyperclaude:hyper-implement                             # Claude executes the plan task-by-task
   /hyperclaude:hyper-code-review                            # Codex reviews the diff (branch vs main)
   /hyperclaude:hyper-docs-sync uncommitted                  # Claude updates docs for the change
   /hyperclaude:hyper-docs-review                            # Codex accuracy gate on docs

   # Or let the autonomous loops self-converge in one gesture:
   /hyperclaude:hyper-plan-loop add OAuth login to the API   # plan → Codex review → revise, looped
   /hyperclaude:hyper-implement-loop <plan path>             # implement → Codex code-review → fix, looped
   ```

   Skip any step a small change doesn't need — only `code-review` is non-negotiable for behavioral changes. Per-step targets (`uncommitted`, `<commit-sha>`, a docs subdir), `--resume` for token-cheap re-runs, and the autonomous `hyper-plan-loop` (plan → review → revise in one gesture) are all covered in [docs/workflow.md](docs/workflow.md).

## Development

```bash
node --test tests/*.mjs            # unit tests for the bridge and setup-doctor
bash scripts/test/smoke.sh         # acceptance smoke checks
```

Zero npm dependencies. Node 18+ stdlib only.

## Status

**Alpha.** Use at your own risk; expect breaking changes between minor versions until v1.0.

## Acknowledgements

Structural inspiration from:

- [superpowers](https://github.com/obra/superpowers) by Jesse Vincent
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo

No code ported from either; references only.

## License

[MIT](LICENSE)
