---
name: hyper-docs-review
description: Use after documentation edits — typically after the documenter agent runs, or when the user invokes /hyperclaude:hyper-docs-review. Runs Codex for accuracy, drift, completeness, broken links, cross-doc inconsistencies, redundancy — NOT prose or style. Distinct from /hyperclaude:hyper-code-review (code diffs) and /hyperclaude:hyper-plan-review (plans).
---

# hyper-docs-review

Documentation accuracy gate. Sends docs (one or more files, or a directory) to Codex for critique focused on: drift between docs and code, missing coverage, broken or suspect links, contradictions between docs, in-doc duplicated claims (redundancy).

## When to use

- User typed `/hyperclaude:hyper-docs-review`.
- After `hyper-docs-sync` has edited docs and you want a Codex accuracy gate.

## When to skip

- Docs haven't changed.
- You want a style/prose review (this gate is accuracy-only).

## How to invoke

**Invocation argument:** $ARGUMENTS

`--resume` is supported. Paths with spaces are unsupported.

### Argv grammar

Apply this regex to the trimmed `$ARGUMENTS`:

```
^((?:(?!--)\S+\s*)*)(?:--diff-base\s+(\S+))?(?:\s*(--resume)(?:\s+(\S+))?)?\s*$
```

- Group 1 = zero or more space-separated leading path tokens (split on whitespace in Step 1); each is either an existing `.md` file or, if it's the sole token, an existing directory; empty defaults to `docs/`. Negative lookahead per-token prevents matching `--diff-base` or `--resume` as a path. Many `.md` files OR one directory — never both.
- Group 2 = optional `--diff-base <ref>` value
- Group 3 = literal `"--resume"` token (truthy when present, undefined when not)
- Group 4 = optional resume artifact path

When Group 3 is `'--resume'` (truthy) and Group 4 is undefined, treat as `--resume auto`.

**Valid invocations:**
- `/hyperclaude:hyper-docs-review` — reviews `docs/`, fresh run
- `/hyperclaude:hyper-docs-review docs/api.md` — reviews single file, fresh run
- `/hyperclaude:hyper-docs-review README.md docs/workflow.md docs/architecture.md` — reviews three files, fresh run
- `/hyperclaude:hyper-docs-review --resume` — reviews `docs/`, resumes from latest artifact
- `/hyperclaude:hyper-docs-review --resume <prev-artifact-path>` — resumes from explicit artifact
- `/hyperclaude:hyper-docs-review docs/api.md --diff-base main` — single file with diff context
- `/hyperclaude:hyper-docs-review docs/api.md --resume` — single file, resume from `auto`
- `/hyperclaude:hyper-docs-review docs/api.md --diff-base main --resume <prev-artifact-path>` — all options

If the argument doesn't match the regex, ask the user to clarify and stop.

### Resume semantics

See `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` for the shared `--resume` semantics (explicit vs `auto` fallback, the `template-version` precondition). Docs-review's identity check keys on the docs-target SET (order-insensitive — not a single scalar).

- Budget exceeded (docs > 200KB after revision): bridge returns `ok:false` — NOT fallback. Tell user to narrow scope (fewer `--docs-path` files, or a smaller subdirectory).

### Step 1 — Resolve target

Split Group 1 on whitespace into tokens (or default to `docs/` when empty). Verify each path exists first via Bash (`[ -e "<path>" ]`).

| Group 1 tokens | Bridge argv |
|---|---|
| Empty | `['docs-review', '--docs-dir', 'docs/']` |
| One or more `.md` paths that exist | `['docs-review', '--docs-path', '<path1>', '--docs-path', '<path2>', ...]` (one flag per file, in order) |
| Single existing directory path | `['docs-review', '--docs-dir', '<path>']` |
| Anything else (mix of files and a dir, non-`.md` path, or a path that doesn't exist) | Tell user the contract, ask to clarify, STOP. |

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

- `docs payload exceeds 200KB` → tell user to narrow scope (fewer `--docs-path` files, or a smaller subdirectory)
- `no .md files in <path>` → tell user the directory has no top-level markdown
- `git diff exceeds 500KB` → tell user to use a closer `--diff-base` ref or omit it

## Output contract

Docs-review files have YAML frontmatter:

- `mode: docs-review`
- `template-version` (sourced from the docs-review template's frontmatter)
- `slug` (derived from file basename or dir name; multi-file runs use `<first>-plus-<n-1>`)
- `generated` (ISO timestamp)
- `plugin-version`
- `codex-version`
- `docs-target` (a JSON STRING of the dir path in `--docs-dir` mode, or a JSON ARRAY of file paths in `--docs-path` list mode)
- Optional `diff-base` (when `--diff-base` was used)
- `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` — each emitted independently when Codex reported that token field in usage; omitted when Codex did not emit usage

Followed by sections: `### Findings`, `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies`, `### Verdict`.

Each `### Findings` item includes severity (Blocker / Major / Minor), doc path, quoted stale claim, code evidence, and recommended edit. Redundancy findings replace the stale claim and code evidence with the duplicated claim (quoted once) and every location where it appears.

## Distinction

- `/hyperclaude:hyper-docs-review` — Codex critiques documentation accuracy (this skill)
- `/hyperclaude:hyper-docs-sync` — Claude updates docs to match code (sister skill)
- `/hyperclaude:hyper-code-review` — Codex critiques code diffs
- `/hyperclaude:hyper-plan-review` — Codex critiques implementation plans

Scope is STRICT: accuracy / drift / completeness / broken links / cross-doc inconsistencies / redundancy (in-doc duplicated claims — reported Minor; deliberate cross-doc propagation exempt). NOT style or prose quality — that's the documenter agent's domain.
