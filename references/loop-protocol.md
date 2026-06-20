# Loop protocol — shared reference

This file is the shared cross-loop protocol reference, loaded at Step 0 by `hyper-plan-loop`, `hyper-implement-loop`, and `hyper-docs-loop`. Each consuming loop's local `failure-protocol.md` is the binding layer that names the teammate role, the reply-token shape, the anchored-reply acceptance rule, and the post-MESSAGE-ACCEPTED validation stage. Consult the loop's local `failure-protocol.md` for those values.

## §A — Agent-teams tool contract

Every loop binding this protocol uses the experimental agent-teams feature. The session team auto-forms on the first `Agent` teammate spawn — no setup step is required. As of v2.1.178, the `Agent` tool's team-name field is accepted-but-ignored / deprecated; omit it rather than passing it.

- `Agent` (spawn teammate) — `subagent_type` and `name` to make the agent a teammate addressable by `name`. The first spawn forms the session team. At spawn, capture the returned `agent_id` VERBATIM/OPAQUELY into run-state `teammate_id` — never parse the `@`/suffix; the format is not a documented contract.
- `SendMessage` — `{ to: <teammate name, e.g. "<teammate-name>">, message: <string | {type:"shutdown_request"}>, summary? }`. `summary` is REQUIRED whenever `message` is a string; the shutdown object message takes no `summary`. Plain-text output is NOT visible to teammates; messaging requires this tool. **`to:` resolution for lead→teammate messages:** every lead→teammate `SendMessage` (findings/revise, corrective, AND `shutdown_request`) is addressed via the **§A send-resolution procedure** below. Teammate→lead replies address the lead by its team-lead role name — that direction is unchanged and is never rewritten by this protocol.

**§A send-resolution procedure (every lead→teammate send invokes this).** The `<teammate-name>` placeholder in §B/§C is an abstract alias for the teammate; this procedure decides the concrete `to:` handle. It has TWO RESPONSIBILITIES, NOT two sequential stages — for an id-bearing send the id is minted FIRST (R2 below), then R1 delivers the already-built message.

- **(R1) HANDLE RESOLUTION — applies to ALL sends, including the teardown `shutdown_request`.**
  - **If `resolved_handle` is SET** → send `to: resolved_handle` directly (single attempt, no fallback double-try).
  - **If `resolved_handle` is UNSET** (no successful lead→teammate send yet this run) → this is the FIRST-SEND: (1) try `to: teammate_name` (bare name, the PRIMARY handle); (2) if that send FAILS — the tool call itself errors/rejects; do NOT pattern-match the error text — retry the SAME message exactly ONCE with `to: teammate_id`; (3) cache the handle that succeeded into `resolved_handle` for all later sends; (4) if BOTH fail → ENV-DEGRADE STOP-with-diagnostic (see "ENV-DEGRADE detection + STOP" below).
