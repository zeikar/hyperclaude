---
name: hyper-code-review
description: Run Codex's native code-review on the current branch, working tree, or a specific commit. Use when the user invokes /hyperclaude:hyper-code-review, or after producing code changes and you want a Codex critique. Distinct from /hyperclaude:hyper-plan-review (which critiques plans, not code).
---

# hyper-code-review

Code review gate. Calls Codex via `codex exec review` against a branch diff, uncommitted working-tree changes, or a specific commit; saves the output to `.hyperclaude/code-reviews/<timestamp>-<slug>.md`; you read the file and surface the findings.

## When to use

- User typed `/hyperclaude:hyper-code-review` (with or without an argument).
- After a non-trivial change set is staged or committed locally and a Codex critique is wanted.

## When to skip

- The change is a tiny one-line tweak where a full review adds no value.
- You want a plan critique, not a code critique — use `/hyperclaude:hyper-plan-review` instead.

## How to invoke

**Invocation argument:** $ARGUMENTS

`--resume` is supported. Paths with spaces are unsupported.

### Argv grammar (summary)

Pre-normalize: if the first token is `uncommitted` case-insensitively, lowercase it. Then apply:

```
/^(?:(uncommitted|[0-9a-f]{7,40}|vs\s+[A-Za-z0-9._/][A-Za-z0-9._/-]*))?(?:\s*(--resume)(?:\s+(?!-)(\S+))?)?\s*$/
```

Group 1 = target, Group 2 = `--resume` token, Group 3 = artifact path. Bare `--resume` → `--resume auto`. Empty Group 1 → bridge default (`--base main`).

For the full regex breakdown, valid/rejected invocation lists, resume identity rules, and per-pattern bridge examples, see [references/argv-grammar.md](references/argv-grammar.md).

### Step 1 — Resolve the bridge argv

Parse `$ARGUMENTS` with the grammar above. Construct an argv array (NOT a single shell string) to pass to the bridge.

| Pattern | Bridge argv |
|---|---|
| Empty (no argument) | `['code-review', '--base', 'main']` |
| Literal `uncommitted` (case-insensitive, pre-normalized to lowercase) | `['code-review', '--uncommitted']` |
| 7–40 hex chars matching `^[0-9a-f]{7,40}$` | `['code-review', '--commit', '<sha>']` |
| Matches `^vs (.+)$` AND rest passes `^[A-Za-z0-9._/-]+$` | `['code-review', '--base', '<ref>']` |
| `--resume` present (Group 2) | Append `['--resume', <Group 3 or 'auto'>]` to above |
| Anything else | Tell the user the contract above, ask them to clarify, **STOP**. Do NOT fall through to `--base <argument>` — this is shell-injection-prone and produces bad slug filenames. |

### Step 2 — Run the bridge

Use the Bash tool with `timeout: 600000`. Pass each argument as a separate token — never interpolate user-supplied substrings into a single quoted string.

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review <flags from table above> [--resume <Group 3 or 'auto'>]
```

Flag selection follows the dispatch table. If `--resume` was matched (Group 2), append `--resume <value>` where `<value>` is Group 3 if present, otherwise `auto`. See [references/argv-grammar.md](references/argv-grammar.md) for a per-pattern cookbook of fully expanded commands.

### Step 3 — Surface the review

The bridge prints a single JSON line to stdout. Parse it and see the Output contract section below for full details on the JSON structure. In brief:

- On success — read the review file with the Read tool and present the findings.
- On failure — surface the error verbatim to the user; do not pretend a review happened. When `resumeStatus` is `resume-failed`, note that the prior context could not be used.

## Output contract

The bridge prints a single JSON line to stdout:

- On `{"ok":true,"path":"...","slug":"...","threadId":"...","resumeStatus":"..."}` — read the review file with the Read tool and present the findings.
- On `{"ok":false,"error":"...","path":"...","resumeStatus":"...","threadId":"..."}` — surface the error verbatim to the user; do not pretend a review happened. When `resumeStatus` is `resume-failed`, note that the prior context could not be used.

Code-review files have YAML frontmatter (`mode: code-review`, `slug`, `generated`, `codex-version`, `git-head`, `cwd`, `codex-thread-id` (when available), `codex-resume-status` (one of `fresh | resumed | fallback | resume-failed`), `codex-resumed-from` (path when resumed successfully), plus either `base-ref` or `commit`, and an optional `title`) followed by a Codex review body. Do not modify the file.

## Distinction note

This skill critiques **code and diffs**. For plan critiques use `/hyperclaude:hyper-plan-review`.
