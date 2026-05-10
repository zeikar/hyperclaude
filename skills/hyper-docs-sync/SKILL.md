---
name: hyper-docs-sync
description: Sync documentation to reflect recent code changes. Use when the user invokes /hyperclaude:hyper-docs-sync or after implementing changes that affect documented behavior (API surface, schemas, CLI flags, architecture). Reads code-to-doc mapping from CLAUDE.md/AGENTS.md, identifies affected docs, dispatches the documenter agent once per affected doc.
---

# hyper-docs-sync

Documentation sync gate. Reads recent code changes, maps them to documentation files via the project's mapping table (or heuristic fallback), and dispatches the `documenter` agent to update each affected doc — creating new docs as needed.

## When to use

- User typed `/hyperclaude:hyper-docs-sync`.
- After non-trivial implementation that changes documented API, CLI flags, data models, or architecture.

## When to skip

- Pure refactors with no behavioral change.
- Changes already reflected in docs.

## How to invoke

**Invocation argument:** $ARGUMENTS

Narrow contract (same shape as `hyper-code-review`):

| Pattern | Meaning |
|---|---|
| Empty | Changes since `main` (`git diff main...HEAD`) |
| Literal `uncommitted` | Staged + unstaged + untracked working-tree changes |
| 7-40 hex chars matching `^[0-9a-f]{7,40}$` | That specific commit (`git show --format= --patch <sha>`) |
| `^vs (.+)$` where the rest matches `^[A-Za-z0-9._/-]+$` | Changes since that ref (`git diff <ref>...HEAD`) |
| Anything else | Tell user the contract above, ask to clarify, STOP. |

### Step 1 — Resolve changed files + their diffs

Use the Bash tool. Concrete commands per scope:

- **Empty (`vs main`)**: `git diff --name-only main...HEAD` for the file list; per-file diffs via `git diff main...HEAD -- <file>`.
- **`uncommitted`**: `git status --porcelain` to enumerate staged + unstaged + untracked. For staged/unstaged: `git diff HEAD -- <file>`. For untracked files (no diff possible): read content directly via Read tool, treat as "new file added."
- **Hex SHA**: `git show --format= --patch <sha>` (NOT `--stat` — you need actual diff content).
- **`vs <ref>`**: `git diff --name-only <ref>...HEAD` + per-file `git diff <ref>...HEAD -- <file>`.

### Step 2 — Read the project's CLAUDE.md and/or AGENTS.md (if either exists)

Look for a markdown table where one column header matches `/code|source|file/i` (case-insensitive) and another matches `/doc|docs|documentation/i`. Extract the mapping into a structured form.

The canonical recommended header names are `Code` and `Docs`. Example (commentarium-style):

```markdown
| Code area | Docs |
|---|---|
| API surface | docs/api.md |
| Firestore schema | docs/data-model.md |
| Auth flows | docs/auth.md |
```

If no conforming table is found, note this in the summary and proceed with heuristic fallback.

### Step 3 — Map changed files to docs

Use the extracted table (exact path or glob match against changed file paths).

**Heuristic fallback** when no table or no table match: name similarity (e.g., changed `src/auth/session.ts` → look for `docs/auth.md` if it exists).

**Confidence rule:** dispatch the `documenter` agent ONLY for matches that meet ONE of:
- Mapping table match (any confidence — table is authoritative).
- Heuristic match where the changed file's stem appears in the doc filename (e.g., `auth.ts` → `auth.md` qualifies; `session.ts` → `auth.md` does NOT qualify by this rule alone).

Lower-confidence heuristic candidates (no clear name overlap) are REPORTED in the summary as `skipped — possible candidates: X, Y` so the user can manually invoke documenter if appropriate. Avoids unsafe edits driven by guesswork.

### Step 4 — Aggregate per doc

Group all changed files + their diffs that map to the same target doc. Never dispatch the `documenter` agent more than once per target doc; aggregate first.

### Step 5 — Dispatch `documenter` agent

For each affected doc, dispatch via the Agent tool with `subagent_type: hyperclaude:documenter`. In the prompt, include:

- The target doc path
- **Whether the doc EXISTS or needs to be CREATED**: check `[ -f "<target>" ]` via Bash before dispatching. If absent, dispatch in CREATE mode (the agent writes a new file with a sensible scaffold). If present, dispatch in UPDATE mode (agent edits in place). Make this explicit in the dispatch prompt.
- The aggregated diff/excerpts for changed code mapped to this doc
- The mapping rationale (table match vs heuristic match)

### Step 6 — Report

Run `git status` and `git diff --stat` to summarize what changed in docs. Report per-doc:

- Updated: `docs/api.md` — sections X, Y modified
- Created: `docs/new-feature.md` — new file scaffolded from <code path>
- No change needed: `docs/foo.md` — code change didn't affect this doc's claims
- Skipped (low confidence): `docs/bar.md` — possible heuristic match, manual review suggested

If the project has no mapping table, end the report with a suggestion: "Tip: add a `Code | Docs` mapping table to your CLAUDE.md so future runs are precise. Based on this run's matches, here's a starter table you can paste:" followed by the inferred table.

## Output contract

This skill produces no `.hyperclaude/` artifacts; the doc edits/new files ARE the artifact. The `hyper-docs-review` gate is the follow-up Codex critic for accuracy verification.

## Distinction note

- `/hyperclaude:hyper-docs-sync` — Claude EDITS docs to match code (this skill)
- `/hyperclaude:hyper-docs-review` — Codex CRITIQUES docs for accuracy
- `/hyperclaude:hyper-code-review` — Codex critiques code diffs
- `/hyperclaude:hyper-plan-review` — Codex critiques plans
