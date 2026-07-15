# Argv grammar — hyper-code-review

Detailed parsing rules for `$ARGUMENTS` in `/hyperclaude:hyper-code-review`. Loaded only when the parser logic itself is in question — the SKILL body keeps a compact summary plus the dispatch table.

## Pre-normalization

If the first whitespace-delimited token equals `uncommitted` case-insensitively, lowercase that single token to `uncommitted` first. This preserves backward-compatible case-insensitive behavior. No other tokens are normalized.

## Regex (case-sensitive — no `/i` flag)

```
/^(?:(uncommitted|[0-9a-f]{7,40}|vs\s+[A-Za-z0-9._/][A-Za-z0-9._/-]*))?(?:\s*(--resume)(?:\s+(?!-)(\S+))?)?\s*$/
```

- **Group 1** — optional target. After pre-normalization, `Uncommitted` / `UNCOMMITTED` / `uncommitted` all match. The hex SHA range is `[0-9a-f]` (lowercase only), so `ABC1234` is rejected at the skill layer. The `vs <ref>` ref starts with `[A-Za-z0-9._/]` then continues with `[A-Za-z0-9._/-]*` — leading `-` forbidden (e.g. `vs -foo` rejected).
- **Group 2** — literal `--resume` token (truthy when present, undefined when absent).
- **Group 3** — optional resume artifact path. Negative lookahead `(?!-)` forbids leading `-` (e.g. `--resume -bad` rejected at the skill layer).
- Bare `--resume` (Group 2 truthy, Group 3 undefined) maps to bridge argv `--resume auto`.
- Default target (Group 1 absent) — the bridge's `parseArgs` itself defaults code-review to `reviewTarget: 'base'`, `baseRef: 'main'`, so the skill passes no target flag.

## Valid invocations

- `/hyperclaude:hyper-code-review` — empty, reviews branch vs main (fresh)
- `/hyperclaude:hyper-code-review uncommitted` — reviews working-tree changes (fresh)
- `/hyperclaude:hyper-code-review Uncommitted` — case-insensitive, normalized to `uncommitted` (fresh)
- `/hyperclaude:hyper-code-review a1b2c3d` — 7–40 lowercase hex, reviews commit (fresh)
- `/hyperclaude:hyper-code-review vs develop` — reviews branch vs ref `develop` (fresh)
- `/hyperclaude:hyper-code-review --resume` — reviews branch vs main, resumes from latest artifact
- `/hyperclaude:hyper-code-review a1b2c3d --resume path/to/prior.md` — reviews commit, resumes from explicit artifact

## Explicitly rejected (explain reason & stop)

- `--resume vs main` — `--resume` appears before target; must be `vs main --resume` or omit `vs main` for default
- `vs --resume` — `--resume` missing ref name; must be `vs <ref>` or bare `--resume`
- `vs -foo` — ref starts with `-`; git refs cannot start with `-`
- `--resume -bad` — artifact path starts with `-`; cannot be a flag
- `ABC1234` — uppercase SHA; bridge accepts only lowercase `[0-9a-f]{7,40}`
- Paths with spaces are unsupported — explicit constraint in the grammar
- Any input failing the regex after pre-normalization — ask user to clarify

## Resume semantics

See `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` for the shared `--resume` semantics (explicit vs `auto` fallback, the `template-version` precondition — a legacy artifact from the old native `codex exec review` path has no `template-version` and is not resumable). Code-review-specific detail:

- Identity check (fresh vs resumed): same `cwd`, same target (base-ref NAME match for `--base`, exact SHA match for `--commit`, symmetric absence of both for `--uncommitted`), prior thread present, prior status ∈ {fresh, resumed}.

## Bridge invocation cookbook

Build argv following the dispatch table in `SKILL.md` and pass each argument as a separate token — never interpolate user-supplied substrings into a single quoted string. Use the Bash tool with `timeout: 600000`.

```bash
# Default — branch vs main, fresh
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main

# Default — branch vs main, resumed
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main --resume auto

# Uncommitted, fresh
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --uncommitted

# Uncommitted, resumed from explicit artifact
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --uncommitted --resume path/to/prior.md

# Specific commit, fresh
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --commit <validated-sha>

# Specific commit, resumed from explicit artifact
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --commit <validated-sha> --resume path/to/prior.md

# Explicit base ref, fresh
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base <validated-ref>

# Explicit base ref, resumed
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base <validated-ref> --resume auto
```

All variations are mechanical compositions of the dispatch table — pick the row for the target pattern, then append `--resume <Group 3 or 'auto'>` if `--resume` was matched.
