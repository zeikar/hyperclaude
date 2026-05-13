# Architecture

System layout for hyperclaude — a Claude Code plugin that pairs Claude (builder) with Codex (critic) through a thin bridge.

## Overview

hyperclaude wires three things together:

- **Skills** — instructions that Claude reads when it sees the matching trigger. Each skill is one `SKILL.md` under [skills/](../skills/).
- **Agents** — sub-Claude personas with restricted tool sets. Each is one `<name>.md` under [agents/](../agents/).
- **Bridge** — [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs), a Node 18+ stdlib script that shells out to `codex` and writes structured output under `.hyperclaude/`.

There is no daemon, no MCP server, no shared process state. The bridge runs on demand; skills and agents are static markdown. The primary persisted state is `.hyperclaude/` artifacts — gate runs produce one markdown file each, read back by `--resume` for thread-id discovery; the hyper-loop layer additionally maintains JSON state files whose lifecycle spans multiple turns within a session.

## Directory layout

```
hyperclaude/
├── .claude-plugin/
│   ├── plugin.json              plugin manifest (name, version, repo)
│   └── marketplace.json         marketplace listing (consumed by `/plugin marketplace add`)
├── commands/                    argv-bearing slash commands (e.g. `/hyperclaude:hyper-loop <plan>`). Explicit-gesture entries, distinct from skills' description-triggered dispatch.
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
├── hooks/                       event-bound hook scripts (SessionStart, UserPromptExpansion, Stop)
├── scripts/
│   ├── codex-bridge.mjs         CLI entry; re-exports the helpers below
│   ├── codex/                   bridge modules (slug, frontmatter, git, templates,
│   │                            args, paths, codex spawn + JSONL, failure, resume)
│   └── test/smoke.sh            acceptance smoke checks
├── templates/codex/             prompt templates rendered into Codex stdin
│   ├── research.md
│   ├── plan-review.md
│   ├── plan-review-resumed.md
│   ├── docs-review.md
│   ├── docs-review-resumed.md
│   └── code-review-resumed.md
├── templates/hooks/             hook prompt templates (SessionStart hook reads session-start-reminder.md)
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
   └──────────┬───────────────────────┘    spawns `codex exec` / `codex exec review`
              │
              ▼
   ┌──────────────────────────────────┐
   │ Codex CLI (>= 0.130.0)           │  ← read-only sandbox; exec review subcommand
   └──────────────────────────────────┘
              │
              ▼
   .hyperclaude/{research,plans,plan-reviews,code-reviews,docs-reviews}/
```

