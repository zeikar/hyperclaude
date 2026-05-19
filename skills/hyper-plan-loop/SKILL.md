---
name: hyper-plan-loop
description: Autonomous plan → Codex-review → revise loop in one gesture. Use when the user invokes /hyperclaude:hyper-plan-loop, or wants a plan generated and critic-hardened end-to-end without manually chaining /hyperclaude:hyper-plan and /hyperclaude:hyper-plan-review. Skip for one-step tasks (dispatch the implementer agent directly), when you want manual control over each plan / review round (use /hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review), or when the experimental agent-teams feature is unavailable.
---

# hyper-plan-loop

Autonomous plan-hardening gate. Creates a per-run team, spawns the `planner` agent as a persistent teammate, writes its plan to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`, runs Codex `plan-review` through the bridge, and revises via the still-live planner until Codex returns no Blocker/Major or the cap is hit; when only a concrete actionable Minor remains, the loop runs a one-shot Minor-cleanup pass before teardown. The planner is spawned **once**; every revise round reuses its retained context via SendMessage. The reviewer is always the Codex bridge, never a teammate — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-plan-loop <task>`.
- User wants an autonomous plan → review → revise cycle in a single gesture.

Skip when:
- The task is one step — dispatch the `implementer` agent directly.
- You want hands-on control over each plan / review round — use `/hyperclaude:hyper-plan` + `/hyperclaude:hyper-plan-review` manually.
- The experimental agent-teams feature is unavailable (this skill stops with a documented fallback message — see Step 2).

## Failure & recovery protocol — read first

`references/failure-protocol.md` carries the recovery procedures invoked at this skill's decision points: §1 anchored-gate corrective, §2 unsolicited-message protocol, §3 revise-validation redo pipeline, §4 teardown recovery, §5 full anti-pattern list. These are load-bearing, not optional troubleshooting — Step 0 makes Reading it mandatory before the loop starts, so the full protocol is in context when its conditions arise.

## Agent-teams tool contract

This skill uses the experimental agent-teams tools. The per-run team name is passed **only** to `TeamCreate` and `Agent` — it is **never** a tool argument to `SendMessage` or `TeamDelete`.

- `TeamCreate` — `{ team_name, description? }`. Creates the team and its task list.
- `Agent` (spawn teammate) — `subagent_type`, plus `team_name` (the SAME run-unique literal from `TeamCreate`) and `name` to make the agent a teammate addressable by `name`.
- `SendMessage` — `{ to: <teammate name, e.g. "planner">, message: <string | {type:"shutdown_request"}>, summary? }`. No `team_name` field. `summary` is REQUIRED whenever `message` is a string; the shutdown object message takes no `summary`. Plain-text output is NOT visible to teammates; messaging requires this tool.
- `TeamDelete` — `{}` (no args; team inferred from session). Fails if the team still has a live member, so shut members down first.
- A teammate's `shutdown_response` or idle-termination notification is auto-delivered as a new turn — there is no poll/wait tool. **But the idle notification is a payload-less wake signal (`{type:"idle_notification",...}`) — it does NOT carry the teammate's reply text.** The `WROTE:` confirmation arrives ONLY if the planner explicitly `SendMessage`s it to the lead (Step 3 reply-transport rule); a planner that prints `WROTE:` as plain text and idles delivers an empty notification and the lead must fall back to the corrective round-trip. Idle teammates keep their process + context alive between turns; a later SendMessage wakes them with context intact — this is the property the revise loop depends on.
- **Plan ownership:** the planner writes the canonical plan file itself via caller-directed write-file mode (its Step 3 prompt carries the exact resolved path). The lead never Writes or Reads the plan body on the normal path — it does only a quiet `ok`/`bad` structure check, and only Reads the body for human-facing failure diagnostics. Every write-file-mode reply (initial, retry, revise redo) is gated to `WROTE: <reqid> <path>`-only (Step 4 anchored gate). Unsolicited planner messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

