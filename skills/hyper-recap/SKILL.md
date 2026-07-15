---
name: hyper-recap
description: Use at cycle completion to write a human-readable recap of what was built and why — "recap this cycle", "summarize what we built", "cycle recap", "write up what changed this cycle". Also when the user invokes /hyperclaude:hyper-recap. Claude-only — no Codex, no agent dispatch — runs after a plan is implemented and reviewed, and writes a recap to .hyperclaude/recaps/. Recaps ONE completed detailed plan / milestone archived under .hyperclaude/plans/done/. Distinct from /hyperclaude:hyper-memory (durable knowledge extraction, not a one-cycle narrative).
---

# hyper-recap

Cycle-completion recap. An AI-run cycle leaves the codebase changed but the human out of the loop: the request, the judgments taken, the alternatives rejected, and the critic rounds are all in the AI's head or scattered across gitignored artifacts. That is cognitive debt — without a write-up a human can't reconstruct *why* and *how* the AI built what it built. This skill collapses one completed cycle into a single human-readable recap under `.hyperclaude/recaps/`.

**Claude-only — no Codex, no agent dispatch.** It joins the non-Codex-spawning set alongside `hyper-interview`, `hyper-memory`, and `hyper-setup`. It never calls the bridge and never dispatches an agent — it only reads `.hyperclaude/` artifacts + in-session context and writes one markdown file.

The recap unit is **ONE completed detailed plan / milestone** (a plan archived under `.hyperclaude/plans/done/`). Epic-level rollup across milestones is a v1 non-goal. This is **NOT a PR draft** — it explains the cycle to a human, it does not propose or format changes for merge.

## When to use

- User typed `/hyperclaude:hyper-recap [path|slug]`.
- A cycle just completed — the plan ran to completion (`implement` / `code-review` done) and was archived under `.hyperclaude/plans/done/` — and the why/how should be captured.
- hyper-auto invokes this skill automatically as its terminal step on a clean composed exit (the sole auto-run path; standalone it stays on-demand).

## When to skip

