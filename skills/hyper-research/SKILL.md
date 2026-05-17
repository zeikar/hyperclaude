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

### Path selection

Two research paths exist. Pick by reading the user's intent — this is a plain-language rule, **not** a flag/token/`$ARGUMENTS` grammar:

- If the user's request explicitly asks for **Claude-native research / no-Codex / a Claude second opinion** → **Claude path**.
- Otherwise (a normal `/hyperclaude:hyper-research <task>`) → **Codex path** (default, preserves the builder/critic invariant).
- If the intent is genuinely unclear → ask the user in chat and stop until they answer.

Both paths first resolve the task description the same way:

- If the invocation argument is non-empty, that is the task description.
- If empty, fall back to the user's most recent build/implement intent in this conversation. If none exists, ask the user to describe the task and stop.

### Codex path (default)

1. Resolve the task description as described in **Path selection** above.

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

### Claude path

This path runs Claude-native research via the `researcher` agent. It uses `WebFetch` against KNOWN URLs only — it is **not** web-search parity with the Codex `--search` bridge mode. If the user needs broad live web search, route them to the Codex path instead.

1. Derive `<slug>` from the resolved task with the same rule as `hyper-plan`: lowercase, ASCII only, alphanumerics + hyphen, first 5 words of the task joined by `-`. Example: "Add OAuth login to the API" → `add-oauth-login-to-the`.

2. Get `<timestamp>` (UTC — matches the bridge's artifact filename convention):

   ```bash
   date -u +%Y%m%d-%H%M
   ```

3. Create the artifact directory and resolve the artifact path:

   ```bash
   mkdir -p .hyperclaude/research
   ```

   Base path: `.hyperclaude/research/<timestamp>-<slug>.md`. If it exists, append `-2`, `-3`, … until free.
   - **No-ASCII-slug fallback** (mirrors the bridge): if slug derivation yields no ASCII characters (e.g. an all-Korean topic), the filename is timestamp-only — `.hyperclaude/research/<timestamp>.md` (with the same `-2`/`-3` collision suffixing) — and the frontmatter `slug:` line is the bare key with an empty value: `slug: ` (key, colon, single space, nothing after — NOT `slug: ""`).

4. Dispatch the `researcher` agent with the Agent tool, `subagent_type: hyperclaude:researcher`, in return-body mode (the agent returns the report markdown; it does not write files). The prompt MUST include:
   - **Task** — the resolved task description, verbatim.
   - **Required section structure** — the report must use exactly these headings, in this order: `### Prior Art`, `### Pitfalls`, `### Recommendations`, `### Open Questions`.

5. Collect the always-present frontmatter values with one short Node one-liner (keeps `cwd`/`git-head` JSON-quoted the same way the bridge's renderer does):

   ```bash
   node -e 'const c=require("child_process");console.log(JSON.stringify({generated:new Date().toISOString(),cwd:process.cwd(),gitHead:c.execSync("git rev-parse HEAD").toString().trim()}))'
   ```

6. Write the artifact with the Write tool to the path from step 3. Frontmatter is ONLY the always-present keys, in this order (do NOT byte-match `renderFrontmatter()` and do NOT add Codex-only conditional keys like `codex-thread-id`):

   ```
   ---
   mode: research
   task: |-
     <task, each line 2-space indented>
   slug: <slug>
   generated: <generated ISO from the one-liner>
   codex-version: claude
   template-version: 1
   cwd: <JSON-quoted cwd from the one-liner>
   git-head: <JSON-quoted gitHead from the one-liner>
   codex-resume-status: fresh
   ---
   # Research: <task>

   <researcher agent body verbatim>
   ```

   For the no-ASCII-slug fallback, the `slug:` line is the bare empty form described in step 3.

7. Tell the user the artifact path and that this was Claude-native research (no Codex). Then integrate the findings into your subsequent plan as in the Codex path step 6.

## Output contract

The research file has YAML frontmatter followed by markdown sections (Prior Art / Pitfalls / Recommendations / Open Questions). Do not modify the file.

Both paths produce the same always-present frontmatter keys (mode, task, slug, generated, codex-version, template-version, cwd, git-head, codex-resume-status) and the same section structure. The Codex path's `codex-version` is the Codex CLI version and it may add Codex-only conditional keys (e.g. `codex-thread-id`); the Claude path's `codex-version` is `claude` and it omits those conditional keys.
