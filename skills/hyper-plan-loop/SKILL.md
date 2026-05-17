---
name: hyper-plan-loop
description: Autonomous plan → Codex-review → revise loop in one gesture. Use when the user invokes /hyperclaude:hyper-plan-loop, or wants a plan generated and critic-hardened end-to-end without manually chaining /hyperclaude:hyper-plan and /hyperclaude:hyper-plan-review. Skip for one-step tasks (dispatch the implementer agent directly), when you want manual control over each plan / review round (use /hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review), or when the experimental agent-teams feature is unavailable.
---

# hyper-plan-loop

Autonomous plan-hardening gate. Creates a per-run team, spawns the `planner` agent as a persistent teammate, writes its plan to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`, runs Codex `plan-review` through the bridge, and revises via the still-live planner until Codex returns no Blocker/Major or the cap is hit. The planner is spawned **once**; every revise round reuses its retained context via SendMessage. The reviewer is always the Codex bridge, never a teammate — this preserves the "Claude builds, Codex reviews" invariant.

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
- **Plan ownership:** the planner writes the canonical plan file itself via caller-directed write-file mode (its Step 3 prompt carries the exact resolved path). The lead never Writes or Reads the plan body on the normal path — it does a filesystem-level `cp` backup/restore plus a quiet `ok`/`bad` structure check, and only Reads the body for human-facing failure diagnostics. Every write-file-mode reply (initial, retry, revise redo) is gated to `WROTE: <path>`-only (Step 4 anchored gate). Unsolicited planner messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

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
- **Write-file mode** — the exact resolved plan path from Step 1, stated literally, with an explicit instruction: use the `Write` tool to write the full plan to THAT EXACT path yourself (never a different path, never a `-v2.md` sibling), then reply with exactly `WROTE: <that exact path>` and NOTHING else — no plan body, no summary of changes, no preamble.
- **Reply transport (MANDATORY)** — that `WROTE:` reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "Plan written", message: "WROTE: <that exact path>" })`. Plain assistant text is NOT visible to the lead, and going idle only emits a payload-less idle notification — so if you merely print `WROTE:` and idle WITHOUT the SendMessage call, the lead never receives the confirmation and the loop stalls until a corrective round-trip. Call `SendMessage` first, then idle. This applies identically to every later revise-round reply.
- **Idle / no-resend discipline** — after replying `WROTE: <path>`, go idle and wait; do NOT resend, re-announce, or nag. The lead will next contact you only via SendMessage carrying revise findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- State that the planner stays alive as a teammate, will receive Codex feedback in later turns, and must retain its full planning context.

(Spawn-failure handling is in Step 2.)

### Step 4 — Confirm the planner wrote the plan

The lead no longer Writes the plan — the planner writes the canonical file itself (caller-directed write-file mode, Step 3). The lead only verifies.

**Anchored reply gate** — applies to EVERY planner reply in write-file mode (the initial write, any retry, and every Step 7 revise redo alike). Accept the reply only if, after trimming trailing whitespace, it matches exactly:

```
^WROTE: <the exact resolved plan path from Step 1>\s*$
```

The path must equal the resolved plan path verbatim. On any body echo, added prose, preamble, or a different path → apply the corrective + escalation in `references/failure-protocol.md` §1.

**File check (only after the gate passes):** confirm the file is non-empty via the Bash tool:

```bash
[ -s "<resolved plan path>" ]
```

If missing or empty → apply the file-check corrective + escalation in `references/failure-protocol.md` §1.

**In-place rule (now binds the planner):** every later revision overwrites THIS SAME path; never a `-v2.md` (or any other) sibling — the bridge's `--resume` keys on the plan path, and a new path breaks resume continuity.

### Step 4a — Unsolicited planner messages

While the planner is live and BEFORE Step 8 teardown, the only planner message the lead expects is the anchored `WROTE:` reply to the lead's most recent SendMessage (spawn, revise, or corrective). Any other inbound planner message — duplicate body, `RESEND:`-style re-emit, nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. Handle it per `references/failure-protocol.md` §2. This lead-side rule is **mandatory** — prompt-only idle discipline (Step 3) is insufficient. The teardown exchange is exempt (a `shutdown_response` after `shutdown_request` is expected, never a violation).

### Step 5 — Plan-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **5 total Codex reviews**, i.e. at most **4 revise rounds**.