- **Mid-cycle.** v1 recaps ONLY completed cycles — there is no mid-cycle partial-recap mode. If the target plan is still active (not yet archived), stop and say so (see Target resolution's completion gate).
- **No completed plan exists.** Zero `.hyperclaude/plans/done/*.md` → report "nothing to recap", write NOTHING, stop.

## Invocation argument

**Invocation argument:** $ARGUMENTS

## Target resolution

Every branch resolves to a COMPLETED plan under `.hyperclaude/plans/done/`. Classify `$ARGUMENTS`:

- contains `/` OR ends in `.md` → **path** branch
- a bare non-empty token → **slug** branch
- empty → **no-arg** branch

### Path branch

First **validate** the supplied path via canonical-path comparison — never a lexical/string-prefix check:

1. Canonicalize the repository's `.hyperclaude/plans/` and `.hyperclaude/plans/done/` directories (resolve symlinks and collapse `.`/`..` traversal — `realpath`/`readlink -f` semantics).
2. **Candidate's leaf EXISTS** → canonicalize the whole candidate path and require its parent directory to be EXACTLY one of those two canonicalized directories (a direct child — reject traversal segments, nested subdirectories, and symlinks that resolve outside either directory).
3. **Candidate's leaf does NOT exist** → canonicalize only its PARENT directory (the leaf itself has nothing to resolve) and require that parent to be EXACTLY the canonicalized `.hyperclaude/plans/` directory. This missing-leaf case is allowed ONLY for the active-plan directory, matching the archival-relocation case below: the plan was archived out from under its active path, so it's the DONE sibling, not the missing active leaf, that gets canonicalized and containment-checked next.
4. Any candidate that fails these checks → STOP `path must be under .hyperclaude/plans/ or plans/done/: <path>`. Never basename-match an external path against a done plan.

Then key on the given path EXACTLY (no blind basename swap):

- Explicit `.hyperclaude/plans/done/<...>` path → use it EXACTLY if it exists and is readable; else STOP `plan not found: <path>`. No basename relocation for a done path.
- Explicit active `.hyperclaude/plans/<...>` path:
  - If that EXACT file still exists → it is an un-archived plan → STOP `plan not yet completed — run it to completion first` (completion gate). Do NOT silently retarget a same-basename done plan.
  - Only when the exact active path NO LONGER exists AND `.hyperclaude/plans/done/<basename>` exists → use the done copy (archival relocation). This is the missing-leaf case validated above: the parent (`.hyperclaude/plans/`) canonicalized and passed containment while the leaf was absent; now canonicalize and containment-check the done sibling (`.hyperclaude/plans/done/<basename>`) before reading it.
  - Neither exists → STOP `plan not found: <path>`.

### Slug branch

Scan `.hyperclaude/plans/done/*.md`, derive each file's slug via the **Target slug** rule below, and collect files whose derived slug equals the argument.

- 0 matches → STOP `no completed plan for slug '<slug>'`.
- 1 match → use it.
- ≥2 matches → select the **newest by mtime** (the SAME `ls -1t` ordering the no-arg branch uses — one total ordering over every candidate, regardless of whether a filename carries a `<YYYYMMDD-HHMM>` prefix) AND report the ambiguity: list the matched candidates and which was chosen.

### No-arg branch

Newest `.hyperclaude/plans/done/*.md` by mtime:

```bash
ls -1t .hyperclaude/plans/done/*.md 2>/dev/null | head -1
```

Zero done plans → report "nothing to recap", write NOTHING, STOP.

## Target slug

Derive the target plan's slug `S` from the resolved plan FILENAME (basename without `.md`). This rule derives ONLY the target plan's own `S` and the recap filename — NEVER use it to match other artifacts (see discovery, which reads frontmatter). It replicates `extractSlugFromPlanFilename` (`scripts/codex/slug.mjs` lines 29–33) with explicit no-ASCII / empty handling:

- basename matches `^\d{8}-\d{4}-(.+)$` → `S` = the captured suffix (the normal `<ts>-<slug>` case).
- basename is a bare timestamp — matches `^\d{8}-\d{4}-?$` (timestamp-only or trailing-hyphen) → `S` = **EMPTY**. This is the repo's **no-ASCII** convention (specs/research use a bare empty `slug:` with a `<timestamp>.md` filename); the plain `extractSlugFromPlanFilename` fallback would wrongly yield the timestamp as `S`.
- otherwise (a manually named `<slug>.md` with no timestamp prefix — `hyper-implement` can archive these) → `S` = the whole basename.

**Empty-`S` behavior.** The recap filename is timestamp-only (`.hyperclaude/recaps/<timestamp>.md`, collision-suffixed `-2`/`-3` as usual — never a dangling `<timestamp>-.md`), and the frontmatter `slug:` is the bare empty key (`slug: ` — key, colon, single space, nothing after — matching `hyper-interview`'s no-ASCII fallback, NOT `slug: ""`). Research/spec slug-linkage is UNAVAILABLE for an empty-`S` cycle (an empty slug can't distinguish cycles) — acknowledge that gap in the recap. Plan-reviews still link exactly via the `plan-path` + `cwd` full-path rule.

**Collision-ambiguous `S` behavior.** The plan-writer appends `-2`/`-3`… collision suffixes to plan FILENAMES, but linked research/spec artifacts keep their ORIGINAL frontmatter `slug:` — and plans persist NO canonical `slug:` field, so a filename-derived `S` ending in a number cannot be proven to be a real slug vs a collision suffix. Flag `S` as **collision-ambiguous** when it matches `-\d+$` (e.g. `foo-2` — could be `slug: foo` collided) OR is entirely digits `^\d+$` (e.g. `2` — an empty-slug collision `<ts>-2.md`). For a collision-ambiguous `S`: still use `S` verbatim for the recap FILENAME and frontmatter `slug:` (naming only, no correctness risk), but treat research/spec slug-linkage as UNAVAILABLE (same as empty `S`) and note it — do NOT silently match `slug: foo` or `slug: 2`. This conservatively accepts that a genuine slug ending in `-<digits>` also loses research/spec linkage; plan-reviews still link exactly via `plan-path` + `cwd`. (v1 declines a durable plan slug marker.)

`recaps/` accumulates like `research/` and is NEVER archived.

## Cycle artifact discovery

Match by **FRONTMATTER, not filename**. Filename extraction is wrong for `<ts>-S-claude.md` (→ `S-claude`) and collision-suffixed `<ts>-S-2.md` (→ `S-2`).

- **plan-reviews (exact membership).** Read each `.hyperclaude/plan-reviews/*.md` frontmatter `plan-path` AND `cwd` (both are recorded — see `scripts/codex/frontmatter.mjs`; `hyper-plan-review` records the caller's path verbatim, which may be relative or an external path). Resolve `plan-path` against that artifact's recorded `cwd` to a canonical absolute path, and include the review ONLY when it equals the target plan's canonical ACTIVE path (`<target-cwd>/.hyperclaude/plans/<basename>`) OR its DONE path (`<target-cwd>/.hyperclaude/plans/done/<basename>`). Basename equality alone is INSUFFICIENT — a review of an unrelated external plan with the same filename must not match.
- **research + specs (slug-only, caveated).** Read each `.hyperclaude/research/*.md` and `.hyperclaude/specs/*.md` frontmatter `slug:`; include those equal to `S`. Because `S` may be non-unique across completed cycles, present these as "slug-matched (may include artifacts from other same-slug cycles)". If more than one `plans/done/*.md` shares slug `S`, surface that ambiguity explicitly. When `S` is EMPTY (no-ASCII) OR collision-ambiguous (per Target slug — matches `-\d+$` or `^\d+$`), **skip this slug match entirely** and note that research/spec linkage is unavailable — do NOT match on an empty slug (it would sweep in every no-ASCII cycle's artifacts) or on a collision-suffixed `S`.
- **code-reviews (live-only).** Include ONLY paths supplied by the live loop's `reviewArtifacts[]` or otherwise referenced in-session — NEVER slug- or frontmatter-guessed (code-review artifacts use release-level slugs and carry no plan identity).

## Context detection

Mode is determined SOLELY by whether the originating conversation is available in-session. Per-field availability is handled separately — do NOT downgrade the whole mode because one field is missing.

- **`context: live`** — the recap is generated in the SAME session that ran the cycle (user request verbatim available). The AI's judgments and rejected alternatives are recoverable ONLY to the extent they are actually evidenced in the visible lead conversation or a written artifact — delegated planner/fixer subagent reasoning that was never surfaced back to the lead is NOT automatically recoverable just because the mode is `live` (see Recap content's Key decisions row for the same evidence requirement). Enrich per-field where available: code review not run → mark that section "not run"; a task with no commit → "no commit"; a standalone review run with no `reviewArtifacts[]` → use any in-session-referenced code-review paths, else mark "unavailable". A missing `reviewArtifacts[]` or a missing commit does NOT force `artifacts-only`.
- **`context: artifacts-only`** — a fresh session where the conversation is unavailable. Build a **plan-scoped partial recap** from the discovered artifacts (enriched by slug-matched research/specs only when the slug is usable), with an explicit **"Unrecoverable gaps"** note enumerating exactly what cannot be recovered: the verbatim request, the AI's judgment rationale, per-task commit SHAs, and code-review-round associations. `.jsonl` transcript mining is a non-goal. Do NOT fabricate any of these.

## Recap content

**The recap carries the story; the artifacts carry the detail.** Target: the body fits on one screen (roughly 500 words) — link artifacts by path instead of restating them, and prefer a one-line summary over a ledger everywhere the detail is already durable (git log, review artifacts). Required sections, each field's source explicit:

- **TL;DR** — 3–5 sentences up top: what was asked, what was built, where it stands (branch / release state).
- **Request summary** — verbatim quote when `context: live`. In `artifacts-only`, a summary derived SOLELY from the exact resolved plan (its H1 / intro / task list), explicitly flagged as NOT the verbatim request. Slug-matched specs/research are NEVER authoritative for the summary (they may belong to another same-slug cycle) — cite them only as caveated supplementary context.
- **Key decisions + why, incl. rejected alternatives** — MUST be a **table**, limited to decisions that SHAPED the outcome (design forks, rejected alternatives, critic-forced redesigns) — omit process/bookkeeping decisions. In BOTH modes, populate a row's rationale/alternative ONLY when it is explicitly evidenced — by the visible in-session conversation (`live`) or by an artifact that explicitly states it (either mode); otherwise mark the cell "unavailable" or clearly label it "inferred from the final plan" — never assert unrecorded rationale as fact, in either mode. Slug-matched specs/research are caveated supplementary context only.
- **What changed** — a compact AREA-level summary (a few bullets naming the areas touched) plus the commit range (`<first>..<last>`, N commits) — NOT a per-commit ledger; `git log` carries the per-commit detail. It MUST still distinguish actual vs planned:
  - In `live`, DERIVE the change set from EVERY cycle commit available in-session — each per-task commit AND the implement-loop's final `fix(review): apply Codex code-review findings` convergence commit when present — via a machine-readable name listing: `git show --name-status --format= <sha>` (handles renames, never abbreviates paths — do NOT use `--stat`); render the summary from that set. Two things are ALWAYS called out on their own line, never silently folded in: the **"review fixes"** convergence commit when it does not map cleanly to a single task, and — if a FAILED convergence commit left fixes staged/unstaged — those working-tree files (`git diff --name-status` + `git diff --cached --name-status`) flagged **"uncommitted (convergence commit failed)"**.
  - In `artifacts-only`, label the summary **"planned file scope"** (from the plan's "Files to create/modify"), NOT "files changed", and mark commits "unavailable". Never present planned scope as evidence of actual change.
- **Critic verdicts** — a per-phase one-liner: rounds consumed, the finding ARC in a clause (what themes forced changes), the final verdict, and the artifact paths. Add a findings table ONLY for findings that materially changed the design. Plan-review rounds (exact, via the `plan-path` + `cwd` resolution above) in both modes; code-review rounds are live-only — sourced from `reviewArtifacts[]` OR any code-review artifact referenced in-session (a standalone `hyper-code-review` run counts), consistent with discovery. A finding's exact resolution is often NOT persisted (intermediate plan revisions are overwritten in place): mark it "unavailable / not persisted" unless a later plan-review round explicitly records it resolved, or clearly label it "inferred from the final plan". In `artifacts-only`, mark the code-review association unavailable.
- **Open / deferred items** — from the plan + plan-reviews.

**Diagrams.** Include one ONLY when a picture makes THIS cycle's *implemented content* easier to understand — the architecture / data flow that was built, the module or component relationships that changed, or the shape of a design decision. Most recaps need none; skip it when prose/tables already suffice. Default a single mermaid `flowchart LR` of ≤10 nodes. Node labels are evidence-grounded and semantic — real module / file / artifact names, commit SHAs, or the actual component / decision names drawn from THIS cycle (never invented, decorative, or generic process names). Render EITHER the mermaid diagram OR, for terminal-only readers, an ASCII fallback that REPLACES it (not both); never decorative; at most 1 diagram per recap by default. Artifacts are linked BY PATH, never inlined.

## Write mechanics

```bash
mkdir -p .hyperclaude/recaps
date -u +%Y%m%d-%H%M
```

Base path `.hyperclaude/recaps/<timestamp>[-<slug>].md` — the `-<slug>` segment is present for a normal `S`, OMITTED entirely for an empty `S` (never emit a dangling `<timestamp>-.md`). If the path exists, append `-2`, `-3`, … until free.

Write with the **Write** tool. Author NO `plugin-version` line — the PostToolUse stamp hook adds it post-write. Frontmatter keys, in this order:

```
---
mode: recap
slug: <slug>
generated: <ISO-8601 timestamp>
context: live|artifacts-only
plan: "<source plan path>"
---
```

- `slug:` value: for a normal nonempty `S`, JSON-serialize it (`JSON.stringify(S)`-equivalent — double-quoted with `"` / `\` / control characters escaped) — a manually named plan's whole-basename slug (e.g. `release: v2` from `release: v2.md`) or one containing `#`, quotes, or backslashes would otherwise corrupt the YAML scalar. For an empty `S`, use the bare empty key (`slug: ` — key, colon, single space, nothing after), NOT `slug: ""`.
- `plan:` value MUST be JSON-serialized (`JSON.stringify()`-equivalent — not raw string interpolation into a quoted literal) so spaces / `#` / `:` / quote characters in the path cannot corrupt the YAML scalar, mirroring how the bridge JSON-quotes its path-valued frontmatter.

**Terminal reporting contract.** After a successful Write, report the EXACT written recap path (the resolved `.hyperclaude/recaps/<...>.md`, collision suffix included). On ANY non-success terminal — target resolution, artifact reads, `mkdir`, timestamp generation, the Write itself, or any other I/O — report the failure reason and NO path (never claim a path that was not written). This is the defined outcome hyper-auto's terminal step consumes; a standalone run likewise states where it wrote or why it could not.

## Anti-patterns

- **Calling Codex / the bridge.** This skill is Claude-only.
- **Dispatching any agent** (the `Agent` tool). No agent dispatch.
- **Auto-running inside a loop.** Recap is invoked at cycle completion, not chained from an implement/review loop — with ONE carve-out: hyper-auto's terminal step MAY auto-run it after BOTH inner loops complete cleanly. Never mid-loop, never chained directly from hyper-implement-loop or hyper-plan-loop.
- **Mining `.jsonl` transcripts** to recover an `artifacts-only` gap. A non-goal — mark the gap unrecoverable instead.
- **Epic-level rollup.** The unit is ONE detailed plan / milestone.
- **PR-draft framing.** This explains the cycle to a human; it is not a merge proposal.
- **Inlining artifact bodies** instead of linking them by path.
- **Ledger-dumping** — per-commit tables or per-round finding tables where an area summary / one-line arc plus artifact links suffices. The recap is the story, not the log.
- **Filename-extracting research / plan-review / spec slugs** instead of reading frontmatter `slug:`.
- **Presenting slug-only-matched research / specs as exact cycle membership** when `S` is non-unique.
- **Slug-guessing a code-review artifact** into a recap (release-level slug, no plan identity).
- **Recapping an un-archived active plan** (violates the completion gate).
- **Basename-matching an external or active path** to a different done plan.
- **Basename-only plan-review matching** without resolving `plan-path` against its recorded `cwd`.
- **Presenting planned file scope as actual changes.**
- **Dropping the implement-loop `fix(review):` convergence commit** (or a failed-convergence staged/unstaged working tree) from live "what changed".
- **Using `git show --stat`** for exact file enumeration — use `--name-status`.
- **Asserting unrecorded rationale / finding-resolution as fact** in EITHER mode — mark "unavailable" or "inferred" unless explicitly evidenced by the session or an artifact.
- **Using a slug-matched spec as the authoritative request summary.**
- **Fabricating commit SHAs or code-review associations** in `artifacts-only` mode.
- **Writing a recap when no completed plan exists.**
