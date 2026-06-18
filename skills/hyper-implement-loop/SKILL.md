---
name: hyper-implement-loop
description: Use when a plan should be executed end-to-end and critic-hardened in one gesture — implement → Codex code-review → fix, repeated until clean. Also when the user invokes /hyperclaude:hyper-implement-loop. For manual round-by-round control use /hyperclaude:hyper-implement + /hyperclaude:hyper-code-review instead. Requires the experimental agent-teams feature.
---

# hyper-implement-loop

Autonomous implement-hardening gate. Creates a per-run team, runs hyper-implement to completion first, then spawns the `fixer` agent as a persistent teammate **once** (only after implementation finishes), invokes Codex `code-review --base main` through the bridge, and fixes via the still-live fixer until no blocking findings remain (judged semantically — see Step 6) or the cap is hit. The fixer is spawned **once**; every fix round reuses its retained context via SendMessage. The reviewer is always the Codex bridge, never a teammate — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-implement-loop <plan path>`.
- User wants an autonomous implement → review → fix cycle in a single gesture.

Skip when:
- The task is one step — use `/hyperclaude:hyper-implement` directly.
- You want hands-on control over each implement / review round — use `/hyperclaude:hyper-implement` + `/hyperclaude:hyper-code-review` manually.
- The experimental agent-teams feature is unavailable (this skill stops with a documented fallback message — see Step 2).

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol — team contract shapes (§A), unsolicited-message protocol skeleton (§B), teardown procedure (§C), shared anti-patterns (§D), abstract request-id state machine (§E). `references/failure-protocol.md` (sibling of this file) is the implement-loop binding layer: structured-schema reply with `request-id: <id>` prefix, semantic finding-map post-acceptance validation, implement-loop-specific anti-patterns. Step 0 makes Reading BOTH mandatory.

## Agent-teams tool contract

This skill uses the experimental agent-teams tools — `Agent` / `SendMessage`. Their argument shapes and idle-notification semantics (a payload-less wake signal that does NOT carry the teammate's reply text — the loop-bound structured findings reply arrives only if the fixer explicitly `SendMessage`s it, else the lead falls back to a corrective round-trip) all live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §A, loaded at Step 0. Loop-specific bindings:
- **Fixer-reply ownership:** there is NO canonical output file — the fixer applies edits in place and replies with the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full source bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting. Unsolicited fixer messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

**Fixer request id.** The run-state fields (`request_id_counter`, `expected_request_id`, `awaiting_reply`, `solicit_sent_at`, `review_iteration`) and their lifecycle (mint protocol, MESSAGE ACCEPTED / POST-ACCEPTANCE VALIDATION ACCEPTED acceptance stages, Phase 1 / Phase 2 routing, stale-recovery) are defined in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E (single source of truth); this loop binds to those names.

**Loop-local id-source rule.** Every lead→fixer solicitation carries a per-run, lead-owned, monotonically increasing integer id. The lead is the SOLE id source — the fixer only echoes it. The counter increments on EVERY solicitation: each Step 7 fix-round = +1, AND every §1/§3 corrective gets its OWN new id. The `shutdown_request` object message is EXEMPT (no id).

**Spawn-is-not-a-solicitation.** Unlike plan-loop's spawn (which mints id 1 because the planner is asked to immediately Write the plan), the implement-loop spawn (Step 4) is contract-only — the fixer goes idle without sending any reply. So `request_id_counter` stays at 0 until the FIRST Step 7 fix solicitation, which mints id 1. The Step 4 spawn does NOT change `request_id_counter` or `awaiting_reply`. After spawn, the lead expects EXACTLY ONE payload-less idle notification (the fixer's post-spawn idle). The lead consumes that idle as a readiness signal and does NOT route it through §B/§E unsolicited handling. From the second wake onward (which is always after the first Step 7 solicitation has been sent), §E Phase 1 / Phase 2 routing applies normally.

Loop-local run state (e.g. `reviewArtifacts[]`, `review_iteration`) is named where it appears in Steps 5/7.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **plan path** (boundary A — a specific `.hyperclaude/plans/*.md` file, not a task description). Resolution:

- `$ARGUMENTS` non-empty → that is the plan path.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/plans/*.md`.
- Nothing found → ask the user and STOP.

This skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to be set in the environment. If the agent-teams feature is unavailable, the skill stops with the documented fallback message (see Step 2).

### Step 0 — Read the failure & recovery protocol

Before any team creation, Read both protocol files into context: (1) `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — the shared cross-loop protocol; (2) `references/failure-protocol.md` (sibling of this file) — the implement-loop binding + implement-loop-specific recoveries. Both are mandatory — the loop's failure branches reference sections by number (shared §A–§E and local §1–§5) and the lead must follow them verbatim when reached.

### Step 1 — Resolve the plan path

Reuse the stock `hyper-implement` plan-path resolution — see `skills/hyper-implement/SKILL.md` Step 1; do not duplicate the rule text. In brief:

1. If `$ARGUMENTS` is non-empty, treat it as a plan path and use it.
2. Else, find the most recent plan via `ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1`.
3. If nothing found, tell the user "No plan file found" and STOP.

**No feature slug.** The code-review slug in this skill is release-level (`vs-main`), not feature-level — it derives from the diff target, not the plan filename. The final report will reference the code-review artifact path(s) only; do not derive or track a feature slug here.

### Step 2 — Confirm agent-teams availability

Run the following Bash probe **before Step 3's `hyper-implement` run**:

```bash
[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]
```

This probe MUST run BEFORE Step 3's `hyper-implement` run so that an unavailable host is detected and the skill STOPs before any tree mutation — preserving the clean-STOP-before-mutation property.

Failure handling:

- **Env unset / probe fails** → STOP with the message below before any mutation. No teardown (nothing was created).
- **Step 4 spawn fails** (note: the fixer is spawned in Step 4, *after* `hyper-implement` completes) → STOP with the same message. No teardown — the team never formed. The implementation output is already in the working tree and is preserved — the user can run `/hyperclaude:hyper-code-review` manually.

Documented stop message:

> agent teams unavailable — this skill requires the experimental agent-teams feature; run /hyperclaude:hyper-setup to diagnose prerequisites. Use /hyperclaude:hyper-implement + /hyperclaude:hyper-code-review manually instead.

### Step 3 — Run hyper-implement to completion (boundary A)

The fixer is **not** spawned yet — it is spawned in Step 4, only *after* implementation completes. Spawning it earlier buys no context: `hyper-implement` builds with its own fresh subagents that the fixer teammate never observes, and the single-spawn / context-reuse guarantee only needs the fixer alive from iteration 1's fix round onward. Deferring the spawn also keeps the unsolicited-message guard window (Step 4a / `references/failure-protocol.md` §2) off the long implementation phase.

Invoke the existing `hyper-implement` skill on the resolved plan path.

**Nested-review boundary:** `skills/hyper-implement/SKILL.md` Step 4 ends with an optional final step: run `/hyperclaude:hyper-code-review`. Under `hyper-implement-loop`, the lead **MUST NOT perform** that optional `/hyperclaude:hyper-code-review` bullet — it is suppressed for this run. Step 5 below is the single authoritative first Codex review of the full diff.

**If `hyper-implement` fails or aborts** (no usable implementation): the fixer was never spawned, so no teardown is owed — STOP, surfacing the `hyper-implement` failure verbatim. The partial working tree is left as-is for manual triage.

The loop begins AFTER `hyper-implement` finishes its task loop + final acceptance (smoke/tests), with the optional code-review bullet suppressed.

### Step 4 — Spawn the fixer teammate

Implementation is complete; spawn the fixer **once** here, before iteration 1. Use the Agent tool. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:fixer",
  name: "fixer",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Role framing** — you are the fixer teammate for this hyper-implement-loop run; your job is to apply Codex code-review findings to the working tree in targeted, minimal fixes.
- **No findings yet** — no code-review findings exist at spawn time; findings will be delivered via `SendMessage` in later turns.
- **Reply transport (MANDATORY)** — every reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "<one-line summary>", message: "<structured schema>" })`. Plain assistant text is NOT visible to the lead, and going idle without calling `SendMessage` only emits a payload-less idle notification — so if you output the schema as plain text and idle WITHOUT the `SendMessage` call, the lead never receives your reply and the loop stalls. Call `SendMessage` first, then idle. This applies identically to every fix-round reply. You spawn with no findings yet. Do NOT send any message on spawn — simply go idle; the payload-less idle notification is sufficient. The lead expects exactly ONE payload-less idle notification after spawn (your post-spawn idle) — it consumes that as a readiness signal and does NOT treat it as unsolicited traffic. From the first Step 7 findings SendMessage onward, the full §E Phase 1 / Phase 2 id-routing applies. Only ever call `SendMessage({ to: "team-lead", … })` to deliver your structured per-finding schema reply in response to a findings `SendMessage` from the lead.
- **Reply id contract** — every reply you send to the lead MUST begin with a `request-id: <id>` line where `<id>` is the integer id the lead included in this round's findings SendMessage (the lead is the sole id source; echo it verbatim). This line is the FIRST non-blank line of the structured reply, followed by the per-finding blocks. The spawn message carries NO findings and no id — do NOT send any reply on spawn (idle as instructed). Only ever send `SendMessage({ to: "team-lead", ... })` in response to a findings SendMessage from the lead, and that response MUST start with `request-id: <id>`.
- **Idle / no-resend discipline** — after replying, go idle and wait; do NOT resend, re-announce, or nag. The lead will contact you only via `SendMessage` carrying the next round's findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each `SendMessage`; no opportunistic refactors; NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the current diff/files each round before applying any fix (context may be stale across rounds).
- State that the fixer stays alive as a teammate, will receive Codex findings in later turns, and must retain its full context across rounds.

(Spawn-failure handling is in Step 2.)

### Step 4a — Unsolicited fixer messages

While the fixer is live and BEFORE Step 8 teardown, the only fixer message the lead expects is the anchored structured-schema reply (prefixed by `request-id: <id>` per Step 7) to the lead's most recent SendMessage (fix, redo, or corrective). Any other inbound fixer message — duplicate body, `RESEND:`-style re-emit, nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. Handle it per `references/failure-protocol.md` §2 (which points at shared §B). This lead-side rule is **mandatory** — prompt-only idle discipline (Step 4) is insufficient. The teardown exchange is exempt (a `shutdown_response` after `shutdown_request` is expected, never a violation).

**Phase-aware cross-reference (per shared §E):** while AWAITING (`awaiting_reply == true`), an id-bearing reply with `reqid < expected_request_id` is shared §E Phase 2's stale branch (ignore content + stale-recovery sub-step), NOT routed through §2. While NOT awaiting (`awaiting_reply == false`), an id-bearing reply with `reqid <= request_id_counter` is ignored SILENTLY; all non-id-bearing unsolicited traffic IS §B's domain. See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E (state machine) and §B (interplay).

### Step 5 — Code-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **6 total Codex reviews**, i.e. at most **5 fix rounds**.

**Why `--base main` is the right target across rounds:** the bridge's `--base` target reviews the *effective worktree vs main* — committed-since-main PLUS the uncommitted overlay — so the fixer's uncommitted fix-round edits are always in scope on every resumed `--base main` review. This is exactly why Step 7 keeps `--base main` (never `--commit <sha>`) and why no per-round commit is needed for the next review to see the fix.

Invoke via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main
```

**JSON parsing (strict):** the bridge contract is exactly ONE JSON object on stdout. Parse stdout as a single JSON object; if any extra non-whitespace appears before or after it, treat as a parse failure and surface the raw output verbatim — no best-effort scraping.

On `ok:true`: Read the artifact at `path` with the Read tool; capture `resumeStatus`; append `path` to a `reviewArtifacts[]` list (for Step 9).

On any non-`ok:true`, Bash timeout, or JSON parse failure → Step 8 teardown, then STOP with a named-loop report (**"hyper-implement-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present.

### Step 6 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The fresh `code-review` body IS templated — it emits `### Findings` (Blocker/Major/Minor bullets) then `### Verdict` — but still classify by meaning, not by the severity label Codex assigned: a finding **blocks** if it concerns **correctness, data loss, security, a broken build/tests, a regression, or missing required behavior** (regardless of which severity word the template attached). Pure **style / nits / opinions do NOT block**.

- Any blocking finding → revise (Step 7).
- No blocking findings (style/nits only, or an approving verdict) → **clean convergence**: exit loop (Step 8 teardown → Step 9). The lead commits the fixer's fix edits **after** teardown (Step 9), never while the fixer is still live. Non-blocking findings are reported, never gating.

**Conservative branch:** if the body cannot be confidently judged by meaning (unparseable, truncated, or no recognizable structure) → Step 8 teardown, then STOP with a named-loop report (**"hyper-implement-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 7 — Fix via the live fixer, then re-review

First check the cap: if the iteration counter is already at 6 (6 total Codex reviews consumed), do NOT send findings or fix — go directly to Step 8 (cap reached).

Before sending, mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_reply = true`; immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (per shared §E's binding rule — assistant-turn start is NOT a valid substitute; a long Codex-review turn can elapse between turn-start and the next SendMessage). Pass the new id in the message and in the reply instruction.

Send the blocking findings to the still-live fixer:

```
SendMessage({
  to: "fixer",
  summary: "Fix Codex blocking findings — request <id>",
  message: "<verbatim blocking findings + relevant verdict direction + the code-review artifact path; the request id for this round is `<id>`; instruct: re-read current diff/files, apply ONLY these fixes, run relevant verification, reply with the structured schema PREFIXED by `request-id: <id>` on the first non-blank line>"
})
```

Do NOT re-send the plan or task — the fixer still holds that context.

**Fix-validation pipeline** (per `references/failure-protocol.md` §3): (1) **id-classification routing** (parse the `request-id: <int>` prefix; route per shared §E Phase 1 / Phase 2 — older = stale-recovery, future = teardown, missing/malformed = corrective) → (2) **anchored structured-schema reply gate** (on matching id only — schema requirements per `references/failure-protocol.md` §1) → (3) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a §1 schema-gate failure escalates (after its one corrective) to **"hyper-implement-loop reply-contract failure"**; a §3 semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the full pipeline from §1) to **"hyper-implement-loop fixer format, iter N"**. Follow `references/failure-protocol.md` §1 and §3 verbatim.

On pass, increment the iteration counter and re-invoke via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main --resume auto
```

Always pass `--resume auto` from iteration 2 onward; `--base main` is REQUIRED on every iteration; `--commit <sha>` is FORBIDDEN. Re-parse per Step 5's strict-JSON rule, append the artifact path to `reviewArtifacts[]`, then loop back to Step 6.

**Resume-status polishing:** if `resumeStatus` ∈ {`resume-failed`, `fallback`} the round is still valid — record it for the Step 9 report.

### Step 8 — Cap + teardown

Cap at **6 total Codex reviews** (iter 1 fresh + at most 5 resumed fix rounds).

On cap-reached with blocking findings still open: FIRST capture the cap report details (iterations consumed, residual blocking findings, working tree left in fixer's latest state, all `reviewArtifacts[]` paths), THEN run teardown, THEN emit the named-loop report (**"hyper-implement-loop fix loop"**).

**Teardown is MANDATORY on EVERY exit path once the Step 4 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure, fixer format failure, unparseable review, plus any other unexpected tool error while the fixer teammate is live. Run teardown FIRST, then report/STOP — never before. (A failure *before* the Step 4 spawn — e.g. `hyper-implement` aborting in Step 3 — owes no teardown: STOP (no team formed).)

Exact procedure:

1. `SendMessage({ to: "fixer", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The fixer's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.

### Step 9 — Final report

Reached only on Step 6's clean (no-blocking) exit — cap-reached and failure STOPs emit their own reports in Step 8 and never arrive here.

**Convergence commit (post-teardown).** Now that the fixer teammate is torn down (Step 8), the lead commits its uncommitted fix edits **once** on the current feature branch — the fixer never commits (invariant), and teardown-first means no teammate is live during the git ops. `git add -A` carries the same scoping as hyper-implement's per-task commit (clean-tree preflight + gitignored `.hyperclaude/`); if autonomous verification left unrelated untracked files they ride in too — same exposure as hyper-implement, so eyeball the diff before pushing. This is the loop's ONLY commit:

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

## Anti-patterns

Core invariants (full list in `references/failure-protocol.md` §5):

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the fixer fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Committing or pushing from the fixer, or letting the fixer invoke codex or `scripts/codex-bridge.mjs`.
- Using `--commit <sha>` as the diff target, or omitting `--base main` on any iteration. `--base main` is the fixed target for all code-review invocations.
- Skipping `shutdown_request` on exit; stopping silently at the cap.
- Editing `hyper-implement` or `hyper-plan-loop`. This skill is purely additive.
- Inlining the shared §E pseudo-code into this SKILL.md instead of pointing at `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E. SKILL.md is the always-loaded surface — duplicating §E bloats every trigger and risks the two copies drifting.
- Letting the fixer omit the `request-id: <id>` first-line prefix on any post-spawn reply; treating any non-`request-id:` reply (or one with a wrong id) as success. The prefix is the loop's id-classification step; without it, the anchored gate fails.
- Editing `agents/fixer.md` to encode the `request-id: <id>` requirement. The prefix is loop-specific and lives ONLY in this SKILL.md's Step 4 spawn-prompt contract. The fixer stays a general-purpose, loop-agnostic agent.
