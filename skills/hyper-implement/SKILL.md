---
name: hyper-implement
description: Use when about to execute a multi-task plan from .hyperclaude/plans/. Also when the user invokes /hyperclaude:hyper-implement. Runs each task in a fresh subagent with spec-compliance and code-quality gates between tasks.
---

# hyper-implement

Plan execution gate. Reads a plan, dispatches a fresh subagent per task, runs two reviews (spec compliance, then code quality) before marking each task complete. Uses our own agents (`implementer`, `verifier`) and our own gate skills.

## When to use

- User typed `/hyperclaude:hyper-implement [path]`.
- A multi-task plan exists (typically in `.hyperclaude/plans/`) and you're about to execute it.

Skip when:
- The plan is one step — just do it directly.
- Tasks are tightly coupled and benefit from shared context.
- You're prototyping; reviews are overhead at this stage.

## How to invoke

**Invocation argument:** $ARGUMENTS

### Step 1 — Resolve the plan path

In priority order:

1. If $ARGUMENTS is non-empty, treat it as a path and use it.
2. Else, find the most recent plan via the Bash tool:

   ```bash
   ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1
   ```

3. If nothing found, tell the user: "No plan file found. Write your plan to `.hyperclaude/plans/<slug>.md` first." Stop.

### Step 1.5 — Reject epic roadmaps

Read the resolved plan's opening lines. If the file begins with a YAML frontmatter block containing `tier: epic`, it is an epic **roadmap**, not an executable task plan (`hyper-plan` emits these for oversized tasks, under `.hyperclaude/epics/`). **STOP** before any branch or git work and tell the user: "This is an epic roadmap (`tier: epic`), not an executable task plan. Expand a milestone into a detailed plan first — `/hyperclaude:hyper-plan <milestone title>` — then run hyper-implement on that detailed plan." Plans without `tier: epic` frontmatter (all detailed plans, including the auto-expanded Milestone-1 plan) proceed normally. Roadmaps live in `.hyperclaude/epics/`, not `.hyperclaude/plans/`, so the newest-plan auto-pick in Step 1 never selects one — this guard only fires when a roadmap path is passed explicitly.

### Step 2 — Parse and track

Read the plan with the Read tool. Extract every `## Task N: <title>` section with its full text — files-to-create/modify, step-by-step checkboxes, verification commands, commit message.

Use TodoWrite to create a todo per task. Mark the first as `in_progress`.

### Step 2.5 — Clean-tree preflight, then create / switch to the feature branch

**Clean-tree preflight (do this FIRST).** Per-task commits use `git add -A` (step 3.6), so the working tree MUST be clean before the loop starts — otherwise pre-existing unrelated edits or untracked files (including local secrets) get swept into the first task's commit. Check:

```bash
git status --porcelain
```

