---
name: hyper-plan-loop
description: Use when a plan should be produced and critic-hardened in one gesture — plan → Codex review → revise, repeated until clean. Also when the user invokes /hyperclaude:hyper-plan-loop. For manual round-by-round control use /hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review instead. Requires the experimental agent-teams feature.
---

# hyper-plan-loop

Autonomous plan-hardening gate. Creates a per-run team, spawns the `planner` agent as a persistent teammate, writes its plan to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`, runs Codex `plan-review` through the bridge, and revises via the still-live planner until Codex returns no blocking findings (judged by meaning, not Codex severity labels) or the cap is hit. The planner is spawned **once**; every revise round reuses its retained context via SendMessage. The reviewer is always the Codex bridge, never a teammate — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-plan-loop <task>`.
- User wants an autonomous plan → review → revise cycle in a single gesture.

Skip when:
- The task is one step — dispatch the `implementer` agent directly.
- You want hands-on control over each plan / review round — use `/hyperclaude:hyper-plan` + `/hyperclaude:hyper-plan-review` manually.
- The experimental agent-teams feature is unavailable (this skill stops with a documented fallback message — see Step 2).

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol — team contract shapes (§A), unsolicited-message protocol skeleton (§B), teardown procedure (§C), shared anti-patterns (§D), abstract request-id state machine (§E). `references/failure-protocol.md` (sibling of this file) is the plan-loop binding layer: it names this loop's reply-token shape (`WROTE: <id> <path>`), accept regex, post-acceptance file/structure validation, and plan-loop-specific anti-patterns. Step 0 makes Reading BOTH mandatory before the loop starts.

## Agent-teams tool contract

