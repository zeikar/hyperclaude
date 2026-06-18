# hyper-docs-loop — failure & recovery protocol

Operational backstops for `hyper-docs-loop`. The shared cross-loop protocol (team contract, unsolicited-message protocol skeleton, teardown procedure, abstract request-id state machine §E, shared anti-patterns) lives in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`. This file is the docs-loop's binding layer: it names the teammate role (`documenter`), the reply-token shape (`request-id: <id>` prefix on the structured findings schema), the structured-schema accept rule, the semantic finding-map post-acceptance validation, and the docs-loop-specific anti-patterns. SKILL.md Step 0 Reads BOTH files.

## Binding declarations

These fill the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` binding holes for the docs-loop:

- **Teammate role-name:** `documenter`. Reused from `agents/documenter.md` (the same agent normally dispatched by `hyper-docs-sync` for UPDATE/CREATE mode); the loop's spawn-prompt contract overrides the dispatch context to "persistent teammate, structured-findings mode".
- **Reply-token-with-id shape** (binds the shared §E "parse leading `<loop-bound reply-token-with-id>`" hole): `request-id: <integer>` on the FIRST non-blank line of the reply body. The integer is the `<reqid>` for shared §E classification. The rest of the body is the structured findings schema; correctives re-enter the full §1 / §3 pipeline (same accept rule), they do NOT relax it. (Note: §B's idle-correction tolerates a content-free "ok, waiting" ack ONCE — but that is an unsolicited-message tolerance handled at the §B layer, NOT a relaxation of this accept rule.)
- **Accept rule** (binds the shared §E "loop-bound accept rule" hole): (a) id-classification routing per §1's pre-gate paragraph (older → stale branch, future → teardown, absent/malformed → corrective, matching → continue); THEN (b) the structured-schema requirements from §1's schema gate (every cited finding has its own `finding:` / `status:` / `files-changed:` / `verification:` / `notes:` block; `status` ∈ {`fixed`, `not-applicable`}; `notes:` required when `status: not-applicable`; no diff dump / no patch block / no source-body echo). Id-classification is the outer wrapper — the schema gate only fires on a matching id.
- **Post-acceptance validation stage** (binds the shared §E "loop-bound post-acceptance validation" hole): the semantic finding-map check from §3 (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason).
- **Named-loop-report strings** (bind the shared `<loop-name>` placeholder): `hyper-docs-loop reply-contract failure`, `hyper-docs-loop documenter format, iter N`, `hyper-docs-loop teardown`, `hyper-docs-loop unparseable review, iter N`, `hyper-docs-loop bridge failure, iter N`, `hyper-docs-loop fix loop`.
- **State-field name reminder:** the shared file calls the awaiting-state field `awaiting_reply`; docs-loop's SKILL.md uses that exact name.

## §1 — Anchored reply gate: corrective + escalation

The anchored reply gate (SKILL.md Step 7) is the accept condition for EVERY documenter reply to a Step 7 findings `SendMessage` (the first fix round, any retry, and every Step 7 redo). The spawn-time state carries no deliverable and is governed by §2 (which now points at shared §B), not this gate.

**Pre-gate id-classification routing (shared §E Phase 1 / Phase 2 — do this FIRST, before evaluating the schema gate):** parse the leading `request-id: <int>` token from the FIRST non-blank line of the documenter reply and route:

- **Older id (`reqid < expected_request_id`)** → shared §E Phase 2 stale branch: ignore the reply content entirely and execute the stale-recovery sub-step. Do NOT invoke the schema gate.
- **Future id (`reqid > expected_request_id`)** → shared §E protocol violation: go to Step 8 teardown, then STOP (**"hyper-docs-loop teardown"**). Do NOT invoke the schema gate.
- **Absent or malformed prefix** (first non-blank line is not `request-id: <integer>`, or `<integer>` is not a valid integer) → reply-contract failure: mint a fresh corrective id per shared §E mint protocol, then send ONE corrective per the template below. The schema gate does NOT fire — this is the "absent/garbled reply-token" branch from shared §E.
- **Matching id (`reqid == expected_request_id`)** → proceed to the schema gate below.

**Schema gate (only on matching id):** the gate is evaluated AFTER id-classification confirms a matching id, and BEFORE the §3 semantic finding-map check. A documenter reply **FAILS** the schema gate if any of the following are true:

- It has no per-finding block (the structured-schema fields are entirely absent).
- It is missing a block for any cited finding (every cited finding must have its own `finding:` / `status:` / `files-changed:` / `verification:` / `notes:` block).
- Any `status:` value is not exactly `fixed` or `not-applicable` (no synonyms, no extra words).
- A `notes:` field is omitted when `status: not-applicable` (the reason is required; an empty or missing `notes:` fails the gate).

Small extra prose (a one-line summary, a brief comment before or after the blocks) is tolerated and does not fail the gate. A diff dump, patch block, or verbatim source-body echo FAILS the gate **even when all required schema fields are present** — the documenter's "No diff dump" rule is enforced here, not weakened.

There is no single output-file path to verify. The gate applies to the documenter's reply structure only — the lead does not perform a filesystem existence check here.

On any gate failure, mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol, then send ONE corrective message that carries the new id:

```
SendMessage({
  to: "documenter",
  summary: "Reply contract: structured schema only — request <id>",
  message: "<re-state: prefix the reply with `request-id: <id>` on the first non-blank line; then for every cited finding emit finding:/status:/files-changed:/verification:/notes: fields on their own lines; status must be exactly 'fixed' or 'not-applicable'; notes: is required when status: not-applicable; no diff dump, no patch block, no source-body echo; small prose summary is tolerated but must not replace the schema; id is <new request_id_counter value>>"
})
```

The redo reply must echo `request-id: <new id>`. If the next reply still fails the anchored gate → Step 8 teardown, then STOP (**"hyper-docs-loop reply-contract failure"**).

## §2 — Lead-side unsolicited-message protocol

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §B — Unsolicited-message protocol skeleton. The docs-loop binds `<loop-bound reply-token>` = the `request-id: <id>` first line + structured findings schema body and `<loop-name>` = `hyper-docs-loop`. The full interplay-with-§E paragraph (Phase 1 / Phase 2 routing for id-bearing traffic vs. non-id-bearing unsolicited traffic) is in shared §B; do not duplicate it here.

## §3 — Fix-validation redo pipeline (Step 7 failure handling)

**The ordered pipeline** every documenter reply must pass (this order is named inline in SKILL.md Step 7): (1) **id-classification routing** (§1 pre-gate: parse `request-id: <int>` prefix; route per shared §E Phase 1 / Phase 2 — older = stale-recovery, future = teardown, absent/malformed = corrective) → (2) **anchored structured-schema reply gate** (§1 schema gate, on matching id only — schema requirements per §1) → (3) **semantic finding-map check**: the lead reads the documenter reply and confirms that EVERY cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason.

There is **NO git-working-tree / no-op / `.bak` / restore mechanism**. A documenter that applies no real change is bounded by the Step 8 cap (the loop re-reviews and re-issues findings until convergence or the cap, then STOPs with the cap report) — reasserting a git-diff gate here is an anti-pattern and is intentionally not a separate failure path.

**Gate failure in Step 7:** apply §1 (initial corrective + escalation to **"hyper-docs-loop reply-contract failure"** via Step 8 teardown if it still fails).

**Semantic finding-map check (step 3 of the pipeline):** the lead reads the documenter reply in context and verifies that each cited blocking finding is accounted for. If one or more findings are unmet (status missing, or `fixed` but the lead judges the explanation impossible, or the required `notes:` for `not-applicable` is absent or empty): mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol, then send ONE corrective `SendMessage` (with `summary: "... request <id>"`) re-issuing only the unmet findings and instructing the documenter to address them. The redo reply must echo `request-id: <new id>` and re-enters the FULL pipeline from step (1): id-classification routing → schema gate → semantic finding-map check. If the redo still fails the semantic check → Step 8 teardown, then STOP (**"hyper-docs-loop documenter format, iter N"**), surfacing the unmet findings for manual triage. The loop does NOT auto-restore — the docs tree is left as the documenter last touched it.

**Invalid-finding path:** a finding the documenter returns as `not-applicable` with a non-empty `notes:` reason is treated as **addressed** for gate purposes and does not block the loop. The next Codex re-review is the arbiter: if Codex drops the finding the loop continues normally; if Codex re-raises it, it re-enters the normal loop and counts toward the cap.

## §5 — Anti-patterns (docs-loop specific)

The cross-loop anti-patterns (reviewer-is-team-agent, re-spawning fresh, skipping teardown, reusing request_id, checking accept rule before classifying reqid, comparing reqid while not awaiting, treating payload-less idle as failure, inlining §E into SKILL.md) live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §D.

Docs-loop-specific:

- Committing or pushing from the documenter. The documenter touches only the working tree; the orchestrating skill decides when to commit.
- Letting the documenter invoke codex or `scripts/codex-bridge.mjs`. The documenter never acts as reviewer.
- Letting the documenter edit source code, tests, scripts, or config files to make a doc claim "true". The doc is what changes; if the doc was actually right, the documenter reports `status: not-applicable` with a `notes:` reason.
- Changing `docs_target` mid-run — substituting one `--docs-path` for another, swapping `--docs-path` for `--docs-dir`, or omitting it on a resumed iteration. `docs_target` is the fixed, invariant loop target every iteration; the bridge requires it on resume too.
- Auto-fixing items from `### Gaps`, `### Broken Or Suspect Links`, or `### Cross-Doc Inconsistencies`. Only `### Findings` drives fix rounds; the other three sections are reported in the final Step 9 summary and resolved by the user manually. Sending those items to the documenter as if they were `### Findings` is a scope violation of this loop's contract.
- Reasserting a git-state / no-op gate. A stuck or no-change documenter is bounded by the Step 8 cap — a separate no-op detection path is an anti-pattern.
- Gating on label vocabulary instead of meaning. Classify by MEANING regardless of label: a `### Findings` item blocks if it concerns accuracy / drift / actively misleading claims, regardless of the severity label Codex assigned; pure style/nits do not block.
- Treating a `resume-failed` or `fallback` round as invalid. Such a round is still a valid loop iteration and counts toward the cap, but it MUST be flagged in the final report so the human can assess continuity.
- Editing `hyper-docs-review` or `hyper-docs-sync`. This skill is purely additive.

## §6 — Request-id state machine

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E. Docs-loop's bindings for the binding holes (reply-token shape, accept rule, post-acceptance validation stage) are declared in the "Binding declarations" section at the top of this file.
