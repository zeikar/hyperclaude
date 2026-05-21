# Loop protocol — shared reference

This file is the shared cross-loop protocol reference, loaded at Step 0 by `hyper-plan-loop`; other loop skills bind to it as they're updated. Each consuming loop's local `failure-protocol.md` is the binding layer that names the teammate role, the reply-token shape, the anchored-reply acceptance rule, and the post-MESSAGE-ACCEPTED validation stage. Consult the loop's local `failure-protocol.md` for those values.

## §A — Agent-teams tool contract

Every loop binding this protocol uses the experimental agent-teams tools. The per-run team name is passed **only** to `TeamCreate` and `Agent` — it is **never** a tool argument to `SendMessage` or `TeamDelete`.

- `TeamCreate` — `{ team_name, description? }`. Creates the team and its task list.
- `Agent` (spawn teammate) — `subagent_type`, plus `team_name` (the SAME run-unique literal from `TeamCreate`) and `name` to make the agent a teammate addressable by `name`.
- `SendMessage` — `{ to: <teammate name, e.g. "<teammate-name>">, message: <string | {type:"shutdown_request"}>, summary? }`. No `team_name` field. `summary` is REQUIRED whenever `message` is a string; the shutdown object message takes no `summary`. Plain-text output is NOT visible to teammates; messaging requires this tool.
- `TeamDelete` — `{}` (no args; team inferred from session). Fails if the team still has a live member, so shut members down first.
- A teammate's `shutdown_response` or idle-termination notification is auto-delivered as a new turn — there is no poll/wait tool. **But the idle notification is a payload-less wake signal (`{type:"idle_notification",...}`) — it does NOT carry the teammate's reply text.** The loop-bound reply confirmation arrives ONLY if the teammate explicitly `SendMessage`s it to the lead; a teammate that prints the reply as plain text and idles delivers an empty notification and the lead must fall back to the corrective round-trip. Idle teammates keep their process + context alive between turns; a later SendMessage wakes them with context intact — this is the property each loop depends on.

Per-loop deliverable rules (what the teammate writes / replies, how the lead verifies) live in each loop's local `failure-protocol.md` binding declarations.

## §B — Unsolicited-message protocol skeleton

This is an operational backstop for the loop's spawn-prompt idle/no-resend instruction. Prompt-only discipline is **insufficient**; this lead-side rule is **mandatory**.

**Scope:** applies ONLY while the teammate is active and BEFORE Step 8 teardown has begun. It EXEMPTS the teardown exchange — once the lead has sent `shutdown_request`, the teammate's `shutdown_response` / idle-termination notification is EXPECTED, not unsolicited, and is never a violation.

