# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this repo is

hyperclaude is a Claude Code plugin that pairs Claude (builder) with Codex (critic) via a thin Node script. **Claude implements, Codex reviews** — that role split is the design invariant. Codex is always invoked with read-only sandbox; never let it author patches.

The plugin is meant to be installed into Claude Code (`/plugin install hyperclaude`); when you're editing this repo, you're editing the plugin source itself.

## Commands

Prerequisites: Node 18+, `codex-cli >= 0.130.0` on PATH, `git`. No `npm install` step — stdlib only.

```bash
node --test tests/*.mjs                   # unit tests (shared fixtures live in tests/helpers/,
                                          # outside the glob). NOTE: `node --test tests/` (dir
                                          # form) does NOT work — it interprets the path as a
                                          # test name and fails.
node --test tests/codex-args.test.mjs --test-name-pattern "<regex>"
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

- **Skills** (`skills/<name>/SKILL.md`) — what Claude reads on the matching trigger. Each skill is one markdown file with YAML frontmatter (`name`, `description`). Skills call the bridge via `Bash` and dispatch agents via the `Agent` tool. A skill MAY also spawn an agent as a persistent team teammate for stateful multi-turn loops (`hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`); this uses Claude Code's experimental agent-teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). `hyper-setup` is an **invoke-only** skill — its frontmatter carries `disable-model-invocation: true` so it only ever runs on an explicit `/hyperclaude:hyper-setup` (never auto-triggered by its description); it is a local prerequisite probe that runs `scripts/setup-doctor.mjs` and spawns no Codex or agents. (Claude Code merged plugin `commands/` into skills; hyper-setup was the plugin's one `commands/*.md` entry and is now a skill with model-invocation disabled — the invoke-only guard depends on a Claude Code that honors that frontmatter, present since ~v2.1.126.) `hyper-memory` is orchestration-only — no Codex, no agent dispatch — it runs `scripts/memory/extract.mjs` via `Bash` to extract repo-local knowledge candidates from accumulated `.hyperclaude/` artifacts to `.hyperclaude/memory/candidates/`; it joins the non-Codex-spawning set alongside the `hyper-setup` skill, `hyper-recap`, and the hooks.
- **Agents** (`agents/<name>.md`) — sub-Claude personas with restricted `tools:` lists. Used by skills, never the other way around.
- **Hooks** (`hooks/*.mjs`, registered in `hooks/hooks.json`) — two: (1) a SessionStart reminder that injects a workflow-router template — `templates/hooks/session-start-reminder.md` by default, or the loop-first `session-start-reminder-loop.md` when `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` (so the `*-loop`/`hyper-auto` skills become the default recommendation only when agent-teams is actually available) — plus an optional `.hyperclaude/` snapshot footer; (2) a PostToolUse(`Write`) stamp hook (`hooks/stamp-artifact.mjs`) that injects a `plugin-version` line into every Claude-written `.hyperclaude/**/*.md` artifact lacking one — deterministic provenance for plans/epics/research-claude that does NOT depend on the model authoring the line (bridge artifacts already carry it and are written via fs, so the hook skips them). Both are pure orchestration — they never spawn codex.
- **Templates** (`templates/codex/*.md`, `templates/hooks/*.md`) — prompt bodies loaded at runtime with `{{UPPERCASE_KEY}}` substitution.
- **Shared protocol references** (`references/loop-protocol.md`) — plugin-wide reference content loaded by skills' Step 0 alongside their loop-specific `failure-protocol.md`. Used by `hyper-plan-loop`, `hyper-implement-loop`, and `hyper-docs-loop`. A second shared reference, `references/review-brief.md`, carries the `--review-brief` composition rules (source/omission/bound/shell-safety) pointed at by `hyper-plan-review`, `hyper-code-review`, `hyper-plan-loop`, and `hyper-implement-loop` at their brief-compose step (not Step 0). A third, `references/bridge-review-calls.md`, carries the shared bridge-invocation contract (stdout JSON envelope + strict-parse rule; `--resume` semantics + `template-version` precondition) pointed at by every skill that invokes a review mode of the bridge (`plan-review` / `code-review` / `docs-review`) where it parses the bridge's output or describes resume behavior.

All four modes use a fresh prompt template (`code-review` uses `templates/codex/code-review.md`) and bump `template-version` when changing them; the resumed variants (`*-resumed.md`) are unversioned in frontmatter.

**Template-version:** each fresh template (`templates/codex/{research,plan-review,code-review,docs-review}.md`) declares its `template-version` in its own leading YAML frontmatter — that's the single source of truth. The bridge reads it via `readTemplateWithVersion()` and propagates it into the artifact frontmatter; every resumable mode's `--resume` (plan-review / docs-review / code-review) compares the prior artifact's version against the current template's and rejects a mismatch (auto → fresh fallback, explicit → `resume rejected`). When you change a fresh template's prompt body, bump its frontmatter version in the same file — no other source needs editing. The `*-resumed.md` continuation prompts stay frontmatter-less by design (they inherit the fresh template's version on artifact emission).

## Code | Docs mapping (for hyper-docs-sync)

| Code | Docs |
|------|------|
| `skills/hyper-setup/SKILL.md` (invoke-only setup skill) | `docs/gates-and-agents.md`, `docs/architecture.md`, `docs/workflow.md`, `README.md`, `site/index.html` |
| `scripts/setup-doctor.mjs` | `docs/architecture.md`, `docs/development.md` (non-bridge probe; never spawns Codex) |
| `scripts/codex-bridge.mjs`, `scripts/codex/*.mjs` | `docs/architecture.md`, `docs/decisions.md` |
| `skills/<any>/SKILL.md` | `docs/gates-and-agents.md`, `docs/workflow.md` |
| `agents/<any>.md` | `docs/gates-and-agents.md` |
| `references/loop-protocol.md` | `docs/architecture.md`, `docs/gates-and-agents.md`, `docs/decisions.md` |
| `references/review-brief.md` | `docs/gates-and-agents.md`, `docs/architecture.md` |
| `references/bridge-review-calls.md` | `docs/gates-and-agents.md`, `docs/architecture.md` |
| `hooks/*.mjs`, `templates/hooks/*.md` | `docs/architecture.md` (SessionStart hook section) |
| `templates/codex/*.md` (incl. `code-review.md`) | `docs/architecture.md`, `docs/development.md` (template-version section); a code-review prompt/spawn change also touches `docs/decisions.md`, `docs/workflow.md`, `docs/gates-and-agents.md`, `README.md`, and `skills/hyper-implement-loop/*` (the loop parses the code-review contract) |
| `scripts/test/smoke.sh`, `tests/*.mjs` (incl. `tests/memory-extract.test.mjs`) | `docs/development.md` |
| `.claude-plugin/plugin.json` | `site/index.html` (the `vMAJOR.MINOR` status-banner line — search `the design has converged`; the README header carries no version line), `docs/development.md` (release flow) |
| `scripts/memory/extract.mjs` | `docs/architecture.md`, `docs/development.md`, `docs/gates-and-agents.md` |
| `skills/hyper-memory/SKILL.md` | `docs/gates-and-agents.md`, `docs/workflow.md`, `README.md` |
| `skills/hyper-recap/SKILL.md` | `docs/gates-and-agents.md`, `docs/workflow.md`, `docs/architecture.md`, `README.md`, `site/index.html` |

Behavioral surface changes (CLI flags, frontmatter keys, output paths, mode names) should also propagate to `README.md` and `docs/workflow.md` if the change is user-visible.

Docs edits — yours or any agent's — should be as terse as accuracy allows: prefer amending existing prose over appending new paragraphs. A `docs/decisions.md` entry is the decision plus its non-obvious why, typically one paragraph — not a forensic changelog.

## Artifacts and slug convention

`.hyperclaude/` (gitignored by consumer convention) holds per-run artifacts. Naming: `<YYYYMMDD-HHMM>-<slug>.md` (UTC). The slug propagates as the trace key — `research → plan → plan-review` share one slug end-to-end (extracted from the plan filename). An optional `hyper-interview` spec (`.hyperclaude/specs/<ts>-<slug>.md`, Claude-only, no Codex — clarity not review) can sit in front of `research`: it mints the slug from the idea text the *same* deterministic way, so carrying the idea forward keeps the trio linked. `specs/` accumulates like `research/` (matched by slug, never archived). A research slug may now resolve to a Codex + Claude artifact PAIR (`<ts>-<slug>.md` + `<ts>-<slug>-claude.md`) that share the same frontmatter `slug:`; the slug remains the single trace key for `research → plan → plan-review`. `code-review` slug comes from the diff target (`vs-main`, `uncommitted`, `commit-<sha7>`); `docs-review` slug from the docs target basename. These are release-level, not feature-level — don't try to align them with the research/plan trio.

Plan files (Claude-authored) live in `.hyperclaude/plans/` and are the input to `plan-review`. Never write `<file>-v2.md` siblings when revising a plan — `--resume` keys on the plan path, so a new path breaks resume continuity. On full completion (every task executed + final acceptance green) `hyper-implement` archives the executed canonical plan (direct child of `.hyperclaude/plans/`) to `.hyperclaude/plans/done/` (plain `mv`) so it stops being the newest-plan auto-pick and the SessionStart "Active plan" — the non-recursive `*.md` globs and the snapshot's `readdir` filter ignore the `done/` subdir for free. Archival is the *plan-implemented* signal, independent of any code-review findings (review fixes are downstream hardening). It applies to nested `hyper-implement-loop` runs too — the loop's later review/fix rounds harden already-implemented code and never re-read the plan. **Only `plans/` is archived.** `research/` accumulates (matched by `slug`, not newest) and `*-reviews/` accumulate by design — the snapshot shows newest-only there, and `--resume auto` walks newest-first gated on identity match, so prior review artifacts must stay in place for resume continuity.

**Plan tiers.** Most plans are *detailed* (`## Task N:` blocks, no planner-authored frontmatter) in `.hyperclaude/plans/` — the executable input to `hyper-implement`. For an oversized task `hyper-plan` instead emits an *epic roadmap* (`## Milestone N:` blocks) carrying a `tier: epic` frontmatter line, written to its own `.hyperclaude/epics/` dir (NOT `plans/`, so `hyper-implement`'s newest-plan auto-pick never selects it), then auto-expands Milestone 1 into a detailed plan at the canonical `.hyperclaude/plans/<ts>-<slug>.md` — NOT `-m1`: the roadmap's `epics/` location means no collision, so Milestone 1 keeps the shared `<slug>` (a `-mN` suffix would leak into `slug.mjs`'s extraction and break the `research → plan → plan-review` trace). Vocabulary: **epic → milestone → task**. The `tier: epic` marker is the only *planner-authored* frontmatter (a PostToolUse stamp hook additionally adds a `plugin-version` line to every `.hyperclaude/` artifact post-write — see the Hooks layer); `hyper-implement` (and therefore `hyper-implement-loop`, which delegates execution to it) refuses a `tier: epic` file. `hyper-plan-loop` has no epic path — it always produces a detailed plan. Later milestones (M2+) are expanded with `hyper-plan milestone <K>` — epic-aware: it reads the newest `epics/` roadmap, carries Milestone K's `Depends on:` context, and writes a detailed plan slugged from the milestone's own title (no `-mN` or epic-slug in the filename; `slug.mjs` untouched). M1 keeps the canonical epic `<slug>`; M2+ carry their own milestone-title slug — the epic linkage rides in the plan content, not the slug.

`.hyperclaude/` is gitignored by convention, so `git mv .hyperclaude/<a> .hyperclaude/<b>` fails with "source directory is empty" — use plain `mv`. Tracked files (templates, scripts) still use `git mv`.

**`.hyperclaude/memory/`** is a new artifact area, written on-demand by `hyper-memory` (`scripts/memory/extract.mjs`), not part of the research→ship cycle. `candidates/` holds proposed knowledge candidates mined from the `plans/done/` + `plan-reviews/` + `research/` corpus; they accumulate, deduped idempotently by compound-key filename checked across BOTH `candidates/` AND `promoted/` (so an already-promoted candidate is never resurrected by a later extraction run). Promotion is a plain `mv` from `candidates/` to `promoted/`, gated on the curator first adding a real, live `anchors:` repo path to the candidate — there is no archival step.

## Release flow

When the user asks to release, run the whole flow end to end — don't stop after the commit.

1. **Tests green — re-run immediately before committing**, not "earlier this session": `node --test tests/*.mjs` and `bash scripts/test/smoke.sh`. Unit must report `fail 0`; smoke must report `failed: 0`. Either red → stop and fix first.
2. **Bump `version`** in `.claude-plugin/plugin.json`. **Pre-adoption policy (no installed user base):** a breaking change **or a new feature** rides a **MINOR** bump, not a major — breaking (bridge subcommand renames, frontmatter key changes, artifact directory renames, layer/command/skill removals) and new features (a new skill/command/mode/flag) both count; only fix/docs/internal work is a patch. (We reached `1.0.0` as a *maturity marker* — the design has converged — not as a strict-semver stability contract. Revisit major-on-break once there's a real user base.) The bump rides in the release commit, not a separate one. When the bump changes the `vMAJOR.MINOR` shown in the status banner, also update it in `README.md` and `site/index.html` (search for `the design has converged`) so the user-visible docs match.
3. **Commit + push to `main`.** Conventional-commit subject; breaking changes take a `!` (`feat!:` / `refactor!:`) and a `BREAKING CHANGE:` footer spelling out migration steps. Review `git status` and stage the release's files explicitly — don't blanket `git add -A`. (`.hyperclaude/` is gitignored so its artifacts never appear, but any *other* untracked file would be swept into the release commit.)
4. **Tag:** `git tag -a vX.Y.Z -m "vX.Y.Z: <one-line>"` then `git push origin vX.Y.Z`.
5. **GitHub release:** `gh release create vX.Y.Z --title "..." --notes "..."`. When breaking, the notes must carry a **Migration** section whose steps match the commit's `BREAKING CHANGE:` footer.

## See also

- [docs/architecture.md](docs/architecture.md) — bridge details, mode table, output contract.
- [docs/gates-and-agents.md](docs/gates-and-agents.md) — per-skill / per-agent mechanics.
- [docs/workflow.md](docs/workflow.md) — research → ship cycle, skip rules, `--resume` semantics.
- [docs/decisions.md](docs/decisions.md) — non-obvious "why" notes and active deferrals.
- [docs/development.md](docs/development.md) — local install, tests, full release checklist.
