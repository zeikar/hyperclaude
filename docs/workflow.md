# Workflow

The end-to-end cycle hyperclaude is built around. This is the dogfooding loop the author actually runs to ship its own releases.

Before running any gate for the first time, run `/hyperclaude:hyper-setup` to diagnose host prerequisites (Node 18+, codex-cli >= 0.130.0, git, and the optional `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var for `hyper-plan-loop`).

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

## 1. Research — Codex surfaces context

```
/hyperclaude:hyper-research add OAuth login to the API
```

Writes `.hyperclaude/research/<timestamp>-add-oauth-login-to-the.md`. Read it. Don't skip the Pitfalls section — that's where Codex earns its keep.

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

**Autonomous alternative:** `/hyperclaude:hyper-plan-loop` combines steps 2–3 into a single gesture — it spawns the `planner` agent as a persistent team teammate, the planner writes the plan file itself at the lead-resolved path (no per-iteration plan-body round-trip; the planner idles between turns), the lead runs Codex `plan-review` via the bridge, sends findings back to the planner for revision, and repeats until no Blocker or Major issues remain (5-review cap). Both `hyper-plan` + `hyper-plan-review` and `hyper-plan-loop` are available; use whichever fits your workflow. `hyper-plan-loop` requires Claude Code's experimental agent-teams feature (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).

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

Resume reuses the prior Codex thread. The bridge sends a small follow-up — plan/docs modes say "the file has been revised; re-read it"; code-review embeds the exact git command (`{{TARGET_INSTRUCTION}}`) so the resumed `UserTurn` re-fetches the diff, since `codex exec resume` does not re-trigger native diff capture. In every mode Codex re-reads from disk via read-only sandbox. The original context + critique stay in conversation cache, so token cost drops dramatically.

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

Driven by an explicit release request — when the user asks to release, run the flow end to end (see Release flow in [CLAUDE.md](../CLAUDE.md)). The autonomous `hyper-implement` executor is the exception: during plan execution it creates a local tag only if the plan's final task says to, and never pushes it.

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

Each Codex gate is one `codex` invocation. The bridge passes `--sandbox read-only` for `exec` modes and uses `codex exec review` for code review — Codex never writes to your workspace.

Default per-call timeout is 300s. Default per-mode size guards: docs-review docs payload ≤ 200KB, docs-review diff ≤ 500KB. See [architecture.md](architecture.md) for the rest.
