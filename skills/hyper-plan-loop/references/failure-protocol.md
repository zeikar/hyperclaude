# hyper-plan-loop — failure & recovery protocol

Operational backstops for `hyper-plan-loop`. SKILL.md carries the happy path and decision points; this file carries the recovery procedures invoked at those points. The lead Reads this file once at Step 0 so the full protocol is in context for the whole run. Follow each section exactly when its condition arises — these are load-bearing, not optional troubleshooting.

## §1 — Anchored reply gate: corrective + escalation

The anchored reply gate (SKILL.md Step 4) is the accept condition for EVERY planner reply in write-file mode (initial write, any retry, every Step 7 revise redo, every Step 7a cleanup reply and redo). The gate definition stays in SKILL.md; this section is the failure handling.

On any body echo, added prose, preamble, or a different path: set ALL THREE run-state fields — `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true` — BEFORE sending, and send ONE corrective message that carries the new id:

```
SendMessage({
  to: "planner",
  summary: "Reply contract: WROTE: <id> <path> only — request <id>",
  message: "<re-state: use Write to write the full plan to the exact resolved path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else — no plan body, no prose, no preamble; id is <new request_id_counter value>>"
})
```

If the next reply still fails the anchored gate → Step 8 teardown, then STOP (**"hyper-plan-loop reply-contract failure"**).

**File check failure (only reached after the gate passes):** if `[ -s "<resolved plan path>" ]` shows the file missing or empty, this is a fresh solicitation — set ALL THREE run-state fields — `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true` — BEFORE sending, and send ONE corrective message:

```
SendMessage({
  to: "planner",
  summary: "File not written — re-Write at exact path — request <id>",
  message: "<the file at <resolved plan path> is missing or empty; use Write to write the full plan to that exact path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else; id is <new request_id_counter value>>"
})
```

Its reply re-enters the anchored gate (§6 Phase 2, expecting the new `expected_request_id`). If it is still missing or empty after that → Step 8 teardown, then STOP (**"hyper-plan-loop planner-write failure"**).

## §2 — Lead-side unsolicited-message protocol

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

**Interplay with §6 (id-first classification).** §2's "did I solicit anything" heuristic is now a secondary check — the §6 two-phase state machine is the authoritative router:

- **While NOT awaiting (§6 Phase 1, `awaiting_planner_reply == false`):** a `WROTE:` with `reqid <= request_id_counter` is stale or duplicate — per §6 Phase 1, ignore its content SILENTLY (NO idle-correction for the `WROTE:` itself), NEVER re-accept. Separately, all genuinely unsolicited non-`WROTE:` traffic (nags, body echoes, `RESEND:`) in Phase 1 IS §2's domain — that, and only that, triggers the §2 idle-correction via Step 4a.
- **While AWAITING (§6 Phase 2, `awaiting_planner_reply == true`):** a `WROTE:` reply with `reqid < expected_request_id` is NOT an unsolicited message — it is §6 Phase 2's stale branch. Ignore its content and run §6's stale-recovery sub-step. Do NOT send the §2 idle-correction for it. This branch positively identifies the stale-reply race that the prior solicited/unsolicited heuristic could only guess at.

The id-based classification subsumes the former Step 7 / Step 7a stale-reply case that was previously papered over by §2's "did I solicit anything" guess — stale replies are now identified by id, not timing.

## §3 — Revise-validation redo pipeline (Step 7 failure handling)

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

**The ordered pipeline** every revise reply must pass (this order is named inline in SKILL.md Step 7): (1) **id-first parse** (§6 Phase 2 — parse `reqid`, classify against `expected_request_id`) → (2) **anchored reply gate** (§1, exact-path + no-prose check) → (3) **structure `ok`/`bad` check**. Note: id-first parse is the FIRST operation of the anchored reply gate (Step 4 / §6 Phase classification), so §3's three-step granular naming and SKILL.md Step 7's two-step naming ("(1) anchored reply gate (Step 4) → (2) structure check") describe the SAME pipeline. The `bad`/malformed corrective redo re-enters this FULL pipeline from step (1) in this exact order. A redo is never "just the gate", a partial check, or id-skipping. The retry budget: exactly ONE corrective redo, then STOP via Step 8 teardown — and that single redo must pass the full pipeline.

There is no no-op / unchanged-plan detection. A planner that replies `WROTE:` but applies no real revision is bounded by the Step 8 cap (the loop re-reviews and re-revises until convergence or the cap, then STOPs with the cap report) — this is intentionally not a separate failure path.

**Gate failure in Step 7:** apply §1 (initial corrective + escalation to **"hyper-plan-loop reply-contract failure"** via Step 8 teardown if it still fails).

