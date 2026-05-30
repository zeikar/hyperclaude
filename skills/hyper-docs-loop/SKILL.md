---
name: hyper-docs-loop
description: Use when documentation should be brought into accuracy with the code in one gesture — Codex docs-review → fix → re-review, repeated until no blocking findings remain. Also when the user invokes /hyperclaude:hyper-docs-loop. For manual round-by-round control use /hyperclaude:hyper-docs-review + manual edits instead. Requires the experimental agent-teams feature.
---

# hyper-docs-loop

Autonomous docs-hardening gate. Creates a per-run team, spawns the `documenter` agent as a persistent teammate **once**, invokes Codex `docs-review` through the bridge, and fixes via the still-live documenter until no blocking findings remain (judged semantically — see Step 6) or the cap is hit. The documenter is spawned **once**; every fix round reuses its retained context via SendMessage. The reviewer is always the Codex bridge, never a teammate — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-docs-loop [target]`.
- User wants an autonomous docs-review → fix cycle in a single gesture.

Skip when:
- A single doc edit is enough — edit it directly or use `/hyperclaude:hyper-docs-sync` for code-change-driven sync.
- You want hands-on control over each review / fix round — use `/hyperclaude:hyper-docs-review` + manual edits.
- The experimental agent-teams feature is unavailable (this skill stops with a documented fallback message — see Step 2).

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol — team contract shapes (§A), unsolicited-message protocol skeleton (§B), teardown procedure (§C), shared anti-patterns (§D), abstract request-id state machine (§E). `references/failure-protocol.md` (sibling of this file) is the docs-loop binding layer: structured-schema reply with `request-id: <id>` prefix, semantic finding-map post-acceptance validation, docs-loop-specific anti-patterns. Step 0 makes Reading BOTH mandatory.

## Agent-teams tool contract

This skill uses the experimental agent-teams tools — `TeamCreate` / `Agent` / `SendMessage` / `TeamDelete`. Their argument shapes, the rule that the per-run team name is passed **only** to `TeamCreate` and `Agent` (never to `SendMessage` / `TeamDelete`), and idle-notification semantics (a payload-less wake signal that does NOT carry the teammate's reply text — the loop-bound structured findings reply arrives only if the documenter explicitly `SendMessage`s it, else the lead falls back to a corrective round-trip) all live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §A, loaded at Step 0. Loop-specific bindings:
- **Documenter-reply ownership:** there is NO canonical output file — the documenter applies edits in place and replies with the structured findings-map schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited finding). The lead avoids reading full doc bodies on the normal path, but MAY run scoped `git status` / `git diff --stat` / targeted file reads for validation and failure reporting. Unsolicited documenter messages follow the lead-side protocol (`references/failure-protocol.md` §2) — prompt-only idle discipline is insufficient.

**Documenter request id.** The run-state fields (`request_id_counter`, `expected_request_id`, `awaiting_reply`, `solicit_sent_at`, `review_iteration`) and their lifecycle (mint protocol, MESSAGE ACCEPTED / POST-ACCEPTANCE VALIDATION ACCEPTED acceptance stages, Phase 1 / Phase 2 routing, stale-recovery) are defined in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E (single source of truth); this loop binds to those names.

**Loop-local id-source rule.** Every lead→documenter solicitation carries a per-run, lead-owned, monotonically increasing integer id. The lead is the SOLE id source — the documenter only echoes it. The counter increments on EVERY solicitation: each Step 7 fix-round = +1, AND every §1/§3 corrective gets its OWN new id. The `shutdown_request` object message is EXEMPT (no id).

**Spawn-is-not-a-solicitation.** Like implement-loop, the docs-loop spawn (Step 4) is contract-only — the documenter goes idle without sending any reply. `request_id_counter` stays at 0 until the FIRST Step 7 fix solicitation, which mints id 1. The Step 4 spawn does NOT change `request_id_counter` or `awaiting_reply`. After spawn, the lead expects EXACTLY ONE payload-less idle notification (the documenter's post-spawn idle). The lead consumes that idle as a readiness signal and does NOT route it through §B/§E unsolicited handling. From the second wake onward (which is always after the first Step 7 solicitation has been sent), §E Phase 1 / Phase 2 routing applies normally.

The lead must also retain `team_name` (the per-run unique team name from Step 2) and `docs_target` (the resolved bridge argv pair from Step 1) across turns. Other loop-local run state (e.g. `reviewArtifacts[]`, `review_iteration`) is named where it appears in Steps 5/7.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **docs target** (an optional path; the loop mirrors `hyper-docs-review`'s target grammar). Resolution:

- `$ARGUMENTS` empty → default to `docs/` (directory mode).
- `$ARGUMENTS` is an existing `.md` file path → single-file mode.
- `$ARGUMENTS` is an existing directory path → directory mode.
- Anything else → ask the user to clarify and STOP.

This skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` to be set in the environment. If the agent-teams feature is unavailable, the skill stops with the documented fallback message (see Step 2).

