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

`references/failure-protocol.md` carries the recovery procedures invoked at this skill's decision points: §1 anchored-gate corrective, §2 unsolicited-message protocol, §3 fix-validation redo pipeline, §4 teardown recovery, §5 full anti-pattern list. These are load-bearing, not optional troubleshooting — Step 0 makes Reading it mandatory before the loop starts, so the full protocol is in context when its conditions arise.

## Agent-teams tool contract

This skill uses the experimental agent-teams tools. The per-run team name is passed **only** to `TeamCreate` and `Agent` — it is **never** a tool argument to `SendMessage` or `TeamDelete`.

- `TeamCreate` — `{ team_name, description? }`. Creates the team and its task list.
- `Agent` (spawn teammate) — `subagent_type`, plus `team_name` (the SAME run-unique literal from `TeamCreate`) and `name` to make the agent a teammate addressable by `name`.
- `SendMessage` — `{ to: <teammate name, e.g. "fixer">, message: <string | {type:"shutdown_request"}>, summary? }`. No `team_name` field. `summary` is REQUIRED whenever `message` is a string; the shutdown object message takes no `summary`. Plain-text output is NOT visible to teammates; messaging requires this tool.
- `TeamDelete` — `{}` (no args; team inferred from session). Fails if the team still has a live member, so shut members down first.
- A teammate's `shutdown_response` or idle-termination notification is auto-delivered as a new turn — there is no poll/wait tool. **But the idle notification is a payload-less wake signal (`{type:"idle_notification",...}`) — it does NOT carry the teammate's reply text.** The structured findings reply arrives ONLY if the fixer explicitly `SendMessage`s it to the lead; a fixer that outputs the schema as plain text and idles delivers an empty notification and the lead must fall back to the corrective round-trip. Idle teammates keep their process + context alive between turns; a later SendMessage wakes them with context intact — this is the property the fix loop depends on.
- **Fixer-reply ownership:** there is NO canonical output file — the fixer applies edits in place and replies with the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full source bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting. Unsolicited fixer messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **plan path** (boundary A — a specific `.hyperclaude/plans/*.md` file, not a task description). Resolution:

