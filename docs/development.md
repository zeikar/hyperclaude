# Development

Local dev setup, test suite, and release flow for hyperclaude itself. Consumer-side install (just running the plugin) is in the [README](../README.md#quick-start).

## Prerequisites

- **Node 18+** — bridge is stdlib-only; no `npm install` step.
- **`codex-cli >= 0.130.0`** — version-checked at runtime by the bridge.
- **`git`** — for diff-backed gates.
- **Claude Code** — to dogfood the slash commands.

```bash
node --version
codex --version
git --version
```

## Repo layout

See [architecture.md](architecture.md#directory-layout). The shapes that matter for development:

- [skills/](../skills/) — one `SKILL.md` per skill. Edits are picked up by Claude Code on next session start (or `/plugin reload` if available).
- [agents/](../agents/) — one `<name>.md` per agent.
- [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs) plus leaf modules under [scripts/codex/](../scripts/codex/) — the only Codex-spawning code in the plugin. Hooks under [hooks/](../hooks/) are also executable Node scripts but pure orchestration (they never spawn Codex).
- [tests/](../tests/) — `node --test` unit tests.
- [scripts/test/smoke.sh](../scripts/test/smoke.sh) — acceptance smoke checks.

## Running the bridge by hand

The bridge is a regular Node script. You can call it directly to debug a gate without going through Claude Code:

```bash
# Research
echo "add OAuth login to the API" > /tmp/task.txt
node scripts/codex-bridge.mjs research --task-file /tmp/task.txt

# Plan review
node scripts/codex-bridge.mjs plan-review --plan-path .hyperclaude/plans/<file>.md

# Plan review (resume — auto-discover the most recent matching prior review)
node scripts/codex-bridge.mjs plan-review --plan-path .hyperclaude/plans/<file>.md --resume auto

# Plan review (resume — from an explicit prior review)
node scripts/codex-bridge.mjs plan-review --plan-path .hyperclaude/plans/<file>.md --resume .hyperclaude/plan-reviews/<prev>.md

# Docs review (resume after fixing the file)
node scripts/codex-bridge.mjs docs-review --docs-path docs/architecture.md --resume auto

# Code review (default: vs main)
node scripts/codex-bridge.mjs code-review --base main

# Code review with a custom heading title (recorded in frontmatter and used as the "# Code review: …" heading)
node scripts/codex-bridge.mjs code-review --base main --title "v0.4 prep — auth refactor"

# Code review (resume — auto-discover the most recent matching prior review with same target identity)
node scripts/codex-bridge.mjs code-review --base main --resume auto

# Code review (resume — from an explicit prior review)
node scripts/codex-bridge.mjs code-review --base main --resume .hyperclaude/code-reviews/<prev>.md

# Docs review
node scripts/codex-bridge.mjs docs-review --docs-path README.md

# Dry-run any mode (validates argv and loads the mode's prompt template; skips the codex spawn).
node scripts/codex-bridge.mjs research --task "test" --dry-run
```

Output goes to mode-specific subdirectories of `.hyperclaude/` by default — `.hyperclaude/research/`, `.hyperclaude/plan-reviews/`, `.hyperclaude/code-reviews/`, `.hyperclaude/docs-reviews/`. Override with `--out`. Set `--timeout <seconds>` for slow networks (default 600s). `--resume` is supported for `plan-review`, `docs-review`, and `code-review`; not `research`. See [architecture.md](architecture.md#cli-surface) for the full flag reference.

## Tests

```bash
node --test tests/*.mjs            # unit tests for the bridge and setup-doctor (includes tests/setup-doctor.test.mjs)
bash scripts/test/smoke.sh         # smoke runs core checks (required files, dry-runs, hook invocations, the SessionStart hook byte-for-byte check against templates/hooks/session-start-reminder.md, manifest wiring across all hook entries, setup-doctor probe, + 3 Codex probes when codex is on PATH + optional `claude plugin validate` when claude is on PATH)
```

Both must pass cleanly before shipping a release. Zero npm dependencies; nothing to install.

The unit tests cover argument parsing, slug derivation, frontmatter rendering, file-collision handling, and per-mode invocation planning; `tests/setup-doctor.test.mjs` covers the prerequisite probe (Node, codex, git, agent-teams checks). The smoke script:

- Runs the unit test suite (`node --test tests/*.mjs`).
- Verifies that required plugin files exist (manifests, marketplace listing, every `SKILL.md` and agent file, the bridge, the templates including the fresh `code-review.md` and all three resumed variants `plan-review-resumed.md` / `docs-review-resumed.md` / `code-review-resumed.md`, and the SessionStart hook).
- Dry-runs the bridge for `research`, `code-review`, and `docs-review` and asserts each emits a JSON success line. (`plan-review` is not dry-run by the smoke script.)
- Runs the `setup-doctor` probe directly and asserts it emits a parseable JSON line with a `checks[]` array.
- When `codex` is on PATH, runs three Codex 0.130 surface probes: `codex exec resume --help`, `codex exec resume --help -c sandbox_mode=read-only` (verifies the `-c sandbox_mode=read-only` config key is accepted on the resume path), and `codex --search exec --help` (verifies the global `--search` flag is accepted before the subcommand — required since every bridge spawn now includes `--search`; this probe also covers the fresh code-review surface, which is `codex --search exec --sandbox read-only -` like the other fresh modes). Each probe failure prints an upgrade hint.
- When `claude` is on PATH, runs `claude plugin validate .` to catch manifest drift.

After the automated checks it prints a manual acceptance checklist for running each slash command end-to-end inside Claude Code — those steps are not automated. The checklist includes `/hyperclaude:hyper-setup` as the first step (verify prerequisites before running gates).

## Local plugin install (for dogfooding)

Symlink the repo into Claude Code's plugin cache so edits are picked up live. Use the version from [.claude-plugin/plugin.json](../.claude-plugin/plugin.json) as the leaf directory name:

Note: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is optional and only needed to dogfood `hyper-plan-loop` (the autonomous plan-revise loop skill) and `hyper-implement-loop` (the autonomous implement-hardening loop skill). All other skills work without it.

```bash
version=$(node -e 'console.log(require("./.claude-plugin/plugin.json").version)')
ln -s "$(pwd)" ~/.claude/plugins/cache/hyperclaude/hyperclaude/"$version"
```

After symlinking, restart Claude Code or use `/plugin reload` if available. To switch back to a clean GitHub install:

```bash
rm ~/.claude/plugins/cache/hyperclaude/hyperclaude/"$version"
```

Then in Claude Code:

```
/plugin marketplace add zeikar/hyperclaude
/plugin install hyperclaude
```

## Editing skills and agents

Skill files are markdown with YAML frontmatter. The `name` and `description` fields drive Claude's auto-trigger logic — keep `description` specific (it's how Claude decides whether to invoke the skill on its own). Body is plain markdown.

Agent files are the same shape, with an additional `tools:` line listing the allowed tool names. Agents inherit no tools by default — list every tool the agent should have. See [agents/planner.md](../agents/planner.md) for the canonical example.

When you change a skill / agent that ships an output contract (e.g. frontmatter keys), update the corresponding section in [architecture.md](architecture.md#output-contract) so docs don't drift.

## Editing the bridge

CLI entry: [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs). Leaf modules: [scripts/codex/](../scripts/codex/) (`args`, `paths`, `resume`, `templates`, `frontmatter`, `slug`, `git`, `codex`, `failure`). The entry re-exports its building blocks (`slugify`, `parseArgs`, `buildInvocation`, `renderFrontmatter`, `runCodexResume`, `parseCodexJsonl`, `parseFrontmatter`, `loadResumeContext`, `discoverResumeArtifact`, `fmString`, `renderFailureBody`, `renderFileListBlock`, `renderDiffBaseBlock`, etc.) from the leaf modules so the unit tests can exercise them in isolation. `runCodexExec` is the internal spawn helper used by every mode; it's exercised through the public surfaces and not exported. (`runCodex` and `runCodexReview` were removed in v0.4 in favor of `runCodexExec`.)

Conventions:

- Stdlib only. No `npm install`. If a feature needs a dep, redesign or shell out.
- Every codex invocation goes through `runCodexExec` or `runCodexResume`. Don't add new spawn paths without re-checking the sandbox argument.
- New flags must be added to `ALLOWED_FLAGS_PER_MODE` and validated in `parseArgs`. The argv parser rejects unknown flags per mode — covered by tests.
- When a codex call fails, the bridge still writes a markdown file with the failure captured under `## stderr` so the caller can read what went wrong without re-running.

## Templates

Codex prompts live in [templates/codex/](../templates/codex/) — `research.md`, `plan-review.md`, `plan-review-resumed.md`, `docs-review.md`, `docs-review-resumed.md`, `code-review.md`, `code-review-resumed.md`. Variables are `{{UPPERCASE_KEY}}` (e.g. `{{TASK}}`, `{{PLAN}}`, `{{DOCS}}`, `{{DIFF}}`, `{{TARGET_INSTRUCTION}}`). Unknown placeholders are left literal.

- `plan-review-resumed.md` — continuation prompt used when `--resume` is passed to `plan-review`; substitutes `{{PLAN_PATH}}`.
- `docs-review-resumed.md` — continuation prompt used when `--resume` is passed to `docs-review`; substitutes `{{DOCS_TARGET}}`, `{{FILE_LIST_BLOCK}}` (rendered via `renderFileListBlock`), and `{{DIFF_BASE_BLOCK}}` (rendered via `renderDiffBaseBlock`).
- `code-review.md` — fresh `code-review` prompt. Substitutes `{{TARGET_INSTRUCTION}}` (the per-target git-command block). Codex runs those git commands itself under the read-only sandbox to collect the diff — there is no native diff capture; the bridge spawns `codex --search exec --sandbox read-only -` with this rendered prompt, exactly like the other fresh modes.
- `code-review-resumed.md` — continuation prompt used when `--resume` is passed to `code-review`; substitutes `{{TARGET_INSTRUCTION}}` (the exact git command to re-fetch the diff, since `codex exec resume` does not re-trigger diff capture).

When changing a template, bump `template-version` in lock-step. Most templates have two locations to update:

1. The `templateVersion: 1` argument passed to `renderFrontmatter()` (research / plan-review path).
2. The hardcoded `template-version: 1` line in `renderDocsReviewFrontmatter()` (docs-review path).

`code-review` now also carries `template-version` and has **three** lock-step points: the prompt body `templates/codex/code-review.md`, the hardcoded `template-version: 1` line in `renderCodeReviewFrontmatter()`, and the `CODE_REVIEW_TEMPLATE_VERSION` constant in [scripts/codex/resume.mjs](../scripts/codex/resume.mjs) (the resume gate). Bump all three together when changing the code-review prompt.

The version is recorded in research / plan-review / docs-review / code-review output frontmatter so consumers can detect prompt drift. `code-review` frontmatter now emits `template-version: 1`, and `--resume` enforces it: a prior code-review artifact lacking a matching `template-version` (e.g. a legacy artifact from the old native `codex exec review` path) is not resumable. With `--resume auto` the bridge silently falls back to a fresh run (stderr note); with an explicit `--resume <legacy-path>` it exits non-zero with `resume rejected`. The resumed variant `code-review-resumed.md` is itself unversioned in frontmatter — bump it freely; the gate keys on the prior artifact's `template-version`, not the resumed template's.

## Release flow

1. **Self-check.** Run `node --test tests/*.mjs` and `bash scripts/test/smoke.sh` until green.
2. **Code review.** `/hyperclaude:hyper-code-review vs v0.<prev>.0` to catch regressions on the diff since the last tag.
3. **Docs sync + review.** `/hyperclaude:hyper-docs-sync uncommitted` then `/hyperclaude:hyper-docs-review` for any docs that changed shape.
4. **Bump version.** Update `version` in [.claude-plugin/plugin.json](../.claude-plugin/plugin.json). Commit.
5. **Tag.** `git tag -a v0.X.Y -m "v0.X.Y: <one-line summary>"`.
6. **Push.** `git push origin main v0.X.Y`.
7. **Verify GitHub install.** From a fresh checkout: `/plugin marketplace add zeikar/hyperclaude` → `/plugin install hyperclaude` → run a gate.

All seven steps run when the user asks to release — steps 1–3 are validation prerequisites, not optional; never tag/push (4–7) without them. The autonomous `hyper-implement` executor is the exception — during plan execution it never pushes or tag-then-pushes on its own.

## Self-test from a clean state

The smoke script's "manual checklist" walks through running each slash command end-to-end inside Claude Code. Use it after a clean GitHub install to verify the plugin actually works the way the docs describe:

```bash
bash scripts/test/smoke.sh
```

Then follow the printed checklist (hyper-setup → research → plan-review → code-review → docs-sync → docs-review). Stop and fix at the first failure.
