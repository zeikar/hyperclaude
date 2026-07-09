# Architecture

System layout for hyperclaude — a Claude Code plugin that pairs Claude (builder) with Codex (critic) through a thin bridge.

## Overview

hyperclaude wires three things together:

- **Skills** — instructions that Claude reads when it sees the matching trigger. Each skill is one `SKILL.md` under [skills/](../skills/). One skill, `hyper-setup`, is **invoke-only** (`disable-model-invocation: true`): a local prerequisite probe run only on explicit `/hyperclaude:hyper-setup`, never auto-triggered, and it never spawns Codex.
- **Agents** — sub-Claude personas with restricted tool sets. Each is one `<name>.md` under [agents/](../agents/).
- **Bridge** — [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs), a Node 18+ stdlib script that shells out to `codex` and writes structured output under `.hyperclaude/`.

There is no daemon, no MCP server, no shared process state — with three documented exceptions, all in the autonomous-loop family: `hyper-plan-loop` spawns a `planner` agent as a persistent team teammate (via Claude Code's experimental agent-teams feature) that retains context across revise iterations for the duration of the loop; `hyper-implement-loop` spawns a `fixer` agent as a persistent team teammate in the same way for its implement-hardening loop; and `hyper-docs-loop` spawns the `documenter` agent (the same agent `hyper-docs-sync` normally dispatches stateless-per-doc) as a persistent team teammate for its docs-hardening loop. In all three loops, every lead→teammate send runs the §A send-resolution procedure: the main path sends `to: teammate_name` (bare name) — the live mailbox routes it directly. Degraded-host addressing (`agent_id` fallback), notification-reply driving (condition (2) re-scoped to deterministic DRIVING), and no-wait degrade teardown are isolated in the removable `§A-DEGRADE` override in `references/loop-protocol.md`; nothing in the main path depends on them. `loop-protocol.md` also carries the shared **§F loop skeleton** — the common Step 0/2/4a/8 boilerplate and degrade-condition pointers — that the three loop SKILLs bind to by pointing at its named §F sub-blocks (F1–F5) rather than restating the prose (§F6 is the skeleton's own degrade-condition pointer to §A-DEGRADE D1/D2/D3 — the SKILLs reference §A-DEGRADE directly via their [DEGRADE] lines, not §F6); loop-specific reply-shape and validation still live in each loop's local `failure-protocol.md`. Conditions (1) and (3) (no usable handle) remain STOP. Teardown on the main path sends a `{ type: "shutdown_request" }` object to bare `teammate_name` best-effort once and does NOT wait for confirmation. In `hyper-plan-loop`, the persistent planner teammate also writes the plan file directly at the lead-resolved path (caller-directed write-file mode), eliminating per-iteration plan-body round-trips. This write-file behavior is scoped to `hyper-plan-loop`; the fixer in `hyper-implement-loop` and the documenter in `hyper-docs-loop` apply edits in place (no canonical output file) and deliver results via `SendMessage` — they do NOT use caller-directed write-file mode. Other agents' existing tool permissions and dispatch semantics are unchanged; stock `hyper-plan` still has the skill own the Write, and `hyper-docs-sync` still dispatches `documenter` stateless-per-doc in its UPDATE/CREATE mode. All other skills and agents are stateless and fresh-per-task. The bridge runs on demand; skills and agents are static markdown. The primary persisted state is `.hyperclaude/` artifacts — individual bridge invocations produce one markdown file each, read back by `--resume` for thread-id discovery; the default `hyper-research` invocation produces a Codex+Claude pair sharing one `slug:`, and loop skills accumulate multiple per-iteration artifacts.

## Directory layout

