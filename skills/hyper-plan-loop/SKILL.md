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

## Agent-teams tool contract

This skill uses the experimental agent-teams tools. The per-run team name is passed **only** to `TeamCreate` and `Agent` — it is **never** a tool argument to `SendMessage` or `TeamDelete`.

- `TeamCreate` — `{ team_name, description? }`. Creates the team and its task list.
- `Agent` (spawn teammate) — `subagent_type`, plus `team_name` (the SAME run-unique literal from `TeamCreate`) and `name` to make the agent a teammate addressable by `name`.
- `SendMessage` — `{ to: <teammate name, e.g. "planner">, message: <string | {type:"shutdown_request"}>, summary? }`. No `team_name` field. `summary` is REQUIRED whenever `message` is a string; the shutdown object message takes no `summary`. Plain-text output is NOT visible to teammates; messaging requires this tool.
- `TeamDelete` — `{}` (no args; team inferred from session). Fails if the team still has a live member, so shut members down first.
- A teammate's `shutdown_response` or idle-termination notification is auto-delivered as a new turn — there is no poll/wait tool; its arrival IS the confirmation. Idle teammates keep their process + context alive between turns; a later SendMessage wakes them with context intact — this is the property the revise loop depends on.
- **Plan ownership:** the planner writes the canonical plan file itself via caller-directed write-file mode (its Step 3 prompt carries the exact resolved path). The lead never Writes or Reads the plan body on the normal path — it does a filesystem-level `cp` backup/restore plus a quiet `ok`/`bad` structure check, and only Reads the body for human-facing failure diagnostics. Every write-file-mode reply (initial, retry, revise redo) is gated to `WROTE: <path>`-only (Step 4 anchored gate). Unsolicited planner messages follow the lead-side protocol (Step 4a) — prompt-only idle discipline is insufficient.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **task description only**. There is NO existing-plan-path input mode — revision happens inside the loop. Resolution (mirrors stock `hyper-plan`):