This skill uses the experimental agent-teams tools — `Agent` / `SendMessage`. Their argument shapes and idle-notification semantics (a payload-less wake signal that does NOT carry the teammate's reply text — the loop-bound `WROTE:` reply arrives only if the planner explicitly `SendMessage`s it (Step 3 reply-transport rule), else the lead falls back to a corrective round-trip) all live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §A, loaded at Step 0. Loop-specific bindings:
- **Plan ownership:** the planner writes the canonical plan file itself via caller-directed write-file mode (its Step 3 prompt carries the exact resolved path). The lead never Writes or Reads the plan body on the normal path — it does only a quiet `ok`/`bad` structure check, and only Reads the body for human-facing failure diagnostics. Every write-file-mode reply (initial, retry, revise redo) is gated to `WROTE: <reqid> <path>`-only (Step 4 anchored gate). Unsolicited planner messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

**Planner request id.** Every lead→planner solicitation carries a per-run, lead-owned, monotonically increasing integer id. The lead is the SOLE id source — the planner only echoes it. The counter increments on EVERY solicitation: spawn = 1, each Step 7 revise = +1, AND every §1/§3 corrective redo — anchored-gate corrective AND file-check corrective alike — gets its OWN new id (a corrective is a fresh solicitation; reusing the prior id reintroduces the blind spot). The `shutdown_request` object message is EXEMPT (no id).

The lead must retain the following run-state across turns and never conflate these fields:

- `plan_path` — the resolved canonical plan path from Step 1.
- `awaiting_reply`, `request_id_counter`, `expected_request_id`, `solicit_sent_at`, `review_iteration` — these are the cross-loop state-machine fields. Lifecycle and semantics (mint protocol, MESSAGE ACCEPTED / POST-ACCEPTANCE VALIDATION ACCEPTED acceptance stages, Phase 1 / Phase 2 routing, stale-recovery) are defined in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E (single source of truth); this loop binds to them by name.

Mint protocol, lifecycle, and phase classification: see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E. The `references/failure-protocol.md` (sibling) carries the plan-loop binding declarations (reply-token shape `WROTE: <id> <path>`, exact-path accept regex, file/structure post-acceptance validation).

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **task description only**. There is NO existing-plan-path input mode — revision happens inside the loop. Resolution (mirrors stock `hyper-plan`):

- `$ARGUMENTS` non-empty → that is the task.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/research/*.md` (its `task:` frontmatter), or the user's most recent build/implement intent in this conversation.
- Nothing found → ask the user and STOP.

### Step 0 — Read the failure & recovery protocol

Before any team creation, Read both protocol files into context: (1) `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — the shared cross-loop protocol; (2) `references/failure-protocol.md` (sibling of this file) — the plan-loop binding + plan-loop-specific recoveries. Both are mandatory — the loop's failure branches reference sections by number (shared §A–§E and local §1–§5) and the lead must follow them verbatim when reached.

### Step 1 — Resolve task + slug + plan path

Reuse the stock `hyper-plan` logic — see `skills/hyper-plan/SKILL.md` Steps 1–2; do not duplicate the rule text. In brief:

1. Derive the canonical slug deterministically (lowercase, ASCII, alphanumerics + hyphen, first 5 words of the task joined by `-`).
2. Scan **all** `.hyperclaude/research/*.md` frontmatter `slug:` fields (the canonical key — not the filename). If one OR MORE equals the derived slug (there may be a Codex + Claude pair), treat ALL matching files as the linked research artifacts and inline the full contents of ALL of them as context in Step 3.
3. Resolve the plan path:

   ```bash
   mkdir -p .hyperclaude/plans
   date +%Y%m%d-%H%M
   ```

   Base path: `.hyperclaude/plans/<timestamp>-<slug>.md`. If it exists, append `-2`, `-3`, … until free.

### Step 2 — Confirm agent-teams availability

Run this Bash probe before spawning anything:

```bash
[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]
```

If the exit code is non-zero (env var unset or not `"1"`) → STOP immediately with the message below. Nothing has been spawned; no teardown is needed.

Initialize and record the following run-state fields (the Step 3 spawn will mint id `1`): `request_id_counter = 0`, `expected_request_id = null`, `awaiting_reply = false`, `solicit_sent_at = null`.

Failure handling:

- **Env var unset** → STOP with the message below. No teardown (nothing was created).
- **Step 3 spawn fails** → STOP with the same message. No teardown (team never formed).

Documented stop message:

> agent teams unavailable — this skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; run /hyperclaude:hyper-setup to diagnose prerequisites. Use /hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review manually instead.

### Step 3 — Spawn the planner teammate

Use the Agent tool. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:planner",
  name: "planner",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Task** — verbatim.
- **Research context** — full contents of ALL matched research artifacts inline (there may be a Codex + Claude pair), if any were found in Step 1. Do not make the planner re-read them.
- **Output format** — a multi-task plan with `## Task N: <title>` headings. Each task block: **Files to create / modify** (exact paths), **Steps** (`[ ]`-checkboxes, 2–5 min each), **Verification** (a command or observable change), **Commit message** (one line, conventional-commits). No frontmatter — plan body only; the skill owns the file name.
- **Write-file mode** — the exact resolved plan path from Step 1, stated literally, with an explicit instruction: use the `Write` tool to write the full plan to THAT EXACT path yourself (never a different path, never a `-v2.md` sibling), then reply with exactly `WROTE: 1 <that exact path>` and NOTHING else — no plan body, no summary of changes, no preamble. (The spawn mints request id `1`: the lead sets `request_id_counter = 1`, `expected_request_id = 1`, `awaiting_reply = true`, and immediately before the Agent-spawn call captures `solicit_sent_at` via a Bash `date -u +%FT%TZ`; the planner must echo that id verbatim.)
- **Reply transport (MANDATORY)** — that `WROTE:` reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "Plan written request 1", message: "WROTE: 1 <that exact path>" })`. Plain assistant text is NOT visible to the lead, and going idle only emits a payload-less idle notification — so if you merely print `WROTE:` and idle WITHOUT the SendMessage call, the lead never receives the confirmation and the loop stalls until a corrective round-trip. Call `SendMessage` first, then idle. Every later solicitation carries its own id; the planner must echo THAT id verbatim in its reply (e.g. `WROTE: 2 <path>` for id `2`), and the `summary` echoes `request <id>` for human mailbox debugging (the message body stays authoritative). This applies identically to every later revise-round reply.
- **Idle / no-resend discipline** — after replying `WROTE: <id> <path>`, go idle and wait; do NOT resend, re-announce, or nag. The lead will next contact you only via SendMessage carrying revise findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- State that the planner stays alive as a teammate, will receive Codex feedback in later turns, and must retain its full planning context.

(Spawn-failure handling is in Step 2.)

### Step 4 — Confirm the planner wrote the plan

The lead no longer Writes the plan — the planner writes the canonical file itself (caller-directed write-file mode, Step 3). The lead only verifies.

**Anchored reply gate (id-first summary)** — applies to EVERY planner reply in write-file mode (the initial write, any retry, and every Step 7 revise redo). Classification is id-first, phase-first:

1. **First operation:** parse the leading `WROTE: <integer>` token from the trimmed reply and capture `<reqid>`. Everything after that token is the path payload.
2. **Classify by `awaiting_reply` FIRST, then by id, BEFORE any exact-path or no-prose check.**
   - **Not awaiting** (`awaiting_reply == false`): a `WROTE:` with `id <= request_id_counter` is stale/duplicate — ignore SILENTLY (NEVER compare to `expected_request_id`; it is `null` then; NO §2 idle-correction for the stale `WROTE:` itself). Any non-`WROTE:` wake routes via Step 4a/§2.
   - **Awaiting** (`awaiting_reply == true`): an older id (`reqid < expected_request_id`) is a stale leftover — ignore content, do NOT run the §1 corrective for it, apply the stale-recovery sub-step; a matching id (`reqid == expected_request_id`) enforces the exact accept regex `^WROTE: <expected id> <exact resolved plan path from Step 1>\s*$` (path = entire remaining string, verbatim) plus no-prose rule — on pass → **MESSAGE ACCEPTED** (clear `expected_request_id`, `awaiting_reply`, and `solicit_sent_at`); a future id (`reqid > expected_request_id`) is a protocol violation → Step 8 teardown then STOP.
3. After MESSAGE ACCEPTED, run the file/structure check (= **PLAN VALIDATION ACCEPTED** stage). On any body echo, added prose, preamble, or a different path at the matching-id step → §1 corrective + escalation.

**File check (only after the gate passes):** confirm the file is non-empty via the Bash tool:

```bash
[ -s "<resolved plan path>" ]
```

If missing or empty → apply the file-check corrective + escalation in `references/failure-protocol.md` §1.

**In-place rule:** every later revision overwrites THIS SAME path; never a `-v2.md` (or any other) sibling — the bridge's `--resume` keys on the plan path, and a new path breaks resume continuity. The id, not a new path, is the disambiguator — a stale round-N `WROTE:` is byte-identical on path but distinguishable by id.

Full two-phase state machine, the two acceptance stages, and the stale-recovery sub-step are authoritative in `references/failure-protocol.md` §6 — do not duplicate the pseudo-code here.

### Step 4a — Unsolicited planner messages

While the planner is live and BEFORE Step 8 teardown, the only planner message the lead expects is the anchored `WROTE:` reply to the lead's most recent SendMessage (spawn, revise, or corrective). Any other inbound planner message — duplicate body, `RESEND:`-style re-emit, nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. Handle it per `references/failure-protocol.md` §2. This lead-side rule is **mandatory** — prompt-only idle discipline (Step 3) is insufficient. The teardown exchange is exempt (a `shutdown_response` after `shutdown_request` is expected, never a violation).

**Phase-aware cross-reference:** while AWAITING (`awaiting_reply == true`), a `WROTE:` whose `reqid < expected_request_id` is handled by §6's stale branch (ignore content + stale-recovery sub-step), NOT routed through §2; while NOT awaiting (`awaiting_reply == false`), a `WROTE:` with `id <= request_id_counter` is ignored SILENTLY (NO §2 idle-correction for the stale `WROTE:` itself), while all non-`WROTE:` traffic IS routed through Step 4a/§2; §2 still governs the post-corrective idle case. See `references/failure-protocol.md` §6 (state machine) and §2 (interplay).

### Step 5 — Plan-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **10 total reviews** (iter 1 fresh + at most **9 resumed revise rounds**). `review_iteration` is independent of `request_id_counter` — the id increments on every solicitation including correctives; `review_iteration` only on bridge re-invocation (see the run-state fields in the "Agent-teams tool contract" section).

Invoke via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<resolved path>"
```

Parse the single-line JSON. On `ok:true`, read the artifact at `path` with the Read tool.

On any non-`ok:true`, Bash timeout, or JSON parse failure → Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present. If the artifact `Read` itself fails → Step 8 teardown, then STOP.

### Step 6 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The plan-review template emits `### Issues` with `- **Blocker** — …` / `- **Major** — …` / `- **Minor** — …` bullets plus `### Verdict` — but classify by meaning, not by the severity word Codex attached: a finding **blocks** if it concerns **plan-level correctness, wrong file paths, broken task ordering, unverifiable steps, or missing required behavior the implementer would inherit** (regardless of severity label). Pure **style / "consider X" / "could be slightly clearer" / vague nits do NOT block.**

- Any blocking finding → revise (Step 7).
- No blocking findings (style/nits only, or an approving verdict) → exit loop (Step 8 teardown → Step 9). Non-blocking findings are reported, never gating.

**Conservative branch:** if severity cannot be confidently judged by meaning (no recognizable `### Issues` / `### Verdict` structure, truncated body, etc.) — do NOT assume "no blocking findings": instead Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 7 — Revise via the live planner, then re-review

First check the cap: if the iteration counter is already at 10 (10 total Codex reviews consumed), do NOT send findings or revise — go directly to Step 8 (cap reached).

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

Before sending, increment the id: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_reply = true`; immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (the field-definition rule above is binding — assistant-turn start is NOT valid). Pass that new id in the message and in the reply instruction.

Send the blocking findings to the still-live planner:

```
SendMessage({
  to: "planner",
  summary: "Revise plan request <id>",
  message: "<verbatim blocking findings + relevant ### Verdict text when it explains the required direction; instruct: first Read <the exact resolved plan path> to refresh, then revise and re-Write THAT SAME path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else — no plan body, no preamble>"
})
```

(Replace `<id>` with the actual integer just minted.)

Do NOT re-send the task or research — the planner still holds that context.

**§3 corrective id note:** any §3 redo-pipeline corrective (see `references/failure-protocol.md` §3) also mints its OWN new incremented id (the full mint protocol applies, same as the increment-before-send above: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_reply = true`, and `solicit_sent_at` captured via Bash `date -u +%FT%TZ` immediately before the SendMessage call) before sending — the redo reply must echo that newest id, not the failed solicitation's id.

**Revise-validation** — every revise reply must pass, in order: (1) **anchored reply gate** (Step 4) → (2) **structure `ok`/`bad` check**. The single-redo budget, corrective wording, and terminal STOP are specified in `references/failure-protocol.md` §3 — follow it verbatim. The structure check is a one-liner that prints only `ok` or `bad`:

```bash
node -e 'try{process.stdout.write(/^##\s*Task\s/m.test(require("fs").readFileSync(process.argv[1],"utf8"))?"ok":"bad")}catch{process.stdout.write("bad")}' "<resolved plan path>"
```

`bad` → §3 corrective + terminal handling. On `ok`, increment the iteration counter and re-invoke the bridge via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<same path>" --resume auto
```

`--plan-path` is REQUIRED on every iteration including resumes (`plan-review --resume auto` alone is invalid). Always pass `--resume auto` from iteration 2 onward. Re-parse per Step 5's JSON rules, then loop back to Step 6.

### Step 8 — Cap + teardown

Cap at **10 total reviews** (iter 1 fresh + at most 9 resumed revise rounds). `review_iteration` is independent of `request_id_counter` — the id increments on every solicitation including correctives; `review_iteration` only on bridge re-invocation (see the run-state fields in the "Agent-teams tool contract" section).

On cap-reached, FIRST capture the cap report details (iterations consumed, residual blocking findings from the latest review, plan path left in its latest revised state), THEN run teardown, THEN emit the named-loop report (**"hyper-plan-loop revise loop"**): the loop ran out of rounds before Codex stopped flagging plan-level correctness/path/ordering/missing-behavior issues. The plan path needs manual triage.

(Cap is only reachable via Step 7, which only runs when the latest review had blocking findings — so cap-reached always means "blocking findings still open." A run where Codex returns non-blocking-only at any iteration exits cleanly via Step 6 before the cap can trip.)

**Teardown is MANDATORY on EVERY exit path once the Step 3 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure (anchored gate / unsolicited-message protocol), planner-write failure, planner-format failure, plus any other unexpected tool error while the planner teammate is live. Run teardown FIRST, then report/STOP — never before. Teardown consists of a graceful shutdown exchange only (no explicit team-delete call — the team is cleaned up automatically on session exit).

Exact procedure:

1. `SendMessage({ to: "planner", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The planner's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.

### Step 9 — Final report

After successful teardown, report:

- The plan path.
- Whether the slug was reused from research artifact(s) or freshly derived.
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking findings (informational, never gating).
- **Next step:**
  - Clean exit (loop converged) → recommend: `Next step: /hyperclaude:hyper-implement <plan path>`.
  - Cap-reached (blocking findings still open) → do NOT recommend implementation. Direct the user to inspect the plan path and decide whether to revise manually (via `/hyperclaude:hyper-plan` + `/hyperclaude:hyper-plan-review`) or re-run `/hyperclaude:hyper-plan-loop` with the original task description (this skill takes a task description, not an existing plan path).

## Anti-patterns

Core invariants (full list in `references/failure-protocol.md` §5):

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the planner fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Reading the plan body into lead context each revise round, or accepting any non-`WROTE:` reply as success.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Skipping `shutdown_request` on exit; stopping silently at the cap.
- Treating non-blocking findings as revise targets. Step 6 classifies by **meaning** — style nits, vague "consider X" suggestions, and pure prose-polish do NOT block, regardless of what severity label Codex attached. Only plan-level correctness / wrong paths / broken ordering / unverifiable steps / missing required behavior gate the loop.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