**Structure check (step 2 of the pipeline):** the SKILL.md one-liner prints only `ok` or `bad`. The try/catch in it is load-bearing: any read failure (the planner deleted or clobbered the canonical path) prints `bad` instead of throwing — so a missing/unreadable file routes through the corrective path here, not to teardown as an unexpected tool error.

If `bad` (the planner clobbered the canonical path with malformed content, OR the file is missing/unreadable): set ALL THREE run-state fields — `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_planner_reply = true` — BEFORE sending, and send ONE corrective `SendMessage` (with `summary: "... request <id>"`) instructing the planner to redo the revision and re-Write the exact resolved plan path, passing the new id and requiring `WROTE: <that new id> <exact resolved path>`. That corrective's reply re-enters the FULL pipeline from step (1): id-first parse → anchored reply gate → structure `ok`/`bad` check — the gate now expects that NEWEST `expected_request_id`. If the redo is still `bad` at the structure step → Step 8 teardown, then STOP (**"hyper-plan-loop planner format, iter N"**), surfacing the resolved plan path for manual triage. The loop does NOT auto-restore — the plan file is left as the planner last wrote it; `/hyperclaude:hyper-plan` regenerates it in one step. Only Read the full file into lead context for that human-facing failure diagnostic — never on the success path.

On `ok`: return to the **caller's** success continuation, not unconditionally Step 7's. **Step 7** increments the iteration, re-invokes the bridge with `--resume auto`, then loops back to Step 6 (the normal Blocker/Major loop). **Step 7a** instead returns to its own Step 7a.2 (exactly one re-review) then Step 7a.3–7a.4 hard-stop — it NEVER enters Step 6 or the Step 7 loop. The §3 redo pipeline is shared; its success exit is caller-scoped.

Step 7a has exactly one planner round, which invokes this same redo pipeline (anchored gate → structure check → single redo) — no separate pipeline, no duplicated rules.

## §4 — Teardown recovery (Step 8 `TeamDelete` failure)

If `TeamDelete` fails because a member is still live: send `shutdown_request` once more, then retry `TeamDelete` a single time. If it STILL fails, STOP with a named-loop report (**"hyper-plan-loop teardown"**) surfacing the verbatim `TeamDelete` error and the run's team name, stating the team may still be live. Do NOT instruct manual deletion of internal team state (`~/.claude/teams/<team-name>/` is internal — unsupported, and deleting it does not terminate a live teammate).

## §5 — Anti-patterns (full list)

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the planner fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Accepting an existing-plan-path argument. Not a v1 input mode — `$ARGUMENTS` is a task description only.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Reading the plan body into lead context each revise round. Use the quiet `ok`/`bad` check — Read-caching the body reintroduces the token cost this skill removes.
- Accepting any non-`WROTE:` reply (body echo, prose, preamble, wrong path) as success. The anchored gate is exact-match only.
- Treating prompt-only idle discipline as sufficient. The lead-side unsolicited-message rule (§2) is mandatory.
- Proceeding to Codex review on a `bad` (malformed) just-written file instead of running the §3 corrective + terminal STOP first.
- Writing the wrong base path. The resolved plan path is a Step 1 concept; Step 2 is team creation only — never derive the path from Step 2.
- Treating an actionable Minor as a recursive revise target. Under Step 6 branch (c) an actionable Minor triggers the one-shot Step 7a cleanup **exactly once** (then hard-stop); recursing on Minor — re-entering revise after the 7a re-review, or looping 7a back to Step 6/7 — is forbidden.
- Omitting `--plan-path` or `--resume auto` on iteration 2+. `--plan-path` is required every iteration; `--resume auto` from iteration 2 onward.
- Stopping silently at the cap. Always emit the named cap report (after teardown).
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the teammate is down. Shutdown first; `TeamDelete` fails while a member is live.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
- Reusing a `request_id` across distinct solicitations — including reusing the same id for either §1 corrective (anchored-gate or file-check) and for the §3 redo corrective. Each is a fresh solicitation; sharing an id reintroduces the stale-reply blind spot the counter is designed to eliminate.
- Checking the exact-path regex before classifying the `reqid`, OR accepting a reply whose `reqid != expected_request_id` as genuine. `reqid < expected_request_id` means stale → ignore content + §6 stale-recovery; `reqid > expected_request_id` is impossible (lead is sole id source) → teardown + STOP. Id classification MUST precede all content checks.
- Comparing `reqid` against `expected_request_id` while `awaiting_planner_reply == false` (§6 Phase 1) — `expected_request_id` is `null` then; the Phase 1 branch routes by `request_id_counter` only. Collapsing Phase 1 and Phase 2 into a single comparison reintroduces the duplicate-during-Codex-review mis-attribution.
- Inlining the §6 pseudo-code / state-machine body into SKILL.md instead of keeping SKILL.md a summary + pointer. SKILL.md is the always-loaded surface; duplicating §6 there bloats every trigger and risks the two copies drifting out of sync.

