---
name: hyper-docs-review
description: Run Codex accuracy review on documentation. Use when the user invokes /hyperclaude:hyper-docs-review or after the documenter agent edits docs. Distinct from /hyperclaude:hyper-code-review (which critiques code diffs) and /hyperclaude:hyper-plan-review (which critiques plans). Scope is strict: accuracy, drift, completeness, broken links, cross-doc inconsistencies — NOT prose or style.
---

# hyper-docs-review

Documentation accuracy gate. Sends docs (single file or directory) to Codex for critique focused on: drift between docs and code, missing coverage, broken or suspect links, contradictions between docs.

## When to use

- User typed `/hyperclaude:hyper-docs-review`.
- After `hyper-docs-sync` has edited docs and you want a Codex accuracy gate.

## When to skip

- Docs haven't changed.
- You want a style/prose review (this gate is accuracy-only).

## How to invoke

**Invocation argument:** $ARGUMENTS

`--resume` is supported in v0.4. Paths with spaces are unsupported.

### Argv grammar

Apply this regex to the trimmed `$ARGUMENTS`:

```
^(?:((?!--)\S+))?(?:\s*--diff-base\s+(\S+))?(?:\s*(--resume)(?:\s+(\S+))?)?\s*$
```

- Group 1 = optional path (single file or dir; defaults to `docs/`); negative lookahead prevents matching `--diff-base` or `--resume` as a path
- Group 2 = optional `--diff-base <ref>` value
- Group 3 = literal `"--resume"` token (truthy when present, undefined when not)
- Group 4 = optional resume artifact path

When Group 3 is `'--resume'` (truthy) and Group 4 is undefined, treat as `--resume auto`.

**Valid invocations:**
- `/hyperclaude:hyper-docs-review` — reviews `docs/`, fresh run
- `/hyperclaude:hyper-docs-review docs/api.md` — reviews single file, fresh run
- `/hyperclaude:hyper-docs-review --resume` — reviews `docs/`, resumes from latest artifact
- `/hyperclaude:hyper-docs-review --resume <prev-artifact-path>` — resumes from explicit artifact
- `/hyperclaude:hyper-docs-review docs/api.md --diff-base main` — single file with diff context
- `/hyperclaude:hyper-docs-review docs/api.md --resume` — single file, resume from `auto`
- `/hyperclaude:hyper-docs-review docs/api.md --diff-base main --resume <prev-artifact-path>` — all options

If the argument doesn't match the regex, ask the user to clarify and stop.

### Resume semantics

- `--resume <path>` (explicit): if validation fails, bridge returns `ok:false`, no fresh run, stderr note. Surface the error verbatim.
- `--resume` / `--resume auto`: if validation fails, bridge falls back to fresh run, writes artifact with `codex-resume-status: fallback`, stderr note.
- Budget exceeded (docs > 200KB after revision): bridge returns `ok:false` — NOT fallback. Tell user to narrow scope.

### Step 1 — Resolve target

From Group 1 (or default `docs/`). Verify the path exists first via Bash (`[ -e "<path>" ]`).

| Group 1 value | Bridge argv |
|---|---|
| Empty | `['docs-review', '--docs-dir', 'docs/']` |
| Path ending in `.md` that exists | `['docs-review', '--docs-path', '<path>']` |
| Existing directory path | `['docs-review', '--docs-dir', '<path>']` |
| Anything else | Tell user the contract, ask to clarify, STOP. |

### Step 2 — Run the bridge

Use the Bash tool with `timeout: 600000`. Pass each argument as a separate token (no shell interpolation of user-supplied substrings):

```bash
# Single file
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review --docs-path docs/api.md

# Directory
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review --docs-dir docs/

# With diff context
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review --docs-path docs/api.md --diff-base main
```

If `--diff-base <ref>` was matched (Group 2), append `--diff-base <ref>` to the argv. If `--resume` was matched (Group 3 truthy), append `--resume <value>` to the argv, where `<value>` is Group 4 if present, otherwise `auto`.

### Step 3 — Surface the review

Parse JSON. On `ok:true`, read the output file with the Read tool. On `ok:false`, surface the error verbatim:

- `docs payload exceeds 200KB` → tell user to narrow scope (`--docs-path` to a single file, or a smaller subdirectory)
- `no .md files in <path>` → tell user the directory has no top-level markdown
- `git diff exceeds 500KB` → tell user to use a closer `--diff-base` ref or omit it

## Output contract

Docs-review files have YAML frontmatter:

- `mode: docs-review`
- `template-version: 1`
- `slug` (derived from file basename or dir name)
- `generated` (ISO timestamp)
- `codex-version`
- `docs-target` (the reviewed path, JSON-stringified)
- Optional `diff-base` (when `--diff-base` was used)

Followed by sections: `### Findings`, `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies`, `### Verdict`.

Each `### Findings` item includes severity (Blocker / Major / Minor), doc path, quoted stale claim, code evidence, and recommended edit.

## Distinction

- `/hyperclaude:hyper-docs-review` — Codex critiques documentation accuracy (this skill)
- `/hyperclaude:hyper-docs-sync` — Claude updates docs to match code (sister skill)
- `/hyperclaude:hyper-code-review` — Codex critiques code diffs
- `/hyperclaude:hyper-plan-review` — Codex critiques implementation plans

Scope is STRICT: accuracy / drift / completeness / broken links / cross-doc inconsistencies. NOT style or prose quality — that's the documenter agent's domain.
