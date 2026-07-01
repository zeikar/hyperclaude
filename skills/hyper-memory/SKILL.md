---
name: hyper-memory
description: Use on-demand to extract evidence-anchored repo-local knowledge candidates from accumulated .hyperclaude/ artifacts (plans/done, plan-reviews, research) and curate them. Also when the user invokes /hyperclaude:hyper-memory. Orchestration-only — no Codex spawn.
---

# hyper-memory

Repo-local knowledge extraction. Scans the accumulated `.hyperclaude/` corpus and writes one evidence-anchored candidate markdown file per deterministic copy-based span under `.hyperclaude/memory/candidates/`. v1 is **extraction + curation only** — auto-injection into future sessions is the v2 north star and is explicitly out of scope here.

## When to use

- User typed `/hyperclaude:hyper-memory` (with or without an argument).
- A batch of work has accumulated in `.hyperclaude/` (several archived plans, plan-reviews, research artifacts) and it's worth mining for durable repo-local knowledge.

## When to skip

- Only a single small artifact exists since the last extraction — not enough accumulated corpus to be worth mining.
- You want the knowledge injected automatically into a session — that's v2, not implemented.

## How it works

1. Run `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory/extract.mjs"` via Bash and parse the one-line JSON summary it prints to stdout: `{ ok, scanned, candidates, written, skipped, errored, candidatesDir }`.

   The script's CLI accepts exactly two flags — no others exist:
   - `--dry-run` — compute candidates and keys but write nothing (`written` is always `0`).
   - `--root <path>` — corpus root to scan (default `.hyperclaude`).

2. It fully enumerates the v1 source allowlist — NOT newest-only:
   - `plans/done/` — every archived plan.
   - `plan-reviews/` — every plan-review artifact whose verdict is `Ship as-is`.
   - `research/` — every research artifact.

   `code-reviews/` and `docs-reviews/` are v1 non-goals and are never scanned.

3. It writes one evidence-anchored markdown file per candidate under `.hyperclaude/memory/candidates/`, keyed by a compound hash so re-runs are idempotent: a candidate is skipped if its key already exists in EITHER `.hyperclaude/memory/candidates/` OR `.hyperclaude/memory/promoted/` — an already-promoted candidate is never resurrected.

## Candidate schema

Each candidate file's YAML frontmatter carries exactly these keys, in this order:

`plugin-version`, `type`, `source-artifact`, `anchors`, `mode`, `slug`, `git-head`, `generated`, `staleness`

followed by a `## Claim` (a deterministically templated one-liner) and a `## Evidence` section holding **strictly the verbatim copied span** — never a generated or derived line.

**CORE POLICY:** artifact sentences are never stored as truth on their own — every candidate carries an inline evidence anchor quoted verbatim from `source-artifact:`, so a claim can always be traced back to the exact text it came from.

Two fields are easy to conflate and must be read as distinct:

- `source-artifact:` — the `.hyperclaude/**` artifact path the candidate was **mined from** (evidence provenance; a gitignored artifact, not a canonical repo source).
- `anchors:` — a YAML list of **live canonical repo source/doc paths** the claim is *about*. **The extractor ALWAYS emits `anchors: []`** — none of the three v1 sources deterministically names a real repo file, and a `.hyperclaude/**` path is NEVER a valid `anchors:` entry.

## Curation

Two locations only — no multi-state machine:

- `.hyperclaude/memory/candidates/` — proposed, unreviewed.
- `.hyperclaude/memory/promoted/` — human-accepted.

**Promote:** plain `mv .hyperclaude/memory/candidates/<file> .hyperclaude/memory/promoted/<file>` — NOT `git mv` (`.hyperclaude/` is gitignored, so git tracks neither side).

**Promotion gate:** every candidate ships with `anchors: []`. Before promoting, the curator MUST add at least one real repo source/doc path (a non-`.hyperclaude/` file that exists on disk) to the candidate's `anchors:` list. `source-artifact:` provenance alone never satisfies this gate — it names a gitignored artifact, not a canonical anchor.

**Reject:** `rm` the candidate file.

**Idempotency:** because promotion is a plain move out of `candidates/`, and the extractor checks BOTH `candidates/` and `promoted/` for an existing key, a promoted candidate is never re-created by a later extraction run.

## Invocation argument

**Invocation argument:** $ARGUMENTS

**Accepted argument grammar — nothing outside this table:**

| Token(s)          | Meaning                                    |
|-------------------|---------------------------------------------|
| `--dry-run`       | compute candidates/keys, write nothing       |
| `--root <path>`   | corpus root to scan (default `.hyperclaude`) |

The script's CLI parser rejects anything else (unknown flags, `--root` with a missing/flag-like value) with `{"ok":false,"error":...}` and a non-zero exit — see `scripts/memory/extract.mjs`.

Do NOT interpolate the raw `$ARGUMENTS` string into the Bash command. Parse it into individual tokens, keep only tokens matching the grammar above, and pass each as its own shell-quoted argument (e.g. quote the `--root` path value) when invoking `node "${CLAUDE_PLUGIN_ROOT}/scripts/memory/extract.mjs"`. Any token outside the grammar means: do not pass it through — the script would reject it anyway.
