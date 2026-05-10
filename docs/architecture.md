# Architecture

System layout for hyperclaude — a Claude Code plugin that pairs Claude (builder) with Codex (critic) through a thin bridge.

## Overview

hyperclaude wires three things together:

- **Skills** — instructions that Claude reads when it sees the matching trigger. Each skill is one `SKILL.md` under [skills/](../skills/).
- **Agents** — sub-Claude personas with restricted tool sets. Each is one `<name>.md` under [agents/](../agents/).
- **Bridge** — [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs), a Node 18+ stdlib script that shells out to `codex` and writes structured output under `.hyperclaude/`.

There is no daemon, no MCP server, no shared state. The bridge runs on demand; skills and agents are static markdown.

## Directory layout

```
hyperclaude/
├── .claude-plugin/
│   ├── plugin.json              plugin manifest (name, version, repo)
│   └── marketplace.json         marketplace listing (consumed by `/plugin marketplace add`)
├── skills/                      one directory per skill, each with SKILL.md
│   ├── hyper-research/          gate — Codex research
│   ├── hyper-plan-review/       gate — Codex plan critique
│   ├── hyper-code-review/       gate — Codex code review
│   ├── hyper-docs-sync/         gate — Claude doc sync orchestrator
│   ├── hyper-docs-review/       gate — Codex doc accuracy review
│   ├── hyper-implement/         helper — plan execution loop
│   ├── hyper-tdd/               helper — TDD discipline
│   └── hyper-debug/             helper — debugging discipline
├── agents/                      sub-Claude personas (planner, implementer, verifier, documenter)
├── scripts/
│   ├── codex-bridge.mjs         the only executable code in the plugin
│   └── test/smoke.sh            acceptance smoke checks
├── templates/codex/             prompt templates rendered into Codex stdin
│   ├── research.md
│   ├── review.md
│   └── docs-review.md
├── tests/                       node --test unit tests for the bridge
├── docs/                        this directory
├── README.md, LICENSE, .gitignore
```

Functional runtime surface stops at the directory above. Zero npm dependencies; Node 18+ stdlib only.

## Layers

```
       User in Claude Code
              │
              ▼
   ┌──────────────────────────────────┐
   │ Skills (gates + helpers)         │  ← /hyperclaude:hyper-* slash commands
   └──────────┬───────────────────────┘
              │ dispatches Agent / runs Bash / writes files
              ▼
   ┌──────────────────────────────────┐
   │ Agents (planner / implementer /  │  ← fresh sub-Claude per task,
   │   verifier / documenter)         │    restricted tool set
   └──────────┬───────────────────────┘
              │ skills (not agents) shell out
              ▼
   ┌──────────────────────────────────┐
   │ Bridge — scripts/codex-bridge.mjs│  ← Node 18+ stdlib script,
   └──────────┬───────────────────────┘    spawns `codex exec` / `codex review`
              │
              ▼
   ┌──────────────────────────────────┐
   │ Codex CLI (>= 0.128.0)           │  ← read-only sandbox or review subcommand
   └──────────────────────────────────┘
              │
              ▼
   .hyperclaude/{research,plans,reviews,code-reviews,docs-reviews}/
```

