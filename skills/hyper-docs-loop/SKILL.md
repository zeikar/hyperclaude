---
name: hyper-docs-loop
description: Use when documentation should be brought into accuracy with the code in one gesture — docs-review → fix → re-review, repeated until no blocking findings remain. Also when the user invokes /hyperclaude:hyper-docs-loop. For manual round-by-round control use /hyperclaude:hyper-docs-review + manual edits instead.
---

# hyper-docs-loop

Autonomous docs-hardening gate. Has the docs target reviewed and — on the FIRST round that carries blocking `### Findings` — spawns the `documenter` agent **once** to apply them, reusing that same agent via `SendMessage` on every later round until no blocking findings remain (judged semantically — see Step 4) or the cap is hit. A run whose first review is clean spawns no documenter at all. The reviewer is Codex `docs-review` through the bridge by default; the adversarial `reviewer` agent takes the seat for the run when the Codex budget is over pace (`${CLAUDE_PLUGIN_ROOT}/references/reviewer-seat.md`).

## When to use

- User typed `/hyperclaude:hyper-docs-loop [target]`.
- User wants an autonomous docs-review → fix cycle in a single gesture.

Skip when:
- A single doc edit is enough — edit it directly or use `/hyperclaude:hyper-docs-sync` for code-change-driven sync.
- You want hands-on control over each review / fix round — use `/hyperclaude:hyper-docs-review` + manual edits.

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol: **Spawn contract**, **Reply transport**, **Correctives and transport failures**, **Shared anti-patterns**. `references/failure-protocol.md` (sibling of this file) is the docs-loop binding layer: it names this loop's structured per-finding reply schema, the schema-gate accept rule, the semantic finding-map validation, the named reports, and what a transport failure preserves. `${CLAUDE_PLUGIN_ROOT}/references/reviewer-seat.md` decides who reviews and how the lead drives the Claude seat. Step 0 makes Reading all three mandatory before the loop starts.

## Spawn & reply transport

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Spawn contract** for the `Agent` / `SendMessage` argument shapes, **Reply transport** for how each round's reply reaches the lead. Loop-specific bindings:

- **Lazy spawn:** the documenter is spawned inside the first fix round (Step 5), not ahead of it. That spawn's prompt already carries round 1's blocking findings, so the spawn is itself a working round — it can mutate the docs tree.
- **Documenter-reply ownership:** there is NO canonical output file — the documenter applies edits in place and its reply is the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full doc bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting.

The lead must retain the following run-state across turns:

