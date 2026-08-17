---
name: hyper-docs-loop
description: Use when documentation should be brought into accuracy with the code in one gesture — Codex docs-review → fix → re-review, repeated until no blocking findings remain. Also when the user invokes /hyperclaude:hyper-docs-loop. For manual round-by-round control use /hyperclaude:hyper-docs-review + manual edits instead.
---

# hyper-docs-loop

Autonomous docs-hardening gate. Invokes Codex `docs-review` through the bridge and — on the FIRST round that carries blocking `### Findings` — spawns the `documenter` agent **once** to apply them, reusing that same agent via `SendMessage` on every later round until no blocking findings remain (judged semantically — see Step 4) or the cap is hit. A run Codex clears on its first review spawns no documenter at all. The reviewer is always the Codex bridge, never an agent — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-docs-loop [target]`.
- User wants an autonomous docs-review → fix cycle in a single gesture.

Skip when:
- A single doc edit is enough — edit it directly or use `/hyperclaude:hyper-docs-sync` for code-change-driven sync.
- You want hands-on control over each review / fix round — use `/hyperclaude:hyper-docs-review` + manual edits.

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol: **Spawn contract**, **Reply transport**, **Correctives and transport failures**, **Shared anti-patterns**. `references/failure-protocol.md` (sibling of this file) is the docs-loop binding layer: it names this loop's structured per-finding reply schema, the schema-gate accept rule, the semantic finding-map validation, the named reports, and what a transport failure preserves. Step 0 makes Reading BOTH mandatory before the loop starts.

## Spawn & reply transport

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Spawn contract** for the `Agent` / `SendMessage` argument shapes, **Reply transport** for how each round's reply reaches the lead. Loop-specific bindings:

- **Lazy spawn:** the documenter is spawned inside the first fix round (Step 5), not ahead of it. That spawn's prompt already carries round 1's blocking findings, so the spawn is itself a working round — it can mutate the docs tree.
- **Documenter-reply ownership:** there is NO canonical output file — the documenter applies edits in place and its reply is the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full doc bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting.

The lead must retain the following run-state across turns:

- `docs_target` — the bridge argv tokens resolved in Step 1, reused verbatim on every iteration.
- `agent_id` — `null` until the Step 5 spawn; from then on the id it returned, captured verbatim, and the address for every later round.
- `reviewArtifacts[]` — every docs-review artifact path produced this run (for Step 7).
- `review_iteration` — the Codex bridge re-invocation count the Step 6 cap bounds.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **docs target** (optional path tokens; the loop mirrors `hyper-docs-review`'s target grammar). Resolution:

- `$ARGUMENTS` empty → default to `docs/` (directory mode).
- `$ARGUMENTS` is one or more existing file paths (any type) → multi-file mode (each maps to its own `--docs-path`).
- `$ARGUMENTS` is a single existing directory path → directory mode.
- Anything else → ask the user to clarify and STOP.

### Step 0 — Read the failure & recovery protocol

Read BOTH files before the loop starts: `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` (the shared spawn + reply transport) AND `references/failure-protocol.md` (sibling of this file — the docs-loop binding: reply schema, accept rule, validation stages, named reports, transport-failure declaration).

### Step 1 — Resolve the docs target

Apply the resolution table above to `$ARGUMENTS`. Classify each token via Bash — `[ -f "<path>" ]` (existing file → `--docs-path`) vs `[ -d "<path>" ]` (existing directory → `--docs-dir`); a token that is neither → STOP. Record `docs_target` as the bridge argv tokens:

| Argument | `docs_target` argv |
|---|---|
| Empty | `['--docs-dir', 'docs/']` |
| One or more existing files (each `[ -f ]`, any type) | `['--docs-path', '<path1>', '--docs-path', '<path2>', ...]` (one flag per file, in order) |
| Single existing directory | `['--docs-dir', '<path>']` |
| Anything else | Ask the user to clarify, STOP. |

`docs_target` is reused **verbatim** on every iteration in Step 3 and Step 5 — never change it mid-run.

**Directory-target note.** Per `docs-review`'s established contract, `--docs-dir <p>` reviews only the top-level `.md` files directly under `<p>` (not recursive). This is intentional. The loop inherits that scope; if the user wants nested docs reviewed, they invoke the loop once per subdirectory or against an explicit file path of any type.

### Step 2 — (Reserved)

This skill has no pre-loop sync step. The loop targets accuracy of docs as they are; if the user wants to first sync docs to recent code changes, they invoke `/hyperclaude:hyper-docs-sync` separately before this skill. Keeping the loop pure (review ↔ fix only) avoids conflating the code-diff-driven sync flow with the docs-target-driven review flow.

### Step 3 — Docs-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 6 cap is **6 total Codex reviews**, i.e. at most **5 fix rounds**.

Invoke via the Bash tool with `timeout: 600000`, passing the `docs_target` argv tokens from Step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv>
# e.g. ... docs-review --docs-dir docs/
# or   ... docs-review --docs-path docs/architecture.md
```

