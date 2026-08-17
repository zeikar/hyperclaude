---
name: hyper-implement-loop
description: Use when a plan should be executed end-to-end and critic-hardened in one gesture — implement → Codex code-review → fix, repeated until clean. Also when the user invokes /hyperclaude:hyper-implement-loop. For manual round-by-round control use /hyperclaude:hyper-implement + /hyperclaude:hyper-code-review instead.
---

# hyper-implement-loop

Autonomous implement-hardening gate. Runs `hyper-implement` to completion first, invokes Codex `code-review --base main` through the bridge, and — on the FIRST round that carries blocking findings — spawns the `fixer` agent **once** to apply them, reusing that same agent via `SendMessage` on every later round until no blocking findings remain (judged semantically — see Step 4) or the cap is hit. A run Codex clears on its first review spawns no fixer at all. The reviewer is always the Codex bridge, never an agent — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-implement-loop <plan path>`.
- User wants an autonomous implement → review → fix cycle in a single gesture.

Skip when:
- The task is one step — use `/hyperclaude:hyper-implement` directly.
- You want hands-on control over each implement / review round — use `/hyperclaude:hyper-implement` + `/hyperclaude:hyper-code-review` manually.

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol: **Spawn contract**, **Reply transport**, **Correctives and transport failures**, **Shared anti-patterns**. `references/failure-protocol.md` (sibling of this file) is the implement-loop binding layer: it names this loop's structured per-finding reply schema, the schema-gate accept rule, the semantic finding-map validation, the named reports, and what a transport failure preserves. Step 0 makes Reading BOTH mandatory before the loop starts.

## Spawn & reply transport

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Spawn contract** for the `Agent` / `SendMessage` argument shapes, **Reply transport** for how each round's reply reaches the lead. Loop-specific bindings:

- **Lazy spawn:** the fixer is spawned inside the first fix round (Step 5), not ahead of it. That spawn's prompt already carries round 1's blocking findings, so the spawn is itself a working round — it can mutate the tree.
- **Fixer-reply ownership:** there is NO canonical output file — the fixer applies edits in place and its reply is the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full source bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting.

The lead must retain the following run-state across turns:

- `agent_id` — `null` until the Step 5 spawn; from then on the id it returned, captured verbatim, and the address for every later round.
- `reviewArtifacts[]` — every code-review artifact path produced this run (for Step 7).
- `review_iteration` — the Codex bridge re-invocation count the Step 6 cap bounds.
- `review_brief_file` — the scratchpad path holding the composed review brief (Step 1), or `null` when no admissible source exists. Retained across turns; distinct from the shell variable `BRIEF_FILE` assigned from it in each Step 3/5 bridge Bash call.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **plan path** (boundary A — a specific `.hyperclaude/plans/*.md` file, not a task description). Resolution:

- `$ARGUMENTS` non-empty → that is the plan path.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/plans/*.md`.
- Nothing found → ask the user and STOP.

### Step 0 — Read the failure & recovery protocol

Read BOTH files before the loop starts: `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` (the shared spawn + reply transport) AND `references/failure-protocol.md` (sibling of this file — the implement-loop binding: reply schema, accept rule, validation stages, named reports, transport-failure declaration).

### Step 1 — Resolve the plan path

Reuse the stock `hyper-implement` plan-path resolution — see `skills/hyper-implement/SKILL.md` Step 1; do not duplicate the rule text. In brief:

1. If `$ARGUMENTS` is non-empty, treat it as a plan path and use it.
2. Else, find the most recent plan via `ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1`.
3. If nothing found, tell the user "No plan file found" and STOP.

**No feature slug.** The code-review slug in this skill is release-level (`vs-main`), not feature-level — it derives from the diff target, not the plan filename. The final report will reference the code-review artifact path(s) only; do not derive or track a feature slug here.

**Compose the review brief (or record `null`).** Compose per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`. The admissible source here is the user's own request text and decisions the user explicitly approved in this conversation — the resolved plan is **not** a source (it is planner-authored, not user-authored). Record the resulting scratchpad path as `review_brief_file`, or `null` if no admissible source exists — in which case the flag is omitted on every round.

### Step 2 — Run hyper-implement to completion (boundary A)

The fixer is **not** spawned yet — it is spawned lazily in Step 5, on the first round that has blocking findings. Spawning earlier buys no context: `hyper-implement` builds with its own fresh subagents the fixer never observes, and a run that converges on the first review needs no fixer at all.

Invoke the existing `hyper-implement` skill on the resolved plan path.

**Nested-review boundary:** `skills/hyper-implement/SKILL.md` Step 4 ends with an optional final step: run `/hyperclaude:hyper-code-review`. Under `hyper-implement-loop`, the lead **MUST NOT perform** that optional `/hyperclaude:hyper-code-review` bullet — it is suppressed for this run. Step 3 below is the single authoritative first Codex review of the full diff.

**If `hyper-implement` fails or aborts** (no usable implementation): nothing has been spawned yet, so there is no agent state to account for — STOP, surfacing the `hyper-implement` failure verbatim. The partial working tree is left as-is for manual triage.

The loop begins AFTER `hyper-implement` finishes its task loop + final acceptance (smoke/tests), with the optional code-review bullet suppressed.

### Step 3 — Code-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 6 cap is **6 total Codex reviews**, i.e. at most **5 fix rounds**.

**Why `--base main` is the right target across rounds:** the bridge's `--base` target reviews the *effective worktree vs main* — committed-since-main PLUS the uncommitted overlay — so the fixer's uncommitted fix-round edits are always in scope on every resumed `--base main` review. This is exactly why Step 5 keeps `--base main` (never `--commit <sha>`) and why no per-round commit is needed for the next review to see the fix.

Invoke via the Bash tool with `timeout: 600000`. If `review_brief_file` is non-null, assign it to `BRIEF_FILE` per the shell-safety recipe in `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md` and append `--review-brief "$(cat "$BRIEF_FILE")"`; omit both when `review_brief_file` is `null`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main [--review-brief "$(cat "$BRIEF_FILE")"]
```

Parse the bridge's single stdout JSON envelope per `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` (envelope shape + strict-parse rule).

On `ok:true`: Read the artifact at `path` with the Read tool; capture `resumeStatus`; append `path` to a `reviewArtifacts[]` list (for Step 7).

On any non-`ok:true`, Bash timeout, or JSON parse failure → STOP with a named-loop report (**"hyper-implement-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present.

### Step 4 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The fresh `code-review` body IS templated — it emits `### Findings` (Blocker/Major/Minor bullets) then `### Verdict` — but still classify by meaning, not by the severity label Codex assigned: a finding **blocks** if it concerns **correctness, data loss, security, a broken build/tests, a regression, or missing required behavior** (regardless of which severity word the template attached). Pure **style / nits / opinions do NOT block**.

- Any blocking finding → fix (Step 5).
- No blocking findings (style/nits only, or an approving verdict) → **clean convergence**: exit the loop and report (Step 7). Non-blocking findings are reported, never gating.

**Conservative branch:** if the body cannot be confidently judged by meaning (unparseable, truncated, or no recognizable structure) → STOP with a named-loop report (**"hyper-implement-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 5 — Fix via the fixer, then re-review

First check the cap: if the iteration counter is already at 6 (6 total Codex reviews consumed), do NOT send findings or fix — go directly to Step 6 (cap reached).

**First blocking round — spawn the fixer.** Use the Agent tool with NO `name:` field. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:fixer",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Role framing** — you are the fixer for this hyper-implement-loop run; your job is to apply Codex code-review findings to the working tree in targeted, minimal fixes.
- **This round's findings** — the verbatim blocking findings, the relevant verdict direction, and the code-review artifact path.
- **Reply format** — for EVERY cited finding emit its own `finding:` / `status:` / `files-changed:` / `verification:` / `notes:` block (`status` exactly `fixed` or `not-applicable`; `notes:` required when `not-applicable`), delivered as your FINAL TEXT. No diff dump, no patch block, no source-body echo. This applies identically to every later round's reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each round; no opportunistic refactors; NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the current diff/files each round before applying any fix (context may be stale across rounds).
- State that the fixer stays live between rounds, will receive further Codex findings in later turns, and must retain its full context across rounds.

**After the `Agent(...)` call** — capture the returned `agent_id` verbatim into run-state; it addresses every later round.

Failure handling — `hyper-implement` has already committed the implementation by this point, so both branches are side-effect-aware STOPs per the transport-failure declaration in `references/failure-protocol.md`:

- **Spawn fails outright** → nothing ran, so this run produced no fix edits. STOP per that declaration.
- **Spawn returns no usable `agent_id`, or fails ambiguously** → the spawn prompt carried this round's findings, so the fixer may already have applied them. Treat the tree as potentially mutated. STOP per that same declaration.

**Later rounds — reuse the live fixer.** Send the round's blocking findings to the captured `agent_id`:

```
SendMessage({
  to: "<agent_id>",
  summary: "Fix Codex blocking findings",
  message: "<verbatim blocking findings + relevant verdict direction + the code-review artifact path; instruct: re-read current diff/files, apply ONLY these fixes, run relevant verification, reply with the structured per-finding schema as your final text>"
})
```

**Reading the reply** — round 1's reply is the spawn task's `<result>`; every later round's is that round's `<result>`. A `SendMessage` that fails → STOP per the transport-failure declaration in `references/failure-protocol.md`.

Do NOT re-send the plan or task — the fixer still holds that context.

**Fix-validation pipeline** (per `references/failure-protocol.md` — **Fix-validation redo pipeline**): (1) **structured-schema reply gate** (schema requirements in that file's **Binding declarations**) → (2) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a schema-gate failure escalates (after its one corrective) to **"hyper-implement-loop reply-contract failure"**; a semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the pipeline from the schema gate) to **"hyper-implement-loop fixer format, iter N"**. Follow that file's corrective and redo-pipeline sections verbatim.

On pass, increment the iteration counter and re-invoke via the Bash tool with `timeout: 600000`. Same `review_brief_file`-gated `BRIEF_FILE` assignment + `--review-brief` token as Step 3 — per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`'s two re-supply reasons (fallback survival on an `auto`→fresh fallback, and mid-loop updates), re-pass it on every round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main --resume auto [--review-brief "$(cat "$BRIEF_FILE")"]
```

Always pass `--resume auto` from iteration 2 onward; `--base main` is REQUIRED on every iteration; `--commit <sha>` is FORBIDDEN. Re-parse per Step 3's strict-JSON rule, append the artifact path to `reviewArtifacts[]`, then loop back to Step 4.

**Resume-status polishing:** if `resumeStatus` ∈ {`resume-failed`, `fallback`} the round is still valid — record it for the Step 7 report.

### Step 6 — Cap

Cap at **6 total Codex reviews** (iter 1 fresh + at most 5 resumed fix rounds).

On cap-reached with blocking findings still open, emit the named-loop report (**"hyper-implement-loop fix loop"**) carrying the iterations consumed, the residual blocking findings from the latest review, the working tree left in the fixer's latest state (fix edits uncommitted), and all `reviewArtifacts[]` paths.

### Step 7 — Final report

Reached only on Step 4's clean (no-blocking) exit — cap-reached and failure STOPs emit their own reports and never arrive here.

**Convergence commit.** The lead commits its uncommitted fix edits **once** on the current feature branch — the fixer never commits (invariant). This only has anything to stage when a fixer actually ran; a first review Codex cleared spawned none, and the `SKIP: no fix edits to commit` branch below covers that case. The fixer is at rest (idle since its last reply) and the lead sends it nothing during the git ops, so it performs no concurrent edits. `git add -A` carries the same scoping as hyper-implement's per-task commit (clean-tree preflight + gitignored `.hyperclaude/`); if autonomous verification left unrelated untracked files they ride in too — same exposure as hyper-implement, so eyeball the diff before pushing. This is the loop's ONLY commit:

```bash
git add -A
if git diff --cached --quiet; then
  echo "SKIP: no fix edits to commit"
else
  git commit -m "fix(review): apply Codex code-review findings" && git rev-parse --short HEAD
fi
```

Report the **actual** git outcome (never assume success): the commit SHA + clean tree on success; the skip note if nothing was staged; or — if `git commit` failed (pre-commit hook, signing, author config) — surface its stderr + `git status --short` and do NOT claim the branch is ready to push. Then report:

- All `reviewArtifacts[]` paths (not just the latest; NO plan/slug — release-level slug only).
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking findings (informational, never gating).
- Any `resume-failed` / `fallback` rounds noted.
- Branch / working-tree state: `hyper-implement` committed each task on the feature branch it created/used (`hyper/<slug>` when started from `main`/`master`); on clean convergence the lead committed the fixer's fix edits in one `fix(review):` commit on top (working tree now clean — or no fix edits to commit). Nothing was pushed. Next step: push the branch when ready.
- Recommend `/hyperclaude:hyper-recap` as an optional follow-up for a human-readable write-up of this cycle — a recommendation only, never auto-run it here.

## Anti-patterns

Cross-loop invariants (passing `name:` at spawn, re-spawning each round, reviewer-as-agent, inlining the shared contract): see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Shared anti-patterns**. Full list also in `references/failure-protocol.md` — **Anti-patterns (implement-loop specific)**. Implement-loop-specific:

- Committing or pushing from the fixer, or letting the fixer invoke codex or `scripts/codex-bridge.mjs`.
- Using `--commit <sha>` as the diff target, or omitting `--base main` on any iteration. `--base main` is the fixed target for all code-review invocations.
- Reasserting a git-state / no-op gate. A stuck or no-change fixer is bounded by the Step 6 cap — a separate no-op detection path is an anti-pattern.
- Editing `hyper-implement` or `hyper-plan-loop`. This skill is purely additive.
- Editing `agents/fixer.md` to encode this loop's spawn-prompt contract. That contract is loop-specific and lives ONLY in this SKILL.md's Step 5 spawn prompt; the fixer stays a general-purpose, loop-agnostic agent.
- Restating `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`'s rules inside this SKILL.md instead of pointing at it; fabricating `review_brief_file` from plan prose; or letting a brief ask Codex to suppress correctness / security / data-loss findings. Also: composing `--background` in this loop — the review brief is this loop's context channel, `--background` is never composed here.