Direction:
- Skills call agents (via Claude's `Agent` tool) and call the bridge (via `Bash`). Agents do not call skills.
- Skills are the only layer that shells out to the bridge. Agents stay focused on their narrow job.
- The bridge is the only component that talks to `codex`. Skills never invoke `codex` directly.

## The bridge

One file: [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs). Four modes, exposed as positional subcommands:

| Mode          | Codex invocation                                  | Template                           | Output dir                       |
|---------------|---------------------------------------------------|------------------------------------|----------------------------------|
| `research`    | `codex exec --sandbox read-only -` (stdin prompt) | [templates/codex/research.md](../templates/codex/research.md)       | `.hyperclaude/research/`         |
| `review`      | `codex exec --sandbox read-only -` (stdin prompt) | [templates/codex/review.md](../templates/codex/review.md)         | `.hyperclaude/reviews/`          |
| `code-review` | `codex review [--base \| --uncommitted \| --commit]` | none — `codex review` owns its prompt | `.hyperclaude/code-reviews/`     |
| `docs-review` | `codex exec --sandbox read-only -` (stdin prompt) | [templates/codex/docs-review.md](../templates/codex/docs-review.md)    | `.hyperclaude/docs-reviews/`     |

### Sandbox policy

Every `codex exec` call passes `--sandbox read-only` — Codex cannot write to the workspace, so research / plan-review / docs-review are guaranteed non-mutating regardless of the user's `~/.codex/config.toml` defaults. `codex review` does not expose `--sandbox`; it is a review-only subcommand by design (does not author patches), and the bridge keeps its argv minimal (no `-c` overrides) to keep the contract auditable.

Net result: Codex is a *critic*, never an *editor*, in every mode.

### CLI surface

```
node scripts/codex-bridge.mjs <mode> [flags]
```

| Mode          | Required flags                                             | Optional flags                                                                       |
|---------------|------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `research`    | `--task <text>` OR `--task-file <path>`                    | `--slug`, `--out`, `--timeout`, `--dry-run`                                          |
| `review`      | `--plan-path <path>`                                       | `--slug`, `--out`, `--timeout`, `--dry-run`                                          |
| `code-review` | none — defaults to `--base main`                           | one of `--base <ref>`, `--uncommitted`, `--commit <sha>`; plus `--title`, `--out`, `--timeout`, `--dry-run` |
| `docs-review` | `--docs-path <file>` OR `--docs-dir <dir>`                 | `--diff-base <ref>`, `--out`, `--timeout`, `--dry-run`                               |

Defaults:

- `--timeout` 300s. Validated as a positive finite number.
- `--out` defaults to the mode-specific output directory listed in the table above (`.hyperclaude/research/`, `.hyperclaude/reviews/`, `.hyperclaude/code-reviews/`, `.hyperclaude/docs-reviews/`).
- `--slug` is auto-derived: from the task text (`research`), the plan filename's slug suffix (`review`), the base ref / commit short SHA / `uncommitted` (`code-review`), or the docs target's basename (`docs-review`). User-provided slugs must match `^[a-z0-9]+(?:-[a-z0-9]+){0,4}$`.
- `--dry-run` for `research` / `review` / `docs-review` validates the template loads but skips the codex spawn; `code-review` dry-run is a pure plan emission and does not require codex on PATH.

### Output contract

Every non-dry-run successful run writes a single markdown file with YAML frontmatter. (`--dry-run` skips the write and prints `{"ok":true,"dryRun":true,"mode":"…","slug":"…","outputPath":"…","timestamp":"…"}` instead.)

The frontmatter shape:

```yaml
---
mode: research | review | code-review | docs-review
slug: <kebab-case>
generated: <ISO-8601 timestamp>
codex-version: <semver from `codex --version`>
template-version: 1                    # research / review / docs-review
task: |-                               # research / review only — block scalar
  <task text or plan path>
codex-subcommand: review               # code-review only
git-head: "<sha>"                      # code-review only
base-ref / commit / title              # code-review (mode-dependent; uncommitted has none)
plan-path: "<path>"                    # review only
docs-target: "<path>"                  # docs-review
diff-base: "<ref>"                     # docs-review (when --diff-base passed)
---
```

Filename: `<YYYYMMDD-HHMM>-<slug>.md` (UTC). Per-mode slug fallbacks:

- `research` — when the task text is pure non-ASCII or otherwise yields no usable slug, the filename falls back to `<YYYYMMDD-HHMM>.md` (slug omitted entirely). Pass `--slug` to force a specific slug.
- `docs-review` — falls back to the literal `docs` if the docs target's basename can't be slugified, producing `<YYYYMMDD-HHMM>-docs.md`.
- `review` and `code-review` — always derive a slug (from the plan filename or the diff target), so the timestamp-only fallback does not apply.

On collision, the bridge appends `-2`, `-3`, … until free.

The script exits 0 and prints `{"ok":true,"path":"…","slug":"…"}` on success, or exits non-zero with `{"ok":false,"error":"…"}` on the explicitly handled failure modes: argv errors (exit 2), missing/unreadable input (task file, plan file, docs file/dir — exit 1), failed `git diff` for `--diff-base` (exit 1), template load failures (exit 1), Codex spawn / non-zero / timeout (exit 1), or oversized payloads (exit 1, with the relevant byte count). Filesystem failures during output (`mkdir`, `writeFile`) propagate as unhandled rejections and surface as a Node stack trace rather than the JSON shape — these paths are intentionally minimal because they only fire when the caller's `.hyperclaude/` directory is unwritable. Even on Codex failure the file is still written, with stderr captured under a `## stderr` heading — so the caller can read what went wrong without running the bridge again.

### Size guards

- `docs-review` rejects docs payloads `> 200KB` (`--docs-dir` aggregates all top-level `.md` files; recursion is deferred — see [decisions.md](decisions.md)).
- `docs-review --diff-base <ref>` runs `git diff <ref>...HEAD` (symmetric-difference, i.e. changes on HEAD since the merge-base with `<ref>`) and rejects diffs `> 500KB`.

These are bridge-level guards. The corresponding Codex context limits are larger; the lower numbers exist to fail fast before the spawn.

## Artifacts

Codex gates and Claude-authored plans write artifacts to `.hyperclaude/` in the *consumer* project (not in the plugin install dir). `hyper-docs-sync` is the exception — it edits documentation files directly and produces no `.hyperclaude/` artifact. The directory is created on first use; users who don't want artifacts committed should add `.hyperclaude/` to `.gitignore`.

```
.hyperclaude/
├── research/        Codex research outputs (research mode)
├── plans/           Claude-authored implementation plans (manual; the slug feeds review/)
├── reviews/         Codex critiques of plans (review mode)
├── code-reviews/    Codex code-review outputs (code-review mode)
└── docs-reviews/    Codex docs accuracy outputs (docs-review mode)
```

Naming is consistent across all subdirs: `<YYYYMMDD-HHMM>-<slug>.md`. The slug is the trace key — a `research` slug carries through to the `plan` written by Claude, then into the `review` of that plan. The bridge's `extractSlugFromPlanFilename()` reuses the slug from a plan filename when invoking `review`, so the trio shares a slug end-to-end.

For the per-artifact frontmatter shapes, see "Output contract" above.

## External dependencies

- **Claude Code plugin runtime** — distribution channel, slash command resolution, agent dispatch.
- **`codex-cli >= 0.128.0`** — version-checked via `codex --version` before spawning Codex on non-dry-run calls. Argv parsing always runs first; subsequent ordering is mode-specific. `docs-review` reads the docs payload and runs the 200KB guard before the version check; `--diff-base` diff capture and its 500KB guard happen after the version check. `review` reads the plan file after the version check, so a missing plan path surfaces *after* the version-check error if both are wrong simultaneously. Older Codex versions fail fast with an upgrade hint.
- **Node 18+** — bridge uses `node:fs/promises`, `node:fs` (`existsSync`), `node:child_process`, `node:path`, `node:url`. No npm packages.
- **`git`** — required for diff-backed gates: `code-review` (always), `docs-review` (when `--diff-base` is passed), and `hyper-docs-sync` (always — the skill uses git diff to determine what changed).

No other runtime dependencies. No MCP server, no tmux, no daemons, no npm bin.

## See also

- [gates-and-agents.md](gates-and-agents.md) — what each skill and agent does, when to use them.
- [workflow.md](workflow.md) — the end-to-end dogfooding cycle.
- [development.md](development.md) — local dev install, tests, release flow.
- [decisions.md](decisions.md) — non-obvious "why" notes and active deferrals.
