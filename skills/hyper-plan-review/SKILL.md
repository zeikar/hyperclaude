---
name: hyper-plan-review
description: Run Codex critique on an implementation plan. Use when the user invokes /hyperclaude:hyper-plan-review, after Claude has produced a plan that should be sanity-checked before execution.
---

# hyper-plan-review

Plan review gate. Locates a plan file, sends it to Codex for critique, saves the review to `.hyperclaude/reviews/<timestamp>-<slug>.md`, and you read the review and refine the plan.

## When to use

- User typed `/hyperclaude:hyper-plan-review` (with or without an argument).
- You just produced an implementation plan and want a critic pass before executing.

## How to invoke

**Invocation argument:** $ARGUMENTS

### Step 1 — Resolve the plan path

In priority order:

1. **Explicit argument.** If the argument above is non-empty, treat it as the plan path and use it.
2. **Most recent in `.hyperclaude/plans/`.** If the argument is empty, run via the Bash tool:

   ```bash
   ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1
   ```

   If that returns a path, use it.

3. **Nothing found.** Tell the user: "No plan file found. Write your plan to `.hyperclaude/plans/<slug>.md`, or pass an explicit path: `/hyperclaude:hyper-plan-review path/to/plan.md`." Stop.

### Step 2 — Run the bridge

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" review --plan-path "<resolved path>"
```

Use the Bash tool with `timeout: 600000`.

### Step 3 — Surface the review

Parse the JSON. On success, read the review file with the Read tool. Integrate the review:

- **Blockers / Majors** — fix the plan before proceeding.
- **Minors / Improvements** — optionally fold in.
- **Verdict** — communicate to the user.

When you revise the plan, write the revision to the same file (overwrite) or to a sibling versioned file (`<slug>-v2.md`). Either is fine; pick one and tell the user.

## Output contract

Review files have frontmatter (mode: review, task: plan path, slug, generated, codex-version, template-version, plan-path) followed by Issues / Improvements / Verdict sections.