```
hyperclaude/
├── .claude-plugin/
│   ├── plugin.json              plugin manifest (name, version, repo)
│   └── marketplace.json         marketplace listing (consumed by `/plugin marketplace add`)
├── skills/                      one directory per skill, each with SKILL.md
│   ├── hyper-setup/             invoke-only — prerequisite doctor (/hyperclaude:hyper-setup; no Codex, no agents)
│   ├── hyper-interview/         gate — Claude requirements-clarification interview (no Codex)
│   ├── hyper-research/          gate — Codex research
│   ├── hyper-plan/              gate — Claude plan generator (dispatches planner agent)
│   ├── hyper-plan-review/       gate — Codex plan critique
│   ├── hyper-code-review/       gate — Codex code review
│   ├── hyper-docs-sync/         gate — Claude doc sync orchestrator
│   ├── hyper-docs-review/       gate — Codex doc accuracy review
│   ├── hyper-plan-loop/         gate — autonomous plan-revise loop (persistent planner teammate)
│   ├── hyper-implement-loop/    gate — autonomous implement-hardening loop (persistent fixer teammate)
│   ├── hyper-docs-loop/         gate — autonomous docs-hardening loop (persistent documenter teammate)
│   ├── hyper-auto/              gate — chain plan-loop into implement-loop in one gesture
│   ├── hyper-memory/            orchestration-only — extracts repo-local knowledge candidates (no Codex)
│   ├── hyper-implement/         helper — plan execution loop
│   ├── hyper-tdd/               helper — TDD discipline
│   └── hyper-debug/             helper — debugging discipline
├── agents/                      sub-Claude personas (planner, implementer, verifier, documenter, researcher, fixer)
├── references/                  plugin-wide reference content not owned by any single skill (currently: loop-protocol.md — Step-0 base for hyper-plan-loop, hyper-implement-loop, and hyper-docs-loop; carries §A–§E for the agent-teams contract/state-machine PLUS the shared §F loop skeleton — Step 0/2/4a/8 boilerplate + degrade-condition pointers — that each SKILL binds by pointing at the named §F sub-blocks; the §A-DEGRADE section is the removable degraded-host override — see decisions.md 2026-06-21)
├── hooks/                       event-bound hook scripts
│   ├── hooks.json               hook manifest (registered SessionStart + PostToolUse hooks)
│   ├── session-start-reminder.mjs  SessionStart reminder (injects workflow-router template)
│   └── stamp-artifact.mjs       PostToolUse(Write) stamp (injects plugin-version into artifacts)
├── scripts/
│   ├── codex-bridge.mjs         CLI entry; re-exports the helpers below
│   ├── setup-doctor.mjs         standalone local probe (non-bridge; never spawns Codex)
│   ├── codex/                   bridge modules (slug, frontmatter, git, templates,
│   │                            args, paths, codex spawn + JSONL, failure, resume)
│   ├── memory/extract.mjs       hyper-memory extraction module (non-bridge; never spawns Codex)
│   └── test/smoke.sh            acceptance smoke checks
├── templates/codex/             prompt templates rendered into Codex stdin
│   ├── research.md
│   ├── plan-review.md
│   ├── plan-review-resumed.md
│   ├── docs-review.md
│   ├── docs-review-resumed.md
│   ├── code-review.md
│   └── code-review-resumed.md
├── templates/hooks/             hook prompt templates (SessionStart reads session-start-reminder.md, or -loop.md when agent-teams is on)
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
   │ Skills (gates + helpers)         │  ← description-triggered /hyperclaude:hyper-* skills
   └──────────┬───────────────────────┘
              │ dispatches Agent / runs Bash / writes files
              ▼
   ┌──────────────────────────────────┐
   │ Agents (planner / implementer /  │  ← fresh sub-Claude per task,
   │   verifier / documenter /        │    restricted tool set
   │   researcher / fixer)            │    (exceptions: hyper-plan-loop keeps
   │                                  │    planner as a live teammate via
   │                                  │    experimental agent-teams; the planner
   │                                  │    also writes the plan file directly in
   │                                  │    caller-directed write-file mode.
   │                                  │    hyper-implement-loop keeps fixer as a
   │                                  │    live teammate; fixer edits in place,
   │                                  │    no canonical output file.
   │                                  │    hyper-docs-loop keeps documenter as a
   │                                  │    live teammate; documenter edits in
   │                                  │    place, no canonical output file)
   └──────────┬───────────────────────┘
              │ skills (not agents) shell out
              ▼
   ┌──────────────────────────────────┐
   │ Bridge — scripts/codex-bridge.mjs│  ← Node 18+ stdlib script,
   └──────────┬───────────────────────┘    spawns `codex exec` / `codex exec resume`
              │
              ▼
   ┌──────────────────────────────────┐
   │ Codex CLI (>= 0.130.0)           │  ← read-only sandbox; critic, never editor
   └──────────────────────────────────┘
              │
              ▼
   .hyperclaude/{research,plans,epics,plan-reviews,code-reviews,docs-reviews}/
```