**Planner request id.** Every lead→planner solicitation carries a per-run, lead-owned, monotonically increasing integer id. The lead is the SOLE id source — the planner only echoes it. The counter increments on EVERY solicitation: spawn = 1, each Step 7 revise = +1, each Step 7a cleanup = +1, AND every §1/§3 corrective redo — anchored-gate corrective AND file-check corrective alike — gets its OWN new id (a corrective is a fresh solicitation; reusing the prior id reintroduces the blind spot). The `shutdown_request` object message is EXEMPT (no id).

The lead must retain the following run-state across turns and never conflate these fields:
- `team_name` — the per-run unique team name.
- `plan_path` — the resolved canonical plan path from Step 1.
- `request_id_counter` — the last id minted (initialized to `0`; incremented on every solicitation as above).
- `expected_request_id` — the id of the outstanding solicitation the lead is currently waiting on; `null` when the lead is not awaiting any reply (e.g. while running Codex review).
- `awaiting_planner_reply` — boolean: `true` ONLY between minting a solicitation and accepting its reply.
- `solicit_sent_at` — UTC wall-clock timestamp captured by the lead IMMEDIATELY BEFORE invoking the SendMessage carrying the current outstanding solicitation: run `date -u +%FT%TZ` (via the Bash tool) as the LAST tool call before that SendMessage and store its output verbatim. The assistant-turn start timestamp is NOT a valid substitute — a long turn can elapse minutes (typically a Codex review) between turn-start and the next SendMessage, during which a payload-less idle could be emitted with `idle.timestamp > assistant-turn-start` but still `< actual-SendMessage time`, leaving the guard mis-comparing and the stale-idle race unplugged. `null` when not awaiting. Used by `references/failure-protocol.md` §6 Phase 2 to distinguish a stale prior-round idle (`idle.timestamp < solicit_sent_at`) from a true post-solicit silence — the dogfooded failure mode this field was added to plug.
- `review_iteration` — bridge re-invocation count, independent of the id counter.

The request-id counter and `review_iteration` are SEPARATE counters: the id bumps on every solicitation including correctives; the iteration only on bridge re-invocation.

On minting any solicitation: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true`, and immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (the field-definition rule above is binding — assistant-turn start is NOT valid); the two acceptance stages **MESSAGE ACCEPTED** (clears `expected_request_id`/`awaiting_planner_reply`/`solicit_sent_at`) and **PLAN VALIDATION ACCEPTED** (file/structure check), the not-awaiting `id <= request_id_counter` = stale / `id > request_id_counter` = protocol-violation rules, and the full two-phase state machine are specified in `references/failure-protocol.md` §6 (authoritative — not duplicated here).

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **task description only**. There is NO existing-plan-path input mode — revision happens inside the loop. Resolution (mirrors stock `hyper-plan`):

- `$ARGUMENTS` non-empty → that is the task.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/research/*.md` (its `task:` frontmatter), or the user's most recent build/implement intent in this conversation.
- Nothing found → ask the user and STOP.

### Step 0 — Read the failure & recovery protocol

Before any team creation, Read `references/failure-protocol.md` (sibling of this file) into context. It is **mandatory** — the loop's failure branches reference its sections by number and the lead must follow them verbatim when reached.

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

### Step 2 — Create the team

Do not add an env-probe shell check — let `TeamCreate` itself surface agent-teams unavailability.

Compute a per-run unique team name (the nonce defeats same-second collisions) and record this exact literal as the run's team name (also used in Step 3's `Agent` call and reports):

```bash
echo "hyper-plan-loop-$(date +%Y%m%d-%H%M%S)-$RANDOM"
```

Then:

```
TeamCreate({ team_name: "<the run-unique name computed above>", description: "plan generation + Codex plan-review revise loop" })
```

Initialize and record the following run-state fields alongside `team_name` (the Step 3 spawn will mint id `1`): `request_id_counter = 0`, `expected_request_id = null`, `awaiting_planner_reply = false`, `solicit_sent_at = null`.

Failure handling:

- **`TeamCreate` fails** → STOP with the message below + the raw error verbatim. No teardown (nothing was created).
- **`TeamCreate` succeeds but the Step 3 spawn fails** → `TeamDelete` FIRST (no orphaned empty team), then STOP with the same message.

Documented stop message:

> agent teams unavailable (or TeamCreate failed — see error below) — this skill requires the experimental agent-teams feature; run /hyperclaude:hyper-setup to diagnose prerequisites. Use /hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review manually instead.

### Step 3 — Spawn the planner teammate

Use the Agent tool. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:planner",
  team_name: "<the run-unique team name computed in Step 2>",
  name: "planner",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Task** — verbatim.
- **Research context** — full contents of ALL matched research artifacts inline (there may be a Codex + Claude pair), if any were found in Step 1. Do not make the planner re-read them.
- **Output format** — a multi-task plan with `## Task N: <title>` headings. Each task block: **Files to create / modify** (exact paths), **Steps** (`[ ]`-checkboxes, 2–5 min each), **Verification** (a command or observable change), **Commit message** (one line, conventional-commits). No frontmatter — plan body only; the skill owns the file name.
- **Write-file mode** — the exact resolved plan path from Step 1, stated literally, with an explicit instruction: use the `Write` tool to write the full plan to THAT EXACT path yourself (never a different path, never a `-v2.md` sibling), then reply with exactly `WROTE: 1 <that exact path>` and NOTHING else — no plan body, no summary of changes, no preamble. (The spawn mints request id `1`: the lead sets `request_id_counter = 1`, `expected_request_id = 1`, `awaiting_planner_reply = true`, and immediately before the Agent-spawn call captures `solicit_sent_at` via a Bash `date -u +%FT%TZ`; the planner must echo that id verbatim.)
- **Reply transport (MANDATORY)** — that `WROTE:` reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "Plan written request 1", message: "WROTE: 1 <that exact path>" })`. Plain assistant text is NOT visible to the lead, and going idle only emits a payload-less idle notification — so if you merely print `WROTE:` and idle WITHOUT the SendMessage call, the lead never receives the confirmation and the loop stalls until a corrective round-trip. Call `SendMessage` first, then idle. Every later solicitation carries its own id; the planner must echo THAT id verbatim in its reply (e.g. `WROTE: 2 <path>` for id `2`), and the `summary` echoes `request <id>` for human mailbox debugging (the message body stays authoritative). This applies identically to every later revise-round reply.
- **Idle / no-resend discipline** — after replying `WROTE: <id> <path>`, go idle and wait; do NOT resend, re-announce, or nag. The lead will next contact you only via SendMessage carrying revise findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- State that the planner stays alive as a teammate, will receive Codex feedback in later turns, and must retain its full planning context.

(Spawn-failure handling is in Step 2.)

### Step 4 — Confirm the planner wrote the plan

The lead no longer Writes the plan — the planner writes the canonical file itself (caller-directed write-file mode, Step 3). The lead only verifies.

**Anchored reply gate (id-first summary)** — applies to EVERY planner reply in write-file mode (the initial write, any retry, every Step 7 revise redo, and every Step 7a cleanup reply and redo alike). Classification is id-first, phase-first:

1. **First operation:** parse the leading `WROTE: <integer>` token from the trimmed reply and capture `<reqid>`. Everything after that token is the path payload.
2. **Classify by `awaiting_planner_reply` FIRST, then by id, BEFORE any exact-path or no-prose check.**
   - **Not awaiting** (`awaiting_planner_reply == false`): a `WROTE:` with `id <= request_id_counter` is stale/duplicate — ignore SILENTLY (NEVER compare to `expected_request_id`; it is `null` then; NO §2 idle-correction for the stale `WROTE:` itself). Any non-`WROTE:` wake routes via Step 4a/§2.
   - **Awaiting** (`awaiting_planner_reply == true`): an older id (`reqid < expected_request_id`) is a stale leftover — ignore content, do NOT run the §1 corrective for it, apply the stale-recovery sub-step; a matching id (`reqid == expected_request_id`) enforces the exact accept regex `^WROTE: <expected id> <exact resolved plan path from Step 1>\s*$` (path = entire remaining string, verbatim) plus no-prose rule — on pass → **MESSAGE ACCEPTED** (clear `expected_request_id`, `awaiting_planner_reply`, and `solicit_sent_at`); a future id (`reqid > expected_request_id`) is a protocol violation → Step 8 teardown then STOP.
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

**Phase-aware cross-reference:** while AWAITING (`awaiting_planner_reply == true`), a `WROTE:` whose `reqid < expected_request_id` is handled by §6's stale branch (ignore content + stale-recovery sub-step), NOT routed through §2; while NOT awaiting (`awaiting_planner_reply == false`), a `WROTE:` with `id <= request_id_counter` is ignored SILENTLY (NO §2 idle-correction for the stale `WROTE:` itself), while all non-`WROTE:` traffic IS routed through Step 4a/§2; §2 still governs the post-corrective idle case. See `references/failure-protocol.md` §6 (state machine) and §2 (interplay).

### Step 5 — Plan-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **5 severity-gated reviews** (iter 1 fresh + at most **4 revise rounds**), plus at most ONE final Minor-cleanup re-review (the separate non-gated Step 7a one). `review_iteration` is independent of `request_id_counter` — the id increments on every solicitation including correctives; `review_iteration` only on bridge re-invocation (see the run-state fields in the "Agent-teams tool contract" section).

Invoke via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<resolved path>"
```