- `docs_target` — the bridge argv tokens resolved in Step 1, reused verbatim on every iteration.
- `agent_id` — the documenter's id: `null` until the Step 5 spawn; from then on the id it returned, captured verbatim, and the address for every later fix round.
- `reviewArtifacts[]` — every docs-review artifact path produced this run, in either seat (for Step 7).
- `review_iteration` — the review count, in either seat, the Step 6 cap bounds.
- `seat` (and its `Reviewer seat:` line), `reviewer_agent_id`, and the dropped findings — per `reviewer-seat.md`, set at Step 3.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **docs target** (optional path tokens; the loop mirrors `hyper-docs-review`'s target grammar), resolved in Step 1.

### Step 0 — Read the failure & recovery protocol

Read all three files before the loop starts: `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` (the shared spawn + reply transport), `${CLAUDE_PLUGIN_ROOT}/references/reviewer-seat.md`, AND `references/failure-protocol.md` (sibling of this file — the docs-loop binding: reply schema, accept rule, validation stages, named reports, transport-failure declaration).

### Step 1 — Resolve the docs target

Strip any seat override from `$ARGUMENTS` first (`reviewer-seat.md` **Decide the seat**, step 1 — the seat itself is decided at Step 3), then apply the table below to what remains. Classify each token via Bash — `[ -f "<path>" ]` (existing file → `--docs-path`) vs `[ -d "<path>" ]` (existing directory → `--docs-dir`); a token that is neither → STOP. Record `docs_target` as the bridge argv tokens:

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

**Iteration counting:** the fresh review here is **iteration 1**.

**Seat the reviewer** per `${CLAUDE_PLUGIN_ROOT}/references/reviewer-seat.md` **Decide the seat**.

**Codex seat.** Invoke via the Bash tool with `timeout: 600000`, passing the `docs_target` argv tokens from Step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv>
# e.g. ... docs-review --docs-dir docs/
# or   ... docs-review --docs-path docs/architecture.md
```

Parse the bridge's single stdout JSON envelope per `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` (envelope shape + strict-parse rule).

On `ok:true`: Read the artifact at `path` with the Read tool; capture `resumeStatus`; append `path` to a `reviewArtifacts[]` list (for Step 7).

On any non-`ok:true`, Bash timeout, or JSON parse failure → STOP with a named-loop report (**"hyper-docs-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present, and the re-run hint from `reviewer-seat.md` **Mid-run Codex failure**.

**Claude seat.** Follow `reviewer-seat.md` **Claude seat — spawn**, **Artifact**, and **Reply and validation** with these bindings:

- artifact dir `.hyperclaude/docs-reviews/`, slug = the `slug` field of `node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv> --dry-run` (no Codex spawn);
- task, brief = none (the target is the request);
- target = each `--docs-path` file, or the top-level `*.md` files of the `--docs-dir` (Step 1's directory-target note);
- mode `docs-review`, identity `docs-target` from `docs_target` (**Artifact**);
- a terminal failure is **"hyper-docs-loop reviewer-seat failure, iter N"** (`references/failure-protocol.md`).

End the turn. Until the reply lands — this round and every later one — leave the docs alone: the reviewer reads them live. On `ok`, Read the artifact, append its path to `reviewArtifacts[]`, and go to Step 4.

### Step 4 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The artifact carries `### Findings` (Blocker/Major/Minor bullets) and `### Verdict`, plus — when present — `### Gaps`, `### Broken Or Suspect Links`, and `### Cross-Doc Inconsistencies`.

**Only `### Findings` is gating.** Bullets in `### Gaps` / `### Broken Or Suspect Links` / `### Cross-Doc Inconsistencies` are reported in the final summary (Step 7) but do NOT drive fix rounds — those sections frequently need human judgment (which gap is worth filling? is this link genuinely broken or just suspicious?) that the loop should not auto-resolve. The user runs another pass manually when ready.

Within `### Findings`, classify by meaning: a finding **blocks** if it concerns **accuracy / drift / actively misleading claims that would cause a reader to do the wrong thing** (regardless of which severity word the reviewer attached). Pure prose-polish nits do NOT block. Redundancy-only findings (duplicated-but-consistent claims) do NOT block either — collapsing repeated content needs human judgment; report them in Step 7 like the non-gating sections.

**Claude seat:** a blocking finding counts only once confirmed at its cited `file:line` per `reviewer-seat.md` **The lead verifies before acting** (`**Code evidence:**` citation included; Grep for a claimed absence).

- Any blocking `### Findings` item → fix (Step 5).
- No blocking `### Findings` (Findings absent, or Findings contains only style/nits/redundancy, or verdict is approving) → exit the loop and report (Step 7). Non-blocking findings + the three non-gating sections are reported, never gating.

**Conservative branch:** if the body cannot be confidently judged by meaning (unparseable, truncated, or no recognizable structure) → STOP with a named-loop report (**"hyper-docs-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 5 — Fix via the documenter, then re-review

First check the cap: if the iteration counter is already at the seat's cap (6 Codex / 3 Claude), do NOT send findings or fix — go directly to Step 6 (cap reached).

The round's blocking `### Findings` bullets (Claude seat: the confirmed ones) go to the documenter.

**First blocking round (`agent_id` is `null`) — spawn the documenter.** Use the Agent tool with NO `name:` field. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:documenter",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Role framing** — you are the documenter for this hyper-docs-loop run; your job is to apply docs-review findings to the cited doc files in targeted, minimal edits. This dispatch is NOT hyper-docs-sync's per-doc UPDATE/CREATE mode — it is the loop's structured-findings mode, and the contract below is authoritative for this dispatch.
- **This round's findings** — the verbatim blocking `### Findings` bullets (with their Stale claim / Code evidence / Recommended edit sub-bullets) and the docs-review artifact path.
- **Reply format** — for EVERY cited finding emit its own `finding:` / `status:` / `files-changed:` (comma-separated doc paths, or `none`) / `verification:` (what you re-read to confirm, or `n/a`) / `notes:` block, each field on its own line (`status` exactly `fixed` or `not-applicable`; `notes:` required when `not-applicable`), delivered as your FINAL TEXT. No diff dump, no patch block, no verbatim source-body echo. End with a one-line summary of the findings processed this round. This applies identically to every later round's reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each round; no opportunistic prose polish; revise the sentence a finding cites rather than appending one beside it; no edits to uncited docs; edit DOCUMENTATION files only (no source code, tests, scripts, or config edits to make a doc claim "true" — if the doc disagrees with code, the doc is what changes, or report `not-applicable` if the doc was actually right); NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the cited docs each round before applying any fix (context may be stale across rounds).
- State that the documenter stays live between rounds, will receive further review findings in later turns, and must retain its full context across rounds.

**After the `Agent(...)` call** — capture the returned `agent_id` verbatim into run-state; it addresses every later fix round.

Failure handling — this loop commits nothing, so any doc edits live only in the working tree; both branches are STOPs per the transport-failure declaration in `references/failure-protocol.md`:

- **Spawn fails outright** → nothing ran, so this run produced no doc edits. STOP per that declaration.
- **Spawn returns no usable `agent_id`, or fails ambiguously** → the spawn prompt carried this round's findings, so the documenter may already have applied them. Treat the docs tree as potentially mutated. STOP per that same declaration.

**Later rounds (`agent_id` set) — reuse the live documenter.** Send the round's blocking `### Findings` bullets to the captured `agent_id`:

```
SendMessage({
  to: "<agent_id>",
  summary: "Fix blocking docs findings",
  message: "<verbatim blocking ### Findings bullets (with their Stale claim / Code evidence / Recommended edit sub-bullets) + the docs-review artifact path; instruct: re-read the cited doc files, apply ONLY these fixes, reply with the structured per-finding schema as your final text>"
})
```

**Reading the reply** — round 1's reply is the spawn task's `<result>`; every later round's is that round's `<result>`. A `SendMessage` to the documenter that fails → STOP per the transport-failure declaration in `references/failure-protocol.md`.

Do NOT re-send context the documenter still holds.

**Fix-validation pipeline** (per `references/failure-protocol.md` — **Fix-validation redo pipeline**): (1) **structured-schema reply gate** (schema requirements in that file's **Binding declarations**) → (2) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a schema-gate failure escalates (after its one corrective) to **"hyper-docs-loop reply-contract failure"**; a semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the pipeline from the schema gate) to **"hyper-docs-loop documenter format, iter N"**. Follow that file's corrective and redo-pipeline sections verbatim.

On pass, increment the iteration counter and re-review in the run's seat, append the artifact path to `reviewArtifacts[]`, then loop back to Step 4.

**Codex seat:** re-invoke via the Bash tool with `timeout: 600000`, passing the SAME `docs_target` argv tokens:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv> --resume auto
```

Always pass `--resume auto` from iteration 2 onward; `docs_target` is REQUIRED on every iteration (the bridge requires `--docs-path` or `--docs-dir` even on resume). Re-parse per Step 3's strict-JSON and failure rules; a `resume-failed`/`fallback` `resumeStatus` is still a valid round — record it for Step 7.

**Claude seat:** mint a new artifact path (Step 3 bindings) and `SendMessage` to `reviewer_agent_id` per `reviewer-seat.md` **Later rounds**, then end the turn; its reply runs **Reply and validation**.

### Step 6 — Cap

Cap at **6 total reviews (Codex seat) / 3 (Claude seat)**.

On cap-reached with blocking findings still open, emit the named-loop report (**"hyper-docs-loop fix loop"**) carrying the seat, the iterations consumed, the residual blocking findings from the latest review, the dropped findings (as in Step 7), the docs tree left in the documenter's latest state (doc edits uncommitted), and all `reviewArtifacts[]` paths.

### Step 7 — Final report

Reached only on Step 4's clean (no-blocking) exit — cap-reached and failure STOPs emit their own reports and never arrive here. Report:

- All `reviewArtifacts[]` paths.
- The `Reviewer seat:` line from Step 3, and review iterations consumed.
- The final review verdict.
- Residual non-blocking `### Findings` items (informational).
- All bullets from `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies`, when present (informational — these sections are non-gating; the user resolves them manually).
- Claude seat: the dropped findings (`reviewer-seat.md` **The lead verifies before acting**) and that its artifacts are not resumable.
- Any `resume-failed` / `fallback` rounds noted.
- Working-tree state: any documenter edits — if fix rounds ran — are left **uncommitted**. Nothing was pushed. Next step: review the diff and commit it when ready.

## Anti-patterns

Cross-loop invariants (passing `name:` at spawn, re-spawning each round, seating a Claude reviewer outside the seat rule, inlining the shared contract): see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Shared anti-patterns**; the seat's own list is `reviewer-seat.md` **Anti-patterns**. Full list also in `references/failure-protocol.md` — **Anti-patterns (docs-loop specific)**. Docs-loop-specific:

- Committing or pushing from the documenter, or letting the documenter invoke codex or `scripts/codex-bridge.mjs`.
- Letting the documenter edit source code, tests, scripts, or config to make a doc claim "true". The doc is what changes; if the doc was actually right, the documenter reports `status: not-applicable` with a `notes:` reason.
- Changing `docs_target` mid-run. The same `--docs-path` / `--docs-dir` argv tokens are REQUIRED on every iteration, including Codex resumes — the bridge enforces this.
- Auto-fixing items from `### Gaps`, `### Broken Or Suspect Links`, or `### Cross-Doc Inconsistencies`. Only `### Findings` drives fix rounds; the other sections need human judgment and are reported in Step 7 only.