## §6 — Request-id state machine

This section is the single source of truth for the request-id algorithm. SKILL.md Step 4 and SKILL.md's request-id bookkeeping paragraph in the "Agent-teams tool contract" / "Plan ownership" notes are summaries that MUST point here and MUST NOT restate the pseudo-code — this keeps the always-loaded SKILL.md lean and prevents the two copies drifting.

The id is the new disambiguator for a stale vs. genuine `WROTE:` reply; it is NOT a new path. The in-place same-path overwrite rule is unchanged — the planner still Writes the one resolved plan path, and `--resume` still keys on it.

**`expected_request_id` lifecycle.** Two named stages bracket every awaited reply:

- **MESSAGE ACCEPTED** — the reply whose `reqid == expected_request_id` passed id classification and the exact accept regex with no extra prose: i.e. none of the reject conditions enumerated in the pseudo-code's `reqid == expected_request_id` branch fired (body echo / added prose / preamble / different path). At this moment, and HERE only, set `expected_request_id = null` and `awaiting_planner_reply = false`. This is the moment the duplicate-during-Codex-review window opens (a byte-identical re-emit may arrive while the long Codex-review turn runs); Phase 1 below handles that window.
- **PLAN VALIDATION ACCEPTED** — the subsequent file/structure check passed, so the reply is fully usable and the loop proceeds. A structure-check `bad` reached AFTER MESSAGE ACCEPTED does not re-open the same id: it routes through the §3 redo pipeline, which mints a FRESH id and re-enters Phase 2 awaiting that fresh id.

Two-phase classification (verbatim):

```
parse leading "WROTE: <int>" from trimmed reply  → reqid  (may be absent)

# PHASE 1 — not awaiting any reply (expected_request_id is null)
if awaiting_planner_reply == false:
    if reqid is absent (no/garbled "WROTE:" token) or any non-WROTE: wake:
        → unsolicited: route via Step 4a / §2 (do NOT compare to expected_request_id)
    elif reqid <= request_id_counter:
        → stale or duplicate (incl. byte-identical dup of an already-accepted reply):
          ignore SILENTLY; NEVER re-accept (no §2 idle-correction for the stale WROTE itself — only genuinely-unsolicited non-WROTE traffic goes to Step 4a/§2)
    else:  # reqid > request_id_counter
        → impossible (lead is sole id source) → protocol violation
          → Step 8 teardown then STOP ("hyper-plan-loop reply-contract failure")

# PHASE 2 — awaiting a reply (awaiting_planner_reply == true; expected_request_id is set)
else:
    if reqid is absent (no/garbled "WROTE:" token):
        → reply-contract failure for the current expected_request_id:
          §1 corrective + escalation
    elif reqid < expected_request_id:
        → stale leftover from a prior round: ignore content regardless of payload;
          do NOT count it as the reply; do NOT run the §1 corrective for it;
          apply the stale-recovery sub-step below
    elif reqid == expected_request_id:
        → candidate genuine reply: enforce the exact accept regex
          ^WROTE: <expected id> <exact resolved plan path from Step 1>\s*$
          (path = entire remaining string, verbatim) and the no-prose rule.
          On body echo / added prose / preamble / different path → §1 corrective + escalation.
          On pass → MESSAGE ACCEPTED: immediately set
            expected_request_id = null, awaiting_planner_reply = false
          then run the file/structure check (= PLAN VALIDATION ACCEPTED stage)
    else:  # reqid > expected_request_id
        → impossible (lead is sole id source) → protocol violation
          → Step 8 teardown then STOP ("hyper-plan-loop reply-contract failure")
```

**Stale-recovery sub-step.** After ignoring a stale-id reply (the `reqid < expected_request_id` branch above) the lead is still waiting on `expected_request_id`. On the next wake the lead routes via exactly one of:

- (i) a reply whose `reqid == expected_request_id` → handled by the expected branch (candidate genuine reply);
- (ii) another stale-id reply → ignore again, stay waiting;
- (iii) a payload-less idle notification OR any non-matching / no-`WROTE:` wake while still waiting → run the existing empty-idle / reply-contract corrective round-trip, which itself mints a FRESH id (per §1/§3) and sets `expected_request_id` to that fresh id; the planner's reply to that corrective is then matched against the fresh id.

Do NOT promise progress in the absence of a wake: there is no poll/wait primitive — the lead only acts when a turn is delivered, and on that turn it routes via either the matching `expected_request_id` reply or a fresh-id corrective round-trip.