Parse the single-line JSON. On `ok:true`, read the artifact at `path` with the Read tool.

On any non-`ok:true`, Bash timeout, or JSON parse failure → Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present. If the artifact `Read` itself fails → Step 8 teardown, then STOP.

### Step 6 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The plan-review template emits `### Issues` with `- **Blocker** — …` / `- **Major** — …` / `- **Minor** — …` bullets plus `### Verdict`.

Three successful severity outcomes; the conservative failure branch below is unchanged:

- **(a)** Any Blocker or Major → revise (Step 7).
- **(b)** Zero Blocker/Major AND no concrete actionable Minor cleanup (pure approve, OR Minor mentioned only vaguely with no identifiable executable change) → exit loop now (Step 8 teardown → Step 9).
- **(c)** Zero Blocker/Major AND a concrete, executable Minor-grade cleanup remains → run the new Step 7a final-cleanup pass exactly once, then unconditionally Step 8 teardown → Step 9. Never return to Step 6. (See Step 7a — runs exactly once, then hard-stops; the loop never recurses on Minor.)

**Branch (b)-vs-(c) detection:** judge by meaning (not a regex count) by reading BOTH the `### Issues` Minor bullets AND the `### Verdict` text. Branch (c) fires ONLY if either names a **concrete**, executable Minor-grade change the planner can act on without guessing. If the Verdict only says "ship after small fixes" (or similar) but neither Issues nor Verdict identifies a specific actionable change, this is branch (b) — exit and report the residual as "non-actionable / ambiguous Minor (not sent to planner)" in Step 9; do NOT send a vague directive to the planner.

**Conservative branch:** if severity cannot be confidently judged by meaning (no recognizable `### Issues` / `### Verdict` structure, truncated body, etc.), do NOT assume "no Blocker/Major" — instead Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 7 — Revise via the live planner, then re-review (Blocker/Major only; Step 7a is the Minor-only counterpart, bounded to one occurrence)

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

Before sending, increment the id: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true`; immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (the field-definition rule above is binding — assistant-turn start is NOT valid). Pass that new id in the message and in the reply instruction.

Send the findings to the still-live planner:

```
SendMessage({
  to: "planner",
  summary: "Revise plan request <id>",
  message: "<verbatim Blocker/Major findings + relevant ### Verdict text when it explains the required direction; instruct: first Read <the exact resolved plan path> to refresh, then revise and re-Write THAT SAME path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else — no plan body, no preamble>"
})
```

(Replace `<id>` with the actual integer just minted.)

Do NOT re-send the task or research — the planner still holds that context.

**§3 corrective id note:** any §3 redo-pipeline corrective (see `references/failure-protocol.md` §3) also mints its OWN new incremented id (the full mint protocol applies, same as the increment-before-send above: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true`, and `solicit_sent_at` captured via Bash `date -u +%FT%TZ` immediately before the SendMessage call) before sending — the redo reply must echo that newest id, not the failed solicitation's id.

