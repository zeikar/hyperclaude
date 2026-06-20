---
name: hyper-research
description: Use when starting a non-trivial task and want prior-art, pitfalls, or recommendations before designing. Also when the user invokes /hyperclaude:hyper-research. Runs Codex and Claude in parallel by default, producing two artifacts in .hyperclaude/research/.
---

# hyper-research

Pre-implementation research gate. By default runs **both** the Codex research path and the Claude research path in parallel, producing two artifacts (`.hyperclaude/research/<timestamp>-<slug>.md` from Codex and `.hyperclaude/research/<timestamp>-<slug>-claude.md` from Claude) that share one frontmatter `slug:`; you read them and integrate findings into your next planning step. A single path runs only on explicit user request.

## When to use

- User typed `/hyperclaude:hyper-research <task>`.
- You're about to start substantial new work and want a parallel Codex + Claude research context dump.

Skip when:
- The task is a small fix or rename.
- A recent research file (within ~30 min) already covers this task.

## How to invoke

`--resume` is not supported (deferred — research is not iterative).

**Invocation argument:** $ARGUMENTS

### Path selection

Two research paths exist (Codex and Claude). Pick by reading the user's intent — this is a plain-language rule, **not** a flag/token/`$ARGUMENTS` grammar:

- **Default** (a normal `/hyperclaude:hyper-research <task>`, or any case not explicitly single-path) → **both paths in parallel** (Codex + Claude), producing two artifacts that share one slug.
- ONLY if the user EXPLICITLY asks for **Codex only / no Claude** → **Codex path** alone.
- ONLY if the user EXPLICITLY asks for **Claude only / Claude-native / no-Codex / a Claude second opinion** → **Claude path** alone.
- If the intent is genuinely unclear → treat it as the default (both paths in parallel). Only narrow to a single path on an unambiguous explicit request.

All cases first resolve the task description the same way:

- If the invocation argument is non-empty, that is the task description.
- If empty, fall back to the user's most recent build/implement intent in this conversation. If none exists, ask the user to describe the task and stop.

### Default: both paths in parallel

This is the default. Run the Codex and Claude research paths concurrently so the two multi-minute operations overlap:

1. Resolve the task description (as in **Path selection**), derive `<slug>` (Claude-path rule, step 1 below), and get `<timestamp>` once — these are shared by both artifacts.

2. **Dispatch the Claude researcher in the background FIRST.** Dispatch the `researcher` agent with the Agent tool, `subagent_type: hyperclaude:researcher`, **`run_in_background: true`**, in return-body mode, using the same prompt contract as the Claude path step 4 below (Task verbatim + required section structure). Do not wait for it yet.

3. **Then run the Codex bridge** exactly as the Codex path describes (write the task to a temp file with the Write tool, run `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" research --task-file "<temp file path>"` with `timeout: 600000`, clean up the temp file, parse the JSON line). This Bash call blocks for ~minutes — while it runs, the backgrounded researcher is working in parallel. The bridge writes `.hyperclaude/research/<timestamp>-<slug>.md`.
   - On `{"ok":false,"error":"..."}` — surface the Codex error to the user. Do NOT pretend the Codex artifact was produced. Then go to step 4 to collect the researcher; if it succeeded, write and report the Claude artifact as a **PARTIAL result** and continue using only it. If the researcher also failed or returned an empty body, report full failure to the user and stop.

4. **After the bridge Bash call returns, collect the backgrounded researcher result.** When the `researcher` agent was dispatched with `run_in_background: true`, the Agent tool returns a task handle immediately; the result is delivered as a completion notification. After the blocking bridge call returns, wait for / collect that researcher completion. If the researcher returned an error or an empty body — SKIP writing the Claude artifact, tell the user only the Codex artifact is available (or report full failure if Codex also failed in step 3), and continue using only what succeeded. Otherwise write the Claude artifact with the Write tool to `.hyperclaude/research/<timestamp>-<slug>-claude.md` using the SAME frontmatter block + one-liner as in **Claude path (single — explicit request only)** steps 5–6. The ONLY difference from the single-Claude case is the filename's `-claude` suffix; the frontmatter `slug:` stays `<slug>` (identical to the Codex artifact — this is the canonical trace key).

5. Report BOTH artifact paths to the user (Codex artifact + Claude artifact). Read both and integrate BOTH into your subsequent plan. When you write a plan, save it under `.hyperclaude/plans/<timestamp>-<slug>.md` so `/hyperclaude:hyper-plan-review` can find it later.

### Codex path (single — explicit request only)

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

### Claude path (single — explicit request only)

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

   Base path: `.hyperclaude/research/<timestamp>-<slug>-claude.md` (the `-claude` suffix is how the Claude artifact coexists with the Codex one when both ran). If it exists, append `-2`, `-3`, … before the extension until free.
   - **No-ASCII-slug fallback** (mirrors the bridge): if slug derivation yields no ASCII characters (e.g. an all-Korean topic), the filename is timestamp + `-claude` — `.hyperclaude/research/<timestamp>-claude.md` (with the same `-2`/`-3` collision suffixing) — and the frontmatter `slug:` line is the bare key with an empty value: `slug: ` (key, colon, single space, nothing after — NOT `slug: ""`).

4. Dispatch the `researcher` agent with the Agent tool, `subagent_type: hyperclaude:researcher`, in return-body mode (the agent returns the report markdown; it does not write files). The prompt MUST include:
   - **Task** — the resolved task description, verbatim.
   - **Required section structure** — the report must use exactly these headings, in this order: `### Prior Art`, `### Pitfalls`, `### Recommendations`, `### Open Questions`.

5. Collect the always-present frontmatter values with one short Node one-liner (keeps `cwd`/`git-head` JSON-quoted the same way the bridge's renderer does):

   ```bash
   node -e 'const c=require("child_process");let h;try{h=c.execSync("git rev-parse HEAD").toString().trim();}catch(e){h="unknown";}console.log(JSON.stringify({generated:new Date().toISOString(),cwd:process.cwd(),gitHead:h}))'
   ```

6. Write the artifact with the Write tool to the path from step 3. Frontmatter is ONLY the keys below, in this order (do NOT byte-match `renderFrontmatter()`, do NOT add Codex-only conditional keys like `codex-thread-id`, and do NOT author `plugin-version` — the PostToolUse stamp hook adds it after the write):

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

A research file has YAML frontmatter followed by markdown sections (Prior Art / Pitfalls / Recommendations / Open Questions). Do not modify the file.

The default (parallel) run produces a **Codex + Claude pair**: `.hyperclaude/research/<timestamp>-<slug>.md` (Codex) and `.hyperclaude/research/<timestamp>-<slug>-claude.md` (Claude). Both files carry an **identical frontmatter `slug:`** — that shared slug is the canonical trace key, not the filename. A single-path run produces only the one corresponding file.

Every research file has the same always-present frontmatter keys (mode, task, slug, generated, plugin-version, codex-version, template-version, cwd, git-head, codex-resume-status) and the same section structure. `plugin-version` is present on both, but by different means: the bridge writes it into the Codex artifact, while the Claude artifact gets it from the PostToolUse stamp hook post-write (so it lands as the first frontmatter key, not mid-block). The Codex artifact's `codex-version` is the Codex CLI version and it may add Codex-only conditional keys (e.g. `codex-thread-id`; `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` — each emitted independently when Codex reported that token field in usage); the Claude artifact's `codex-version` is `claude` and it omits those conditional keys. Downstream consumers match on frontmatter `slug:` and may find BOTH files of a pair.
