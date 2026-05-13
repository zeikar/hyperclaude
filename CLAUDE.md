# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

hyperclaude is a Claude Code plugin that pairs Claude (builder) with Codex (critic) via a thin Node script. **Claude implements, Codex reviews** — that role split is the design invariant. Codex is always invoked with read-only sandbox; never let it author patches.

The plugin is meant to be installed into Claude Code (`/plugin install hyperclaude`); when you're editing this repo, you're editing the plugin source itself.

## Commands

```bash
node --test tests/codex-bridge.test.mjs tests/codex-bridge-spawn.test.mjs tests/codex-bridge-jsonl.test.mjs
                                          # unit tests (~232 cases). NOTE: `node --test tests/*.mjs`
                                          # works too; `node --test tests/` (dir form) does NOT — it
                                          # interprets the path as a test name and fails.
node --test tests/codex-bridge.test.mjs --test-name-pattern "<regex>"
                                          # single test by name
bash scripts/test/smoke.sh                # acceptance smoke: dry-runs, manifest, hook, codex probes
node scripts/codex-bridge.mjs <mode> --dry-run [flags]
                                          # exercise the bridge without spawning codex
```

Both test commands must pass before tagging a release. Zero npm dependencies — do not introduce any.

## The bridge

`scripts/codex-bridge.mjs` is the **only executable code** in the plugin. It's a CLI entry that owns mode dispatch; leaf modules in `scripts/codex/` (`args`, `paths`, `resume`, `templates`, `frontmatter`, `slug`, `git`, `codex`, `failure`) are pure-ish helpers re-exported from the entry file for test access.

Four modes, exposed as positional subcommands. The mode name maps 1:1 to the artifact directory under `.hyperclaude/`:

| Bridge subcommand | Output dir                   | Codex invocation                                   |
|-------------------|------------------------------|----------------------------------------------------|
| `research`        | `.hyperclaude/research/`     | `codex exec --sandbox read-only -` (stdin prompt)  |
| `plan-review`     | `.hyperclaude/plan-reviews/` | `codex exec --sandbox read-only -` (stdin prompt)  |
| `code-review`     | `.hyperclaude/code-reviews/` | `codex exec review -c sandbox_mode=read-only ...`  |
| `docs-review`     | `.hyperclaude/docs-reviews/` | `codex exec --sandbox read-only -` (stdin prompt)  |

**Naming trap:** the `review` string appears in two unrelated places. Inside the bridge, `args.mode === 'plan-review'` is the bridge's *plan-review* mode. The `'review'` token in `scripts/codex/codex.mjs:167` and `scripts/codex-bridge.mjs:394` (`['exec', 'review', ...]`) is Codex CLI's **native `exec review` subcommand** used internally by `code-review` mode. Don't conflate them when renaming.

## Sandbox invariant

Every Codex spawn must be read-only:

- Fresh `codex exec` (`research` / `plan-review` / `docs-review`) → `--sandbox read-only` flag.
- `codex exec resume` (any mode with `--resume`) → `-c sandbox_mode=read-only` config override (resume doesn't inherit the original session's sandbox; this was empirically verified).
- `codex exec review` (`code-review`) → `-c sandbox_mode=read-only` config override (the subcommand doesn't accept `--sandbox`).

If you add a new spawn path, re-check both argv shapes. New flags must be added to `ALLOWED_FLAGS_PER_MODE` in `scripts/codex/args.mjs`; the parser rejects unknown flags per mode and tests cover this.

## Layers

- **Skills** (`skills/<name>/SKILL.md`) — what Claude reads on the matching trigger. Each skill is one markdown file with YAML frontmatter (`name`, `description`). Skills call the bridge via `Bash` and dispatch agents via the `Agent` tool.
- **Agents** (`agents/<name>.md`) — sub-Claude personas with restricted `tools:` lists. Used by skills, never the other way around.
- **Hooks** (`hooks/*.mjs`, registered in `hooks/hooks.json`) — currently one: SessionStart reminder that injects `templates/hooks/session-start-reminder.md` plus an optional `.hyperclaude/` snapshot footer.
- **Templates** (`templates/codex/*.md`, `templates/hooks/*.md`) — prompt bodies loaded at runtime with `{{UPPERCASE_KEY}}` substitution.

`code-review` has no template — `codex exec review` owns its own prompt. The other three modes use templates and bump `template-version` when changing them.

**Template-version pitfall:** when changing any `templates/codex/*.md`, bump `template-version` in **two** lock-step locations in `scripts/codex-bridge.mjs`: the `templateVersion: 1` argument passed to `renderFrontmatter()`, AND the hardcoded `template-version: 1` line in `renderDocsReviewFrontmatter()`.

## Code | Docs mapping (for hyper-docs-sync)

| Code | Docs |
|------|------|
| `scripts/codex-bridge.mjs`, `scripts/codex/*.mjs` | `docs/architecture.md`, `docs/decisions.md` |
| `skills/<any>/SKILL.md` | `docs/gates-and-agents.md`, `docs/workflow.md` |
| `agents/<any>.md` | `docs/gates-and-agents.md` |
| `hooks/*.mjs`, `templates/hooks/*.md` | `docs/architecture.md` (SessionStart hook section) |
| `templates/codex/*.md` | `docs/architecture.md`, `docs/development.md` (template-version section) |
| `scripts/test/smoke.sh`, `tests/*.mjs` | `docs/development.md` |
| `.claude-plugin/plugin.json` | `README.md`, `docs/development.md` (release flow) |

Behavioral surface changes (CLI flags, frontmatter keys, output paths, mode names) should also propagate to `README.md` and `docs/workflow.md` if the change is user-visible.

## Artifacts and slug convention

`.hyperclaude/` (gitignored by consumer convention) holds per-run artifacts. Naming: `<YYYYMMDD-HHMM>-<slug>.md` (UTC). The slug propagates as the trace key — `research → plan → plan-review` share one slug end-to-end (extracted from the plan filename). `code-review` slug comes from the diff target (`vs-main`, `uncommitted`, `commit-<sha7>`); `docs-review` slug from the docs target basename. These are release-level, not feature-level — don't try to align them with the research/plan trio.

Plan files (Claude-authored) live in `.hyperclaude/plans/` and are the input to `plan-review`. Never write `<file>-v2.md` siblings when revising a plan — `--resume` keys on the plan path, so a new path breaks resume continuity.

## Release flow

1. Tests green: `node --test tests/codex-bridge*.test.mjs` and `bash scripts/test/smoke.sh`.
2. Bump `version` in `.claude-plugin/plugin.json` (pre-1.0: minor bump for breaking changes — bridge subcommand renames, frontmatter key changes, artifact directory renames all count).
3. Commit. Push.
4. `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line>"` then `git push origin vX.Y.Z`.
5. GitHub release via `gh release create vX.Y.Z` (include migration notes when breaking).

Tagging and releasing are user-initiated; skills never push or tag themselves.

## See also

- [docs/architecture.md](docs/architecture.md) — bridge details, mode table, output contract.
- [docs/gates-and-agents.md](docs/gates-and-agents.md) — per-skill / per-agent mechanics.
- [docs/workflow.md](docs/workflow.md) — research → ship cycle, skip rules, `--resume` semantics.
- [docs/decisions.md](docs/decisions.md) — non-obvious "why" notes and active deferrals.
- [docs/development.md](docs/development.md) — local install, tests, full release checklist.