**Revise-validation** — every revise reply must pass, in order: (1) **anchored reply gate** (Step 4) → (2) **structure `ok`/`bad` check**. The single-redo budget, corrective wording, and terminal STOP are specified in `references/failure-protocol.md` §3 — follow it verbatim. The structure check is a one-liner that prints only `ok` or `bad`:

```bash
node -e 'try{process.stdout.write(/^##\s*Task\s/m.test(require("fs").readFileSync(process.argv[1],"utf8"))?"ok":"bad")}catch{process.stdout.write("bad")}' "<resolved plan path>"
```

`bad` → §3 corrective + terminal handling. On `ok`, increment the iteration counter and re-invoke the bridge via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<same path>" --resume auto
```

`--plan-path` is REQUIRED on every iteration including resumes (`plan-review --resume auto` alone is invalid). Always pass `--resume auto` from iteration 2 onward. Re-parse per Step 5's JSON rules, then loop back to Step 6.

### Step 7a — Final Minor-cleanup pass (exactly once)

Entered only on Step 6 branch (c): zero Blocker/Major, concrete actionable Minor remains. Runs exactly once, then hard-stops at Step 8 teardown → Step 9. **Never loops back to Step 6 or Step 7.**

**Cap accounting:** this cleanup re-review is the single non-gated review outside the 5-review cap (Step 8); it never affects the Blocker/Major cap-exhaust path.

1. **SendMessage the Minor findings to the still-live planner.** Before sending, increment the id: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true`; immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (the field-definition rule above is binding — assistant-turn start is NOT valid). Send verbatim concrete Minor `### Issues` findings PLUS the relevant actionable `### Verdict` directive text. Do NOT re-send the task or research (planner holds context). Pass that new id in the message and in the reply instruction. Use the SAME reply-transport, anchored reply gate (Step 4), structure `ok`/`bad` check, and single-redo pipeline as Step 7 — reuse the `references/failure-protocol.md` §3 pipeline exactly — do not restate it. (A §3 terminal outcome here proceeds to Step 8 teardown → STOP — Step 8 is mandatory on every post-spawn stop; do not fall through to the passing-reply path below.) SendMessage shape:

   ```
   SendMessage({
     to: "planner",
     summary: "Apply Codex Minor cleanup request <id>",
     message: "<verbatim Minor ### Issues findings + relevant ### Verdict directive text; instruct: first Read <the exact resolved plan path> to refresh, then revise and re-Write THAT SAME path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else — no plan body, no preamble>"
   })
   ```

   (Replace `<id>` with the actual integer just minted.)

   **§3 corrective id note:** any §3 redo-pipeline corrective (see `references/failure-protocol.md` §3) also mints its OWN new incremented id (the full mint protocol applies, same as the increment-before-send above: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true`, and `solicit_sent_at` captured via Bash `date -u +%FT%TZ` immediately before the SendMessage call) before sending — the redo reply must echo that newest id, not the failed solicitation's id.

2. **On a passing reply (gate + structure `ok`),** increment the iteration counter and re-invoke the bridge EXACTLY ONCE via the Bash tool with `timeout: 600000`:

   ```bash
   node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<same path>" --resume auto
   ```

   `--plan-path` is REQUIRED; `--resume auto` always (this is iteration ≥2). Re-parse per Step 5's JSON rules; on `ok:true`, Read the artifact at `path` with the Read tool (required input for the Step 7a.3 classification). On any non-`ok:true`, Bash timeout, or parse failure → Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop bridge failure, iter N"**) — same as Step 5's bridge-failure path.

3. **Final-review classification (REPORTING ONLY — never re-revise).** Read the cleanup re-review artifact by meaning and extract, for Step 9's report ONLY: the final Codex verdict, and whether it introduced a NEW Blocker/Major (revise regression) or left only residual Minor. This is a read for reporting — it does NOT route back to Step 6 or Step 7 and never triggers another revision. If the cleanup artifact's structure is unparseable (no recognizable `### Issues` / `### Verdict`, truncated body), do NOT treat it as success — carry an explicit **"final cleanup re-review unparseable"** flag into Step 9 and report it loudly there (still hard-stop; never re-revise).

4. **Hard stop regardless of classification.** Proceed unconditionally to Step 8 teardown → Step 9. NEVER loop back to Step 6 or Step 7. Even a NEW Blocker/Major found in Step 7a.3 above does NOT cause another revise — it is reported loudly in Step 9 and the loop terminates.

### Step 8 — Cap + teardown

Cap at **5 severity-gated reviews, plus at most ONE final Minor-cleanup re-review** (iter 1 fresh + at most 4 resumed revise rounds as the severity-gated portion; the cleanup re-review from Step 7a is the separate non-gated one). `review_iteration` is independent of `request_id_counter` — the id increments on every solicitation including correctives; `review_iteration` only on bridge re-invocation (see the run-state fields in the "Agent-teams tool contract" section).

On cap-reached with Blocker/Major still open: FIRST capture the cap report details (iterations consumed, residual Blocker/Major findings, plan path left in its latest revised state), THEN run teardown, THEN emit the named-loop report (**"hyper-plan-loop revise loop"**).

**Teardown is MANDATORY on EVERY exit path once the Step 3 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure (anchored gate / unsolicited-message protocol), planner-write failure, planner-format failure, plus any other unexpected tool error while the planner teammate is live. Run teardown FIRST, then report/STOP — never before.

Exact procedure:

1. `SendMessage({ to: "planner", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The planner's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.
3. `TeamDelete({})`.

If `TeamDelete` fails because a member is still live → apply the recovery in `references/failure-protocol.md` §4.

### Step 9 — Final report

After successful teardown, report:

- The plan path.
- Whether the slug was reused from research artifact(s) or freshly derived.
- Review iterations consumed (on branch (c), this count INCLUDES the final cleanup re-review — it is the one non-severity-gated review that sits OUTSIDE the 5-review cap (it does not count against it)).
- The final Codex verdict (this bullet is the SINGLE source of the latest Codex verdict; do NOT restate it in the cleanup bullet below).
- **Cleanup outcome and residuals:** report ONE of the following:
  - Branch (b) path: the one-shot Minor-cleanup pass was skipped (either zero actionable Minor existed, or the Minor was non-actionable / ambiguous and not sent to the planner); state any residual Minor findings from the last review as informational.
  - Branch (c) clean path: the one-shot Minor-cleanup pass was applied; state any residual Minor findings from the cleanup re-review as informational.
  - Branch (c) with the "final cleanup re-review unparseable" flag set: the one-shot Minor-cleanup pass was applied but the final cleanup re-review could not be classified — report this loudly.
  - Branch (c) with a NEW Blocker/Major from the cleanup re-review: **WARNING — revise regression detected.** The one-shot Minor-cleanup pass was applied but the cleanup re-review surfaced a new Blocker/Major. Do NOT duplicate the Codex verdict here — state only that a regression was found and see the terminal-state next-step below.

- **Next step** — conditional on branch and final cleanup re-review outcome:
  - If branch (b), OR branch (c) with the final cleanup re-review reporting NO Blocker/Major → recommend: `Next step: /hyperclaude:hyper-implement <plan path>`.
  - If branch (c) and the final cleanup re-review surfaced a NEW Blocker/Major, OR the "final cleanup re-review unparseable" flag is set → **terminal revise-regression state**: the plan is left in its last revised form at the reported plan path. Do NOT recommend implementation. Direct the user to inspect that plan path and restart the plan/review flow from the original task context using `/hyperclaude:hyper-plan` + `/hyperclaude:hyper-plan-review` manually (do NOT tell them to re-run `/hyperclaude:hyper-plan-loop` with the plan path — that skill takes a task description, not an existing plan path).

## Anti-patterns

Core invariants (full list in `references/failure-protocol.md` §5):

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the planner fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Reading the plan body into lead context each revise round, or accepting any non-`WROTE:` reply as success.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the teammate is down; stopping silently at the cap.
- Treating an actionable Minor as a recursive revise target. Under Step 6 branch (c) an actionable Minor triggers the one-shot Step 7a cleanup exactly once (then hard-stop); recursing on Minor — re-entering revise after the 7a re-review, or looping 7a back to Step 6/7 — is forbidden.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
