---
name: hyper-research
description: Run Codex pre-implementation research on a task. Use when the user invokes /hyperclaude:hyper-research, or when starting a non-trivial implementation and you want Codex's prior-art / pitfalls / recommendations before designing. Skip for one-line fixes or when a recent research artifact already covers the task.
---

# hyper-research

Pre-implementation research gate. Calls Codex with a research prompt; saves the output to `.hyperclaude/research/<timestamp>-<slug>.md`; you read the file and integrate findings into your next planning step.

## When to use

- User typed `/hyperclaude:hyper-research <task>`.
- You're about to start substantial new work and want a second-opinion context dump.

Skip when:
- The task is a small fix or rename.
- A recent research file (within ~30 min) already covers this task.

## How to invoke

`--resume` is not supported (deferred — research is not iterative).

**Invocation argument:** $ARGUMENTS

1. Resolve the task description:
   - If the argument above is non-empty, that is the task description.
   - If empty, fall back to the user's most recent build/implement intent in this conversation. If none exists, ask the user to describe the task and stop.

2. Write the resolved task description to a temp file using the **Write tool** (not the Bash tool — this avoids shell quoting). Pick a path under the system temp dir; for example: `/tmp/hyperclaude-task-<unix-timestamp>.txt`. Save the task as plain text; no escaping needed.

3. Run the bridge in research mode using the Bash tool with `timeout: 600000`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" research --task-file "<temp file path>"
   ```

4. After the bridge returns, clean up the temp file:

   ```bash
   rm -f "<temp file path>"
   ```

5. The bridge prints a single JSON line to stdout. Parse it.
   - On `{"ok":true,"path":"..."}` — read the file with the Read tool.
   - On `{"ok":false,"error":"..."}` — surface the error to the user; do not pretend research happened.

6. Integrate the file's findings into your subsequent plan. When you write a plan, save it under `.hyperclaude/plans/<timestamp>-<slug>.md` so `/hyperclaude:hyper-plan-review` can find it later.

## Output contract

The research file has YAML frontmatter (mode, task, slug, generated, codex-version, template-version) followed by markdown sections (Prior Art / Pitfalls / Recommendations / Open Questions). Do not modify the file.
