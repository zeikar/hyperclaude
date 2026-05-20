---
name: hyper-plan-review
description: Use after a plan exists in .hyperclaude/plans/ and should be sanity-checked before execution. Also when the user invokes /hyperclaude:hyper-plan-review. Runs Codex critique on the plan — distinct from /hyperclaude:hyper-code-review (code, not plans).
---

# hyper-plan-review

Plan review gate. Locates a plan file, sends it to Codex for critique, saves the review to `.hyperclaude/plan-reviews/<timestamp>-<slug>.md`, and you read the review and refine the plan.

## When to use

- User typed `/hyperclaude:hyper-plan-review` (with or without an argument).
- You just produced an implementation plan and want a critic pass before executing.

## How to invoke

**Invocation argument:** $ARGUMENTS

`--resume` is supported. Paths with spaces are unsupported.

### Argv grammar

Apply this regex to the trimmed `$ARGUMENTS`:

```
^(?:((?!--)\S+))?(?:\s*(--resume)(?:\s+(\S+))?)?\s*$
```

- Group 1 = optional plan path (negative lookahead prevents matching `--resume` as a path)
- Group 2 = literal `"--resume"` token (truthy when present, undefined when not)
- Group 3 = optional resume artifact path

When Group 2 is `'--resume'` (truthy) and Group 3 is undefined, treat as `--resume auto`.

**Valid invocations:**
- `/hyperclaude:hyper-plan-review` — auto-discovers most recent plan, fresh run
- `/hyperclaude:hyper-plan-review path/to/plan.md` — explicit plan path, fresh run
- `/hyperclaude:hyper-plan-review --resume` — auto-discovers plan, resumes from latest artifact (`auto`)
- `/hyperclaude:hyper-plan-review --resume <prev-artifact-path>` — resumes from explicit artifact
- `/hyperclaude:hyper-plan-review path/to/plan.md --resume` — explicit path, resume from `auto`
- `/hyperclaude:hyper-plan-review path/to/plan.md --resume <prev-artifact-path>` — explicit path, explicit artifact

If the argument doesn't match the regex, ask the user to clarify and stop.

### Resume semantics

- `--resume <path>` (explicit): if validation fails, bridge returns `ok:false`, no fresh run, stderr note. Surface the error verbatim.
- `--resume` / `--resume auto`: if validation fails, bridge falls back to fresh run, writes artifact with `codex-resume-status: fallback`, stderr note.
- Budget exceeded (docs > 200KB after revision): bridge returns `ok:false` — NOT fallback. Tell user to narrow scope.

### Step 1 — Resolve the plan path

In priority order:

1. **Explicit argument (Group 1).** If Group 1 is non-empty, treat it as the plan path.
2. **Most recent in `.hyperclaude/plans/`.** If Group 1 is empty, run via the Bash tool:

   ```bash
   ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1
   ```

   If that returns a path, use it.

3. **Nothing found.** Tell the user: "No plan file found. Write your plan to `.hyperclaude/plans/<slug>.md`, or pass an explicit path: `/hyperclaude:hyper-plan-review path/to/plan.md`." Stop.

### Step 2 — Run the bridge

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<resolved path>"
```

If `--resume` was matched (Group 2 truthy), append `--resume <value>` to the argv passed to the bridge, where `<value>` is Group 3 if present, otherwise `auto`.

Use the Bash tool with `timeout: 600000`.

### Step 3 — Surface the review

Parse the JSON. On success, read the review file with the Read tool. Integrate the review:

- **Blockers / Majors** — fix the plan before proceeding.
- **Minors / Improvements** — optionally fold in.
- **Verdict** — communicate to the user.

When you revise the plan, **always overwrite the same plan file in place**. Do not create `-v2.md` or sibling files: the review thread's `--resume` identity is keyed on the plan path, so a new path breaks resume continuity (the next critique loses its prior context). Tell the user the plan was updated in place.

## Output contract

Review files have frontmatter (mode: plan-review, task: plan path, slug, generated, codex-version, template-version, plan-path) followed by Issues / Improvements / Verdict sections.
