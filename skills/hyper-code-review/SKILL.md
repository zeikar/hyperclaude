---
name: hyper-code-review
description: Run Codex's native code-review on the current branch, working tree, or a specific commit. Use when the user invokes /hyperclaude:hyper-code-review, or after producing code changes and you want a Codex critique. Distinct from /hyperclaude:hyper-plan-review (which critiques plans, not code).
---

# hyper-code-review

Code review gate. Calls Codex in code-review mode against a branch diff, uncommitted working-tree changes, or a specific commit; saves the output to `.hyperclaude/reviews/<timestamp>-<slug>.md`; you read the file and surface the findings.

## When to use

- User typed `/hyperclaude:hyper-code-review` (with or without an argument).
- After a non-trivial change set is staged or committed locally and a Codex critique is wanted.

## When to skip

- The change is a tiny one-line tweak where a full review adds no value.
- You want a plan critique, not a code critique — use `/hyperclaude:hyper-plan-review` instead.

## How to invoke

**Invocation argument:** $ARGUMENTS

### Step 1 — Resolve the bridge argv

Parse `$ARGUMENTS` with the STRICT narrow contract below. Construct an argv array (NOT a single shell string) to pass to the bridge.

| Pattern | Bridge argv |
|---|---|
| Empty (no argument) | `['code-review', '--base', 'main']` |
| Literal `uncommitted` (case-insensitive) | `['code-review', '--uncommitted']` |
| 7–40 hex chars matching `^[0-9a-f]{7,40}$` | `['code-review', '--commit', '<sha>']` |
| Matches `^vs (.+)$` AND rest passes `^[A-Za-z0-9._/-]+$` | `['code-review', '--base', '<ref>']` |
| Anything else | Tell the user the contract above, ask them to clarify, **STOP**. Do NOT fall through to `--base <argument>` — this is shell-injection-prone and produces bad slug filenames. |

**`vs` stripping:** when the argument starts with `vs `, strip the `vs ` prefix, validate the remainder with `^[A-Za-z0-9._/-]+$` as a git ref-name approximation, then use the remainder as `<ref>`. If the remainder fails validation, treat it as invalid input and stop.

### Step 2 — Run the bridge

Use the Bash tool with `timeout: 600000`. Pass each argument as a separate token — never interpolate user-supplied substrings into a single quoted string.

**Default (branch vs main):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main
```

**Uncommitted changes:**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --uncommitted
```

**Specific commit (with validated sha):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --commit <validated-sha>
```

**Explicit base ref (with validated ref):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base <validated-ref>
```

### Step 3 — Surface the review

The bridge prints a single JSON line to stdout. Parse it.

- On `{"ok":true,"path":"..."}` — read the review file with the Read tool and present the findings.
- On `{"ok":false,"error":"..."}` — surface the error verbatim to the user; do not pretend a review happened.

## Output contract

Code-review files have YAML frontmatter (`mode: code-review`, `codex-subcommand: review`, `slug`, `generated`, `codex-version`, `git-head`, plus either `base-ref` or `commit`, and an optional `title`) followed by a Codex review body. Do not modify the file.

## Distinction note

This skill critiques **code and diffs**. For plan critiques use `/hyperclaude:hyper-plan-review`.