- `$ARGUMENTS` non-empty → that is the plan path.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/plans/*.md`.
- Nothing found → ask the user and STOP.

This skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to be set in the environment. If the agent-teams feature is unavailable, the skill stops with the documented fallback message (see Step 2).

### Step 0 — Read the failure & recovery protocol

Before any team creation, Read `references/failure-protocol.md` (sibling of this file) into context. It is **mandatory** — the loop's failure branches reference its sections by number and the lead must follow them verbatim when reached.

### Step 1 — Resolve the plan path

Reuse the stock `hyper-implement` plan-path resolution — see `skills/hyper-implement/SKILL.md` Step 1; do not duplicate the rule text. In brief:

1. If `$ARGUMENTS` is non-empty, treat it as a plan path and use it.
2. Else, find the most recent plan via `ls -1t .hyperclaude/plans/*.md 2>/dev/null | head -1`.
3. If nothing found, tell the user "No plan file found" and STOP.

**No feature slug.** The code-review slug in this skill is release-level (`vs-main`), not feature-level — it derives from the diff target, not the plan filename. The final report will reference the code-review artifact path(s) only; do not derive or track a feature slug here.

### Step 2 — Create the team

Do not add an env-probe shell check — let `TeamCreate` itself surface agent-teams unavailability.

Compute a per-run unique team name (the nonce defeats same-second collisions) and record this exact literal as the run's team name (also used in Step 4's `Agent` call and reports):

```bash
echo "hyper-implement-loop-$(date +%Y%m%d-%H%M%S)-$RANDOM"
```

Then:

```
TeamCreate({ team_name: "<the run-unique name computed above>", description: "implement + Codex code-review fix loop" })
```

Failure handling:

- **`TeamCreate` fails** → STOP with the message below + the raw error verbatim. No teardown (nothing was created).
- **`TeamCreate` succeeds but the Step 4 spawn fails** (note: the fixer is now spawned in Step 4, *after* `hyper-implement` completes) → `TeamDelete` FIRST (no orphaned empty team), then STOP with the same message. The implementation output is already in the working tree and is preserved — the user can run `/hyperclaude:hyper-code-review` manually.

Documented stop message:

> agent teams unavailable (or TeamCreate failed — see error below) — this skill requires the experimental agent-teams feature; run /hyperclaude:hyper-setup to diagnose prerequisites. Use /hyperclaude:hyper-implement + /hyperclaude:hyper-code-review manually instead.

### Step 3 — Run hyper-implement to completion (boundary A)

The fixer is **not** spawned yet — it is spawned in Step 4, only *after* implementation completes. Spawning it earlier buys no context: `hyper-implement` builds with its own fresh subagents that the fixer teammate never observes, and the single-spawn / context-reuse guarantee only needs the fixer alive from iteration 1's fix round onward. Deferring the spawn also keeps the unsolicited-message guard window (Step 4a / `references/failure-protocol.md` §2) off the long implementation phase.

Invoke the existing `hyper-implement` skill on the resolved plan path.

**Nested-review boundary:** `skills/hyper-implement/SKILL.md` Step 4 ends with an optional final step: run `/hyperclaude:hyper-code-review`. Under `hyper-implement-loop`, the lead **MUST NOT perform** that optional `/hyperclaude:hyper-code-review` bullet — it is suppressed for this run. Step 5 below is the single authoritative first Codex review of the full diff.

**If `hyper-implement` fails or aborts** (no usable implementation): the fixer was never spawned, so no teardown is owed — `TeamDelete({})` the empty team and STOP, surfacing the `hyper-implement` failure verbatim. The partial working tree is left as-is for manual triage.

The loop begins AFTER `hyper-implement` finishes its task loop + final acceptance (smoke/tests), with the optional code-review bullet suppressed.

### Step 4 — Spawn the fixer teammate

Implementation is complete; spawn the fixer **once** here, before iteration 1. Use the Agent tool. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:fixer",
  team_name: "<the run-unique team name computed in Step 2>",
  name: "fixer",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Role framing** — you are the fixer teammate for this hyper-implement-loop run; your job is to apply Codex code-review findings to the working tree in targeted, minimal fixes.
- **No findings yet** — no code-review findings exist at spawn time; findings will be delivered via `SendMessage` in later turns.
- **Reply transport (MANDATORY)** — every reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "<one-line summary>", message: "<structured schema>" })`. Plain assistant text is NOT visible to the lead, and going idle without calling `SendMessage` only emits a payload-less idle notification — so if you output the schema as plain text and idle WITHOUT the `SendMessage` call, the lead never receives your reply and the loop stalls. Call `SendMessage` first, then idle. This applies identically to every fix-round reply. You spawn with no findings yet. Do NOT send any message on spawn — simply go idle; the payload-less idle notification is sufficient. Only ever call `SendMessage({ to: "team-lead", … })` to deliver your structured per-finding schema reply in response to a findings `SendMessage` from the lead.
- **Idle / no-resend discipline** — after replying, go idle and wait; do NOT resend, re-announce, or nag. The lead will contact you only via `SendMessage` carrying the next round's findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each `SendMessage`; no opportunistic refactors; NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the current diff/files each round before applying any fix (context may be stale across rounds).
- State that the fixer stays alive as a teammate, will receive Codex findings in later turns, and must retain its full context across rounds.

(Spawn-failure handling is in Step 2.)

### Step 4a — Unsolicited fixer messages

While the fixer is live and BEFORE Step 8 teardown, the only fixer message the lead expects is the anchored structured-schema reply to the lead's most recent SendMessage (spawn, fix, or corrective). Any other inbound fixer message — duplicate body, `RESEND:`-style re-emit, nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. Handle it per `references/failure-protocol.md` §2. This lead-side rule is **mandatory** — prompt-only idle discipline (Step 4) is insufficient. The teardown exchange is exempt (a `shutdown_response` after `shutdown_request` is expected, never a violation).

### Step 5 — Code-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **3 total Codex reviews**, i.e. at most **2 fix rounds**.

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
- No blocking findings (style/nits only, or an approving verdict) → exit loop (Step 8 teardown → Step 9). Non-blocking findings are reported, never gating.

**Conservative branch:** if the body cannot be confidently judged by meaning (unparseable, truncated, or no recognizable structure) → Step 8 teardown, then STOP with a named-loop report (**"hyper-implement-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 7 — Fix via the live fixer, then re-review

First check the cap: if the iteration counter is already at 3 (3 total Codex reviews consumed), do NOT send findings or fix — go directly to Step 8 (cap reached).

Send the blocking findings to the still-live fixer:

```
SendMessage({
  to: "fixer",
  summary: "Fix Codex blocking findings",
  message: "<verbatim blocking findings + relevant verdict direction + the code-review artifact path; instruct: re-read current diff/files, apply ONLY these fixes, run relevant verification, reply with the structured schema>"
})
```

Do NOT re-send the plan or task — the fixer still holds that context.

**Fix-validation pipeline** (per `references/failure-protocol.md` §3): (1) **anchored structured-schema reply gate** → (2) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a §1 anchored-gate failure escalates (after its one corrective) to **"hyper-implement-loop reply-contract failure"**; a §3 semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the full pipeline from §1) to **"hyper-implement-loop fixer format, iter N"**. Follow `references/failure-protocol.md` §1 and §3 verbatim.

On pass, increment the iteration counter and re-invoke via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" code-review --base main --resume auto
```

Always pass `--resume auto` from iteration 2 onward; `--base main` is REQUIRED on every iteration; `--commit <sha>` is FORBIDDEN. Re-parse per Step 5's strict-JSON rule, append the artifact path to `reviewArtifacts[]`, then loop back to Step 6.

**Resume-status polishing:** if `resumeStatus` ∈ {`resume-failed`, `fallback`} the round is still valid — record it for the Step 9 report.

### Step 8 — Cap + teardown

Cap at **3 total Codex reviews** (iter 1 fresh + at most 2 resumed fix rounds).

On cap-reached with blocking findings still open: FIRST capture the cap report details (iterations consumed, residual blocking findings, working tree left in fixer's latest state, all `reviewArtifacts[]` paths), THEN run teardown, THEN emit the named-loop report (**"hyper-implement-loop fix loop"**).

**Teardown is MANDATORY on EVERY exit path once the Step 4 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure, fixer format failure, unparseable review, plus any other unexpected tool error while the fixer teammate is live. Run teardown FIRST, then report/STOP — never before. (A failure *before* the Step 4 spawn — e.g. `hyper-implement` aborting in Step 3 — owes no teardown: only an empty team exists; `TeamDelete({})` it and STOP.)

Exact procedure:

1. `SendMessage({ to: "fixer", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The fixer's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.
3. `TeamDelete({})`.

If `TeamDelete` fails because a member is still live → apply the recovery in `references/failure-protocol.md` §4.

### Step 9 — Final report

After successful teardown, report:

- All `reviewArtifacts[]` paths (not just the latest; NO plan/slug — release-level slug only).
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking findings (informational, never gating).
- Any `resume-failed` / `fallback` rounds noted.
- Branch / working-tree state: `hyper-implement` committed each task on the feature branch it created/used (`hyper/<slug>` when started from `main`/`master`); the fixer's fix-round edits are left **uncommitted** on top of those commits. Nothing was pushed. Next step: review the fixer's uncommitted diff and commit it (or run `/hyperclaude:hyper-code-review` again), then push the branch when ready.

## Anti-patterns

Core invariants (full list in `references/failure-protocol.md` §5):

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the fixer fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Committing or pushing from the fixer, or letting the fixer invoke codex or `scripts/codex-bridge.mjs`.
- Using `--commit <sha>` as the diff target, or omitting `--base main` on any iteration. `--base main` is the fixed target for all code-review invocations.
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the fixer is down; stopping silently at the cap.
- Editing `hyper-implement` or `hyper-plan-loop`. This skill is purely additive.
