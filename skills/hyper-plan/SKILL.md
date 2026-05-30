---
name: hyper-plan
description: Use when about to start a non-trivial implementation that needs decomposition before coding. Also when the user invokes /hyperclaude:hyper-plan. Produces an ordered, bite-sized plan in .hyperclaude/plans/ — the input for /hyperclaude:hyper-plan-review and /hyperclaude:hyper-implement.
---

# hyper-plan

Plan generation gate. Dispatches the `planner` agent to produce a multi-task plan; saves it to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`. When a recent `hyper-research` artifact matches, the plan inherits its slug so `research → plan → plan-review` form a linked trio.

For an **oversized** task the planner returns an epic roadmap (`tier: epic`, saved under `.hyperclaude/epics/`) — a list of `## Milestone N:` chunks — instead of one giant detailed plan; the skill then auto-expands Milestone 1 into a runnable detailed plan under `.hyperclaude/plans/` and leaves the remaining milestones to expand on demand. This keeps each plan — and each `hyper-plan-review` — small. Vocabulary: **epic → milestone → task** (the roadmap is the epic, its chunks are milestones, each milestone expands into a detailed plan of tasks).

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

### Step 3 — Dispatch planner (scope-aware)

Use the Agent tool with `subagent_type: hyperclaude:planner`. Prompt MUST include:

- **Task** — verbatim.
- **Research context** — full contents of all matched research artifacts inline (there may be a Codex + Claude pair), if any were found in Step 1. Do not make the agent re-read them.
- **Scope assessment first** — before writing, judge the task's size and pick ONE format:
  - **Fits one cohesive plan** (~10 bite-sized tasks or fewer, a single area) → produce the **detailed** format.
  - **Oversized** (would exceed ~10–12 tasks, or spans multiple independent areas/milestones) → produce the **epic roadmap** format instead. Do not force a giant detailed plan.
- **Detailed format** — a multi-task plan with `## Task N: <title>` headings. Each task block contains:
  - **Files to create / modify** — exact paths.
  - **Steps** — `[ ]`-checkboxes, 2–5 minutes each.
  - **Verification** — a command to run, or an observable change.
  - **Commit message** — one line, conventional-commits style.
- **Epic roadmap format** — a `# Epic: <task one-liner>` H1, then `## Milestone N: <title>` headings (1-indexed). Each milestone block has a 1–3 line scope, a `Depends on:` line (`none` or `Milestone K`), and a rough task-count estimate. NO file paths, NO step checkboxes, NO commit messages — those belong to the per-milestone detailed expansion.
- **Heading style is the mode signal** — the skill detects which format you chose from the headings (`## Task N:` = detailed, `## Milestone N:` = epic roadmap); never mix the two in one reply.
- **No frontmatter** — return the plan body only (planner's default return-body mode); `hyper-plan` owns the file and adds any frontmatter itself.

The detailed format is what `/hyperclaude:hyper-implement` consumes; do not produce a flat numbered list.

### Step 4 — Write the file(s), branching on detected mode

Detect the planner's chosen mode from its heading style: `## Milestone N:` headings present **and no** `## Task N:` → **epic roadmap**; otherwise → **detailed** (the default — covers normal plans and any reply lacking milestone headings).

**Detailed** (the common case): use the Write tool with the planner's response verbatim, saving to the path from Step 2 (no frontmatter). Go to Step 5.

**Epic roadmap** (oversized task): the roadmap is not executable on its own; persist it under `.hyperclaude/epics/`, then auto-expand the first milestone into a runnable plan under `.hyperclaude/plans/`.

1. **Write the roadmap.** `mkdir -p .hyperclaude/epics`, then Write to `.hyperclaude/epics/<timestamp>-<slug>.md` (same `<timestamp>-<slug>` as Step 2; if it exists, append `-2`, `-3`, … until free), prepending a `tier: epic` frontmatter block before the planner's milestone body:

   ```
   ---
   tier: epic
   ---

   <planner milestone body verbatim>
   ```

   The `tier: epic` marker is what makes `/hyperclaude:hyper-implement` refuse it — it's a roadmap, not a task plan. Keeping it out of `.hyperclaude/plans/` also keeps it off hyper-implement's newest-plan auto-pick entirely.

2. **Expand Milestone 1.** Dispatch the `planner` again (return-body mode, **detailed** format). The prompt MUST give Milestone 1's title + scope as the task, the full roadmap as context (so the expansion respects milestone boundaries and dependencies), and any Step 1 research context. Require the `## Task N:` detailed format.

3. **Write the detailed plan** with the planner's response verbatim (no frontmatter) to the **Step 2 plans path** (`.hyperclaude/plans/<timestamp>-<slug>.md`) — the same canonical path the detailed case uses. The roadmap is in `.hyperclaude/epics/`, so there is no name collision, and the Milestone-1 plan keeps the canonical `<slug>` — preserving the `research → plan → plan-review` shared-slug trace. (Do NOT append `-m1`: that would leak into the slug `slug.mjs` extracts and break the shared-slug convention.)

### Step 5 — Report

**Detailed:** tell the user the plan path, whether the slug was reused from research or freshly derived, and the next step (`/hyperclaude:hyper-plan-review` to critique, `/hyperclaude:hyper-implement` to execute).

**Epic roadmap:** tell the user:
- The roadmap path (`.hyperclaude/epics/…`, `tier: epic`, N milestones) — and that `/hyperclaude:hyper-implement` refuses it by design.
- The expanded Milestone-1 detailed plan path (`.hyperclaude/plans/<timestamp>-<slug>.md`, canonical slug) — this is the runnable artifact: critique with `/hyperclaude:hyper-plan-review <plan path>`, execute with `/hyperclaude:hyper-implement <plan path>`.
- How to proceed to later milestones: when ready, re-run `/hyperclaude:hyper-plan <Milestone K scope>`. Be explicit that this currently produces a **standalone** detailed plan with its own freshly-derived slug — it does NOT read the epic roadmap, so the user should carry that milestone's `Depends on:` context over themselves. (Automatic epic-aware re-expansion — reuse the epic slug, auto-link dependencies — is a planned follow-up, not today's behavior.)
- Whether the slug was reused from research or freshly derived.

## Anti-patterns

- Calling Codex. This skill is Claude-only; the `planner` agent does the work.
- Inventing a slug when a matching research artifact exists — that breaks trio traceability.
- Writing code in the plan. Names, paths, verifications only — the planner does not write code, tests, or commits; for `hyper-plan` the skill owns the Write (the planner only returns the body here).
- Forcing a giant detailed plan for an oversized task. Let the planner return an epic roadmap; expand milestones one at a time.
- Feeding a `tier: epic` roadmap to `/hyperclaude:hyper-implement`, or adding `tier: epic` to a detailed plan. The marker rides only on the roadmap (in `.hyperclaude/epics/`); detailed plans (including the auto-expanded Milestone-1 plan) stay frontmatter-less in `.hyperclaude/plans/`.
- Appending `-m1` (or any `-mN`) to a milestone plan's filename. The slug extractor would fold it into the slug and break the `research → plan → plan-review` shared-slug trace; the Milestone-1 plan uses the canonical `<slug>` path.