### Step 0 — Read the failure & recovery protocol

Before any team creation, Read both protocol files into context: (1) `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — the shared cross-loop protocol; (2) `references/failure-protocol.md` (sibling of this file) — the docs-loop binding + docs-loop-specific recoveries. Both are mandatory — the loop's failure branches reference sections by number (shared §A–§E and local §1–§5) and the lead must follow them verbatim when reached.

### Step 1 — Resolve the docs target

Apply the resolution table above to `$ARGUMENTS`. Verify the path exists via Bash (`[ -e "<path>" ]`). Record `docs_target` as the bridge argv pair:

| Argument | `docs_target` argv |
|---|---|
| Empty | `['--docs-dir', 'docs/']` |
| `.md` file that exists | `['--docs-path', '<path>']` |
| Existing directory | `['--docs-dir', '<path>']` |
| Anything else | Ask the user to clarify, STOP. |

`docs_target` is reused **verbatim** on every iteration in Step 5 and Step 7 — never change it mid-run.

**Directory-target note.** Per `docs-review`'s established contract, `--docs-dir <p>` reviews only the top-level `.md` files directly under `<p>` (not recursive). This is intentional. The loop inherits that scope; if the user wants nested docs reviewed, they invoke the loop once per subdirectory or against a single `.md` path.

### Step 2 — Create the team

Do not add an env-probe shell check — let `TeamCreate` itself surface agent-teams unavailability.

Compute a per-run unique team name (the nonce defeats same-second collisions) and record this exact literal as the run's team name (also used in Step 4's `Agent` call and reports):

```bash
echo "hyper-docs-loop-$(date +%Y%m%d-%H%M%S)-$RANDOM"
```

Then:

```
TeamCreate({ team_name: "<the run-unique name computed above>", description: "Codex docs-review fix loop" })
```

Failure handling:

- **`TeamCreate` fails** → STOP with the message below + the raw error verbatim. No teardown (nothing was created).
- **`TeamCreate` succeeds but the Step 4 spawn fails** → `TeamDelete` FIRST (no orphaned empty team), then STOP with the same message.

Documented stop message:

> agent teams unavailable (or TeamCreate failed — see error below) — this skill requires the experimental agent-teams feature; run /hyperclaude:hyper-setup to diagnose prerequisites. Use /hyperclaude:hyper-docs-review + manual edits instead.

### Step 3 — (Reserved)

This skill has no pre-loop sync step. The loop targets accuracy of docs as they are; if the user wants to first sync docs to recent code changes, they invoke `/hyperclaude:hyper-docs-sync` separately before this skill. Keeping the loop pure (review ↔ fix only) avoids conflating the code-diff-driven sync flow with the docs-target-driven review flow.

### Step 4 — Spawn the documenter teammate

Spawn the documenter **once** here, before iteration 1. Use the Agent tool. The full contract text below goes in the `prompt:` string:

```
Agent({
  subagent_type: "hyperclaude:documenter",
  team_name: "<the run-unique team name computed in Step 2>",
  name: "documenter",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Role framing** — you are the documenter teammate for this hyper-docs-loop run; your job is to apply Codex docs-review findings to the cited doc files in targeted, minimal edits. This dispatch is NOT hyper-docs-sync's per-doc UPDATE/CREATE mode — it is the loop's structured-findings mode, and the contract below is authoritative for this dispatch.
- **No findings yet** — no docs-review findings exist at spawn time; findings will be delivered via `SendMessage` in later turns.
- **Reply transport (MANDATORY)** — every reply MUST be delivered by calling `SendMessage({ to: "team-lead", summary: "<one-line summary>", message: "<structured schema>" })`. Plain assistant text is NOT visible to the lead, and going idle without calling `SendMessage` only emits a payload-less idle notification — so if you output the schema as plain text and idle WITHOUT the `SendMessage` call, the lead never receives your reply and the loop stalls. Call `SendMessage` first, then idle. This applies identically to every fix-round reply. You spawn with no findings yet. Do NOT send any message on spawn — simply go idle; the payload-less idle notification is sufficient. The lead expects exactly ONE payload-less idle notification after spawn (your post-spawn idle) — it consumes that as a readiness signal and does NOT treat it as unsolicited traffic. From the first Step 7 findings SendMessage onward, the full §E Phase 1 / Phase 2 id-routing applies. Only ever call `SendMessage({ to: "team-lead", … })` to deliver your structured per-finding schema reply in response to a findings `SendMessage` from the lead.
- **Reply id contract** — every reply you send to the lead MUST begin with a `request-id: <id>` line where `<id>` is the integer id the lead included in this round's findings SendMessage (the lead is the sole id source; echo it verbatim). This line is the FIRST non-blank line of the structured reply, followed by the per-finding blocks. The spawn message carries NO findings and no id — do NOT send any reply on spawn (idle as instructed). Only ever send `SendMessage({ to: "team-lead", ... })` in response to a findings SendMessage from the lead, and that response MUST start with `request-id: <id>`.
- **Structured per-finding schema** — for EVERY cited finding emit these fields, each on its own line: `finding:` / `status:` (exactly `fixed` or `not-applicable`) / `files-changed:` (comma-separated doc paths, or `none`) / `verification:` (what you re-read to confirm, or `n/a`) / `notes:` (REQUIRED when `status: not-applicable`; a non-empty reason). No diff dump, no patch block, no verbatim source-body echo. End with a one-line summary of all findings processed this round.
- **Idle / no-resend discipline** — after replying, go idle and wait; do NOT resend, re-announce, or nag. The lead will contact you only via `SendMessage` carrying the next round's findings or a `shutdown_request`, and may take several minutes running Codex review between turns (this is normal). Never re-emit a prior reply.
- **Constraints echo** — fix ONLY the findings explicitly cited in each `SendMessage`; no opportunistic prose polish; no edits to uncited docs; edit DOCUMENTATION files only (no source code, tests, scripts, or config edits to make a doc claim "true" — if the doc disagrees with code, the doc is what changes, or report `not-applicable` if the doc was actually right); NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; re-read the cited docs each round before applying any fix (context may be stale across rounds).
- State that the documenter stays alive as a teammate, will receive Codex findings in later turns, and must retain its full context across rounds.

(Spawn-failure handling is in Step 2.)

### Step 4a — Unsolicited documenter messages

While the documenter is live and BEFORE Step 8 teardown, the only documenter message the lead expects is the anchored structured-schema reply (prefixed by `request-id: <id>` per Step 7) to the lead's most recent SendMessage (fix, redo, or corrective). Any other inbound documenter message — duplicate body, `RESEND:`-style re-emit, nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. Handle it per `references/failure-protocol.md` §2 (which points at shared §B). This lead-side rule is **mandatory** — prompt-only idle discipline (Step 4) is insufficient. The teardown exchange is exempt (a `shutdown_response` after `shutdown_request` is expected, never a violation).

**Phase-aware cross-reference (per shared §E):** while AWAITING (`awaiting_reply == true`), an id-bearing reply with `reqid < expected_request_id` is shared §E Phase 2's stale branch (ignore content + stale-recovery sub-step), NOT routed through §2. While NOT awaiting (`awaiting_reply == false`), an id-bearing reply with `reqid <= request_id_counter` is ignored SILENTLY; all non-id-bearing unsolicited traffic IS §B's domain. See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E (state machine) and §B (interplay).

### Step 5 — Docs-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 8 cap is **6 total Codex reviews**, i.e. at most **5 fix rounds**.

Invoke via the Bash tool with `timeout: 600000`, passing the `docs_target` argv pair from Step 1:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv>
# e.g. ... docs-review --docs-dir docs/
# or   ... docs-review --docs-path docs/architecture.md
```

**JSON parsing (strict):** the bridge contract is exactly ONE JSON object on stdout. Parse stdout as a single JSON object; if any extra non-whitespace appears before or after it, treat as a parse failure and surface the raw output verbatim — no best-effort scraping.

On `ok:true`: Read the artifact at `path` with the Read tool; capture `resumeStatus`; append `path` to a `reviewArtifacts[]` list (for Step 9).

On any non-`ok:true`, Bash timeout, or JSON parse failure → Step 8 teardown, then STOP with a named-loop report (**"hyper-docs-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present.

### Step 6 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The `docs-review` template emits `### Findings` (Blocker/Major/Minor bullets), `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies`, and `### Verdict`.

**Only `### Findings` is gating.** Bullets in `### Gaps` / `### Broken Or Suspect Links` / `### Cross-Doc Inconsistencies` are reported in the final summary (Step 9) but do NOT drive fix rounds — those sections frequently need human judgment (which gap is worth filling? is this link genuinely broken or just suspicious?) that the loop should not auto-resolve. The user runs another pass manually when ready.

Within `### Findings`, classify by meaning: a finding **blocks** if it concerns **accuracy / drift / actively misleading claims that would cause a reader to do the wrong thing** (regardless of which severity word the template attached). Pure prose-polish nits do NOT block.

- Any blocking `### Findings` item → fix (Step 7).
- No blocking `### Findings` (Findings absent, or Findings contains only style/nits, or verdict is approving) → exit loop (Step 8 teardown → Step 9). Non-blocking findings + the three non-gating sections are reported, never gating.

**Conservative branch:** if the body cannot be confidently judged by meaning (unparseable, truncated, or no recognizable structure) → Step 8 teardown, then STOP with a named-loop report (**"hyper-docs-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 7 — Fix via the live documenter, then re-review

First check the cap: if the iteration counter is already at 6 (6 total Codex reviews consumed), do NOT send findings or fix — go directly to Step 8 (cap reached).

Before sending, mint a new id per `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E's mint protocol: `request_id_counter += 1`, `expected_request_id = request_id_counter`, `awaiting_reply = true`; immediately before the SendMessage call, capture `solicit_sent_at` via a Bash `date -u +%FT%TZ` (per shared §E's binding rule — assistant-turn start is NOT a valid substitute; a long Codex-review turn can elapse between turn-start and the next SendMessage). Pass the new id in the message and in the reply instruction.

Send the blocking `### Findings` bullets to the still-live documenter:

```
SendMessage({
  to: "documenter",
  summary: "Fix Codex blocking docs findings — request <id>",
  message: "<verbatim blocking ### Findings bullets (with their Stale claim / Code evidence / Recommended edit sub-bullets) + the docs-review artifact path; the request id for this round is `<id>`; instruct: re-read the cited doc files, apply ONLY these fixes, reply with the structured schema PREFIXED by `request-id: <id>` on the first non-blank line>"
})
```

For `--docs-dir <p>` reviews, a `### Findings` bullet may cite the doc path as a basename only (e.g. `architecture.md`) because the bridge prompt presents files as basenames under that directory. Forward the bullet verbatim — the documenter resolves the basename to the actual path under the directory target using its working-tree knowledge.

Do NOT re-send context the documenter still holds.

**Fix-validation pipeline** (per `references/failure-protocol.md` §3): (1) **id-classification routing** (parse the `request-id: <int>` prefix; route per shared §E Phase 1 / Phase 2 — older = stale-recovery, future = teardown, missing/malformed = corrective) → (2) **anchored structured-schema reply gate** (on matching id only — schema requirements per `references/failure-protocol.md` §1) → (3) **semantic finding-map check** (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason). **No git-state / no-op gate.** Each stage has its OWN one-redo budget — a §1 schema-gate failure escalates (after its one corrective) to **"hyper-docs-loop reply-contract failure"**; a §3 semantic-finding-map failure escalates (after its own one corrective redo, which re-enters the full pipeline from §1) to **"hyper-docs-loop documenter format, iter N"**. Follow `references/failure-protocol.md` §1 and §3 verbatim.

On pass, increment the iteration counter and re-invoke via the Bash tool with `timeout: 600000`, passing the SAME `docs_target` argv pair:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" docs-review <docs_target argv> --resume auto
```

Always pass `--resume auto` from iteration 2 onward; `docs_target` is REQUIRED on every iteration (the bridge requires `--docs-path` or `--docs-dir` even on resume). Re-parse per Step 5's strict-JSON rule, append the artifact path to `reviewArtifacts[]`, then loop back to Step 6.

**Resume-status polishing:** if `resumeStatus` ∈ {`resume-failed`, `fallback`} the round is still valid — record it for the Step 9 report.

### Step 8 — Cap + teardown

Cap at **6 total Codex reviews** (iter 1 fresh + at most 5 resumed fix rounds).

On cap-reached with blocking findings still open: FIRST capture the cap report details (iterations consumed, residual blocking findings, working tree left in documenter's latest state, all `reviewArtifacts[]` paths), THEN run teardown, THEN emit the named-loop report (**"hyper-docs-loop fix loop"**).

**Teardown is MANDATORY on EVERY exit path once the Step 4 teammate spawn has succeeded** — loop success, cap reached, and every post-spawn STOP: bridge failure, reply-contract failure, documenter format failure, unparseable review, plus any other unexpected tool error while the documenter teammate is live. Run teardown FIRST, then report/STOP — never before. (A failure *before* the Step 4 spawn — e.g. a target that won't resolve — owes no teardown: only an empty team exists; `TeamDelete({})` it and STOP.)

Exact procedure:

1. `SendMessage({ to: "documenter", message: { type: "shutdown_request" } })` — object message, no `summary`.
2. The documenter's `shutdown_response` / idle-termination notification arrives as a new turn — its arrival IS confirmed termination. Do not loop on a status check.
3. `TeamDelete({})`.

If `TeamDelete` fails because a member is still live → apply the recovery in `references/failure-protocol.md` §4.

### Step 9 — Final report

After successful teardown, report:

- All `reviewArtifacts[]` paths.
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking `### Findings` items (informational).
- All bullets from `### Gaps`, `### Broken Or Suspect Links`, `### Cross-Doc Inconsistencies` (informational — these sections are non-gating; the user resolves them manually).
- Any `resume-failed` / `fallback` rounds noted.
- Working-tree state: the documenter's edits are left **uncommitted**. Nothing was pushed. Next step: review the diff and commit it when ready.

## Anti-patterns

Core invariants (full list in `references/failure-protocol.md` §5):

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the documenter fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Committing or pushing from the documenter, or letting the documenter invoke codex or `scripts/codex-bridge.mjs`.
- Letting the documenter edit source code, tests, scripts, or config to make a doc claim "true". The doc is what changes; if the doc was actually right, the documenter reports `status: not-applicable` with a `notes:` reason.
- Changing `docs_target` mid-run. The same `--docs-path` / `--docs-dir` argv pair is REQUIRED on every iteration (including resumes — the bridge enforces this).
- Auto-fixing items from `### Gaps`, `### Broken Or Suspect Links`, or `### Cross-Doc Inconsistencies`. Only `### Findings` drives fix rounds; the other sections need human judgment and are reported in Step 9 only.
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the documenter is down; stopping silently at the cap.
- Editing `hyper-docs-review` or `hyper-docs-sync`. This skill is purely additive.
- Inlining the shared §E pseudo-code into this SKILL.md instead of pointing at `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E. SKILL.md is the always-loaded surface — duplicating §E bloats every trigger and risks the two copies drifting.
- Letting the documenter omit the `request-id: <id>` first-line prefix on any post-spawn reply; treating any non-`request-id:` reply (or one with a wrong id) as success. The prefix is the loop's id-classification step; without it, the anchored gate fails.
- Editing `agents/documenter.md` to encode the `request-id: <id>` requirement or the structured findings schema. The prefix and schema are loop-specific and live ONLY in this SKILL.md's Step 4 spawn-prompt contract. The documenter stays a general-purpose, loop-agnostic agent (still primarily dispatched by `hyper-docs-sync` for its UPDATE/CREATE mode).