Invoke via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<resolved path>"
```

Parse the single-line JSON. On `ok:true`, read the artifact at `path` with the Read tool.

On any non-`ok:true`, Bash timeout, or JSON parse failure → Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present. If the artifact `Read` itself fails → Step 8 teardown, then STOP.

### Step 6 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The plan-review template emits `### Issues` with `- **Blocker** — …` / `- **Major** — …` / `- **Minor** — …` bullets plus `### Verdict`.

- Any Blocker or Major → revise (Step 7).
- Zero Blocker and zero Major (Minor-only, or a Verdict that approves / says proceed) → exit loop (Step 8 teardown → Step 9). Minor findings are reported, never blocking.

**Conservative branch:** if severity cannot be confidently judged by meaning (no recognizable `### Issues` / `### Verdict` structure, truncated body, etc.), do NOT assume "no Blocker/Major" — instead Step 8 teardown, then STOP with a named-loop report (**"hyper-plan-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 7 — Revise via the live planner, then re-review

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Preservation and validation are filesystem-level only.

**Before sending findings**, back up the canonical file via the Bash tool (the `.hyperclaude/` tree is gitignored, so the `.bak` sibling is harmless and untracked):

```bash
cp "<resolved plan path>" "<resolved plan path>.bak"
```

Then send the findings to the still-live planner:

```
SendMessage({
  to: "planner",
  summary: "Revise plan for Codex Blocker/Major findings",
  message: "<verbatim Blocker/Major findings + relevant ### Verdict text when it explains the required direction; instruct: first Read <the exact resolved plan path> to refresh, then revise and re-Write THAT SAME path; reply with exactly 'WROTE: <that exact path>' and nothing else — no plan body>"
})
```

Do NOT re-send the task or research — the planner still holds that context.

**Revise-validation pipeline** — every revise reply must pass this ordered sequence: (1) **anchored reply gate** (Step 4) → (2) **`cmp -s` no-op compare vs `.bak`** → (3) **structure `ok`/`bad` check**. Each failure branch, its single-redo budget, the corrective message wording, the no-op / malformed terminal STOPs, and the `.bak` restore + cleanup ordering are specified in `references/failure-protocol.md` §3 — follow it verbatim. The two bash checks themselves:

No-op compare (step 2):

```bash
cmp -s "<resolved plan path>" "<resolved plan path>.bak"
```

Exit 0 = byte-identical = the planner replied `WROTE:` but applied NO revision → §3 no-op handling.

Structure check (step 3, only when the file genuinely differs from `.bak`) — a one-liner that prints only `ok` or `bad`:

```bash
node -e 'try{process.stdout.write(/^##\s*Task\s/m.test(require("fs").readFileSync(process.argv[1],"utf8"))?"ok":"bad")}catch{process.stdout.write("bad")}' "<resolved plan path>"
```

`bad` → §3 restore-from-`.bak` + corrective + terminal handling.

On `ok`, delete the backup (`rm "<resolved plan path>.bak"`). Increment the iteration counter and re-invoke the bridge via the Bash tool with `timeout: 600000`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<same path>" --resume auto
```

`--plan-path` is REQUIRED on every iteration including resumes (`plan-review --resume auto` alone is invalid). Always pass `--resume auto` from iteration 2 onward. Re-parse per Step 5's JSON rules, then loop back to Step 6.

### Step 8 — Cap + teardown

Cap at **5 total Codex reviews** (iter 1 fresh + at most 4 resumed revise rounds).

On cap-reached with Blocker/Major still open: FIRST capture the cap report details (iterations consumed, residual Blocker/Major findings, plan path left in its latest revised state), THEN run teardown, THEN emit the named-loop report (**"hyper-plan-loop revise loop"**).

**Teardown is MANDATORY on EVERY exit path once the Step 3 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure (anchored gate / unsolicited-message protocol), planner-write failure, planner-format-after-restore, plus any other unexpected tool error while the planner teammate is live. Run teardown FIRST, then report/STOP — never before.

Exact procedure:

1. `SendMessage({ to: "planner", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The planner's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.
3. `TeamDelete({})`.

If `TeamDelete` fails because a member is still live → apply the recovery in `references/failure-protocol.md` §4.

### Step 9 — Final report

After successful teardown, report:

- The plan path.
- Whether the slug was reused from research artifact(s) or freshly derived.
- Review iterations consumed.
- The final Codex verdict.
- Residual Minor findings (informational, non-blocking).
- Next step: `/hyperclaude:hyper-implement <plan path>`.

## Anti-patterns

Core invariants (full list in `references/failure-protocol.md` §5):

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the planner fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Reading the plan body into lead context each revise round, or accepting any non-`WROTE:` reply / a byte-identical no-op revise as success.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the teammate is down; stopping silently at the cap.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