Within scope, the only teammate message the lead expects is the loop-bound anchored reply (see the loop's local failure-protocol.md for the exact reply-token shape and acceptance rule) to the lead's most recent SendMessage (spawn, revise, or corrective). Any other inbound teammate message — a duplicate body, a `RESEND:`-style re-emit, a nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. The lead ignores its content and sends ONE message:

```
SendMessage({
  to: "<teammate-name>",
  summary: "Idle until contacted",
  message: "<remain idle; DO NOT reply to this message; do not resend; wait for further findings or a shutdown_request>"
})
```

After that single idle correction, a short content-free acknowledgment (e.g. "ok, waiting") is tolerated and ignored ONCE — not a violation, as long as it carries no reply body, no `RESEND:`, and no nag. A SECOND substantive unsolicited message of the same kind (body / `RESEND:` / nag) → Step 8 teardown, then STOP (**"<loop-name> reply-contract failure"**).

**Interplay with §E (id-first classification).** §B's "did I solicit anything" heuristic is now a secondary check — the §E two-phase state machine is the authoritative router:

- **While NOT awaiting (§E Phase 1, `awaiting_reply == false`):** the loop-bound reply-token-with-id with `reqid <= request_id_counter` is stale or duplicate — per §E Phase 1, ignore its content SILENTLY (NO idle-correction for the loop-bound reply-token-with-id itself), NEVER re-accept. Separately, all genuinely unsolicited non-(loop-bound reply-token) traffic (nags, body echoes, `RESEND:`) in Phase 1 IS §B's domain — that, and only that, triggers the §B idle-correction.
- **While AWAITING (§E Phase 2, `awaiting_reply == true`):** the loop-bound reply-token-with-id reply with `reqid < expected_request_id` is NOT an unsolicited message — it is §E Phase 2's stale branch. Ignore its content and run §E's stale-recovery sub-step. Do NOT send the §B idle-correction for it. This branch positively identifies the stale-reply race that the prior solicited/unsolicited heuristic could only guess at. A payload-less `idle_notification` whose `idle.timestamp < solicit_sent_at` is similarly NOT an unsolicited message — it is §E Phase 2's stale-idle branch (ignore silently, stay awaiting); only an idle with `idle.timestamp >= solicit_sent_at` is a true post-solicit silence and routes through the loop's local §1.

The id-based classification subsumes the former stale-reply case that was previously papered over by §B's "did I solicit anything" guess, and the timestamp-based idle guard subsumes the stale-idle case that triggered the dogfooded 1-round-lag race — both are now identified by lead-owned state, not timing heuristics.

## §C — Teardown 3-step procedure

**Teardown is MANDATORY on EVERY exit path once the loop's teammate-spawn step has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure (anchored gate / unsolicited-message protocol), teammate-write failure, teammate-format failure, plus any other unexpected tool error while the teammate is live. Run teardown FIRST, then report/STOP — never before.

Exact procedure:

1. `SendMessage({ to: "<teammate-name>", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The teammate's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.
3. `TeamDelete({})`.

**Recovery — `TeamDelete` failure (Step 8 in the loop's SKILL.md).** If `TeamDelete` fails because a member is still live: send `shutdown_request` once more, then retry `TeamDelete` a single time. If it STILL fails, STOP with a named-loop report (**"<loop-name> teardown"**) surfacing the verbatim `TeamDelete` error and the run's team name, stating the team may still be live. Do NOT instruct manual deletion of internal team state (`~/.claude/teams/<team-name>/` is internal — unsupported, and deleting it does not terminate a live teammate).

## §D — Shared anti-patterns

**Eight** cross-loop anti-patterns. Loop-specific anti-patterns (file-write specifics, diff-target specifics, etc.) stay in each loop's local §5.

1. **Making the reviewer a team agent.** The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
2. **Re-spawning the teammate fresh each iteration.** Context-reuse via the live teammate is the entire reason every loop in this family exists.
3. **Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the teammate is down.** Shutdown first; `TeamDelete` fails while a member is live.
4. **Reusing a `request_id` across distinct solicitations** — including reusing the same id for any local §1 corrective (anchored-gate or post-acceptance-validation corrective) and for the local §3 redo corrective. Each is a fresh solicitation; sharing an id reintroduces the stale-reply blind spot the counter is designed to eliminate.
5. **Checking the loop's accept rule before classifying the `reqid`, OR accepting a reply whose `reqid != expected_request_id` as genuine.** `reqid < expected_request_id` means stale → ignore content + §E stale-recovery; `reqid > expected_request_id` is impossible (lead is sole id source) → teardown + STOP. Id classification MUST precede all content checks.
6. **Comparing `reqid` against `expected_request_id` while `awaiting_reply == false` (§E Phase 1)** — `expected_request_id` is `null` then; the Phase 1 branch routes by `request_id_counter` only. Collapsing Phase 1 and Phase 2 into a single comparison reintroduces the duplicate-during-Codex-review mis-attribution.
7. **Treating a payload-less `idle_notification` as a contract failure without comparing `idle.timestamp` to `solicit_sent_at`.** An idle queued from a PRIOR round can land between the current solicitation's send and the teammate's reply — typically because the lead's previous turn ran Codex review for minutes and the teammate's post-reply idle from that prior round was held until the next turn delivery. Minting a fresh-id corrective for such a stale idle kicks off a perpetual 1-round-lag race; the §E Phase 2 stale-idle guard exists to plug exactly this dogfooded failure mode.
8. **Inlining the §E pseudo-code / state-machine body into a SKILL.md** instead of keeping SKILL.md a summary + pointer. SKILL.md is the always-loaded surface; duplicating §E there bloats every trigger and risks the two copies drifting out of sync.

## §E — Abstract request-id state machine

This section is the single source of truth for the request-id state machine and the run-state fields used by every loop binding this protocol. Each loop's SKILL.md "Agent-teams tool contract" section is a summary that MUST point here and MUST NOT restate the pseudo-code — this keeps each always-loaded SKILL.md lean and prevents the two copies drifting.

The id is the disambiguator for a stale vs. genuine reply; it is NOT a new path or a new artifact. Each loop's local `failure-protocol.md` declares the loop-bound reply-token shape and the post-MESSAGE-ACCEPTED validation stage.

**Run-state fields (single source of truth — every binding loop uses these names).** The lead must retain the following run-state across turns and never conflate these fields:

- `request_id_counter` — the last id minted (initialized to `0`; incremented on every solicitation as below).
- `expected_request_id` — the id of the outstanding solicitation the lead is currently waiting on; `null` when the lead is not awaiting any reply (e.g. while running Codex review).
- `awaiting_reply` — boolean: `true` ONLY between minting a solicitation and accepting its reply.
- `solicit_sent_at` — UTC wall-clock timestamp captured by the lead IMMEDIATELY BEFORE invoking the SendMessage carrying the current outstanding solicitation: run `date -u +%FT%TZ` (via the Bash tool) as the LAST tool call before that SendMessage and store its output verbatim. The assistant-turn start timestamp is NOT a valid substitute — a long turn can elapse minutes (typically a Codex review) between turn-start and the next SendMessage, during which a payload-less idle could be emitted with `idle.timestamp > assistant-turn-start` but still `< actual-SendMessage time`, leaving the guard mis-comparing and the stale-idle race unplugged. `null` when not awaiting. Used by Phase 2 below to distinguish a stale prior-round idle (`idle.timestamp < solicit_sent_at`) from a true post-solicit silence — the dogfooded failure mode this field was added to plug.
- `review_iteration` — bridge re-invocation count, independent of the id counter.

The request-id counter and `review_iteration` are SEPARATE counters: the id bumps on every solicitation including correctives; the iteration only on bridge re-invocation.

Each loop carries additional loop-LOCAL run state (e.g. `team_name`, plus any loop-specific path or artifact id like `plan_path` for plan-loop). Those stay defined in the loop's SKILL.md.

On minting any solicitation: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_reply = true`, and immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (the field-definition rule above is binding — assistant-turn start is NOT valid).

**`expected_request_id` lifecycle.** Two named stages bracket every awaited reply:

- **MESSAGE ACCEPTED** — the reply whose `reqid == expected_request_id` passed id classification and the loop-bound accept rule with no extra prose: i.e. none of the reject conditions enumerated in the pseudo-code's `reqid == expected_request_id` branch fired (body echo / added prose / preamble / different payload). At this moment, and HERE only, set `expected_request_id = null`, `awaiting_reply = false`, and `solicit_sent_at = null`. This is the moment the duplicate-during-Codex-review window opens (a byte-identical re-emit may arrive while the long Codex-review turn runs); Phase 1 below handles that window.
- **POST-ACCEPTANCE VALIDATION ACCEPTED** — the subsequent post-acceptance validation stage (defined in the loop's local failure-protocol.md) passed, so the reply is fully usable and the loop proceeds. A post-acceptance validation `bad` reached AFTER MESSAGE ACCEPTED does not re-open the same id: it routes through the §3 redo pipeline, which mints a FRESH id and re-enters Phase 2 awaiting that fresh id.

Two-phase classification (verbatim):

```
parse leading <loop-bound reply-token-with-id> from trimmed reply  → reqid  (may be absent)

# PHASE 1 — not awaiting any reply (expected_request_id is null)
if awaiting_reply == false:
    if reqid is absent (no/garbled <loop-bound reply-token> token) or any non-<loop-bound reply-token> wake:
        → unsolicited: route via the loop's Step 4a-equivalent / §B (do NOT compare to expected_request_id)
    elif reqid <= request_id_counter:
        → stale or duplicate (incl. byte-identical dup of an already-accepted reply):
          ignore SILENTLY; NEVER re-accept (no §B idle-correction for the stale <loop-bound reply-token-with-id> itself — only genuinely-unsolicited non-<loop-bound reply-token> traffic goes to the loop's Step 4a-equivalent/§B)
    else:  # reqid > request_id_counter
        → impossible (lead is sole id source) → protocol violation
          → the loop's teardown step (see §C) then STOP ("<loop-name> reply-contract failure")

# PHASE 2 — awaiting a reply (awaiting_reply == true; expected_request_id is set)
else:
    if reqid is absent (no/garbled <loop-bound reply-token-with-id> token):
        # Stale-idle guard. A payload-less idle_notification carries the
        # teammate's idle-event timestamp, NOT the lead-receipt time; a long
        # lead turn (typically Codex review) can queue an idle from the PRIOR
        # round so it lands AFTER the current solicit was sent. Such an idle
        # cannot possibly be a response to the current solicit — minting a
        # fresh-id corrective for it triggers the perpetual 1-round-lag race
        # this guard exists to prevent. Compare timestamps to tell the cases
        # apart; "true post-solicit silence" is the only case that warrants
        # the corrective.
        if wake is a payload-less idle_notification
           AND idle.timestamp < solicit_sent_at:
            → stale prior-round idle: ignore SILENTLY, stay awaiting
              expected_request_id (do NOT mint a corrective; the current
              solicit may still be unread by the teammate)
        else:
            → reply-contract failure for the current expected_request_id:
              §1 corrective + escalation
    elif reqid < expected_request_id:
        → stale leftover from a prior round: ignore content regardless of payload;
          do NOT count it as the reply; do NOT run the §1 corrective for it;
          apply the stale-recovery sub-step below
    elif reqid == expected_request_id:
        → candidate genuine reply: enforce <the loop-bound accept rule defined in the loop's local failure-protocol.md>
          (the accept rule's full content-shape check, defined in the loop's local file).
          On any accept-rule failure → §1 corrective + escalation (per the loop's local file).
          On pass → MESSAGE ACCEPTED: immediately set
            expected_request_id = null, awaiting_reply = false,
            solicit_sent_at = null
          then run the loop-bound post-acceptance validation stage (= POST-ACCEPTANCE VALIDATION ACCEPTED stage)
    else:  # reqid > expected_request_id
        → impossible (lead is sole id source) → protocol violation
          → the loop's teardown step (see §C) then STOP ("<loop-name> reply-contract failure")
```

**Stale-recovery sub-step.** After ignoring a stale-id reply (the `reqid < expected_request_id` branch above) the lead is still waiting on `expected_request_id`. On the next wake the lead routes via exactly one of:

- (i) a reply whose `reqid == expected_request_id` → handled by the expected branch (candidate genuine reply);
- (ii) another stale-id reply → ignore again, stay waiting;
- (iii) a payload-less idle notification with `idle.timestamp >= solicit_sent_at` (the Phase 2 stale-idle guard above already ignored any idle with `idle.timestamp < solicit_sent_at`, so those never enter this branch) OR any non-matching / no-loop-bound reply-token-with-id wake while still waiting → run the existing empty-idle / reply-contract corrective round-trip, which itself mints a FRESH id (per §1/§3), sets `expected_request_id` to that fresh id, and records a fresh `solicit_sent_at`; the teammate's reply to that corrective is then matched against the fresh id.

Do NOT promise progress in the absence of a wake: there is no poll/wait primitive — the lead only acts when a turn is delivered, and on that turn it routes via either the matching `expected_request_id` reply or a fresh-id corrective round-trip.
