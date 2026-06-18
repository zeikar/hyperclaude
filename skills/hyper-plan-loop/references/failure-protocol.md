# hyper-plan-loop — failure & recovery protocol

Operational backstops for `hyper-plan-loop`. The shared cross-loop protocol (team contract, unsolicited-message protocol skeleton, teardown procedure, abstract request-id state machine §E, shared anti-patterns) lives in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`. This file is the plan-loop's binding layer: it names the teammate role (`planner`), the reply-token shape (`WROTE: <id> <path>`), the exact-path accept regex, the file/structure post-acceptance validation stage, and the plan-loop-specific anti-patterns. SKILL.md Step 0 Reads BOTH files.

## Binding declarations

These fill the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` binding holes for the plan-loop:

- **Teammate role-name:** `planner`.
- **Reply-token-with-id shape** (binds the shared §E "parse leading `<loop-bound reply-token-with-id>`" hole): `WROTE: <integer>`. The trailing token after the integer is the path payload.
- **Accept rule** (binds the shared §E "loop-bound accept rule" hole): the exact regex `^WROTE: <expected id> <exact resolved plan path from Step 1>\s*$` (path = entire remaining string, verbatim) plus the no-prose / no-preamble / no-body-echo rule. On any body echo, added prose, preamble, or a different path at the matching-id step → §1 corrective + escalation.
- **Post-acceptance validation stage** (binds the shared §E "loop-bound post-acceptance validation" hole): the file/structure check — `[ -s "<resolved plan path>" ]` for existence + the `node -e ...^##\s*Task\s` regex one-liner from SKILL.md Step 7. This is the "PLAN VALIDATION ACCEPTED" stage in plan-loop terms.
- **Named-loop-report strings** (bind the shared `<loop-name>` placeholder): `hyper-plan-loop reply-contract failure`, `hyper-plan-loop planner-write failure`, `hyper-plan-loop planner format, iter N`.
- **State-field name reminder:** the shared file calls the awaiting-state field `awaiting_reply`; plan-loop uses that exact name throughout.

## §1 — Anchored reply gate: corrective + escalation

The anchored reply gate (SKILL.md Step 4) is the accept condition for EVERY planner reply in write-file mode (initial write, any retry, and every Step 7 revise redo). The gate definition stays in SKILL.md; this section is the failure handling.

On any body echo, added prose, preamble, or a different path: mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol, then send ONE corrective message that carries the new id:

```
SendMessage({
  to: "planner",
  summary: "Reply contract: WROTE: <id> <path> only — request <id>",
  message: "<re-state: use Write to write the full plan to the exact resolved path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else — no plan body, no prose, no preamble; id is <new request_id_counter value>>"
})
```

If the next reply still fails the anchored gate → Step 8 teardown, then STOP (**"hyper-plan-loop reply-contract failure"**).

**File check failure (only reached after the gate passes):** if `[ -s "<resolved plan path>" ]` shows the file missing or empty, this is a fresh solicitation — mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol, then send ONE corrective message:

```
SendMessage({
  to: "planner",
  summary: "File not written — re-Write at exact path — request <id>",
  message: "<the file at <resolved plan path> is missing or empty; use Write to write the full plan to that exact path; reply with exactly 'WROTE: <id> <that exact path>' and nothing else; id is <new request_id_counter value>>"
})
```

Its reply re-enters the anchored gate (§E Phase 2, expecting the new `expected_request_id`). If it is still missing or empty after that → Step 8 teardown, then STOP (**"hyper-plan-loop planner-write failure"**).

## §2 — Lead-side unsolicited-message protocol

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §B — Unsolicited-message protocol skeleton. The plan-loop binds `<loop-bound reply-token>` = `WROTE: <id> <path>` and `<loop-name>` = `hyper-plan-loop`. The full interplay-with-§E paragraph (Phase 1 / Phase 2 routing for `WROTE:` traffic vs. non-`WROTE:` traffic) is in shared §B; do not duplicate it here.

## §3 — Revise-validation redo pipeline (Step 7 failure handling)

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