- `$ARGUMENTS` non-empty → that is the task.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/research/*.md` (its `task:` frontmatter), or the user's most recent build/implement intent in this conversation.
- Nothing found → ask the user and STOP.

### Step 1 — Resolve task + slug + plan path

Reuse the stock `hyper-plan` logic — see `skills/hyper-plan/SKILL.md` Steps 1–2; do not duplicate the rule text. In brief:

1. Derive the canonical slug deterministically (lowercase, ASCII, alphanumerics + hyphen, first 5 words of the task joined by `-`).
2. Scan **all** `.hyperclaude/research/*.md` frontmatter `slug:` fields (the canonical key — not the filename). If one equals the derived slug, treat it as the linked research artifact and inline its full contents as context in Step 3.
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
- **Research context** — full contents of the matched research artifact inline, if one was found in Step 1. Do not make the planner re-read it.
- **Output format** — a multi-task plan with `## Task N: <title>` headings. Each task block: **Files to create / modify** (exact paths), **Steps** (`[ ]`-checkboxes, 2–5 min each), **Verification** (a command or observable change), **Commit message** (one line, conventional-commits). No frontmatter — plan body only; the skill owns the file name.
- **Write-file mode** — the exact resolved plan path from Step 1, stated literally, with an explicit instruction: use the `Write` tool to write the full plan to THAT EXACT path yourself (never a different path, never a `-v2.md` sibling), then reply with exactly `WROTE: <that exact path>` and NOTHING else — no plan body, no summary of changes, no preamble.
- **Idle / no-resend discipline** — after replying `WROTE: <path>`, go idle and wait; do NOT resend, re-announce, or nag. The lead will next contact you only via SendMessage carrying revise findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- State that the planner stays alive as a teammate, will receive Codex feedback in later turns, and must retain its full planning context.

(Spawn-failure handling is in Step 2.)

### Step 4 — Confirm the planner wrote the plan

The lead no longer Writes the plan — the planner writes the canonical file itself (caller-directed write-file mode, Step 3). The lead only verifies.

**Anchored reply gate** — applies to EVERY planner reply in write-file mode (the initial write, any retry, and every Step 7 revise redo alike). Accept the reply only if, after trimming trailing whitespace, it matches exactly:

```
^WROTE: <the exact resolved plan path from Step 1>\s*$
```

The path must equal the resolved plan path verbatim. On any body echo, added prose, preamble, or a different path, send ONE corrective message:

```
SendMessage({
  to: "planner",
  summary: "Reply contract: WROTE: <path> only",
  message: "<re-state: use Write to write the full plan to the exact resolved path; reply with exactly 'WROTE: <that exact path>' and nothing else — no plan body, no prose, no preamble>"
})
```

If the next reply still fails the anchored gate → Step 8 teardown, then STOP (**"hyper-plan-loop reply-contract failure"**).

**File check (only after the gate passes):** confirm the file is non-empty via the Bash tool:

```bash
[ -s "<resolved plan path>" ]
```

If missing or empty, send ONE corrective `SendMessage` (with `summary`) instructing the planner to Write the exact resolved path again — its reply re-enters the same anchored gate above. If it is still missing or empty after that → Step 8 teardown, then STOP (**"hyper-plan-loop planner-write failure"**).

**In-place rule (now binds the planner):** every later revision overwrites THIS SAME path; never a `-v2.md` (or any other) sibling — the bridge's `--resume` keys on the plan path, and a new path breaks resume continuity.

### Step 4a — Lead-side unsolicited-message protocol

This is an operational backstop for the Step 3 idle/no-resend prompt instruction. Prompt-only discipline is **insufficient**; this lead-side rule is **mandatory**.

**Scope:** applies ONLY while the planner is active and BEFORE Step 8 teardown has begun. It EXEMPTS the teardown exchange — once the lead has sent `shutdown_request`, the planner's `shutdown_response` / idle-termination notification is EXPECTED, not unsolicited, and is never a violation.

Within scope, the only planner message the lead expects is the anchored `WROTE:` reply to the lead's most recent SendMessage (spawn, revise, or corrective). Any other inbound planner message — a duplicate body, a `RESEND:`-style re-emit, a nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. The lead ignores its content and sends ONE message:

```
SendMessage({
  to: "planner",
  summary: "Idle until contacted",
  message: "<remain idle; DO NOT reply to this message; do not resend; wait for revise findings or a shutdown_request>"
})
```

After that single idle correction, a short content-free acknowledgment (e.g. "ok, waiting") is tolerated and ignored ONCE — not a violation, as long as it carries no plan body, no `RESEND:`, and no nag. A SECOND substantive unsolicited message of the same kind (body / `RESEND:` / nag) → Step 8 teardown, then STOP (**"hyper-plan-loop reply-contract failure"**).

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

**Revise-validation pipeline** — the ordered sequence every revise reply must pass: (1) **anchored reply gate** (Step 4) → (2) **`cmp -s` no-op compare vs `.bak`** → (3) **structure `ok`/`bad` check**. EVERY corrective redo in this step — the no-op corrective AND the `bad`/malformed corrective — re-enters this FULL pipeline from step (1) in this exact order. A redo is never "just the gate" or a partial check. The retry budget is unchanged: exactly ONE corrective redo per failure kind, then STOP via Step 8 teardown — but that single redo must pass the full validation pipeline, not a partial check. Because `.bak` is only `rm`'d on the `ok` success path or after terminal teardown, it still exists on every redo path, so the `cmp -s` compare is valid for the redo too.

Apply the **anchored reply gate from Step 4** to the reply (initial corrective + escalation to **"hyper-plan-loop reply-contract failure"** via Step 8 teardown if it still fails).

**No-op-revise detection (after the gate passes, before the structure check):** confirm the planner actually changed the file — compare it to the pre-revise backup via the Bash tool:

```bash
cmp -s "<resolved plan path>" "<resolved plan path>.bak"
```

Exit 0 = byte-identical = the planner replied `WROTE:` but applied NO revision. On byte-identical, send ONE corrective `SendMessage({ to: "planner", summary: "Revision not applied — file unchanged", message: "<you replied WROTE: but the plan file is byte-identical to before; actually apply the Blocker/Major revisions and re-Write the exact resolved plan path; reply with exactly 'WROTE: <that exact path>' and nothing else>" })`. That corrective's reply re-enters the FULL revise-validation pipeline from step (1): anchored reply gate → `cmp -s` no-op compare vs `.bak` → structure `ok`/`bad` check. If the redo is STILL byte-identical at the `cmp -s` step → this is a planner-write failure: Step 8 teardown, then STOP (**"hyper-plan-loop no-op revise"**). The `.bak` equals the canonical file so no restore is needed; `rm "<resolved plan path>.bak"` AFTER teardown to avoid stale-backup clutter (consistent with the existing terminal-cleanup rule).

Only when the file genuinely differs from `.bak` do you proceed to the structure check below. A real change that is `bad`/malformed still follows the restore-from-`.bak` logic unchanged.

After the gate and no-op check pass, **quietly** validate structure without pulling the body into context — a one-liner that prints only `ok` or `bad`:

```bash
node -e 'try{process.stdout.write(/^##\s*Task\s/m.test(require("fs").readFileSync(process.argv[1],"utf8"))?"ok":"bad")}catch{process.stdout.write("bad")}' "<resolved plan path>"
```

The try/catch is load-bearing: any read failure (the planner deleted or clobbered the canonical path) prints `bad` instead of throwing — so a missing/unreadable file routes through the restore-from-`.bak` path below, not to teardown as an unexpected tool error that would leave the canonical file missing.

If `bad` (the planner clobbered the canonical path with malformed content, OR the file is missing/unreadable): restore via `cp "<resolved plan path>.bak" "<resolved plan path>"`, then send ONE corrective `SendMessage` (with `summary`) instructing the planner to redo the revision. That corrective's reply re-enters the FULL revise-validation pipeline from step (1): anchored reply gate → `cmp -s` no-op compare vs `.bak` → structure `ok`/`bad` check. If the redo is still `bad` at the structure step → `cp "<resolved plan path>.bak" "<resolved plan path>"` again, then Step 8 teardown, then STOP (**"hyper-plan-loop planner format, iter N"**) with the canonical path holding the restored last-valid plan. On that terminal STOP-after-restore path, `rm "<resolved plan path>.bak"` only AFTER the restore `cp` has succeeded — never before the restore is confirmed.

Only Read the full file into lead context for human-facing failure diagnostics — never on the success path. (Residual risk: a transient malformed file exists on disk until the immediate `cp` restore — acceptable, since the lead never proceeds to review on a `bad` file.)

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

If `TeamDelete` fails because a member is still live: send `shutdown_request` once more, then retry `TeamDelete` a single time. If it STILL fails, STOP with a named-loop report (**"hyper-plan-loop teardown"**) surfacing the verbatim `TeamDelete` error and the run's team name, stating the team may still be live. Do NOT instruct manual deletion of internal team state (`~/.claude/teams/<team-name>/` is internal — unsupported, and deleting it does not terminate a live teammate).

### Step 9 — Final report

After successful teardown, report:

- The plan path.
- Whether the slug was reused from a research artifact or freshly derived.
- Review iterations consumed.
- The final Codex verdict.
- Residual Minor findings (informational, non-blocking).
- Next step: `/hyperclaude:hyper-implement <plan path>`.

## Anti-patterns

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the planner fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Accepting an existing-plan-path argument. Not a v1 input mode — `$ARGUMENTS` is a task description only.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Reading the plan body into lead context each revise round. Use `cp` backup + the quiet `ok`/`bad` check — Read-caching the body reintroduces the token cost this skill removes.
- Accepting any non-`WROTE:` reply (body echo, prose, preamble, wrong path) as success. The anchored gate is exact-match only.
- Accepting a revise `WROTE:` whose file is byte-identical to the pre-revise `.bak` — the loop would re-review an unchanged plan until the cap; detect the no-op and treat it as a planner-write failure.
- Treating prompt-only idle discipline as sufficient. The lead-side unsolicited-message rule (Step 4a) is mandatory.
- Proceeding to Codex review on a `bad` (malformed) just-written file instead of `cp`-restoring the last-valid plan first.
- Writing the wrong base path. The resolved plan path is a Step 1 concept; Step 2 is team creation only — never derive the path from Step 2.
- Treating Minor findings as blocking. Only Blocker/Major gate the loop.
- Omitting `--plan-path` or `--resume auto` on iteration 2+. `--plan-path` is required every iteration; `--resume auto` from iteration 2 onward.
- Stopping silently at the cap. Always emit the named cap report (after teardown).
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the teammate is down. Shutdown first; `TeamDelete` fails while a member is live.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
