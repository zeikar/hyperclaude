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

See `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` for the shared `--resume` semantics (explicit vs `auto` fallback, the `template-version` precondition). Plan-review's identity check keys on the plan path.

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

### Step 2 — Compose the review brief (or omit it)

Compose per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`, assigning the scratchpad path to `BRIEF_FILE` per its shell-safety recipe; with no admissible source, omit the flag.

Concrete omission case for this skill: a fresh session with no conversation history that auto-discovers a plan (Step 1.2) has no (a)/(b) source at all — omit the flag, or ask the user for their requirements and use their reply. **Never mine the plan file's prose** — it is Claude-authored; quoting it would let the planner bless its own additions.

### Step 3 — Run the bridge

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<resolved path>" [--review-brief "$(cat "$BRIEF_FILE")"]
```

If `--resume` was matched (Group 2 truthy), append `--resume <value>` to the argv passed to the bridge, where `<value>` is Group 3 if present, otherwise `auto`. The `--review-brief "$(cat "$BRIEF_FILE")"` token is OPTIONAL — present when a source exists (fresh and `--resume` alike), omitted otherwise.

Use the Bash tool with `timeout: 600000`.

### Step 4 — Surface the review

Parse the bridge's single stdout JSON envelope per `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` (envelope shape + strict-parse rule). On success, read the review file with the Read tool. Integrate the review:

- **Blockers / Majors** — fix the plan before proceeding.
- **Minors / Improvements** — optionally fold in.
- **Verdict** — communicate to the user.

When you revise the plan, **always overwrite the same plan file in place**. Do not create `-v2.md` or sibling files: the review thread's `--resume` identity is keyed on the plan path, so a new path breaks resume continuity (the next critique loses its prior context). Tell the user the plan was updated in place.

## Output contract

Review files have frontmatter (mode: plan-review, task: plan path, slug, generated, plugin-version, codex-version, template-version, plan-path, `review-brief` (present when a brief was supplied, or carried forward from a successfully-resolved resume), plus `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` each emitted independently when Codex reported that token field in usage; omitted when Codex did not emit usage) followed by Issues / Improvements / Verdict sections.
