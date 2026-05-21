# Workflow

The end-to-end cycle hyperclaude is built around. This is the dogfooding loop the author actually runs to ship its own releases.

Before running any gate for the first time, run `/hyperclaude:hyper-setup` to diagnose host prerequisites (Node 18+, codex-cli >= 0.130.0, git, and the optional `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var for `hyper-plan-loop`, `hyper-implement-loop`, and `hyper-auto` which chains both).

For per-skill mechanics, see [gates-and-agents.md](gates-and-agents.md). For the bridge details, see [architecture.md](architecture.md).

## The cycle

```
            ┌─ refine ─┐            ┌──── fix ───┐            ┌──── fix ───┐
            ▼          │            ▼            │            ▼            │
research → plan → plan-review → implement → code-review → docs-sync → docs-review → ship
   │         │         │            │            │            │            │           │
Codex     Claude     Codex     Claude(+agents) Codex      Claude       Codex        user
```

Each step has a single concrete trigger and a single concrete output. Slugs propagate so a release's research, plan, and review can be paired by name.

---

## 1. Research — surfaces context

```
/hyperclaude:hyper-research add OAuth login to the API
```

By default, research runs **both Codex and Claude in parallel**, producing a pair: `.hyperclaude/research/<timestamp>-add-oauth-login-to-the.md` (Codex, read-only sandbox, live web search via `--search`) and `.hyperclaude/research/<timestamp>-add-oauth-login-to-the-claude.md` (the `researcher` agent, dispatched in the background — `WebFetch` on known URLs, not a web-search substitute). Read both. Don't skip the Pitfalls section.

A single path runs only on an explicit "Codex only" / "Claude only / no-Codex / second-opinion" request — a plain-language intent rule, not a flag. Either way, every artifact carries the same always-present frontmatter keys and section structure, and a pair shares one `slug:`. Trio traceability (`research → plan → plan-review`) is preserved by that shared frontmatter slug — the downstream `hyper-plan` ingests both files of the pair.

When to skip: the task is mechanical (rename, dep bump, one-file fix).

## 2. Plan — Claude writes an ordered plan

```
/hyperclaude:hyper-plan [task]
```

Dispatches the `planner` agent and writes the result to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`. With no argument, the skill pulls task + slug from the most recent `hyper-research` artifact; with an explicit task, it reuses the matching research slug if one exists so the `research → plan → plan-review` trio links by name.

You can still dispatch the `planner` agent directly, or write the plan inline, when the skill's defaults don't fit. Plans are markdown with `## Task N: <title>` headings, files-to-create/modify, step checkboxes, verification commands, and a commit message line.

`.hyperclaude/` is gitignored by convention — plans are working artifacts, lifted into the spec / README only when load-bearing.

## 3. Plan review — Codex critiques the plan

```
/hyperclaude:hyper-plan-review
```

Auto-discovers the most recent plan in `.hyperclaude/plans/`. Writes `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` with Issues (Blocker / Major / Minor), Improvements, and Verdict.

Iterate: refine the plan, re-run `hyper-plan-review`. One or two refinement passes is normal; more than three usually means the plan was scoped too large — split it.

Do NOT proceed to implement while Blocker-severity issues are unresolved.

**Autonomous alternative:** `/hyperclaude:hyper-plan-loop` combines steps 2–3 into a single gesture — it spawns the `planner` agent as a persistent team teammate, the planner writes the plan file itself at the lead-resolved path (no per-iteration plan-body round-trip; the planner idles between turns), the lead runs Codex `plan-review` via the bridge, sends findings back to the planner for revision, and repeats until no Blocker or Major issues remain (10 severity-gated reviews + at most one final Minor-cleanup re-review); when only a concrete actionable Minor remains the loop runs exactly one final cleanup revision and re-review then hard-stops — it never recurses on Minor. Both `hyper-plan` + `hyper-plan-review` and `hyper-plan-loop` are available; use whichever fits your workflow. `hyper-plan-loop` requires Claude Code's experimental agent-teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). (Implementation note: `hyper-plan-loop`'s lead↔planner protocol — request-id state machine, unsolicited-message handling, teardown — lives in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`, a shared base intended for any future autonomous-loop skill; `hyper-plan-loop`'s local `references/failure-protocol.md` binds it to the loop-specific reply shape and validation. Invisible at the user-facing cycle level, but explains the structure should you read the SKILL.md sources.)

## 4. Implement — execute the plan task by task

```
/hyperclaude:hyper-implement
```

For each `## Task N:` in the plan, this skill:

1. Dispatches a fresh `implementer` subagent for the task.
2. Dispatches a general-purpose subagent for **spec compliance review** (does the diff actually match what the plan said?).
3. Dispatches another general-purpose subagent for **code quality review** (clarity, YAGNI, test quality, severity-tagged issues).
4. Dispatches the `verifier` agent if tests / build steps are involved.
5. Marks the task complete and moves on.

Fix loops happen inline — reviewer ❌ → implementer fixes → re-review. The skill does not pause for user input between tasks; it executes the whole plan.

When to skip the skill: one-step plans (just dispatch `implementer` directly), tightly-coupled tasks that benefit from shared context, or fast prototyping.

**Autonomous alternative:** `/hyperclaude:hyper-implement-loop` combines steps 4–5 into a single gesture — it creates the team FIRST (the `TeamCreate` probe is what makes an agent-teams-unavailable host fail as a clean no-op before any tree mutation), runs `hyper-implement` to completion (boundary A; hyper-implement's own optional final code-review is suppressed so the loop's first review is the single authoritative one), then spawns the `fixer` agent as a persistent teammate — only *after* implementation finishes, since spawning earlier buys no context (hyper-implement builds with its own fresh subagents the fixer never observes) — then invokes Codex `code-review --base main` via the bridge, sends blocking findings to the fixer via SendMessage, and repeats until no blocking findings remain (6-review cap). Both `hyper-implement` + `hyper-code-review` and `hyper-implement-loop` are available; use whichever fits your workflow. `hyper-implement-loop` requires Claude Code's experimental agent-teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).

**Full-chain alternative:** `/hyperclaude:hyper-auto <task>` chains steps 2–3 (plan-loop) into steps 4–5 (implement-loop) in one gesture — it runs `hyper-plan-loop` to terminal state, branches on the result (clean exit proceeds; cap-reached / terminal revise-regression / any other terminal failure stops without entering the implement phase, so the implement budget is never spent on a non-converged plan), then runs `hyper-implement-loop` against the canonical plan path. Use when you want plan-harden + implement-harden without manually invoking each. Inherits both inner loops' agent-teams requirement.

## 5. Code review — Codex critiques the diff

```
/hyperclaude:hyper-code-review
```

Default: branch diff vs `main`. Variants:

```
/hyperclaude:hyper-code-review uncommitted        # working-tree changes
/hyperclaude:hyper-code-review <commit-sha>       # specific commit
/hyperclaude:hyper-code-review vs <ref>           # vs an arbitrary base
```

Writes `.hyperclaude/code-reviews/<timestamp>-<slug>.md`. Read findings; fix what matters before shipping.

This is the post-implement gate. The two reviews inside `hyper-implement` catch per-task drift; this one catches cross-task issues.

## 6. Docs sync — Claude updates docs to match code

```
/hyperclaude:hyper-docs-sync uncommitted
```

Same target contract as `hyper-code-review`. The skill:

1. Resolves the changed files via git.
2. Reads the `Code | Docs` mapping table from `CLAUDE.md` / `AGENTS.md` (or falls back to filename-stem heuristics).
3. Aggregates diffs per affected doc.
4. Dispatches the `documenter` agent once per doc — UPDATE mode if the file exists, CREATE mode if not.

The doc edits are the artifact. No `.hyperclaude/` file is written.

If the project has no mapping table, the skill ends its report with a starter table inferred from this run's matches — paste it into `CLAUDE.md` so future runs are precise.

## 7. Docs review — Codex gates docs accuracy

```
/hyperclaude:hyper-docs-review
```

Default: top-level `.md` files in `docs/`. Variants:

```
/hyperclaude:hyper-docs-review README.md                       # single file
/hyperclaude:hyper-docs-review docs/api/                       # specific subdir
/hyperclaude:hyper-docs-review README.md --diff-base main      # with code-diff context
```

Writes `.hyperclaude/docs-reviews/<timestamp>-<slug>.md`. Scope is strict: accuracy / drift / completeness / broken links / cross-doc inconsistencies. NOT prose or style — the documenter agent owns those.

Fix accuracy issues before merging or shipping.

## Resuming a review

When you fix issues raised by `plan-review` or `docs-review` and want a re-critique without re-uploading the full payload, use `--resume`:

```text
# After fixing the plan
/hyperclaude:hyper-plan-review --resume

# After fixing the docs
/hyperclaude:hyper-docs-review --resume
```

Without an artifact path, `--resume` auto-discovers the most recent matching prior review under `.hyperclaude/<mode-dir>/`. With an explicit path:

```text
/hyperclaude:hyper-docs-review --resume .hyperclaude/docs-reviews/20260510-1300-architecture.md
```

Code review also supports resume:

```text
# After fixing code issues
/hyperclaude:hyper-code-review --resume

# With an explicit prior review
/hyperclaude:hyper-code-review --resume .hyperclaude/code-reviews/20260510-1430-vs-main.md
```

Resume reuses the prior Codex thread. The bridge sends a small follow-up — plan/docs modes say "the file has been revised; re-read it"; code-review embeds the exact git command (`{{TARGET_INSTRUCTION}}`) so the resumed `UserTurn` re-fetches the diff, since `codex exec resume` does not re-run the fresh prompt's git-collection step. In every mode Codex re-reads from disk via read-only sandbox. The original context + critique stay in conversation cache, so token cost drops dramatically.

Validation: bridge re-checks same mode, same cwd, same plan-path / docs-target / diff-base (for code-review: same base ref, commit, or uncommitted state), prior thread-id present, prior `codex-resume-status` ∈ {fresh, resumed}. Mismatch behavior:

| Scenario | Result |
|---|---|
| `--resume <path>` validation fail | `ok:false`, no fresh run |
| `--resume auto` miss | falls back to fresh; artifact records `codex-resume-status: fallback` |
| docs payload >200KB on resume | `ok:false`; user must narrow scope |
| code-review target mismatch (base ref / commit / uncommitted) | `ok:false`, no fresh run |

Status taxonomy recorded in `codex-resume-status` frontmatter:

| Status | Meaning |
|---|---|
| `fresh` | no `--resume` passed |
| `resumed` | resume succeeded |
| `fallback` | `--resume auto` miss; ran fresh |
| `resume-failed` | resume spawn died after validation passed |

`research` does NOT support `--resume` (deferred; see decisions.md).

## 8. Ship — tag and push

```bash
git tag -a v0.X.Y -m "v0.X.Y: <one-line summary>"
git push origin main v0.X.Y
```

Driven by an explicit release request — when the user asks to release, run the flow end to end (see Release flow in [CLAUDE.md](../CLAUDE.md)). The autonomous `hyper-implement` executor is the exception: during plan execution it commits each task on a feature branch (`hyper/<slug>`, created when started from `main`/`master`) and creates a local tag only if the plan's final task says to — it never pushes the branch or the tag.

---

## Slug propagation

The same slug should follow a feature through the cycle:

- `research` derives the slug from the task text (first 5 words, kebab-case, ASCII).
- The plan filename uses the same slug: `<YYYYMMDD-HHMM>-<slug>.md`.
- `plan-review` extracts the slug from the plan filename.
- `code-review` uses its own slug derived from the diff target (`vs-main`, `uncommitted`, or `commit-<sha7>`) — release-level, not feature-level.
- `docs-review` uses the docs target's basename.

This is deliberate: research → plan → plan-review form a per-feature trio (linked slug), while code-review / docs-review are release-level gates (linked to the diff or doc target).

## Skip conditions

Not every change needs the full cycle. Honest skip rules:

| Step | Skip when |
|---|---|
| `research` | Task is mechanical / well-trodden / one-file |
| `plan` | Single concrete step — dispatch `implementer` directly |
| `plan-review` | One-step plans; prototyping where review overhead exceeds value |
| `hyper-implement` | One-step or prototype work |
| `code-review` | Doc-only or config-only changes (still run for behavioral changes) |
| `docs-sync` | No documented behavior changed |
| `docs-review` | No docs changed AND no code changes that would affect doc claims |

The only step that should never be skipped on a behavioral change is `code-review`. Everything else is optional discipline.

## What it costs

Each Codex gate is one `codex` invocation. The bridge passes `--sandbox read-only` for every fresh `exec` mode — including code review, which uses `codex exec --sandbox read-only -` with a code-review prompt template (Codex runs the target git commands itself but never writes to your workspace).

Every invocation (all modes, fresh and resume) runs with live web search enabled via the global `--search` flag, so Codex may fetch external content (official docs, changelogs, live references) while it has your task or code context. This is intentional and does NOT relax the read-only filesystem sandbox.

Default per-call timeout is 300s. Default per-mode size guards: docs-review docs payload ≤ 200KB, docs-review diff ≤ 500KB. See [architecture.md](architecture.md) for the rest.
