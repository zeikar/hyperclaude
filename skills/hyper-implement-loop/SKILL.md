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

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §F1 + §A for the `Agent`/`SendMessage` argument shapes and idle-notification semantics (a payload-less wake — the loop-bound structured findings reply arrives only via fixer `SendMessage`, else the lead falls back to a corrective round-trip). Loop-specific bindings:
- **Fixer-reply ownership:** there is NO canonical output file — the fixer applies edits in place and replies with the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full source bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting. Unsolicited fixer messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

**Fixer request id.** Run-state fields (`request_id_counter`, `expected_request_id`, `awaiting_reply`, `solicit_sent_at`, `review_iteration`) and their lifecycle are defined in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E (single source of truth); this loop binds to those names. This loop also binds the `request-id: <id>` structured schema (integer id, echoed verbatim by the fixer on every post-spawn reply).

**Loop-local id-source rule.** Every lead→fixer solicitation carries a per-run, lead-owned, monotonically increasing integer id. The lead is the SOLE id source — the fixer only echoes it. The counter increments on EVERY solicitation: each Step 7 fix-round = +1, AND every §1/§3 corrective gets its OWN new id. The `shutdown_request` object message is EXEMPT (no id).

**Spawn-is-not-a-solicitation.** Unlike plan-loop's spawn (which mints id 1 because the planner is asked to immediately Write the plan), the implement-loop spawn (Step 4) is contract-only — the fixer goes idle without sending any reply. So `request_id_counter` stays at 0 until the FIRST Step 7 fix solicitation, which mints id 1. The Step 4 spawn does NOT change `request_id_counter` or `awaiting_reply`. After spawn, the lead expects EXACTLY ONE payload-less idle notification (the fixer's post-spawn idle). The lead consumes that idle as a readiness signal and does NOT route it through §B/§E unsolicited handling. From the second wake onward (which is always after the first Step 7 solicitation has been sent), §E Phase 1 / Phase 2 routing applies normally.

The lead must also retain the following handle-resolution run-state across turns: `teammate_name = "fixer"` (the spawn `name`; bare-name handle for every lead→fixer send, per §A R1 — see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §A for the authoritative send-resolution algorithm). The spawn step captures the teammate handle but does NOT change `request_id_counter` or `awaiting_reply` (spawn-is-not-a-solicitation stays).
[DEGRADE] Degrade-only run-state: `teammate_id` (the opaque `agent_id` captured at Step 4 spawn per §A-DEGRADE D0 — never parsed; FALLBACK handle for the first degraded send) and `resolved_handle` (`null` until D1 resolves it; the winning handle for later degraded sends). Unused on the live-mailbox main path.

Loop-local run state (e.g. `reviewArtifacts[]`, `review_iteration`) is named where it appears in Steps 5/7.

- `review_brief_file` — the scratchpad path holding the composed review brief (Step 1), or `null` when no admissible source exists. Retained across turns; distinct from the shell variable `BRIEF_FILE` assigned from it in each Step 5/7 bridge Bash call.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **plan path** (boundary A — a specific `.hyperclaude/plans/*.md` file, not a task description). Resolution:

