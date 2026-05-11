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

### Argv grammar

The skill PRE-NORMALIZES the input: if the first whitespace-delimited token equals `uncommitted` case-insensitively, lowercase that single token to `uncommitted` (preserving backward-compatible case-insensitive behavior). Then apply this regex (case-sensitive — no `/i` flag):

```
/^(?:(uncommitted|[0-9a-f]{7,40}|vs\s+[A-Za-z0-9._/][A-Za-z0-9._/-]*))?(?:\s*(--resume)(?:\s+(?!-)(\S+))?)?\s*$/
```

- Group 1 = optional target. After pre-normalization, `Uncommitted` / `UNCOMMITTED` / `uncommitted` all match. Hex SHA range is `[0-9a-f]` (lowercase-only), so `/hyperclaude:hyper-code-review ABC1234` is rejected at the skill layer. The `vs <ref>` ref starts with `[A-Za-z0-9._/]` then continues with `[A-Za-z0-9._/-]*` — forbids leading `-` (e.g. `vs -foo` is rejected).
- Group 2 = literal `--resume` token (truthy when present, undefined when absent).
- Group 3 = optional resume artifact path. Negative lookahead `(?!-)` forbids leading `-` (e.g. `--resume -bad` is rejected at the skill layer).
- Bare `--resume` (Group 2 truthy, Group 3 undefined) maps to bridge argv `--resume auto`.
- Default target (Group 1 absent) — the bridge's `parseArgs` itself defaults code-review to `reviewTarget: 'base'`, `baseRef: 'main'`, so the skill passes no target flag.

**Valid invocations:**
- `/hyperclaude:hyper-code-review` — empty, reviews branch vs main (fresh)
- `/hyperclaude:hyper-code-review uncommitted` — reviews working-tree changes (fresh)
- `/hyperclaude:hyper-code-review Uncommitted` — case-insensitive, normalized to `uncommitted` (fresh)
- `/hyperclaude:hyper-code-review a1b2c3d` — 7-40 lowercase hex, reviews commit (fresh)
- `/hyperclaude:hyper-code-review vs develop` — reviews branch vs ref `develop` (fresh)
- `/hyperclaude:hyper-code-review --resume` — reviews branch vs main, resumes from latest artifact
- `/hyperclaude:hyper-code-review a1b2c3d --resume path/to/prior.md` — reviews commit, resumes from explicit artifact

**Explicitly rejected (explain reason & stop):**
- `--resume vs main` — `--resume` appears before target; must be `vs main --resume` or omit `vs main` for default
- `vs --resume` — `--resume` missing ref name; must be `vs <ref>` or bare `--resume`
- `vs -foo` — ref starts with `-`; git refs cannot start with `-`
- `--resume -bad` — artifact path starts with `-`; cannot be a flag
- `ABC1234` — uppercase SHA; bridge accepts only lowercase `[0-9a-f]{7,40}`
- Any input failing the regex after pre-normalization; ask user to clarify

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

### Resume semantics

- `--resume <path>` (explicit): if validation fails, bridge returns `ok:false`, no fresh run, stderr note. Surface the error verbatim.
- `--resume` / `--resume auto`: if validation fails, bridge falls back to fresh run, writes artifact with `codex-resume-status: fallback`, stderr note.
- Identity check (fresh vs resumed): same `cwd`, same target (base-ref NAME match for `--base`, exact SHA match for `--commit`, symmetric absence of both for `--uncommitted`), prior thread present, prior status ∈ {fresh, resumed}.

### Step 2 — Run the bridge

Use the Bash tool with `timeout: 600000`. Pass each argument as a separate token — never interpolate user-supplied substrings into a single quoted string.

If `--resume` was matched (Group 2), append `--resume <value>` where `<value>` is Group 3 if present, otherwise `auto`.

**Default (branch vs main, fresh):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main
```

**Default (branch vs main, resumed):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main --resume auto
```

**Uncommitted changes (fresh):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --uncommitted
```

**Uncommitted changes (resumed from explicit artifact):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --uncommitted --resume path/to/prior.md
```

**Specific commit (fresh, with validated sha):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --commit <validated-sha>
```

**Specific commit (resumed, with validated sha and artifact path):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --commit <validated-sha> --resume path/to/prior.md
```

**Explicit base ref (fresh, with validated ref):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base <validated-ref>
```

**Explicit base ref (resumed, with validated ref):**
```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base <validated-ref> --resume auto
```

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