Direction:
- Skills call agents (via Claude's `Agent` tool) and call the bridge (via `Bash`). Agents do not call skills.
- Skills are the only layer that shells out to the bridge. Agents stay focused on their narrow job.
- The bridge is the only component that talks to `codex`. Skills never invoke `codex` directly.

`hyper-setup` is an invoke-only skill, not a gate: its frontmatter carries `disable-model-invocation: true`, so it runs only on an explicit `/hyperclaude:hyper-setup` and is never auto-triggered by its description or preloaded into subagents. It runs `scripts/setup-doctor.mjs` — a standalone local probe that checks Node, codex-cli, git, and the agent-teams env var. `setup-doctor.mjs` is not part of the Codex bridge and never spawns Codex. (Historical note: hyper-setup was the plugin's one `commands/*.md` entry until Claude Code merged plugin commands into skills; the invoke-only guard now depends on a Claude Code that honors `disable-model-invocation`, present since ~v2.1.126 — see decisions.md.)

## The bridge

CLI entry [scripts/codex-bridge.mjs](../scripts/codex-bridge.mjs) plus leaf modules under [scripts/codex/](../scripts/codex/) (slug, frontmatter, git, templates, args, paths, codex spawn + JSONL, failure body, resume). The entry file owns the `main()` mode dispatch; everything else is pure-ish helpers. Four modes, exposed as positional subcommands:

| Mode          | Codex invocation                                  | Template                           | Output dir                       |
|---------------|---------------------------------------------------|------------------------------------|----------------------------------|
| `research`    | `codex --search exec --sandbox read-only -` (stdin prompt) | [templates/codex/research.md](../templates/codex/research.md)       | `.hyperclaude/research/`         |
| `plan-review` | `codex --search exec --sandbox read-only -` (stdin prompt) | [templates/codex/plan-review.md](../templates/codex/plan-review.md)         | `.hyperclaude/plan-reviews/`     |
| `code-review` | `codex --search exec --sandbox read-only -` (stdin prompt; Codex runs the target git commands itself) | fresh: [templates/codex/code-review.md](../templates/codex/code-review.md); resume: [templates/codex/code-review-resumed.md](../templates/codex/code-review-resumed.md) | `.hyperclaude/code-reviews/`     |
| `docs-review` | `codex --search exec --sandbox read-only -` (stdin prompt) | [templates/codex/docs-review.md](../templates/codex/docs-review.md)    | `.hyperclaude/docs-reviews/`     |

### SessionStart hook

The [SessionStart hook](../hooks/session-start-reminder.mjs) is template-driven: it reads a workflow-router template at runtime and injects its contents as `additionalContext`. Which template is **env-aware** — it matches setup-doctor's `=== '1'` check on `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS`: when set, it reads the loop-first [templates/hooks/session-start-reminder-loop.md](../templates/hooks/session-start-reminder-loop.md) (the autonomous `*-loop` / `hyper-auto` skills become the default recommendation for non-trivial multi-step work, with single-step work still routed direct); otherwise it reads the manual-first [templates/hooks/session-start-reminder.md](../templates/hooks/session-start-reminder.md). Gating on the env var keeps the hook from steering a host without agent-teams toward skills that would immediately hit their fallback. If the selected template file is missing, the hook fails open and does not raise an error. This design allows the workflow reminder text to be edited without touching code.

### PostToolUse stamp hook

The [stamp hook](../hooks/stamp-artifact.mjs) (`PostToolUse`, matcher `Write`) gives **Claude-authored** `.hyperclaude/` artifacts the same `plugin-version` provenance the bridge writes into its own artifacts — without depending on the model to author the line. On every `Write` it checks whether `tool_input.file_path` resolves under `<cwd>/.hyperclaude/` and ends in `.md`; if so, and the file lacks a `plugin-version:` frontmatter line, it injects one (reusing `getPluginVersion()` from [scripts/codex/plugin.mjs](../scripts/codex/plugin.mjs), so the recorded version is the loaded copy's — identical to the bridge). It is:

- **Deterministic** — runs regardless of what the model "remembered"; covers plans, epic roadmaps, and the Claude-authored research artifact uniformly.
- **Idempotent** — skips any file that already carries `plugin-version`. Bridge artifacts already do (and are written via `fs`, not the `Write` tool, so the hook never fires for them); a re-`Write` of a stamped plan is a no-op.
- **Fail-open** — any error (bad stdin, unreadable file) exits 0 with `{continue:true,suppressOutput:true}`; it never blocks the tool flow.

Consequence: a detailed plan that the planner authored frontmatter-free still ends up with a leading `---\nplugin-version: <v>\n---` block on disk. This is provenance only — it carries no `tier:` marker, so `hyper-implement`'s epic guard (which keys on `tier: epic`) is unaffected.

### Sandbox policy

Three cases, all read-only:

- **Fresh `codex exec`** (`research`, `plan-review`, `docs-review`, `code-review`): passes `--sandbox read-only` flag. Codex cannot write to the workspace regardless of the user's `~/.codex/config.toml` defaults. Fresh `code-review` is no longer the native `codex exec review` subcommand — it is a regular `codex exec --sandbox read-only -` spawn with a rendered prompt ([templates/codex/code-review.md](../templates/codex/code-review.md)); the prompt instructs Codex to run the target git commands itself to collect the diff (read-only sandbox permits running git).
- **`codex exec resume`** (`plan-review`, `docs-review`, `code-review` with `--resume`): no `--sandbox` flag; instead passes `-c sandbox_mode=read-only` as a config override (resume does not inherit the original session's sandbox).

Net result: Codex is a *critic*, never an *editor*, in every mode.

Every spawn also prepends the global `--search` flag (before the subcommand): `codex --search exec …`. This enables live web search unconditionally across all modes, fresh and resume. `--search` does not relax `--sandbox read-only`; the filesystem invariant is unchanged.

### CLI surface

```
node scripts/codex-bridge.mjs <mode> [flags]
```

| Mode          | Required flags                                             | Optional flags                                                                       |
|---------------|------------------------------------------------------------|--------------------------------------------------------------------------------------|
| `research`    | `--task <text>` OR `--task-file <path>`                    | `--model <name>`, `--effort <low\|medium\|high\|xhigh>`, `--slug`, `--out`, `--timeout`, `--dry-run` |
| `plan-review` | `--plan-path <path>`                                       | `--model <name>`, `--effort <low\|medium\|high\|xhigh>`, `--resume <path\|auto>`, `--slug`, `--out`, `--timeout`, `--dry-run` |
| `code-review` | none — defaults to `--base main`                           | `--model <name>`, `--effort <low\|medium\|high\|xhigh>`; one of `--base <ref>`, `--uncommitted`, `--commit <sha>`; plus `--resume <path\|auto>`, `--background <text>` (fresh only — rejected with `--resume`), `--title`, `--out`, `--timeout`, `--dry-run` |
| `docs-review` | `--docs-path <file>` OR `--docs-dir <dir>`                 | `--model <name>`, `--effort <low\|medium\|high\|xhigh>`, `--resume <path\|auto>`, `--diff-base <ref>`, `--out`, `--timeout`, `--dry-run` |

Defaults:

- `--timeout` 600s. Validated as a positive finite number. (Large code-review diffs can exceed 5 min on a fresh Codex thread; 600s default avoids token waste from premature timeouts. Pass an explicit `--timeout` for niche cases.)
- `--out` defaults to the mode-specific output directory listed in the table above (`.hyperclaude/research/`, `.hyperclaude/plan-reviews/`, `.hyperclaude/code-reviews/`, `.hyperclaude/docs-reviews/`).
- `--slug` is auto-derived: from the task text (`research`), the plan filename's slug suffix (`plan-review`), the base ref / commit short SHA / `uncommitted` (`code-review`), or the docs target's basename (`docs-review`). User-provided slugs must match `^[a-z0-9]+(?:-[a-z0-9]+){0,4}$`.
- `--dry-run` validates argv and that the mode's prompt template loads (uniformly for all four modes, including `code-review`), then skips the codex spawn. It does not require codex on PATH.
- `--model <name>` has no default. When omitted, Codex inherits the user's `~/.codex/config.toml` model setting. Any non-empty, non-leading-dash string is accepted (e.g. `openai/gpt-5`); the bridge passes it to `codex` as `--model <name>`. Available on all four modes; v1 is bridge-only (not exposed via slash commands / SKILL.md).
- `--effort <low|medium|high|xhigh>` has no default. When omitted, Codex inherits the user's `~/.codex/config.toml` reasoning-effort setting. Valid values are exactly `low`, `medium`, `high`, `xhigh`; `none` and `minimal` are rejected (not a supported exec reasoning level). The bridge passes it as `-c model_reasoning_effort=<value>`. Available on all four modes; v1 is bridge-only.

When either flag is passed the selection tokens are inserted into the semantic argv **after** the subcommand and **before** `--sandbox read-only` (fresh) or before `-c sandbox_mode=read-only` (resume), preserving the [sandbox invariant](#sandbox-policy) in all cases.

`--background <text>` (code-review fresh only): an optional free-text field describing what changed and why. The bridge renders it into the `{{REVIEW_BACKGROUND}}` slot of the fresh `code-review` prompt template (v3). When absent the slot renders as an empty string (no-op). When present the bridge injects a fenced `### Change context` block marked as untrusted DATA (with a fence-collision guard) plus a static template instruction to treat it as data, not instructions. Rejected with an error if `--resume` is also passed.

### Output contract

Every non-dry-run successful run writes a single markdown file with YAML frontmatter. (`--dry-run` skips the write and prints `{"ok":true,"dryRun":true,"mode":"…","slug":"…","outputPath":"…","timestamp":"…"}` instead.)

The frontmatter shape:

```yaml
---
mode: research | plan-review | code-review | docs-review
slug: <kebab-case>
generated: <ISO-8601 timestamp>
plugin-version: <hyperclaude version of the loaded copy that ran, or "unknown">
codex-version: <semver from `codex --version`>
template-version: <N>                  # from the fresh template's own frontmatter — research/docs-review: 1, plan-review: 2, code-review: 3
task: |-                               # research / plan-review only — block scalar
  <task text or plan path>
cwd: "<absolute path>"                 # always
git-head: "<sha or \"unknown\">"       # always
codex-thread-id: "<uuid>"             # when Codex reports a thread id
codex-resume-status: fresh | resumed | fallback | resume-failed  # always (research is always "fresh")
codex-resumed-from: "<path>"           # when --resume was used and resume succeeded
codex-model-requested: "<name>"        # only when --model was passed (omitted when not)
codex-effort-requested: "<level>"      # only when --effort was passed (omitted when not)
codex-input-tokens: <N>               # present when that specific usage field was non-null in turn.completed.usage (even on failure artifacts); omitted otherwise
codex-cached-input-tokens: <N>        # same per-field gate
codex-output-tokens: <N>              # same per-field gate
codex-reasoning-output-tokens: <N>    # same per-field gate; no total key (source has no total_tokens); in practice all four appear together when codex-cli >= 0.130.0 emits usage
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
├── specs/           Claude-authored specs from hyper-interview (front-end input to research/plan; slug mints the trace)
├── research/        Codex research outputs (research mode)
├── plans/           Claude-authored implementation plans (manual; the slug feeds plan-reviews/)
├── epics/           Claude-authored epic roadmaps (tier: epic) for oversized tasks; hyper-implement refuses these
├── plan-reviews/    Codex critiques of plans (plan-review mode)
├── code-reviews/    Codex code-review outputs (code-review mode)
├── docs-reviews/    Codex docs accuracy outputs (docs-review mode)
└── memory/          hyper-memory candidates/ + promoted/ (see below; not part of the research→ship cycle)
```

Naming is consistent across all subdirs: `<YYYYMMDD-HHMM>-<slug>.md`. The slug is the trace key — a `research` slug carries through to the `plan` written by Claude, then into the `plan-review` of that plan. The bridge's `extractSlugFromPlanFilename()` reuses the slug from a plan filename when invoking `plan-review`, so the trio shares a slug end-to-end.

The `specs/` artifact is **Claude-authored** (from `hyper-interview`, like plans) — not a bridge output, so its frontmatter is the skill-defined set `mode: interview`, `idea`, `slug`, `generated`, `type: greenfield|brownfield`, plus the PostToolUse-hook-added `plugin-version`. It does NOT carry the bridge's `codex-*` / `template-version` keys. The `slug` is minted from the idea text with the same deterministic rule `research`/`plan` use, so carrying the idea forward keeps the trace linked.

### `memory/` — repo-local knowledge candidates

`.hyperclaude/memory/` is written on-demand by `hyper-memory` (`scripts/memory/extract.mjs`), not by a bridge mode — it spawns NO Codex. Layout:

```
.hyperclaude/memory/
├── candidates/      proposed, unreviewed knowledge candidates
└── promoted/        human-curated, accepted candidates
```

Each candidate is one file named `<compound-key>.md`, where the compound key is a 12-char hex slice of a sha256 hash over `mode`, `slug`, `generated`, `git-head`, and `claim` (never the slug alone — slugs are not unique across artifacts). The extractor scans `plans/done/`, `plan-reviews/` (ship-as-is verdicts only), and `research/`, copying an exact verbatim span per artifact (a research bullet, a plan-review verdict line, or a plan's H1 title) — no summarization. Candidate frontmatter: `plugin-version`, `type`, `source-artifact`, `anchors`, `mode`, `slug`, `git-head`, `generated`, `staleness`; body: `## Claim` + `## Evidence` (the verbatim span).

`source-artifact:` and `anchors:` are deliberately distinct fields: `source-artifact:` is evidence provenance (the `.hyperclaude/**` artifact the span was mined from — a gitignored artifact, not a canonical repo source); `anchors:` is a YAML list of live canonical repo source/doc paths the claim is *about*, and the extractor **always** emits `anchors: []` — none of the three v1 sources deterministically names a real repo file. Promotion requires a human curator to first add at least one real, on-disk repo path to `anchors:`, then plain `mv` the file from `candidates/` to `promoted/` (not `git mv` — `.hyperclaude/` is gitignored). Idempotency is checked across BOTH directories: a candidate whose compound-key file exists in EITHER `candidates/` OR `promoted/` is skipped on re-run, so a promoted candidate is never resurrected. There is no archival step for `memory/` — rejection is a plain `rm` of the candidate file.

The module reuses `parseFrontmatter` (re-exported from `scripts/codex/frontmatter.mjs`), `extractSlugFromPlanFilename` (from `scripts/codex/slug.mjs`), and `getPluginVersion` (from `scripts/codex/plugin.mjs`). It authors its own `plugin-version` line at write time — unlike Claude-authored plans/specs, the PostToolUse stamp hook does not apply here, because the hook fires only on the `Write` tool and this module writes via `node:fs/promises`.

For the per-artifact frontmatter shapes of the bridge-authored gates, see "Output contract" above.

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