- `$ARGUMENTS` non-empty → that is the plan path.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/plans/*.md`.
- Nothing found → ask the user and STOP.

This skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to be set in the environment. If the agent-teams feature is unavailable, the skill stops with the documented fallback message (see Step 2).

### Step 0 — Read the failure & recovery protocol

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §F2 for the two-file read requirement. Both `loop-protocol.md` (shared §A–§E) AND `references/failure-protocol.md` (sibling, implement-loop binding) are mandatory before spawning; this loop's local file binds the `request-id: <id>` structured schema (integer id prefix on every fixer post-spawn reply).

### Step 1 — Resolve the plan path

Reuse the stock `hyper-implement` plan-path resolution — see `skills/hyper-implement/SKILL.md` Step 1; do not duplicate the rule text. In brief:

1. If `$ARGUMENTS` is non-empty, treat it as a plan path and use it.
2. Else, find the most recent plan via `ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1`.
3. If nothing found, tell the user "No plan file found" and STOP.

**No feature slug.** The code-review slug in this skill is release-level (`vs-main`), not feature-level — it derives from the diff target, not the plan filename. The final report will reference the code-review artifact path(s) only; do not derive or track a feature slug here.

**Compose the review brief (or record `null`).** Compose per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`. The admissible source here is the user's own request text and decisions the user explicitly approved in this conversation — the resolved plan is **not** a source (it is planner-authored, not user-authored). Record the resulting scratchpad path as `review_brief_file`, or `null` if no admissible source exists — in which case the flag is omitted on every round.

### Step 2 — Confirm agent-teams availability

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §F3 for the probe + documented stop message; `<fallback-command>` = `/hyperclaude:hyper-implement + /hyperclaude:hyper-code-review`.

```bash
[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]
```

This probe MUST run BEFORE Step 3's `hyper-implement` run so that an unavailable host is detected and the skill STOPs before any tree mutation — preserving the clean-STOP-before-mutation property.

Failure handling (both cases emit the §F3 documented message with `<fallback-command>` = `/hyperclaude:hyper-implement + /hyperclaude:hyper-code-review`):

- **Env unset / probe fails** → STOP with the §F3 message (fallback bound above) before any mutation. No teardown (nothing was created).
- **Step 4 spawn fails** (note: the fixer is spawned in Step 4, *after* `hyper-implement` completes) → STOP with the §F3 message (fallback bound above). No teardown — the team never formed. The implementation output is already in the working tree and is preserved — the user can run `/hyperclaude:hyper-code-review` manually.

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
- **Reply transport (MANDATORY)** — every reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "<one-line summary>", message: "<structured schema>" })`. Plain assistant text is NOT visible to the lead on a live-mailbox host, and going idle without calling `SendMessage` only emits a payload-less idle notification — so if you output the schema as plain text and idle WITHOUT the `SendMessage` call, the lead never receives your reply and the loop stalls. Call `SendMessage` first, then idle. This applies identically to every fix-round reply. You spawn with no findings yet. Do NOT send any message on spawn — simply go idle; the payload-less idle notification is sufficient. The lead expects exactly ONE payload-less idle notification after spawn (your post-spawn idle) — it consumes that as a readiness signal and does NOT treat it as unsolicited traffic. From the first Step 7 findings SendMessage onward, the full §E Phase 1 / Phase 2 id-routing applies. Only ever call `SendMessage({ to: "team-lead", … })` to deliver your structured per-finding schema reply in response to a findings `SendMessage` from the lead.
[DEGRADE] Exception (degraded host only): if `SendMessage` is unavailable on your host (degraded), emit the structured reply as your FINAL ASSISTANT TEXT — the lead reads it from your task-completion result per §A-DEGRADE D2.
- **Reply id contract** — every reply you send to the lead MUST begin with a `request-id: <id>` line where `<id>` is the integer id the lead included in this round's findings SendMessage (the lead is the sole id source; echo it verbatim). This line is the FIRST non-blank line of the structured reply, followed by the per-finding blocks. The spawn message carries NO findings and no id — do NOT send any reply on spawn (idle as instructed). Only ever send `SendMessage({ to: "team-lead", ... })` in response to a findings SendMessage from the lead, and that response MUST start with `request-id: <id>`.
- **Idle / no-resend discipline** — after replying, go idle and wait; do NOT resend, re-announce, or nag. The lead will contact you only via `SendMessage` carrying the next round's findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each `SendMessage`; no opportunistic refactors; NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the current diff/files each round before applying any fix (context may be stale across rounds).
- State that the fixer stays alive as a teammate, will receive Codex findings in later turns, and must retain its full context across rounds.

**After the `Agent(...)` call** — capture and validate handles:

- Record `teammate_name = "fixer"` (the bare-name handle for all lead→fixer sends, per §A R1).
[DEGRADE] - Capture the returned `agent_id` VERBATIM/OPAQUELY into run-state `teammate_id` (§A-DEGRADE D0 — never parse the `@`/suffix); this is the FALLBACK handle for the first degraded send. Capturing the id does NOT bump `request_id_counter` or `awaiting_reply` (spawn-is-not-a-solicitation stays).
[DEGRADE] - Set `resolved_handle = null` (no degraded lead→fixer send has been made yet; degrade-only field).
[DEGRADE] - **Degrade detection (conditions (1)/(2)/(3) per §A-DEGRADE):**
[DEGRADE]   - Condition (1): the first bare-name send FAILED and `teammate_id` was not captured at spawn (D0 captured nothing — no fallback handle available). `hyper-implement` has already run and committed the implementation — PRESERVE the committed feature branch, report it explicitly, point the user at `/hyperclaude:hyper-code-review` for manual review. STOP WITHOUT teardown (no addressable teammate — §A-DEGRADE D3 no-usable-handle exception). This condition is reached ONLY after a bare-name send has actually failed, NOT at spawn time.
[DEGRADE]   - Condition (2): the fixer replies via its task-completion result (`SendMessage` unavailable on this host) → this is §A-DEGRADE D2 driving; do NOT STOP. Read the structured reply from the fixer task result (every reply is D2 case (ii) for implement-loop — spawn is non-soliciting, so the first reply comes from the first D1 `teammate_id` SendMessage task result). Apply the SAME §1 schema gate + §3 semantic finding-map check, then continue the loop. Reference §A-DEGRADE D2 for the driving algorithm.
[DEGRADE]   - Condition (3): first lead→fixer send fails on BOTH bare `teammate_name` AND `teammate_id` (D1 fallback exhausted) → `hyper-implement` has already run — PRESERVE the committed feature branch and point the user at `/hyperclaude:hyper-code-review`. STOP WITHOUT teardown (no addressable teammate).

(Spawn-failure handling is in Step 2.)

### Step 4a — Unsolicited fixer messages

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §F4 for unsolicited-message handling (§E two-phase classification is the authoritative router; §B governs genuinely-unsolicited non-reply-token traffic). This loop's anchored reply-token is the structured findings-map schema prefixed by `request-id: <id>`; the local binding: reply-token shape + accept rule in `references/failure-protocol.md` **Binding declarations**; corrective/recovery in **§1**; unsolicited-message handling in **§2** (which points at shared §B).

### Step 5 — Code-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **6 total Codex reviews**, i.e. at most **5 fix rounds**.

**Why `--base main` is the right target across rounds:** the bridge's `--base` target reviews the *effective worktree vs main* — committed-since-main PLUS the uncommitted overlay — so the fixer's uncommitted fix-round edits are always in scope on every resumed `--base main` review. This is exactly why Step 7 keeps `--base main` (never `--commit <sha>`) and why no per-round commit is needed for the next review to see the fix.

Invoke via the Bash tool with `timeout: 600000`. If `review_brief_file` is non-null, assign it to `BRIEF_FILE` per the shell-safety recipe in `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md` and append `--review-brief "$(cat "$BRIEF_FILE")"`; omit both when `review_brief_file` is `null`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main [--review-brief "$(cat "$BRIEF_FILE")"]
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

Send the blocking findings to the still-live fixer, addressed via the **§A send-resolution procedure** (R1: bare `teammate_name` — see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §A):
[DEGRADE] On a degraded run, the lead reads the fixer's structured reply from the task result of the D1 `teammate_id` SendMessage per §A-DEGRADE D2 (case (ii)). Apply the SAME §1 schema gate + §3 semantic finding-map check; then continue to the next review round. Driving ends at "validate → continue"; teardown is NOT part of this sequence.

```
SendMessage({
  to: <resolved via §A send-resolution procedure>,
  summary: "Fix Codex blocking findings — request <id>",
  message: "<verbatim blocking findings + relevant verdict direction + the code-review artifact path; the request id for this round is `<id>`; instruct: re-read current diff/files, apply ONLY these fixes, run relevant verification, reply with the structured schema PREFIXED by `request-id: <id>` on the first non-blank line>"
})
```

Do NOT re-send the plan or task — the fixer still holds that context.

**Fix-validation pipeline** (per `references/failure-protocol.md` §3): (1) **id-classification routing** (parse the `request-id: <int>` prefix; route per shared §E Phase 1 / Phase 2 — older = stale-recovery, future = teardown, missing/malformed = corrective) → (2) **anchored structured-schema reply gate** (on matching id only — schema requirements per `references/failure-protocol.md` §1) → (3) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a §1 schema-gate failure escalates (after its one corrective) to **"hyper-implement-loop reply-contract failure"**; a §3 semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the full pipeline from §1) to **"hyper-implement-loop fixer format, iter N"**. Follow `references/failure-protocol.md` §1 and §3 verbatim.

On pass, increment the iteration counter and re-invoke via the Bash tool with `timeout: 600000`. Same `review_brief_file`-gated `BRIEF_FILE` assignment + `--review-brief` token as Step 5 — per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`'s two re-supply reasons (fallback survival on an `auto`→fresh fallback, and mid-loop updates), re-pass it on every round:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main --resume auto [--review-brief "$(cat "$BRIEF_FILE")"]
```

Always pass `--resume auto` from iteration 2 onward; `--base main` is REQUIRED on every iteration; `--commit <sha>` is FORBIDDEN. Re-parse per Step 5's strict-JSON rule, append the artifact path to `reviewArtifacts[]`, then loop back to Step 6.

**Resume-status polishing:** if `resumeStatus` ∈ {`resume-failed`, `fallback`} the round is still valid — record it for the Step 9 report.

### Step 8 — Cap + teardown

Cap at **6 total Codex reviews** (iter 1 fresh + at most 5 resumed fix rounds).

On cap-reached with blocking findings still open: FIRST capture the cap report details (iterations consumed, residual blocking findings, working tree left in fixer's latest state, all `reviewArtifacts[]` paths), THEN run teardown, THEN emit the named-loop report (**"hyper-implement-loop fix loop"**).

**Teardown is MANDATORY on EVERY exit path once the Step 4 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure, fixer format failure, unparseable review, plus any other unexpected tool error while the fixer teammate is live. Run teardown FIRST, then report/STOP — never before. (A failure *before* the Step 4 spawn — e.g. `hyper-implement` aborting in Step 3 — owes no teardown: STOP (no team formed).)

Teardown procedure: see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §F5 → §C.
[DEGRADE] On a degraded run, teardown follows §A-DEGRADE D3 instead — D3 resolves the target in order: (a) `resolved_handle` set → send to it; (b) `resolved_handle` null but `teammate_id` captured → send to `teammate_id`; (c) both null → STOP WITHOUT teardown (no-addressable-teammate exception, genuine STOP per §A-DEGRADE condition (1)/(3)).

### Step 9 — Final report

Reached only on Step 6's clean (no-blocking) exit — cap-reached and failure STOPs emit their own reports in Step 8 and never arrive here.

**Convergence commit (after Step 8 shutdown_request).** The lead commits its uncommitted fix edits **once** on the current feature branch — the fixer never commits (invariant). The no-wait teardown (§C) sends a shutdown_request best-effort and proceeds immediately: the fixer may remain live until session-exit auto-cleanup, but it is AT REST (idle since its last reply) and the lead sends it nothing during the git ops, so it performs no concurrent edits. `git add -A` carries the same scoping as hyper-implement's per-task commit (clean-tree preflight + gitignored `.hyperclaude/`); if autonomous verification left unrelated untracked files they ride in too — same exposure as hyper-implement, so eyeball the diff before pushing. This is the loop's ONLY commit:

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

Cross-loop invariants (reviewer-as-agent, re-spawning, skipping shutdown, §E-inlining): see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §D. Full list also in `references/failure-protocol.md` §5. Implement-loop-specific:

- Committing or pushing from the fixer, or letting the fixer invoke codex or `scripts/codex-bridge.mjs`.
- Using `--commit <sha>` as the diff target, or omitting `--base main` on any iteration. `--base main` is the fixed target for all code-review invocations.
[DEGRADE] - Hardcoding `to: teammate_id` as the primary handle for lead→fixer sends instead of routing via the §A send-resolution procedure. `teammate_id` is the FALLBACK (degrade-only); the PRIMARY is bare `teammate_name`. All lead→fixer sends (fix, corrective, AND teardown `shutdown_request`) must go through the §A procedure — see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §A and §D anti-pattern 3.
- Editing `hyper-implement` or `hyper-plan-loop`. This skill is purely additive.
- Inlining the shared §E pseudo-code into this SKILL.md instead of pointing at `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E. SKILL.md is the always-loaded surface — duplicating §E bloats every trigger and risks the two copies drifting.
- Letting the fixer omit the `request-id: <id>` first-line prefix on any post-spawn reply; treating any non-`request-id:` reply (or one with a wrong id) as success. The prefix is the loop's id-classification step; without it, the anchored gate fails.
- Editing `agents/fixer.md` to encode the `request-id: <id>` requirement. The prefix is loop-specific and lives ONLY in this SKILL.md's Step 4 spawn-prompt contract. The fixer stays a general-purpose, loop-agnostic agent.
- Restating `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`'s rules inside this SKILL.md (see shared anti-pattern #8) instead of pointing at it; fabricating `review_brief_file` from plan prose; or letting a brief ask Codex to suppress correctness / security / data-loss findings. Also: composing `--background` in this loop — the review brief is this loop's context channel, `--background` is never composed here.