- **(R2) REQUEST-ID / `solicit_sent_at` state — ID-BEARING solicitations ONLY (revise / findings / corrective).** The teardown `shutdown_request` is EXEMPT (no id, no `solicit_sent_at`, per §E) — it runs ONLY R1.
- **Operational order for an id-bearing send (explicit, to avoid the "resolve-then-mint" misread):** (1) mint the id + build the message payload FIRST (the §E mint protocol: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_reply = true`, and capture `solicit_sent_at` per §E); (2) run R1 handle-resolution to DELIVER that already-built message; (3) **(m6)** if the delivered attempt was the `teammate_id` fallback (the bare-name primary failed), KEEP the same request id and message payload but RECAPTURE `solicit_sent_at` (Bash `date -u +%FT%TZ`) immediately BEFORE that actually-delivered fallback `SendMessage` — §E's "capture immediately before the delivered SendMessage" invariant binds to the send that actually went out. This recapture is R2 and applies only to id-bearing solicitations; teardown never touches `solicit_sent_at`.
- **Which sends can be the first send:** the first send is NOT always a findings/revise round. On a clean run with no blocking findings the FIRST lead→teammate send is the **teardown `shutdown_request`** (§C — R1 only, id-exempt); in plan-loop a malformed initial reply-token makes the **initial §1 corrective** the first lead→planner send (id-bearing — R1 + R2). Both invoke R1's same handle resolution.
- **Rationale.** Bare-name-primary tracks the live-mailbox (terminal CLI) host as forward-correct; the `agent_id` fallback covers VSCode-degraded hosts and becomes a cleanly-removable dead path once they converge to live-mailbox parity.

**ENV-DEGRADE detection + STOP.** Degrade = missing OR unusable `agent_id`: (1) the spawn result has no `agent_id`; OR (2) the teammate reports `SendMessage` unavailable (replies via task-completion notification instead of mailbox); OR (3) the FIRST lead→teammate `SendMessage` fails on BOTH `teammate_name` AND the `teammate_id` fallback (R1 exhausted both). ANY of these is a documented STOP/fallback — the loop does NOT proceed in a notification-reply mode (doing so would require migrating the §E + anchored-gate + `to:"team-lead"` reply pipeline, which is out of scope). The per-loop STOP-and-preserve behavior (what state to surface, whether to preserve work done so far) is bound in each loop's spawn step; refer to the per-loop asymmetry in each loop's SKILL.md. **Degrade-path teardown:** on degrade, teardown follows §C's degrade-path exception (STOP without teardown when no addressable teammate exists; best-effort no-wait shutdown then STOP when a usable `teammate_id` routes).
- A teammate's `shutdown_response` or idle-termination notification is auto-delivered as a new turn — there is no poll/wait tool. **But the idle notification is a payload-less wake signal (`{type:"idle_notification",...}`) — it does NOT carry the teammate's reply text.** The loop-bound reply confirmation arrives ONLY if the teammate explicitly `SendMessage`s it to the lead; a teammate that prints the reply as plain text and idles delivers an empty notification and the lead must fall back to the corrective round-trip. Idle teammates keep their process + context alive between turns; a later SendMessage wakes them with context intact — this is the property each loop depends on.

Per-loop deliverable rules (what the teammate writes / replies, how the lead verifies) live in each loop's local `failure-protocol.md` binding declarations.

## §B — Unsolicited-message protocol skeleton

This is an operational backstop for the loop's spawn-prompt idle/no-resend instruction. Prompt-only discipline is **insufficient**; this lead-side rule is **mandatory**.

**Scope:** applies ONLY while the teammate is active and BEFORE Step 8 teardown has begun. It EXEMPTS the teardown exchange — once the lead has sent `shutdown_request`, the teammate's `shutdown_response` / idle-termination notification is EXPECTED, not unsolicited, and is never a violation.

Within scope, the only teammate message the lead expects is the loop-bound anchored reply (see the loop's local failure-protocol.md for the exact reply-token shape and acceptance rule) to the lead's most recent SendMessage (spawn, revise, or corrective). Any other inbound teammate message — a duplicate body, a `RESEND:`-style re-emit, a nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. The lead ignores its content and sends ONE message:

```
SendMessage({
  to: "<teammate-name>",   // addressed via the §A send-resolution procedure (R1)
  summary: "Idle until contacted",
  message: "<remain idle; DO NOT reply to this message; do not resend; wait for further findings or a shutdown_request>"
})
```

After that single idle correction, a short content-free acknowledgment (e.g. "ok, waiting") is tolerated and ignored ONCE — not a violation, as long as it carries no reply body, no `RESEND:`, and no nag. A SECOND substantive unsolicited message of the same kind (body / `RESEND:` / nag) → Step 8 teardown, then STOP (**"<loop-name> reply-contract failure"**).

**Interplay with §E (id-first classification).** §B's "did I solicit anything" heuristic is now a secondary check — the §E two-phase state machine is the authoritative router:

- **While NOT awaiting (§E Phase 1, `awaiting_reply == false`):** the loop-bound reply-token-with-id with `reqid <= request_id_counter` is stale or duplicate — per §E Phase 1, ignore its content SILENTLY (NO idle-correction for the loop-bound reply-token-with-id itself), NEVER re-accept. Separately, all genuinely unsolicited non-(loop-bound reply-token) traffic (nags, body echoes, `RESEND:`) in Phase 1 IS §B's domain — that, and only that, triggers the §B idle-correction.
- **While AWAITING (§E Phase 2, `awaiting_reply == true`):** the loop-bound reply-token-with-id reply with `reqid < expected_request_id` is NOT an unsolicited message — it is §E Phase 2's stale branch. Ignore its content and run §E's stale-recovery sub-step. Do NOT send the §B idle-correction for it. This branch positively identifies the stale-reply race that the prior solicited/unsolicited heuristic could only guess at. A payload-less `idle_notification` whose `idle.timestamp < solicit_sent_at` is similarly NOT an unsolicited message — it is §E Phase 2's stale-idle branch (ignore silently, stay awaiting); only an idle with `idle.timestamp >= solicit_sent_at` is a true post-solicit silence and routes through the loop's local §1.

The id-based classification subsumes the former stale-reply case that was previously papered over by §B's "did I solicit anything" guess, and the timestamp-based idle guard subsumes the stale-idle case that triggered the dogfooded 1-round-lag race — both are now identified by lead-owned state, not timing heuristics.

## §C — Teardown 2-step procedure

**Teardown is MANDATORY on EVERY exit path once the loop's teammate-spawn step has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure (anchored gate / unsolicited-message protocol), teammate-write failure, teammate-format failure, plus any other unexpected tool error while the teammate is live. Run teardown FIRST, then report/STOP — never before. **This rule is SUBORDINATE to "only when an addressable teammate exists":** if there is no usable handle (§A R1 already exhausted both `teammate_name` and `teammate_id`, per the §A ENV-DEGRADE rule), STOP WITHOUT teardown — there is no addressable teammate to shut down.

Exact procedure:

1. Send the `shutdown_request` via the **§A send-resolution procedure** (R1 handle resolution only — teardown is id-exempt, R2 is skipped). On a clean run this teardown IS the first send, so R1 runs the bare-name→`teammate_id` fallback rather than a hardcoded `to: resolved_handle`. Pin the shape: `message` MUST be the OBJECT `{ type: "shutdown_request" }` — a STRING message is rejected ("summary is required when message is a string"); the object form takes NO `summary`. **Cross-note:** the shutdown routes via the §A procedure's R1 like any send. Sending it to an at-rest teammate requires the no-wait teardown in step 2 below; no-wait teardown is NOT a premise of §A addressing for normal findings/revise/corrective sends, which deliver via mailbox `SendMessage` through the same R1.
2. Send `shutdown_request` best-effort ONCE, then treat the teammate as effectively terminated and proceed to report/STOP WITHOUT waiting for any confirmation (idle-termination notification or `shutdown_response`). **"No-wait" governs ONLY** (a) not waiting for shutdown confirmation and (b) not retrying the shutdown after a SUCCESSFUL send — it does NOT skip the §A R1 first-send handle resolution (bare-name→`teammate_id` fallback), which still runs when this teardown is the first send. A `shutdown_request` object message does NOT wake an at-rest teammate (e.g. the fixer/documenter idle since Step 4) — confirmation is impossible in that state; a still-live teammate may confirm as a harmless bonus, never depended on. There is no retry after a successful send.

The teammate may remain live until session-exit auto-cleanup; any later stray messages are ignored by the already-completed loop (this applies to teardown after protocol failures / unexpected errors, not just clean exit).

## §D — Shared anti-patterns

**Eight** cross-loop anti-patterns. Loop-specific anti-patterns (file-write specifics, diff-target specifics, etc.) stay in each loop's local §5.

1. **Making the reviewer a team agent.** The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
2. **Re-spawning the teammate fresh each iteration.** Context-reuse via the live teammate is the entire reason every loop in this family exists.
3. **Skipping `shutdown_request` before exit.** Shutdown first; the session team is cleaned up automatically on exit, but the teammate must be sent a `shutdown_request` before the loop ends WHEN an addressable handle exists (§A R1 can still reach the teammate) (see §A ENV-DEGRADE and §C's degrade-path exception, where teardown is skipped because there is no addressable teammate). **Corollary — do NOT hardcode `to: resolved_handle` on a path that can be the first send** (clean teardown, plan-loop initial corrective): `resolved_handle` is `null` there, so route via the §A procedure's R1 (bare-name→`teammate_id` fallback), never a bare `to: resolved_handle`.
4. **Reusing a `request_id` across distinct solicitations** — including reusing the same id for any local §1 corrective (anchored-gate or post-acceptance-validation corrective) and for the local §3 redo corrective. Each is a fresh solicitation; sharing an id reintroduces the stale-reply blind spot the counter is designed to eliminate.
5. **Checking the loop's accept rule before classifying the `reqid`, OR accepting a reply whose `reqid != expected_request_id` as genuine.** `reqid < expected_request_id` means stale → ignore content + §E stale-recovery; `reqid > expected_request_id` is impossible (lead is sole id source) → teardown + STOP. Id classification MUST precede all content checks.
6. **Comparing `reqid` against `expected_request_id` while `awaiting_reply == false` (§E Phase 1)** — `expected_request_id` is `null` then; the Phase 1 branch routes by `request_id_counter` only. Collapsing Phase 1 and Phase 2 into a single comparison reintroduces the duplicate-during-Codex-review mis-attribution.
7. **Treating a payload-less `idle_notification` as a contract failure without comparing `idle.timestamp` to `solicit_sent_at`.** An idle queued from a PRIOR round can land between the current solicitation's send and the teammate's reply — typically because the lead's previous turn ran Codex review for minutes and the teammate's post-reply idle from that prior round was held until the next turn delivery. Minting a fresh-id corrective for such a stale idle kicks off a perpetual 1-round-lag race; the §E Phase 2 stale-idle guard exists to plug exactly this dogfooded failure mode.
8. **Inlining the §E pseudo-code / state-machine body into a SKILL.md** instead of keeping SKILL.md a summary + pointer. SKILL.md is the always-loaded surface; duplicating §E there bloats every trigger and risks the two copies drifting out of sync.

## §E — Abstract request-id state machine

This section is the single source of truth for the request-id state machine and the run-state fields used by every loop binding this protocol. Each loop's SKILL.md "Agent-teams tool contract" section is a summary that MUST point here and MUST NOT restate the pseudo-code — this keeps each always-loaded SKILL.md lean and prevents the two copies drifting.

The id is the disambiguator for a stale vs. genuine reply; it is NOT a new path or a new artifact. Each loop's local `failure-protocol.md` declares the loop-bound reply-token shape and the post-MESSAGE-ACCEPTED validation stage.

**Run-state fields (single source of truth — every binding loop uses these names).** The lead must retain the following run-state across turns and never conflate these fields:

- `teammate_name` — our chosen spawn `name` (`planner` / `fixer` / `documenter`); the PRIMARY handle tried first on the first send, per §A's send-resolution procedure.
- `teammate_id` — the captured `agent_id` of the spawned teammate, stored verbatim; the FALLBACK handle for the first send (never parsed). Never parse its format; see §A's send-resolution procedure.
- `resolved_handle` — the handle (`teammate_name` or `teammate_id`) that won the first send; `null` until the first successful lead→teammate send resolves it. The §A procedure's cache and the direct `to:` target for every send once set.
- `request_id_counter` — the last id minted (initialized to `0`; incremented on every solicitation as below).
- `expected_request_id` — the id of the outstanding solicitation the lead is currently waiting on; `null` when the lead is not awaiting any reply (e.g. while running Codex review).
- `awaiting_reply` — boolean: `true` ONLY between minting a solicitation and accepting its reply.
- `solicit_sent_at` — UTC wall-clock timestamp captured by the lead IMMEDIATELY BEFORE invoking the SendMessage carrying the current outstanding solicitation: run `date -u +%FT%TZ` (via the Bash tool) as the LAST tool call before that SendMessage and store its output verbatim. The assistant-turn start timestamp is NOT a valid substitute — a long turn can elapse minutes (typically a Codex review) between turn-start and the next SendMessage, during which a payload-less idle could be emitted with `idle.timestamp > assistant-turn-start` but still `< actual-SendMessage time`, leaving the guard mis-comparing and the stale-idle race unplugged. `null` when not awaiting. **m6 cross-note (per §A):** for an ID-BEARING solicitation whose delivery fell back to `teammate_id` (bare-name primary failed), this field is RECAPTURED immediately before that delivered fallback send — the invariant binds to the send that actually went out. The teardown `shutdown_request` is id-exempt and never sets `solicit_sent_at`. Used by Phase 2 below to distinguish a stale prior-round idle (`idle.timestamp < solicit_sent_at`) from a true post-solicit silence — the dogfooded failure mode this field was added to plug.
- `review_iteration` — bridge re-invocation count, independent of the id counter.

The request-id counter and `review_iteration` are SEPARATE counters: the id bumps on every solicitation including correctives; the iteration only on bridge re-invocation.

Each loop carries additional loop-LOCAL run state (e.g. `plan_path` for plan-loop). Those stay defined in the loop's SKILL.md.

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
