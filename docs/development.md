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
node --test tests/*.mjs            # unit tests for the bridge, setup-doctor, and hyper-memory extraction (shared fixtures live in tests/helpers/, outside the glob)
bash scripts/test/smoke.sh         # smoke runs core checks (required files, dry-runs, hook invocations, the SessionStart hook byte-for-byte check against the active router template — session-start-reminder.md with agent-teams off, session-start-reminder-loop.md when CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1 — manifest wiring across all hook entries, setup-doctor probe, hyper-memory extract dry-run probe, + 3 Codex probes when codex is on PATH + optional `claude plugin validate` when claude is on PATH)
```

Both must pass cleanly before shipping a release. Zero npm dependencies; nothing to install.

The bridge unit tests are split by topic — `codex-args` (argv parsing / invocation planning, including the `--background` flag: acceptance, rejection of invalid combinations, mutual-exclusion with `--resume`, fresh-spawn `### Change context` injection, and fence-collision guard; and the `--review-brief` flag: acceptance on plan-review / code-review, allowed WITH `--resume`, and rejection elsewhere), `codex-frontmatter` (slug derivation, frontmatter render + parse, `review-brief` persistence), `codex-templates` (template-version frontmatter, resumed prompts, render blocks incl. the `{{REVIEW_BRIEF}}` block + flag-overrides-carried precedence exercised across the spawn tests), `codex-provenance` (plugin-version stamping), `codex-git` (git helpers), `codex-resume` (resume validation + template-version gates), plus the integration pair `codex-spawn-fresh` / `codex-spawn-resume` (mock-codex spawn shapes; shared mocks in `tests/helpers/fixtures.mjs`) and `codex-bridge-jsonl` (JSONL parsing); `tests/setup-doctor.test.mjs` covers the prerequisite probe (Node, codex, git, agent-teams checks); `tests/memory-extract.test.mjs` covers `scripts/memory/extract.mjs` with hermetic `mkdtemp` fixtures — corpus enumeration, identity derivation, span/verdict helpers, compound-key stability, candidate rendering, and cross-dir (`candidates/` + `promoted/`) idempotency. The smoke script:

- Runs the unit test suite (`node --test tests/*.mjs`).
- Verifies that required plugin files exist (manifests, marketplace listing, every `SKILL.md` and agent file, the bridge, the templates including the fresh `code-review.md` and all three resumed variants `plan-review-resumed.md` / `docs-review-resumed.md` / `code-review-resumed.md`, both SessionStart router templates `session-start-reminder.md` / `session-start-reminder-loop.md`, the SessionStart hook, `scripts/memory/extract.mjs`, and `skills/hyper-memory/SKILL.md`).
- Dry-runs the bridge for `research`, `code-review`, and `docs-review` and asserts each emits a JSON success line. (`plan-review` is not dry-run by the smoke script.)
- Runs the `setup-doctor` probe directly and asserts it emits a parseable JSON line with a `checks[]` array.
- Runs `node scripts/memory/extract.mjs --dry-run` and asserts it emits a JSON line with `ok === true`, a numeric `scanned`, and `written === 0`.
- When `codex` is on PATH, runs three Codex 0.130 surface probes: `codex exec resume --help`, `codex exec resume --help -c sandbox_mode=read-only` (verifies the `-c sandbox_mode=read-only` config key is accepted on the resume path), and `codex --search exec --help` (verifies the global `--search` flag is accepted before the subcommand — required since every bridge spawn now includes `--search`; this probe also covers the fresh code-review surface, which is `codex --search exec --sandbox read-only -` like the other fresh modes). Each probe failure prints an upgrade hint.
- When `claude` is on PATH, runs `claude plugin validate .` to catch manifest drift.

After the automated checks it prints a manual acceptance checklist for running each slash command end-to-end inside Claude Code — those steps are not automated. `/hyperclaude:hyper-setup` is the last step in the printed checklist (step 11).

Phase A adds shared-loop-protocol static assertions: existence of `references/loop-protocol.md`, presence of `PHASE 1` / `PHASE 2` / `stale-recovery` markers, absence of loop-specific tokens (`WROTE:`, role names like `planner`/`fixer` — the binding-hole invariant), and a check that `skills/hyper-plan-loop/SKILL.md` Step 0 references the shared file via `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`.

Phase B adds `==> hyper-implement-loop reqid promotion assertions` to smoke, statically checking that implement-loop's `SKILL.md` carries the four run-state field references (`request_id_counter` / `expected_request_id` / `awaiting_reply` / `solicit_sent_at`) and the `request-id: <id>` reply-prefix contract; that `references/failure-protocol.md` carries the `request-id: <id>` gate binding plus the three field references it actually routes by (`request_id_counter` / `expected_request_id` / `awaiting_reply`; `solicit_sent_at` is a shared-§E-only field referenced inside the stale-idle guard pseudo-code, not in the local binding); and that `agents/fixer.md` does NOT carry the prefix (the prefix is loop-injected, not agent-baked). Smoke also prints a manual end-to-end acceptance banner.

`hyper-docs-loop` adds `==> hyper-docs-loop binding assertions` to smoke, mirroring the implement-loop checks: `SKILL.md` carries the four run-state fields plus `request-id:` prefix and the `documenter` teammate role; `references/failure-protocol.md` carries the `request-id:` gate binding and the documenter role binding; and `agents/documenter.md` does NOT carry the `request-id:` prefix (the prefix is loop-injected, not agent-baked, so `documenter` stays reusable by both `hyper-docs-sync` and `hyper-docs-loop`). A manual acceptance bullet (9b) is added to the end-to-end checklist.

The 2026-06-20 addressing-reversal migration adds agent-teams contract assertions across all three loop SKILLs: a negative lock that `to: teammate_id` (the stale id-only form) does NOT appear in loop SKILL.md files or in `references/loop-protocol.md`; a positive lock that main §A bare-name routing is present (`to: teammate_name` as the sole live-mailbox handle, no cache, no fallback in the main path); per-loop `teammate_name` role-binding assertions; a `{ type: "shutdown_request" }` object-shape lock on teardown (plain string `message` form is rejected); the no-wait + v2.1.178 blocks retained from the prior migration; and a removal-simulation isolation check confirming that the `## §A-DEGRADE` section + every `[DEGRADE]`-tagged line is the complete degrade boundary (deleting them leaves the bare-`teammate_name` protocol standalone — the `agent_id` fallback, condition (2) DRIVING, and conditions (1)/(3) STOP are confined to §A-DEGRADE). Teardown steps must NOT assert a wait for termination notification or a `shutdown_response`. The smoke suite also asserts **§F loop-skeleton presence** — that `references/loop-protocol.md` carries the `## §F` section header — and **per-loop §F pointer assertions** — that each loop SKILL.md references the shared §F skeleton (rather than restating the prose). The manual acceptance checklist for `hyper-plan-loop`, `hyper-implement-loop`, and `hyper-docs-loop` includes: (a) confirm all lead→teammate SendMessages address the bare spawn name directly (live mailbox routes it); (b) confirm teardown sends `{ type: "shutdown_request" }` to the bare `teammate_name` and does not block waiting for a reply; (c) on a degraded host (bare-name send fails), confirm §A-DEGRADE D1 fallback to `agent_id` engages and condition (2) DRIVING / conditions (1)/(3) STOP apply as specified in §A-DEGRADE.

## Local plugin install (for dogfooding)

Symlink the repo into Claude Code's plugin cache so edits are picked up live. Use the version from [.claude-plugin/plugin.json](../.claude-plugin/plugin.json) as the leaf directory name:

Note: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is optional and only needed to dogfood `hyper-plan-loop` (the autonomous plan-revise loop skill), `hyper-implement-loop` (the autonomous implement-hardening loop skill), `hyper-docs-loop` (the autonomous docs-hardening loop skill), and `hyper-auto` (which chains plan + implement inner loops and inherits the requirement). All other skills work without it.

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
- `--model <name>` and `--effort <low|medium|high|xhigh>` are available on all four modes. Both have no bridge default (null = inherit `~/.codex/config.toml`). Valid `--effort` values are exactly `low`, `medium`, `high`, `xhigh`; `none` (plan-mode only in the Codex CLI, not an exec reasoning level) and `minimal` (not a supported exec reasoning level per the local Codex catalog) are rejected. Selection tokens are inserted into argv after the subcommand and before `--sandbox`/`-c sandbox_mode=read-only`, preserving the sandbox invariant. The two flags record new frontmatter keys (`codex-model-requested`, `codex-effort-requested`) only when passed; they are omitted from the artifact when not used.

## Templates

Codex prompts live in [templates/codex/](../templates/codex/) — `research.md`, `plan-review.md`, `plan-review-resumed.md`, `docs-review.md`, `docs-review-resumed.md`, `code-review.md`, `code-review-resumed.md`. Variables are `{{UPPERCASE_KEY}}` (e.g. `{{TASK}}`, `{{PLAN}}`, `{{DOCS}}`, `{{DIFF}}`, `{{TARGET_INSTRUCTION}}`). Unknown placeholders are left literal.

- `plan-review-resumed.md` — continuation prompt used when `--resume` is passed to `plan-review`; substitutes `{{PLAN_PATH}}` and `{{REVIEW_BRIEF}}`.
- `docs-review-resumed.md` — continuation prompt used when `--resume` is passed to `docs-review`; substitutes `{{DOCS_TARGET}}`, `{{FILE_LIST_BLOCK}}` (rendered via `renderFileListBlock`), and `{{DIFF_BASE_BLOCK}}` (rendered via `renderDiffBaseBlock`).
- `code-review.md` — fresh `code-review` prompt. Substitutes `{{TARGET_INSTRUCTION}}` (the per-target git-command block), `{{REVIEW_BACKGROUND}}` (optional caller-supplied context injected under a `### Change context` heading when `--background` is passed; empty string otherwise), and `{{REVIEW_BRIEF}}` (optional caller-composed brief of the user's requirements / approved decisions injected under a `### Review brief` DATA heading when `--review-brief` is passed; empty otherwise — the same slot appears on `plan-review.md` and both `*-resumed.md` review prompts). Codex runs those git commands itself under the read-only sandbox to collect the diff — there is no native diff capture; the bridge spawns `codex --search exec --sandbox read-only -` with this rendered prompt, exactly like the other fresh modes.
- `code-review-resumed.md` — continuation prompt used when `--resume` is passed to `code-review`; substitutes `{{TARGET_INSTRUCTION}}` (the exact git command to re-fetch the diff, since `codex exec resume` does not re-trigger diff capture) and `{{REVIEW_BRIEF}}`.

Adding bridge flags (`--model`, `--effort`) that do NOT change a template's prompt body does NOT require a `template-version` bump — the template text is unchanged and resume comparisons remain valid.

When changing a fresh template's prompt body, bump its `template-version` in the SAME file's leading YAML frontmatter — that's the single source of truth. The bridge reads it via `readTemplateWithVersion()` (see [scripts/codex/templates.mjs](../scripts/codex/templates.mjs)) and propagates it into the artifact frontmatter; the renderers no longer hardcode the version. The `*-resumed.md` continuation prompts stay frontmatter-less by design — they inherit the fresh template's version when the artifact is written.

The version is recorded in research / plan-review / docs-review / code-review output frontmatter so consumers can detect prompt drift. Plan-review emits `template-version: 3` (v2 anti-over-engineering rubric reframe in v0.16.0; v3 added the `{{REVIEW_BRIEF}}` slot for the `--review-brief` channel); code-review emits `template-version: 4` (v2 added the over-engineering lens; v3 added the `{{REVIEW_BACKGROUND}}` slot for the `--background` channel; v4 added the `{{REVIEW_BRIEF}}` slot); docs-review is at `2` (v2 added the redundancy scope); research is at `1`. Every resumable mode's `--resume` (`plan-review` / `docs-review` / `code-review`; research has no resume path) enforces a version match: a prior artifact whose `template-version` doesn't match the current fresh template's frontmatter is not resumable (e.g. a legacy code-review artifact from the old native `codex exec review` path, or an artifact from before a prompt change). With `--resume auto` the bridge silently falls back to a fresh run (stderr note); with an explicit `--resume <old-path>` it exits non-zero with `resume rejected`. The resumed variants (`*-resumed.md`) are themselves unversioned — bump them freely; the gate keys on the prior artifact's `template-version`, not the resumed template's.

## Release flow

1. **Self-check.** Run `node --test tests/*.mjs` and `bash scripts/test/smoke.sh` until green.
2. **Code review.** `/hyperclaude:hyper-code-review vs <last release tag>` to catch regressions on the diff since the last tag.
3. **Docs sync + review.** `/hyperclaude:hyper-docs-sync uncommitted` then `/hyperclaude:hyper-docs-review` for any docs that changed shape.
4. **Bump version.** Update `version` in [.claude-plugin/plugin.json](../.claude-plugin/plugin.json). **Pre-adoption policy:** a breaking change OR a new feature rides a MINOR bump, not a major (`1.0.0` is a maturity marker, not a strict-semver contract — see [CLAUDE.md](../CLAUDE.md) Release flow). When the bump changes the `vMAJOR.MINOR` shown in the status banner, also update it in [site/index.html](../site/index.html) (search for `the design has converged`; the README header carries no version line). Commit.
5. **Tag.** `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line summary>"`.
6. **Push.** `git push origin main vX.Y.Z`.
7. **Verify GitHub install.** From a fresh checkout: `/plugin marketplace add zeikar/hyperclaude` → `/plugin install hyperclaude` → run a gate.

All seven steps run when the user asks to release — steps 1–3 are validation prerequisites, not optional; never tag/push (4–7) without them. The autonomous `hyper-implement` executor is the exception — during plan execution it never pushes or tag-then-pushes on its own.

## Self-test from a clean state

The smoke script's "manual checklist" walks through running each slash command end-to-end inside Claude Code. Use it after a clean GitHub install to verify the plugin actually works the way the docs describe:

```bash
bash scripts/test/smoke.sh
```

Then follow the printed checklist (research → plan → plan-review → code-review → docs-sync → docs-review → plan-loop → implement-loop → docs-loop → hyper-auto → hyper-setup). Stop and fix at the first failure.
