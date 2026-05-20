---
name: hyper-plan
description: Use when about to start a non-trivial implementation that needs decomposition before coding. Also when the user invokes /hyperclaude:hyper-plan. Produces an ordered, bite-sized plan in .hyperclaude/plans/ — the input for /hyperclaude:hyper-plan-review and /hyperclaude:hyper-implement.
---

# hyper-plan

Plan generation gate. Dispatches the `planner` agent to produce a multi-task plan; saves it to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`. When a recent `hyper-research` artifact matches, the plan inherits its slug so `research → plan → plan-review` form a linked trio.

## When to use

- User typed `/hyperclaude:hyper-plan <task>`.
- About to start multi-task work; want a plan `/hyperclaude:hyper-plan-review` can critique and `/hyperclaude:hyper-implement` can execute.

Skip when:
- The task is one step — dispatch the `implementer` agent directly.
- A recent plan already covers this task.

## How to invoke

`--resume` is not supported (re-plan by running again with a refined task).

**Invocation argument:** $ARGUMENTS

### Step 1 — Resolve task + slug

In priority order:

1. `$ARGUMENTS` non-empty → that is the task. Then, in order:

   1. Derive the canonical slug deterministically (rule below).
   2. Scan **all** research files under `.hyperclaude/research/*.md` — not just the newest. Read each file's frontmatter `slug:` field (the canonical key — do not match against the filename, which may have collision suffixes like `-2`).
   3. If one OR MORE files' frontmatter `slug:` equals the derived slug (there may be a Codex `<ts>-<slug>.md` AND a Claude `<ts>-<slug>-claude.md` pair), treat ALL of them as the linked research artifacts and read ALL of them in Step 3 for context.

   This deterministic slug-equality scan is what preserves `research → plan → plan-review` traceability even when an unrelated newer research file exists.

2. `$ARGUMENTS` empty → list research files newest-first:

   ```bash
   ls -1t .hyperclaude/research/*.md 2>/dev/null | head -1
   ```

   Read the latest file's frontmatter `task:` + `slug:` and use both. If no research file exists, fall back to the user's most recent build/implement intent in this conversation; if none, ask the user and stop.

**Slug derivation rule** (used in branch 1, and matches what `hyper-research` writes into the artifact frontmatter): lowercase, ASCII only, alphanumerics + hyphen, first 5 words of the task joined by `-`. Example: "Add OAuth login to the API" → `add-oauth-login-to-the`.

### Step 2 — Resolve plan path

```bash
mkdir -p .hyperclaude/plans
date +%Y%m%d-%H%M
```

Base path: `.hyperclaude/plans/<timestamp>-<slug>.md`. If it exists, append `-2`, `-3`, … until free.

### Step 3 — Dispatch planner

Use the Agent tool with `subagent_type: hyperclaude:planner`. Prompt MUST include:

- **Task** — verbatim.
- **Research context** — full contents of all matched research artifacts inline (there may be a Codex + Claude pair), if any were found in Step 1. Do not make the agent re-read them.
- **Output format** — a multi-task plan with `## Task N: <title>` headings. Each task block contains:
  - **Files to create / modify** — exact paths.
  - **Steps** — `[ ]`-checkboxes, 2–5 minutes each.
  - **Verification** — a command to run, or an observable change.
  - **Commit message** — one line, conventional-commits style.
- **No frontmatter** — return the plan body only (planner's default return-body mode); `hyper-plan` deliberately keeps the skill as the file owner.

This is the format `/hyperclaude:hyper-implement` consumes; do not produce a flat numbered list.

### Step 4 — Write the file

Use the Write tool with the planner's response verbatim, saving to the path from Step 2.

### Step 5 — Report

Tell the user the plan path, whether the slug was reused from research or freshly derived, and the next step (`/hyperclaude:hyper-plan-review` to critique, `/hyperclaude:hyper-implement` to execute).

## Anti-patterns

- Calling Codex. This skill is Claude-only; the `planner` agent does the work.
- Inventing a slug when a matching research artifact exists — that breaks trio traceability.
- Writing code in the plan. Names, paths, verifications only — the planner does not write code, tests, or commits; for `hyper-plan` the skill owns the Write (the planner only returns the body here).