**The ordered pipeline** every revise reply must pass (this order is named inline in SKILL.md Step 7): (1) **id-first parse** (§E Phase 2 — parse `reqid`, classify against `expected_request_id`) → (2) **anchored reply gate** (§1, exact-path + no-prose check) → (3) **structure `ok`/`bad` check**. Note: id-first parse is the FIRST operation of the anchored reply gate (Step 4 / §E Phase classification), so §3's three-step granular naming and SKILL.md Step 7's two-step naming ("(1) anchored reply gate (Step 4) → (2) structure check") describe the SAME pipeline. The `bad`/malformed corrective redo re-enters this FULL pipeline from step (1) in this exact order. A redo is never "just the gate", a partial check, or id-skipping. The retry budget: exactly ONE corrective redo, then STOP via Step 8 teardown — and that single redo must pass the full pipeline.

There is no no-op / unchanged-plan detection. A planner that replies `WROTE:` but applies no real revision is bounded by the Step 8 cap (the loop re-reviews and re-revises until convergence or the cap, then STOPs with the cap report) — this is intentionally not a separate failure path.

**Gate failure in Step 7:** apply §1 (initial corrective + escalation to **"hyper-plan-loop reply-contract failure"** via Step 8 teardown if it still fails).

**Structure check (step 2 of the pipeline):** the SKILL.md one-liner prints only `ok` or `bad`. The try/catch in it is load-bearing: any read failure (the planner deleted or clobbered the canonical path) prints `bad` instead of throwing — so a missing/unreadable file routes through the corrective path here, not to teardown as an unexpected tool error.

If `bad` (the planner clobbered the canonical path with malformed content, OR the file is missing/unreadable): mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol, then send ONE corrective `SendMessage` (with `summary: "... request <id>"`) instructing the planner to redo the revision and re-Write the exact resolved plan path, passing the new id and requiring `WROTE: <that new id> <exact resolved path>`. That corrective's reply re-enters the FULL pipeline from step (1): id-first parse → anchored reply gate → structure `ok`/`bad` check — the gate now expects that NEWEST `expected_request_id`. If the redo is still `bad` at the structure step → Step 8 teardown, then STOP (**"hyper-plan-loop planner format, iter N"**), surfacing the resolved plan path for manual triage. The loop does NOT auto-restore — the plan file is left as the planner last wrote it; `/hyperclaude:hyper-plan` regenerates it in one step. Only Read the full file into lead context for that human-facing failure diagnostic — never on the success path.

On `ok`: Step 7 increments the iteration, re-invokes the bridge with `--resume auto`, then loops back to Step 6.

## §5 — Anti-patterns (plan-loop specific)

The cross-loop anti-patterns (reviewer-is-team-agent, re-spawning fresh, skipping teardown, reusing request_id, checking accept rule before classifying reqid, comparing reqid while not awaiting, treating payload-less idle as failure, inlining §E into SKILL.md) live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §D.

Plan-loop-specific:

- Accepting an existing-plan-path argument. Not a v1 input mode — `$ARGUMENTS` is a task description only.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Reading the plan body into lead context each revise round. Use the quiet `ok`/`bad` check — Read-caching the body reintroduces the token cost this skill removes.
- Accepting any non-`WROTE:` reply (body echo, prose, preamble, wrong path) as success. The anchored gate is exact-match only.
- Proceeding to Codex review on a `bad` (malformed) just-written file instead of running the §3 corrective + terminal STOP first.
- Writing the wrong base path. The resolved plan path is a Step 1 concept; Step 2 is the teammate availability check only — never derive the path from Step 2.
- Treating non-blocking findings as revise targets. Step 6 classifies by **meaning** (correctness, wrong paths, broken ordering, unverifiable steps, missing required behavior) — pure style nits, vague "consider X" suggestions, and prose-polish do NOT gate the loop regardless of which severity word Codex attached. Trust the meaning judgment; do not invent revisions for non-blocking findings.
- Omitting `--plan-path` or `--resume auto` on iteration 2+. `--plan-path` is required every iteration; `--resume auto` from iteration 2 onward.
- Stopping silently at the cap. Always emit the named cap report (after teardown).
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.

## §6 — Request-id state machine

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E. Plan-loop's bindings for the binding holes (reply-token shape, accept rule, post-acceptance validation stage) are declared in the "Binding declarations" section at the top of this file.