If the output is non-empty (any tracked modification or non-ignored untracked file — `.hyperclaude/` is gitignored and never appears, so it's exempt), **STOP** and tell the user: "Working tree is not clean. hyper-implement commits per task with `git add -A`; commit, stash, or clean the unrelated changes first, then re-run." Do not branch, do not start the loop. This preflight is what makes per-task `git add -A` provably scoped: each task starts from a clean tree, so everything added during the task (implementer output + spec/quality fix-loop edits) is exactly that task's work, and the task commit returns the tree to clean for the next task.

Per-task commits never land on the default branch — `hyper-implement` always commits on a feature branch.

Derive the slug from the plan filename: strip the `<YYYYMMDD-HHMM>-` timestamp prefix and the `.md` suffix (e.g. `20260517-1946-hyper-implement-code-review-reviser.md` → `hyper-implement-code-review-reviser`). If the filename has no timestamp prefix, use the basename without `.md`.

Find the current branch and act on it:

```bash
git rev-parse --abbrev-ref HEAD
```

- Current branch is `main` or `master` (the default branch — protected) → create or switch to `hyper/<slug>`:

  ```bash
  git switch -c "hyper/<slug>" 2>/dev/null || git switch "hyper/<slug>"
  ```

  (`-c` creates it from the current HEAD; the `||` fallback switches to it if it already exists — a resumed run reuses the same branch.)
- Already on a non-default branch → **stay on it**; the user pre-selected a working branch and per-task commits land there. Do NOT create a nested branch.

Tell the user which branch per-task commits will land on. Never push the branch — push stays a user action (see Step 4 / Rules).

### Step 3 — Per-task loop

For EACH task in order:

1. **Implementer.** Dispatch via the Agent tool. Prefer `subagent_type: hyperclaude:implementer`. Prompt MUST include:
   - The full task text (paste it; do not make the subagent re-read the plan file).
   - Project context: where this fits, recent commits, base SHA before this task.
   - Global constraints from the plan's preamble (zero deps, sandbox invariant, naming traps, etc.).
   - A self-review checklist before reporting back.
   - Expected report format: status (DONE / DONE_WITH_CONCERNS / BLOCKED / NEEDS_CONTEXT), files changed, test counts. (No commit SHA — the implementer never commits; the lead commits in step 6 after both reviews pass and records the SHA.)

2. **Spec compliance review.** Once implementer reports DONE, dispatch a fresh **general-purpose** subagent (NOT the verifier — verifier runs tests, doesn't compare to spec). Prompt:
   - The full task text.
   - The implementer's report (verbatim).
   - The git SHA range (`<base>..<head>`).
   - Instruction: read the actual code; don't trust the report. Look for missing requirements AND unrequested extras.
   - Expected outcome: ✅ compliant, or ❌ with specific file:line issues.

   If issues found → re-dispatch the implementer with the fix list → re-review. Loop until ✅.

3. **Code quality review.** After spec ✅, dispatch another fresh general-purpose subagent. Focus on:
   - Clarity (names, decomposition, file responsibility).
   - Test quality (do tests verify behavior, not types?).
   - YAGNI (any unrequested abstractions or features?).
   - Consistency with existing codebase style.
   - Severity-tagged issues: Critical / Important / Minor.

   Loop until reviewer approves (Minor-only is acceptable; Critical/Important must be fixed).

4. **Verifier — when tests or build steps changed.** If the task added or modified test files (`tests/**`, `*.test.*`, `*.spec.*`) or build/CI configuration (`package.json` scripts, smoke script, CI workflow), dispatch `subagent_type: hyperclaude:verifier`. Verifier runs `node --test`, `bash scripts/test/smoke.sh`, lint, etc. and reports PASS / PARTIAL / FAIL with verbatim output. Verifier never modifies files. Skip the verifier when the task didn't touch tests or build inputs — the spec/quality reviews above already cover code correctness.

5. **Mark the task's step checkboxes as `- [x]` in the plan file.** After both reviews approve, use the Edit tool to convert every `- [ ]` inside the current `## Task N: <title>` block to `- [x]`. Scope is the task block only — leave other tasks' boxes alone. This keeps the plan file's checkbox state the durable source of "what's done" — survives context loss and lets a resumed session see exactly which tasks remain. Do this BEFORE the commit/TodoWrite updates so the durable artifact lands first.

6. **Commit the task (the lead commits — never the implementer).** Only after spec ✅ + quality ✅ (+ verifier PASS when it ran):

   Stage, then check whether anything was staged, then commit only if so:

   ```bash
   git add -A
   git diff --cached --quiet && echo "SKIP: nothing staged" || git commit -m "<task commit message>"
   ```

   - **Message:** the task block's **Commit message** line (one-line conventional-commits, emitted by the planner). If the block has none, synthesize a conventional subject from the task title (defensive only — the planner always emits one).
   - **`git add -A` is intentional and safe here** *because* Step 2.5's clean-tree preflight guaranteed the tree held no unrelated work when the loop started: each task begins from a clean tree, so the entire current diff is exactly this task's work (implementer + fix-loop edits). `.hyperclaude/` is gitignored, so plan-file checkbox edits and run artifacts never sweep in. (This is the documented exception to CLAUDE.md's "don't blanket `git add -A`", which is scoped to the release commit on `main`.)
   - **Nothing staged** (`git diff --cached --quiet` exits 0 → no diff, e.g. a pure-verification task) → skip the commit, note "Task N: no file changes — no commit" in the run summary, continue.
   - Record the resulting commit SHA (`git rev-parse HEAD`) for the final summary.
   - Never push. Never tag here (tags only per Step 4, still user-pushed).

7. **Mark task complete in TodoWrite.** Move on.

### Step 4 — Final pass

After all tasks:

- All tasks are now committed on the feature branch (one commit per task, minus skipped no-change tasks). Run `bash scripts/test/smoke.sh` (or whatever the plan defines as final acceptance) and confirm 0 failures.
- If `/hyperclaude:hyper-code-review` is available, run it for a Codex-side review of the entire diff. Useful catch for cross-task issues.
- If the plan's final task includes a tag step (`git tag -a vX.Y.Z`), do NOT push it; leave that to the user.
- Report the feature branch name and the per-task commit SHAs (and any "no file changes" skips). Do NOT push the branch — pushing stays a user action.

## Rules

- **Fresh subagent per task.** Don't reuse implementer subagents across tasks — context pollution kills focus.
- **Two reviews per task.** Spec compliance FIRST (catches scope drift), then code quality (catches style/clarity). Skipping either means you'll ship bugs.
- **Don't trust implementer self-reports.** Reviewers must read the actual code.
- **Fix loops are mandatory.** Reviewer ❌ → implementer fixes → re-review. No "close enough."
- **Continuous execution.** Don't pause to ask the user between tasks — execute the whole plan. Stop only on BLOCKED, genuine ambiguity, or all tasks done.
- **The lead commits, not the implementer.** Per-task commit happens in Step 3.6 after both reviews pass — never inside the implementer subagent (it stays commit-free per [agents/implementer.md](../../agents/implementer.md)).
- **Feature branch, never the default branch.** Step 2.5 creates/uses `hyper/<slug>` when on `main`/`master`; per-task commits never land on the protected default branch.
- **Never push.** Branch creation, per-task commits, and any tag are all LOCAL. Pushes are user actions. The skill creates a tag locally only if the plan says to.

## Anti-patterns

- Using `verifier` agent for code review. Wrong role — verifier runs tests, doesn't critique code.
- Skipping spec compliance review because "the plan was clear." It never is.
- Single subagent handling multiple tasks (the whole reason we don't do manual orchestration).
- Marking a task complete with reviewer issues still open.
- Committing a task before both reviews pass, letting the implementer commit, or committing on the default branch.
- Pushing the feature branch or pushing a tag. Everything this skill does is local.
- Following the implementer's own model selection. Pick model per task complexity at dispatch time:
  - Mechanical (1-2 files, exact spec): haiku
  - Standard (multi-file, integration): sonnet
  - Architectural / judgment-heavy: opus

  **Apply the SAME tier to the spec / quality reviewer dispatches in Step 3.2 and 3.3.** They're `general-purpose` subagents that otherwise inherit the lead's model, which over-pays on mechanical / standard tasks. Pass `model:` on the Agent call to match the implementer tier you just chose. Verifier (Step 3.4) stays on its frontmatter default — no override.