Direction:
- Skills call agents (via Claude's `Agent` tool) and call the bridge (via `Bash`). Agents do not call skills.
- Skills are the only layer that shells out to the bridge. Agents stay focused on their narrow job.
- The bridge is the only component that talks to `codex`. Skills never invoke `codex` directly.

## The bridge

CLI entry [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs) plus leaf modules under [scripts/codex/](../scripts/codex/) (slug, frontmatter, git, templates, args, paths, codex spawn + JSONL, failure body, resume). The entry file owns the `main()` mode dispatch; everything else is pure-ish helpers. Four modes, exposed as positional subcommands:

| Mode          | Codex invocation                                  | Template                           | Output dir                       |
|---------------|---------------------------------------------------|------------------------------------|----------------------------------|
| `research`    | `codex exec --sandbox read-only -` (stdin prompt) | [templates/codex/research.md](../templates/codex/research.md)       | `.hyperclaude/research/`         |
| `plan-review` | `codex exec --sandbox read-only -` (stdin prompt) | [templates/codex/plan-review.md](../templates/codex/plan-review.md)         | `.hyperclaude/plan-reviews/`     |
| `code-review` | `codex exec review -c sandbox_mode=read-only [--base \| --uncommitted \| --commit]` | fresh: none — `codex exec review` owns its prompt; resume: [templates/codex/code-review-resumed.md](../templates/codex/code-review-resumed.md) | `.hyperclaude/code-reviews/`     |
| `docs-review` | `codex exec --sandbox read-only -` (stdin prompt) | [templates/codex/docs-review.md](../templates/codex/docs-review.md)    | `.hyperclaude/docs-reviews/`     |

### SessionStart hook

The [SessionStart hook](../hooks/session-start-reminder.mjs) is template-driven: it reads [templates/hooks/session-start-reminder.md](../templates/hooks/session-start-reminder.md) at runtime and injects its contents as `additionalContext`. If the template file is missing, the hook fails open and does not raise an error. This design allows the workflow reminder text to be edited without touching code.

### Hyper-loop (commands + intake/Stop hooks)

Two commands and two hooks form a self-contained ralph-style loop layer over `hyper-implement`.

**Commands:**

- `commands/hyper-loop.md` — `/hyperclaude:hyper-loop <plan-path> [--max=N]`. Starts an iteration loop. Default `--max=10`, range 1–1000. Thin dispatcher; the intake hook does the state work.
- `commands/hyper-loop-cancel.md` — `/hyperclaude:hyper-loop-cancel <plan-path>`. Flips `active: false`. Works even when the plan file has been deleted.

**State files:** `.hyperclaude/loops/<sanitized-slug>__<sanitized-session_id>.json`. Body: `{active, iteration, max, plan_path, session_id, started_at}`. Per-session per-slug. Distinct from the markdown gate-run artifacts.

**Session-scoping mechanism:** The intake hook fires on the `UserPromptExpansion` event, which carries `session_id` in its stdin payload. At command-issue time the hook writes the state file bound to that `session_id`. Markdown commands cannot read `session_id` directly (no env var); the hook does it for them.

**Stop hook:** on each turn the Stop hook scans `.hyperclaude/loops/` for a state file matching the current `session_id` with `active: true`. Three decision branches:

1. **All plan checkboxes done** — blocks with "all plan tasks complete; run /hyperclaude:hyper-code-review then exit".
2. **`iteration >= max`** — blocks with "max iterations reached" plus a cancel/restart suggestion.
3. **Otherwise** — increments `iteration`, blocks with "[HYPER-LOOP iter N/M] K unchecked tasks remain; continue per /hyperclaude:hyper-implement protocol".

Unchecked-checkbox regex: `/^\s*- \[ \]/gm` (leading whitespace allowed — nested checkboxes count). This differs from `session-start-reminder.mjs`'s root-only `/^- \[ \]/gm`.

**Multi-match guard:** if two state files match the same `session_id` with `active: true` (corrupt or manual state), the Stop hook blocks and asks the user to cancel one.

**Recovery path:** if the plan file is missing when the Stop hook runs, it surfaces a quoted cancel command so the user can escape cleanly.

**Invariant:** neither hook spawns codex. This is pure orchestration — the "Claude builds, Codex reviews" model is unchanged.

### Sandbox policy

Three cases, all read-only:

- **Fresh `codex exec`** (`research`, `plan-review`, `docs-review`): passes `--sandbox read-only` flag. Codex cannot write to the workspace regardless of the user's `~/.codex/config.toml` defaults.
- **`codex exec resume`** (`plan-review`, `docs-review`, `code-review` with `--resume`): no `--sandbox` flag; instead passes `-c sandbox_mode=read-only` as a config override (resume does not inherit the original session's sandbox).
- **`codex exec review`** (fresh `code-review`): no `--sandbox` flag; passes `-c sandbox_mode=read-only` as a config override. `codex exec review` is a review-only subcommand and does not author patches.

Net result: Codex is a *critic*, never an *editor*, in every mode.

### CLI surface

```
node scripts/codex-bridge.mjs <mode> [flags]
```

| Mode          | Required flags                                             | Optional flags                                                                       |
|---------------|------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `research`    | `--task <text>` OR `--task-file <path>`                    | `--slug`, `--out`, `--timeout`, `--dry-run`                                          |
| `plan-review` | `--plan-path <path>`                                       | `--resume <path\|auto>`, `--slug`, `--out`, `--timeout`, `--dry-run`                 |
| `code-review` | none — defaults to `--base main`                           | one of `--base <ref>`, `--uncommitted`, `--commit <sha>`; plus `--resume <path\|auto>`, `--title`, `--out`, `--timeout`, `--dry-run` |
| `docs-review` | `--docs-path <file>` OR `--docs-dir <dir>`                 | `--resume <path\|auto>`, `--diff-base <ref>`, `--out`, `--timeout`, `--dry-run`      |

Defaults:

- `--timeout` 300s. Validated as a positive finite number.
- `--out` defaults to the mode-specific output directory listed in the table above (`.hyperclaude/research/`, `.hyperclaude/plan-reviews/`, `.hyperclaude/code-reviews/`, `.hyperclaude/docs-reviews/`).
- `--slug` is auto-derived: from the task text (`research`), the plan filename's slug suffix (`plan-review`), the base ref / commit short SHA / `uncommitted` (`code-review`), or the docs target's basename (`docs-review`). User-provided slugs must match `^[a-z0-9]+(?:-[a-z0-9]+){0,4}$`.
- `--dry-run` for `research` / `plan-review` / `docs-review` validates the template loads but skips the codex spawn; `code-review` dry-run is a pure plan emission and does not require codex on PATH.

### Output contract

Every non-dry-run successful run writes a single markdown file with YAML frontmatter. (`--dry-run` skips the write and prints `{"ok":true,"dryRun":true,"mode":"…","slug":"…","outputPath":"…","timestamp":"…"}` instead.)

The frontmatter shape:

```yaml
---
mode: research | plan-review | code-review | docs-review
slug: <kebab-case>
generated: <ISO-8601 timestamp>
codex-version: <semver from `codex --version`>
template-version: 1                    # research / plan-review / docs-review
task: |-                               # research / plan-review only — block scalar
  <task text or plan path>
cwd: "<absolute path>"                 # always
git-head: "<sha or \"unknown\">"       # always
codex-thread-id: "<uuid>"             # when Codex reports a thread id
codex-resume-status: fresh | resumed | fallback | resume-failed  # always (research is always "fresh")
codex-resumed-from: "<path>"           # when --resume was used and resume succeeded
base-ref / commit / title              # code-review (mode-dependent; uncommitted has none)
plan-path: "<path>"                    # plan-review only
docs-target: "<path>"                  # docs-review
diff-base: "<ref>"                     # docs-review (when --diff-base passed)
---
```

Filename: `<YYYYMMDD-HHMM>-<slug>.md` (UTC). Per-mode slug fallbacks:

- `research` — when the task text is pure non-ASCII or otherwise yields no usable slug, the filename falls back to `<YYYYMMDD-HHMM>.md` (slug omitted entirely). Pass `--slug` to force a specific slug.
- `docs-review` — falls back to the literal `docs` if the docs target's basename can't be slugified, producing `<YYYYMMDD-HHMM>-docs.md`.
- `plan-review` and `code-review` — always derive a slug (from the plan filename or the diff target), so the timestamp-only fallback does not apply.

On collision, the bridge appends `-2`, `-3`, … until free.

On success (non-dry-run, `plan-review` / `docs-review` / `code-review`) the script exits 0 and prints `{"ok":true,"path":"…","slug":"…","threadId":"<uuid>","resumeStatus":"<state>"}`. On failure those modes print `{"ok":false,"error":"…","path":"<path|null>","resumeStatus":"<state>","threadId":"<uuid|null>"}`. Research success / failure uses the same v0.3 shape (no `threadId` / `resumeStatus` exposed). `--dry-run` skips the write and prints `{"ok":true,"dryRun":true,"mode":"…","slug":"…","outputPath":"…","timestamp":"…"}` (unchanged for all modes).

Exits are: argv errors (exit 2), missing/unreadable input (exit 1), failed `git diff` for `--diff-base` (exit 1), template load failures (exit 1), Codex spawn / non-zero / timeout (exit 1), oversized payloads (exit 1, with byte count), resume budget exceeded (exit 1; no fallback). Filesystem failures during output (`mkdir`, `writeFile`) propagate as unhandled rejections — they only fire when the caller's `.hyperclaude/` directory is unwritable. Even on Codex failure the file is still written with a structured failure body (see below).

### Failure artifact body shape

When Codex exits non-zero or times out (plan-review / docs-review / code-review), the bridge still writes the artifact. The body follows a fixed structure produced by `renderFailureBody`:

```
# (codex failed)

## JSONL parser report
- thread.started: <yes|no, thread_id if yes>
- turn.completed: <yes|no>
- turn.failed: <yes|no, message if yes>
- top-level error events: <count> (last 3 messages: ...)
- malformed lines: <count>

## Last message (from --output-last-message)
<contents if non-empty, else "(empty)">

## stderr
<verbatim stderr from the Codex process>

## Exit
status=<code|null>, signal=<name|null>, timed-out=<bool>
```

Output is always to the file-per-run (tmpfile body + stderr), never just to stdout. `codex-resume-status` in frontmatter is set to `resume-failed` when the failure occurs on a resume spawn; otherwise follows the normal status.

### Size guards

- `docs-review` rejects docs payloads `> 200KB` (`--docs-dir` aggregates all top-level `.md` files; recursion is deferred — see [decisions.md](decisions.md)).
- `docs-review --diff-base <ref>` runs `git diff <ref>...HEAD` (symmetric-difference, i.e. changes on HEAD since the merge-base with `<ref>`) and rejects diffs `> 500KB`.

These are bridge-level guards. The corresponding Codex context limits are larger; the lower numbers exist to fail fast before the spawn.

## Artifacts

Codex gates and Claude-authored plans write artifacts to `.hyperclaude/` in the *consumer* project (not in the plugin install dir). `hyper-docs-sync` is the exception — it edits documentation files directly and produces no `.hyperclaude/` artifact. The directory is created on first use; users who don't want artifacts committed should add `.hyperclaude/` to `.gitignore`.

```
.hyperclaude/
├── research/        Codex research outputs (research mode)
├── plans/           Claude-authored implementation plans (manual; the slug feeds plan-reviews/)
├── plan-reviews/    Codex critiques of plans (plan-review mode)
├── code-reviews/    Codex code-review outputs (code-review mode)
├── docs-reviews/    Codex docs accuracy outputs (docs-review mode)
└── loops/           JSON state files for hyper-loop; per-session per-slug; distinct from the markdown gate-run artifacts
```

Naming is consistent across all subdirs: `<YYYYMMDD-HHMM>-<slug>.md`. The slug is the trace key — a `research` slug carries through to the `plan` written by Claude, then into the `plan-review` of that plan. The bridge's `extractSlugFromPlanFilename()` reuses the slug from a plan filename when invoking `plan-review`, so the trio shares a slug end-to-end.

For the per-artifact frontmatter shapes, see "Output contract" above.

## External dependencies

- **Claude Code plugin runtime** — distribution channel, slash command resolution, agent dispatch.
- **`codex-cli >= 0.130.0`** — version-checked via `codex --version` before spawning Codex on non-dry-run calls. Argv parsing always runs first; subsequent ordering is mode-specific. `docs-review` reads the docs payload and runs the 200KB guard before the version check; `--diff-base` diff capture and its 500KB guard happen after the version check. `plan-review` reads the plan file after the version check, so a missing plan path surfaces *after* the version-check error if both are wrong simultaneously. Older Codex versions fail fast with an upgrade hint.
- **Node 18+** — bridge uses `node:fs/promises`, `node:fs` (`existsSync`), `node:child_process`, `node:path`, `node:url`, `node:os`, `node:crypto`. No npm packages.
- **`git`** — required for diff-backed gates: `code-review` (always), `docs-review` (when `--diff-base` is passed), and `hyper-docs-sync` (always — the skill uses git diff to determine what changed).

No other runtime dependencies. No MCP server, no tmux, no daemons, no npm bin.

## See also

- [gates-and-agents.md](gates-and-agents.md) — what each skill and agent does, when to use them.
- [workflow.md](workflow.md) — the end-to-end dogfooding cycle.
- [development.md](development.md) — local dev install, tests, release flow.
- [decisions.md](decisions.md) — non-obvious "why" notes and active deferrals.
