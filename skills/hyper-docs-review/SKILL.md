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

Narrow contract — parse the optional `--diff-base <ref>` suffix FIRST, then validate the remaining target path:

| Pattern (after stripping optional `--diff-base <ref>` suffix) | Bridge argv |
|---|---|
| Empty | `['docs-review', '--docs-dir', 'docs/']` (the hyperclaude/commentarium convention) |
| Path ending in `.md` that exists | `['docs-review', '--docs-path', '<path>']` |
| Existing directory path | `['docs-review', '--docs-dir', '<path>']` |
| Anything else | Tell user the contract, ask to clarify, STOP. |

Default is `docs/`. Projects that don't follow the flat-`docs/` convention should pass an explicit path (e.g., `/hyperclaude:hyper-docs-review README.md`). If `docs/` is missing or has no flat `.md` files, the bridge returns a structured error guiding the user.

### Step 1 — Parse `--diff-base` suffix

If `$ARGUMENTS` matches `^(\S.*) --diff-base ([A-Za-z0-9._/-]+)$` (note: requires non-empty target before the ` --diff-base ` separator — empty target is NOT supported, user must say e.g. `README.md --diff-base main`, not just `--diff-base main`), capture the path part and the ref. Otherwise treat the whole `$ARGUMENTS` as the path part (no diff-base).

### Step 2 — Resolve target

From the path part. Verify the path exists first via Bash (`[ -e "<path>" ]`).

### Step 3 — Run the bridge

Use the Bash tool with `timeout: 600000`. Pass each argument as a separate token (no shell interpolation of user-supplied substrings):

```bash
# Single file
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review --docs-path docs/api.md

# Directory
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review --docs-dir docs/

# With diff context
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review --docs-path docs/api.md --diff-base main
```

### Step 4 — Surface the review

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
