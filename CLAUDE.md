# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

hyperclaude is a Claude Code plugin that pairs Claude (builder) with Codex (critic) via a thin Node script. **Claude implements, Codex reviews** — that role split is the design invariant. Codex is always invoked with read-only sandbox; never let it author patches.

The plugin is meant to be installed into Claude Code (`/plugin install hyperclaude`); when you're editing this repo, you're editing the plugin source itself.

## Commands

Prerequisites: Node 18+, `codex-cli >= 0.130.0` on PATH, `git`. No `npm install` step — stdlib only.

```bash
node --test tests/codex-bridge.test.mjs tests/codex-bridge-spawn.test.mjs tests/codex-bridge-jsonl.test.mjs tests/setup-doctor.test.mjs
                                          # unit tests. NOTE: `node --test tests/*.mjs`
                                          # works too; `node --test tests/` (dir form) does NOT — it
                                          # interprets the path as a test name and fails.
node --test tests/codex-bridge.test.mjs --test-name-pattern "<regex>"
                                          # single test by name
bash scripts/test/smoke.sh                # acceptance smoke: dry-runs, manifest, hook, codex probes
node scripts/codex-bridge.mjs <mode> --dry-run [flags]
                                          # exercise the bridge without spawning codex
```

Both test commands must pass before tagging a release. Zero npm dependencies — do not introduce any.

## Local dev install (dogfooding)

To exercise skill/agent edits live inside Claude Code, symlink the repo into the plugin cache. Use the version from `.claude-plugin/plugin.json` as the leaf:

```bash
version=$(node -e 'console.log(require("./.claude-plugin/plugin.json").version)')
ln -s "$(pwd)" ~/.claude/plugins/cache/hyperclaude/hyperclaude/"$version"
```

Restart Claude Code (or `/plugin reload` if available) to pick up edits.

## The bridge

`scripts/codex-bridge.mjs` is the only Codex-spawning code in the plugin. Hook scripts under `hooks/` are also executable but pure orchestration — they never spawn codex. The bridge is a CLI entry that owns mode dispatch; leaf modules in `scripts/codex/` (`args`, `paths`, `resume`, `templates`, `frontmatter`, `slug`, `git`, `codex`, `failure`) are pure-ish helpers re-exported from the entry file for test access.

Four modes, exposed as positional subcommands. The mode name maps 1:1 to the artifact directory under `.hyperclaude/`:

| Bridge subcommand | Output dir                   | Codex invocation                                   |
|-------------------|------------------------------|----------------------------------------------------|
| `research`        | `.hyperclaude/research/`     | `codex exec --sandbox read-only -` (stdin prompt)  |
| `plan-review`     | `.hyperclaude/plan-reviews/` | `codex exec --sandbox read-only -` (stdin prompt)  |
| `code-review`     | `.hyperclaude/code-reviews/` | `codex exec --sandbox read-only -` (stdin prompt)  |
| `docs-review`     | `.hyperclaude/docs-reviews/` | `codex exec --sandbox read-only -` (stdin prompt)  |

`--resume` is supported by `plan-review`, `docs-review`, and `code-review` — not `research` (deferred; would re-upload context resume is meant to avoid).

**Naming note:** the bridge's `code-review` mode (`args.mode === 'code-review'`) is unrelated to the bridge's `plan-review` mode (`args.mode === 'plan-review'`). The native `codex exec review` subcommand is **no longer used** — fresh `code-review` is a plain `codex exec --sandbox read-only -` spawn with the `templates/codex/code-review.md` prompt, identical in shape to the other fresh modes. (Historical context: `code-review` used the native `exec review` subcommand from v0.4 until the 2026-05-18 reversal to a custom prompt — see `docs/decisions.md`.)

## Sandbox invariant

Every Codex spawn must be read-only:

- Fresh `codex exec` (`research` / `plan-review` / `docs-review` / `code-review`) → `--sandbox read-only` flag. Fresh `code-review` is a regular `codex exec --sandbox read-only -` spawn (NOT the native `exec review` subcommand); the read-only sandbox still lets Codex run the target git commands the prompt instructs it to.
- `codex exec resume` (any mode with `--resume`) → `-c sandbox_mode=read-only` config override (resume doesn't inherit the original session's sandbox; this was empirically verified).

If you add a new spawn path, re-check both argv shapes. New flags must be added to `ALLOWED_FLAGS_PER_MODE` in `scripts/codex/args.mjs`; the parser rejects unknown flags per mode and tests cover this.

## Layers

- **Commands** (`commands/<name>.md`) — explicitly-invoked slash commands (`/hyperclaude:<name>`), distinct from description-triggered Skills. Auto-discovered by Claude Code; no manifest entry required. The only command is `hyper-setup`: a local prerequisite probe that never spawns Codex or agents — it runs `scripts/setup-doctor.mjs` and reports the result.
- **Skills** (`skills/<name>/SKILL.md`) — what Claude reads on the matching trigger. Each skill is one markdown file with YAML frontmatter (`name`, `description`). Skills call the bridge via `Bash` and dispatch agents via the `Agent` tool. A skill MAY also spawn an agent as a persistent team teammate for stateful multi-turn loops (currently only `hyper-plan-loop`); this uses Claude Code's experimental agent-teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
- **Agents** (`agents/<name>.md`) — sub-Claude personas with restricted `tools:` lists. Used by skills, never the other way around.
- **Hooks** (`hooks/*.mjs`, registered in `hooks/hooks.json`) — currently one: SessionStart reminder that injects `templates/hooks/session-start-reminder.md` plus an optional `.hyperclaude/` snapshot footer.
- **Templates** (`templates/codex/*.md`, `templates/hooks/*.md`) — prompt bodies loaded at runtime with `{{UPPERCASE_KEY}}` substitution.
- **Shared protocol references** (`references/loop-protocol.md`) — plugin-wide reference content loaded by skills' Step 0 alongside their loop-specific `failure-protocol.md`. Currently used by `hyper-plan-loop` and `hyper-implement-loop`; the shared base is the eventual binding target for a future `hyper-docs-loop` as well.

All four modes use a fresh prompt template (`code-review` uses `templates/codex/code-review.md`) and bump `template-version` when changing them; the resumed variants (`*-resumed.md`) are unversioned in frontmatter.

**Template-version pitfall:** when changing a `templates/codex/*.md` prompt, bump `template-version` in lock-step. Research and plan-review share the same call site (`renderFrontmatter()` in `scripts/codex-bridge.mjs`) but their versions are split per-mode — the live shape is `templateVersion: args.mode === 'plan-review' ? 2 : 1`. Bump the branch for whichever mode's template you changed; don't sweep both together unless both prompts actually changed. Docs-review has its own hardcoded `template-version: 1` line in `renderDocsReviewFrontmatter()`. For `code-review` there are **three** lock-step points: the prompt body `templates/codex/code-review.md`, the hardcoded `template-version: 1` in `renderCodeReviewFrontmatter()`, and the `CODE_REVIEW_TEMPLATE_VERSION` constant in `scripts/codex/resume.mjs` (the code-review resume gate that rejects legacy native artifacts).

## Code | Docs mapping (for hyper-docs-sync)

| Code | Docs |
|------|------|
| `commands/*.md` | `docs/gates-and-agents.md`, `docs/workflow.md`, `README.md` |
| `scripts/setup-doctor.mjs` | `docs/architecture.md`, `docs/development.md` (non-bridge probe; never spawns Codex) |
| `scripts/codex-bridge.mjs`, `scripts/codex/*.mjs` | `docs/architecture.md`, `docs/decisions.md` |
| `skills/<any>/SKILL.md` | `docs/gates-and-agents.md`, `docs/workflow.md` |
| `agents/<any>.md` | `docs/gates-and-agents.md` |
| `references/loop-protocol.md` | `docs/architecture.md`, `docs/gates-and-agents.md`, `docs/decisions.md` |
| `hooks/*.mjs`, `templates/hooks/*.md` | `docs/architecture.md` (SessionStart hook section) |
| `templates/codex/*.md` (incl. `code-review.md`) | `docs/architecture.md`, `docs/development.md` (template-version section); a code-review prompt/spawn change also touches `docs/decisions.md`, `docs/workflow.md`, `docs/gates-and-agents.md`, `README.md`, and `skills/hyper-implement-loop/*` (the loop parses the code-review contract) |
| `scripts/test/smoke.sh`, `tests/*.mjs` | `docs/development.md` |
| `.claude-plugin/plugin.json` | `README.md`, `site/index.html` (alpha-status `v0.X` line), `docs/development.md` (release flow) |

Behavioral surface changes (CLI flags, frontmatter keys, output paths, mode names) should also propagate to `README.md` and `docs/workflow.md` if the change is user-visible.

## Artifacts and slug convention

`.hyperclaude/` (gitignored by consumer convention) holds per-run artifacts. Naming: `<YYYYMMDD-HHMM>-<slug>.md` (UTC). The slug propagates as the trace key — `research → plan → plan-review` share one slug end-to-end (extracted from the plan filename). A research slug may now resolve to a Codex + Claude artifact PAIR (`<ts>-<slug>.md` + `<ts>-<slug>-claude.md`) that share the same frontmatter `slug:`; the slug remains the single trace key for `research → plan → plan-review`. `code-review` slug comes from the diff target (`vs-main`, `uncommitted`, `commit-<sha7>`); `docs-review` slug from the docs target basename. These are release-level, not feature-level — don't try to align them with the research/plan trio.

Plan files (Claude-authored) live in `.hyperclaude/plans/` and are the input to `plan-review`. Never write `<file>-v2.md` siblings when revising a plan — `--resume` keys on the plan path, so a new path breaks resume continuity.

`.hyperclaude/` is gitignored by convention, so `git mv .hyperclaude/<a> .hyperclaude/<b>` fails with "source directory is empty" — use plain `mv`. Tracked files (templates, scripts) still use `git mv`.

## Release flow

When the user asks to release, run the whole flow end to end — don't stop after the commit.

1. **Tests green — re-run immediately before committing**, not "earlier this session": `node --test tests/codex-bridge.test.mjs tests/codex-bridge-spawn.test.mjs tests/codex-bridge-jsonl.test.mjs tests/setup-doctor.test.mjs` and `bash scripts/test/smoke.sh`. Unit must report `fail 0`; smoke must report `failed: 0`. Either red → stop and fix first.
2. **Bump `version`** in `.claude-plugin/plugin.json`. Pre-1.0: minor bump for breaking changes — bridge subcommand renames, frontmatter key changes, artifact directory renames, layer/command/skill removals all count. The bump rides in the release commit, not a separate one. On a minor bump, also update the `vMAJOR.MINOR` alpha-status string in `README.md` and `site/index.html` (search for `v0.X is implemented`) so the user-visible docs match.
3. **Commit + push to `main`.** Conventional-commit subject; breaking changes take a `!` (`feat!:` / `refactor!:`) and a `BREAKING CHANGE:` footer spelling out migration steps. Review `git status` and stage the release's files explicitly — don't blanket `git add -A`. (`.hyperclaude/` is gitignored so its artifacts never appear, but any *other* untracked file would be swept into the release commit.)
4. **Tag:** `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line>"` then `git push origin vX.Y.Z`.
5. **GitHub release:** `gh release create vX.Y.Z --title "..." --notes "..."`. When breaking, the notes must carry a **Migration** section whose steps match the commit's `BREAKING CHANGE:` footer.

## See also

- [docs/architecture.md](docs/architecture.md) — bridge details, mode table, output contract.
- [docs/gates-and-agents.md](docs/gates-and-agents.md) — per-skill / per-agent mechanics.
- [docs/workflow.md](docs/workflow.md) — research → ship cycle, skip rules, `--resume` semantics.
- [docs/decisions.md](docs/decisions.md) — non-obvious "why" notes and active deferrals.
- [docs/development.md](docs/development.md) — local install, tests, full release checklist.