Parse the bridge's single stdout JSON envelope per `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` (envelope shape + strict-parse rule).

On `ok:true`: Read the artifact at `path` with the Read tool; capture `resumeStatus`; append `path` to a `reviewArtifacts[]` list (for Step 7).

On any non-`ok:true`, Bash timeout, or JSON parse failure → STOP with a named-loop report (**"hyper-docs-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present.

### Step 4 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The `docs-review` template emits `### Findings` (Blocker/Major/Minor bullets), `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies`, and `### Verdict`.

**Only `### Findings` is gating.** Bullets in `### Gaps` / `### Broken Or Suspect Links` / `### Cross-Doc Inconsistencies` are reported in the final summary (Step 7) but do NOT drive fix rounds — those sections frequently need human judgment (which gap is worth filling? is this link genuinely broken or just suspicious?) that the loop should not auto-resolve. The user runs another pass manually when ready.

Within `### Findings`, classify by meaning: a finding **blocks** if it concerns **accuracy / drift / actively misleading claims that would cause a reader to do the wrong thing** (regardless of which severity word the template attached). Pure prose-polish nits do NOT block. Redundancy-only findings (duplicated-but-consistent claims) do NOT block either — collapsing repeated content needs human judgment; report them in Step 7 like the non-gating sections.

- Any blocking `### Findings` item → fix (Step 5).
- No blocking `### Findings` (Findings absent, or Findings contains only style/nits/redundancy, or verdict is approving) → exit the loop and report (Step 7). Non-blocking findings + the three non-gating sections are reported, never gating.

**Conservative branch:** if the body cannot be confidently judged by meaning (unparseable, truncated, or no recognizable structure) → STOP with a named-loop report (**"hyper-docs-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 5 — Fix via the documenter, then re-review

First check the cap: if the iteration counter is already at 6 (6 total Codex reviews consumed), do NOT send findings or fix — go directly to Step 6 (cap reached).

**First blocking round — spawn the documenter.** Use the Agent tool with NO `name:` field. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:documenter",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Role framing** — you are the documenter for this hyper-docs-loop run; your job is to apply Codex docs-review findings to the cited doc files in targeted, minimal edits. This dispatch is NOT hyper-docs-sync's per-doc UPDATE/CREATE mode — it is the loop's structured-findings mode, and the contract below is authoritative for this dispatch.
- **This round's findings** — the verbatim blocking `### Findings` bullets (with their Stale claim / Code evidence / Recommended edit sub-bullets) and the docs-review artifact path.
- **Reply format** — for EVERY cited finding emit its own `finding:` / `status:` / `files-changed:` (comma-separated doc paths, or `none`) / `verification:` (what you re-read to confirm, or `n/a`) / `notes:` block, each field on its own line (`status` exactly `fixed` or `not-applicable`; `notes:` required when `not-applicable`), delivered as your FINAL TEXT. No diff dump, no patch block, no verbatim source-body echo. End with a one-line summary of the findings processed this round. This applies identically to every later round's reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each round; no opportunistic prose polish; no edits to uncited docs; edit DOCUMENTATION files only (no source code, tests, scripts, or config edits to make a doc claim "true" — if the doc disagrees with code, the doc is what changes, or report `not-applicable` if the doc was actually right); NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the cited docs each round before applying any fix (context may be stale across rounds).
- State that the documenter stays live between rounds, will receive further Codex findings in later turns, and must retain its full context across rounds.

**After the `Agent(...)` call** — capture the returned `agent_id` verbatim into run-state; it addresses every later round.

Failure handling — this loop commits nothing, so any doc edits live only in the working tree; both branches are STOPs per the transport-failure declaration in `references/failure-protocol.md`:

- **Spawn fails outright** → nothing ran, so this run produced no doc edits. STOP per that declaration.
- **Spawn returns no usable `agent_id`, or fails ambiguously** → the spawn prompt carried this round's findings, so the documenter may already have applied them. Treat the docs tree as potentially mutated. STOP per that same declaration.

**Later rounds — reuse the live documenter.** Send the round's blocking `### Findings` bullets to the captured `agent_id`:

```
SendMessage({
  to: "<agent_id>",
  summary: "Fix Codex blocking docs findings",
  message: "<verbatim blocking ### Findings bullets (with their Stale claim / Code evidence / Recommended edit sub-bullets) + the docs-review artifact path; instruct: re-read the cited doc files, apply ONLY these fixes, reply with the structured per-finding schema as your final text>"
})
```

**Reading the reply** — round 1's reply is the spawn task's `<result>`; every later round's is that round's `<result>`. A `SendMessage` that fails → STOP per the transport-failure declaration in `references/failure-protocol.md`.

Do NOT re-send context the documenter still holds.

**Fix-validation pipeline** (per `references/failure-protocol.md` — **Fix-validation redo pipeline**): (1) **structured-schema reply gate** (schema requirements in that file's **Binding declarations**) → (2) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a schema-gate failure escalates (after its one corrective) to **"hyper-docs-loop reply-contract failure"**; a semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the pipeline from the schema gate) to **"hyper-docs-loop documenter format, iter N"**. Follow that file's corrective and redo-pipeline sections verbatim.

On pass, increment the iteration counter and re-invoke via the Bash tool with `timeout: 600000`, passing the SAME `docs_target` argv tokens:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv> --resume auto
```

Always pass `--resume auto` from iteration 2 onward; `docs_target` is REQUIRED on every iteration (the bridge requires `--docs-path` or `--docs-dir` even on resume). Re-parse per Step 3's strict-JSON rule, append the artifact path to `reviewArtifacts[]`, then loop back to Step 4.

**Resume-status polishing:** if `resumeStatus` ∈ {`resume-failed`, `fallback`} the round is still valid — record it for the Step 7 report.

### Step 6 — Cap

Cap at **6 total Codex reviews** (iter 1 fresh + at most 5 resumed fix rounds).

On cap-reached with blocking findings still open, emit the named-loop report (**"hyper-docs-loop fix loop"**) carrying the iterations consumed, the residual blocking findings from the latest review, the docs tree left in the documenter's latest state (doc edits uncommitted), and all `reviewArtifacts[]` paths.

### Step 7 — Final report

Reached only on Step 4's clean (no-blocking) exit — cap-reached and failure STOPs emit their own reports and never arrive here. Report:

- All `reviewArtifacts[]` paths.
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking `### Findings` items (informational).
- All bullets from `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies` (informational — these sections are non-gating; the user resolves them manually).
- Any `resume-failed` / `fallback` rounds noted.
- Working-tree state: any documenter edits — if fix rounds ran — are left **uncommitted**. Nothing was pushed. Next step: review the diff and commit it when ready.

## Anti-patterns

Cross-loop invariants (passing `name:` at spawn, re-spawning each round, reviewer-as-agent, inlining the shared contract): see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Shared anti-patterns**. Full list also in `references/failure-protocol.md` — **Anti-patterns (docs-loop specific)**. Docs-loop-specific:

- Committing or pushing from the documenter, or letting the documenter invoke codex or `scripts/codex-bridge.mjs`.
- Letting the documenter edit source code, tests, scripts, or config to make a doc claim "true". The doc is what changes; if the doc was actually right, the documenter reports `status: not-applicable` with a `notes:` reason.
- Changing `docs_target` mid-run. The same `--docs-path` / `--docs-dir` argv tokens are REQUIRED on every iteration (including resumes — the bridge enforces this).
- Auto-fixing items from `### Gaps`, `### Broken Or Suspect Links`, or `### Cross-Doc Inconsistencies`. Only `### Findings` drives fix rounds; the other sections need human judgment and are reported in Step 7 only.
- Editing `hyper-docs-review` or `hyper-docs-sync`. This skill is purely additive.
- Editing `agents/documenter.md` to encode this loop's structured findings schema. That schema is loop-specific and lives ONLY in this SKILL.md's Step 5 spawn prompt; the documenter stays a general-purpose, loop-agnostic agent (still primarily dispatched by `hyper-docs-sync` for its UPDATE/CREATE mode).
