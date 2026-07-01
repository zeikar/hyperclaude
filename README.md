# HyperClaude

> Push Claude Code beyond stock. Claude builds, Codex critiques.
> A gated research → plan → review → ship pipeline, with autonomous multi-agent revise loops that self-converge.

![Claude builds, Codex critiques](assets/hero.jpg)

## Why

A Claude Code plugin built around a deliberate division of labor between two AI coding agents:

- **Claude** implements — planning, coding, subagents, agent teams
- **Codex** reviews — plan critique, code review, documentation accuracy review

Thesis: **Claude is the builder, Codex is the critic.** Better software with a smarter cost split.

## The cycle

```
            ┌─ refine ─┐            ┌──── fix ───┐            ┌──── fix ───┐
            ▼          │            ▼            │            ▼            │
research → plan → plan-review → implement → code-review → docs-sync → docs-review → ship
   │         │         │            │            │            │            │           │
Codex+Claude  Claude   Codex   Claude(+agents)  Codex      Claude       Codex        user
```

When the *idea itself* is vague (not just un-planned), an optional `hyper-interview` front-end clarifies it into a spec before `research` / `plan` — a short one-question-at-a-time interview, Claude-only (no Codex; clarity is its job, review happens downstream). The `refine` / `fix` arcs are what `hyper-plan-loop`, `hyper-implement-loop`, and `hyper-docs-loop` automate — a Claude-side teammate (`planner` / `fixer` / `documenter`) revises while Codex stays the reviewer, looping until no blocking findings remain. Gates write trace artifacts under `.hyperclaude/` (gitignore-friendly); `hyper-docs-sync`, `hyper-docs-loop`, and `hyper-implement` edit the working tree directly. Skip any step a small change doesn't need — only `code-review` is non-negotiable for behavioral changes. See [docs/workflow.md](docs/workflow.md) for triggers, skip rules, slug/artifact conventions, and `--resume`.

## Full automation: `hyper-auto`

One gesture, end-to-end:

```text
/hyperclaude:hyper-auto add OAuth login to the API
```

`hyper-auto` chains `hyper-plan-loop → hyper-implement-loop`. Claude plans, Codex critiques the plan until no blockers remain, Claude implements, Codex code-reviews until no blocking findings remain (style/nits are reported, never gating) — all hands-off. It's not a new layer, just composition over the two loops, so the same gates and artifacts apply. Requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (inherited from the underlying loops).

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
   .hyperclaude/{specs,research,plans,epics,
                 plan-reviews,code-reviews,docs-reviews}/

Hooks — SessionStart reminder, fires independently
```

Four layers — **Commands** (explicit slash entry points), **Skills** (description-triggered gates, orchestrators, autonomous loops, and `hyper-auto`), **Agents** (Claude implementation arm), **Hooks** (SessionStart reminder). Every Codex spawn — fresh or `--resume`, with live web search enabled — runs in a read-only sandbox; Codex is critic, never editor. The bridge accepts two optional model-selection flags on all four modes: `--model <name>` (any non-empty model identifier, e.g. `openai/gpt-5`) and `--effort <low|medium|high|xhigh>` (reasoning effort; `none` and `minimal` are rejected); both default to null, inheriting `~/.codex/config.toml`. `code-review` additionally accepts `--background "<text>"`: a short, strictly descriptive change context (what the change is / what it touches / author intent) passed to the Codex critic to orient the review; it does not alter the review rubric. `--background` is optional and a no-op when omitted; it is mutually exclusive with `--resume` (resumed sessions already carry context in the Codex thread). The `hyper-code-review` skill composes and passes a background automatically; direct CLI callers may pass it explicitly. These are bridge-level flags; v1 is not exposed via slash commands. See [docs/architecture.md](docs/architecture.md) for layer details, bridge internals, and the sandbox flag matrix.

External dependencies: Claude Code plugin runtime, `codex-cli >= 0.130.0` with the global `--search` flag, Node 18+, and `git`. Nothing else (no npm bin, no tmux, no MCP servers).

## Quick start

1. Install:

   ```bash
   /plugin marketplace add zeikar/hyperclaude
   /plugin install hyperclaude
   ```

2. Verify prerequisites:

   ```text
   /hyperclaude:hyper-setup
   ```

   Checks Node, codex-cli, `codex --search`, git, and (optionally) `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` (needed by the loops and `hyper-auto`). Report-only; nothing is installed automatically.

3. Run the cycle. Invoke gates explicitly, or chain them with the loops:

   ```text
   /hyperclaude:hyper-research add OAuth login to the API   # Codex+Claude prior-art / pitfalls
   /hyperclaude:hyper-plan                                  # Claude writes .hyperclaude/plans/<slug>.md
   /hyperclaude:hyper-plan-review                            # Codex critiques the plan
   /hyperclaude:hyper-implement                             # Claude executes the plan task-by-task
   /hyperclaude:hyper-code-review                            # Codex reviews the diff (branch vs main)
   /hyperclaude:hyper-docs-sync uncommitted                  # Claude updates docs for the change
   /hyperclaude:hyper-docs-review                            # Codex accuracy gate on docs

   # Or let the loops self-converge:
   /hyperclaude:hyper-plan-loop add OAuth login to the API   # plan → review → revise, looped
   /hyperclaude:hyper-implement-loop <plan path>             # implement → code-review → fix, looped
   /hyperclaude:hyper-docs-loop                              # docs → review → fix, looped (default: docs/)
   /hyperclaude:hyper-auto add OAuth login to the API        # plan-loop → implement-loop, end-to-end

   # On-demand, outside the cycle:
   /hyperclaude:hyper-memory                                 # mine .hyperclaude/ artifacts for repo-local knowledge candidates
   ```

## Documentation

- [docs/architecture.md](docs/architecture.md) — layers, bridge details, plugin layout, output contract.
- [docs/gates-and-agents.md](docs/gates-and-agents.md) — what each skill and agent does, when to invoke.
- [docs/workflow.md](docs/workflow.md) — the research → ship cycle, slug/artifact conventions, skip rules, `--resume`.
- [docs/development.md](docs/development.md) — local install, tests, release flow.
- [docs/decisions.md](docs/decisions.md) — non-obvious "why" notes and active deferrals.

## Development

```bash
node --test tests/*.mjs            # unit tests for the bridge and setup-doctor
bash scripts/test/smoke.sh         # acceptance smoke checks
```

Zero npm dependencies. Node 18+ stdlib only.

## Acknowledgements

Structural inspiration from:

- [superpowers](https://github.com/obra/superpowers) by Jesse Vincent
- [oh-my-claudecode](https://github.com/Yeachan-Heo/oh-my-claudecode) by Yeachan Heo

No code ported from either; references only.

## License

[MIT](LICENSE)
