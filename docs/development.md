# Development

Local dev setup, test suite, and release flow for hyperclaude itself. Consumer-side install (just running the plugin) is in the [README](../README.md#quick-start).

## Prerequisites

- **Node 18+** — bridge is stdlib-only; no `npm install` step.
- **`codex-cli >= 0.128.0`** — version-checked at runtime by the bridge.
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
- [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs) — the only executable code in the plugin.
- [tests/](../tests/) — `node --test` unit tests.
- [scripts/test/smoke.sh](../scripts/test/smoke.sh) — acceptance smoke checks.

## Running the bridge by hand

The bridge is a regular Node script. You can call it directly to debug a gate without going through Claude Code:

```bash
# Research
echo "add OAuth login to the API" > /tmp/task.txt
node scripts/codex-bridge.mjs research --task-file /tmp/task.txt

# Review
node scripts/codex-bridge.mjs review --plan-path .hyperclaude/plans/<file>.md

# Code review (default: vs main)
node scripts/codex-bridge.mjs code-review --base main

# Code review with a custom heading title (recorded in frontmatter and used as the "# Code review: …" heading)
node scripts/codex-bridge.mjs code-review --base main --title "v0.4 prep — auth refactor"

# Docs review
node scripts/codex-bridge.mjs docs-review --docs-path README.md

# Dry-run any mode (validates argv; for templated modes also loads the template; skips the codex spawn).
# code-review dry-run skips the template check (the codex review subcommand owns its own prompt).
node scripts/codex-bridge.mjs research --task "test" --dry-run
```

Output goes to mode-specific subdirectories of `.hyperclaude/` by default — `.hyperclaude/research/`, `.hyperclaude/reviews/`, `.hyperclaude/code-reviews/`, `.hyperclaude/docs-reviews/`. Override with `--out`. Set `--timeout <seconds>` for slow networks (default 300s). See [architecture.md](architecture.md#cli-surface) for the full flag reference.

## Tests

```bash
node --test tests/*.mjs            # unit tests for the bridge — currently 123 cases
bash scripts/test/smoke.sh         # 23 automated checks + optional `claude plugin validate` if Claude Code CLI is on PATH
```

Both must pass cleanly before tagging a release. Zero npm dependencies; nothing to install.

The unit tests cover argument parsing, slug derivation, frontmatter rendering, file-collision handling, and per-mode invocation planning. The smoke script:

- Runs the unit test suite (`node --test tests/*.mjs`).
- Verifies that required plugin files exist (manifests, marketplace listing, every `SKILL.md` and agent file, the bridge, the templates).
- Dry-runs the bridge for `research`, `code-review`, and `docs-review` and asserts each emits a JSON success line. (`review` is not dry-run by the smoke script.)
- When `claude` is on PATH, runs `claude plugin validate .` to catch manifest drift.

After the automated checks it prints a manual acceptance checklist for running each slash command end-to-end inside Claude Code — those steps are not automated.

## Local plugin install (for dogfooding)

Symlink the repo into Claude Code's plugin cache so edits are picked up live. Use the version from [.claude-plugin/plugin.json](../.claude-plugin/plugin.json) as the leaf directory name:

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

Single file: [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs). It exports its building blocks (`slugify`, `parseArgs`, `buildInvocation`, `renderFrontmatter`, etc.) so the unit tests can exercise them in isolation.

Conventions:

- Stdlib only. No `npm install`. If a feature needs a dep, redesign or shell out.
- Every codex invocation goes through `runCodex` (`exec --sandbox read-only -`) or `runCodexReview` (`review`). Don't add new spawn paths without re-checking the sandbox argument.
- New flags must be added to `ALLOWED_FLAGS_PER_MODE` and validated in `parseArgs`. The argv parser rejects unknown flags per mode — covered by tests.
- When a codex call fails, the bridge still writes a markdown file with the failure captured under `## stderr` so the caller can read what went wrong without re-running.

## Templates

Codex prompts live in [templates/codex/](../templates/codex/) — `research.md`, `review.md`, `docs-review.md`. Variables are `{{UPPERCASE_KEY}}` (e.g. `{{TASK}}`, `{{PLAN}}`, `{{DOCS}}`, `{{DIFF}}`). Unknown placeholders are left literal.

The `code-review` mode does not have a template; `codex review` owns its own prompt.

When changing a template, bump `template-version` in [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs). There are currently two locations to update in lock-step:

1. The `templateVersion: 1` argument passed to `renderFrontmatter()` (research / review path).
2. The hardcoded `template-version: 1` line in `renderDocsReviewFrontmatter()` (docs-review path).

The version is recorded in research / review / docs-review output frontmatter so consumers can detect prompt drift. (`code-review` has no template, so its frontmatter omits `template-version`.)

## Release flow

1. **Self-check.** Run `node --test tests/*.mjs` and `bash scripts/test/smoke.sh` until green.
2. **Code review.** `/hyperclaude:hyper-code-review vs v0.<prev>.0` to catch regressions on the diff since the last tag.
3. **Docs sync + review.** `/hyperclaude:hyper-docs-sync uncommitted` then `/hyperclaude:hyper-docs-review` for any docs that changed shape.
4. **Bump version.** Update `version` in [.claude-plugin/plugin.json](../.claude-plugin/plugin.json). Commit.
5. **Tag.** `git tag -a v0.X.Y -m "v0.X.Y: <one-line summary>"`.
6. **Push.** `git push origin main v0.X.Y`.
7. **Verify GitHub install.** From a fresh checkout: `/plugin marketplace add zeikar/hyperclaude` → `/plugin install hyperclaude` → run a gate.

The user does steps 5–7 manually. Skills never push or tag-then-push.

## Self-test from a clean state

The smoke script's "manual checklist" walks through running each slash command end-to-end inside Claude Code. Use it after a clean GitHub install to verify the plugin actually works the way the docs describe:

```bash
bash scripts/test/smoke.sh
```

Then follow the printed checklist (research → plan-review → code-review → docs-sync → docs-review). Stop and fix at the first failure.
