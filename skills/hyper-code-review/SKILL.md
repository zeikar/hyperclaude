---
name: hyper-code-review
description: Run a Codex code review on the current branch, working tree, or a specific commit. Use when the user invokes /hyperclaude:hyper-code-review, or after producing code changes and you want a Codex critique. Distinct from /hyperclaude:hyper-plan-review (which critiques plans, not code).
---

# hyper-code-review

Code review gate. Calls Codex via `codex exec --sandbox read-only -` with a code-review prompt template ([templates/codex/code-review.md](../../templates/codex/code-review.md)) against a branch diff, uncommitted working-tree changes, or a specific commit; the prompt instructs Codex to run the target git commands itself (read-only sandbox) and review with broadened blast-radius context — not only the literal changed lines. Saves the output to `.hyperclaude/code-reviews/<timestamp>-<slug>.md`; you read the file and surface the findings.

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

Code-review files have YAML frontmatter (`mode: code-review`, `slug`, `generated`, `codex-version`, `template-version`, `git-head`, `cwd`, `codex-thread-id` (when available), `codex-resume-status` (one of `fresh | resumed | fallback | resume-failed`), `codex-resumed-from` (path when resumed successfully), plus either `base-ref` or `commit`, and an optional `title`) followed by a Codex review body (`### Findings` with Blocker/Major/Minor + `### Verdict`). Do not modify the file.

**Legacy-artifact resume:** code-review `--resume` requires the prior artifact to carry a `template-version` matching the current code-review prompt. A legacy artifact from the old native `codex exec review` path lacks it and is not resumable: `--resume auto` falls back to a fresh run (`codex-resume-status: fallback`, stderr note); an explicit `--resume <legacy-path>` returns `{"ok":false,...}` with a `resume rejected` error — surface it verbatim and do not pretend a review happened.

## Distinction note

This skill critiques **code and diffs**. For plan critiques use `/hyperclaude:hyper-plan-review`.
