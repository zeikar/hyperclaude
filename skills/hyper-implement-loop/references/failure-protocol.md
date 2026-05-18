# hyper-implement-loop — failure & recovery protocol

Operational backstops for `hyper-implement-loop`. SKILL.md carries the happy path and decision points; this file carries the recovery procedures invoked at those points. The lead Reads this file once at Step 0 so the full protocol is in context for the whole run. Follow each section exactly when its condition arises — these are load-bearing, not optional troubleshooting.

## §1 — Anchored reply gate: corrective + escalation

The anchored reply gate (SKILL.md Step 7) is the accept condition for EVERY fixer reply to a Step 7 findings `SendMessage` (the first fix round, any retry, and every Step 7 redo). The spawn-time state carries no deliverable and is governed by §2, not this gate. The gate is evaluated BEFORE the §3 semantic finding-map check. A fixer reply **FAILS** the anchored gate if any of the following are true:

- It has no per-finding block (the structured-schema fields are entirely absent).
- It is missing a block for any cited finding (every cited finding must have its own `finding:` / `status:` / `files-changed:` / `verification:` / `notes:` block).
- Any `status:` value is not exactly `fixed` or `not-applicable` (no synonyms, no extra words).
- A `notes:` field is omitted when `status: not-applicable` (the reason is required; an empty or missing `notes:` fails the gate).

Small extra prose (a one-line summary, a brief comment before or after the blocks) is tolerated and does not fail the gate. A diff dump, patch block, or verbatim source-body echo FAILS the gate **even when all required schema fields are present** — the fixer's "No diff dump" rule is enforced here, not weakened.

There is no single output-file path to verify. The gate applies to the fixer's reply structure only — the lead does not perform a filesystem existence check here.

On any gate failure, send ONE corrective message:

```
SendMessage({
  to: "fixer",
  summary: "Reply contract: structured schema only",
  message: "<re-state: for every cited finding emit finding:/status:/files-changed:/verification:/notes: fields on their own lines; status must be exactly 'fixed' or 'not-applicable'; notes: is required when status: not-applicable; no diff dump, no patch block, no source-body echo; small prose summary is tolerated but must not replace the schema>"
})
```

If the next reply still fails the anchored gate → Step 8 teardown, then STOP (**"hyper-implement-loop reply-contract failure"**).

## §2 — Lead-side unsolicited-message protocol

This is an operational backstop for the Step 4 idle/no-resend prompt instruction. Prompt-only discipline is **insufficient**; this lead-side rule is **mandatory**.

**Scope:** applies ONLY while the fixer is active and BEFORE Step 8 teardown has begun. It EXEMPTS the teardown exchange — once the lead has sent `shutdown_request`, the fixer's `shutdown_response` / idle-termination notification is EXPECTED, not unsolicited, and is never a violation.

Within scope, the only fixer message the lead expects is the anchored structured-schema reply to the lead's most recent SendMessage (spawn, redo, or corrective). Any other inbound fixer message — a duplicate body, a `RESEND:`-style re-emit, a nag, or anything arriving when the lead solicited nothing (including a message auto-delivered after a long Codex-review turn) — is **unsolicited**. The lead ignores its content and sends ONE message:

```
SendMessage({
  to: "fixer",
  summary: "Idle until contacted",
  message: "<remain idle; DO NOT reply to this message; do not resend; wait for the next code-review findings or a shutdown_request>"
})
```

After that single idle correction, a short content-free acknowledgment (e.g. "ok, waiting") is tolerated and ignored ONCE — not a violation, as long as it carries no finding blocks, no `RESEND:`, and no nag. A SECOND substantive unsolicited message of the same kind (schema body / `RESEND:` / nag) → Step 8 teardown, then STOP (**"hyper-implement-loop reply-contract failure"**).

## §3 — Fix-validation redo pipeline (Step 7 failure handling)

**The ordered pipeline** every fixer reply must pass (this order is named inline in SKILL.md Step 7): (1) **anchored structured-schema reply gate** (§1) → (2) **semantic finding-map check**: the lead reads the fixer reply and confirms that EVERY cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason.

There is **NO git-working-tree / no-op / `.bak` / restore mechanism**. A fixer that applies no real change is bounded by the Step 8 cap (the loop re-reviews and re-issues findings until convergence or the cap, then STOPs with the cap report) — reasserting a git-diff gate here is an anti-pattern and is intentionally not a separate failure path.

**Gate failure in Step 7:** apply §1 (initial corrective + escalation to **"hyper-implement-loop reply-contract failure"** via Step 8 teardown if it still fails).

**Semantic finding-map check (step 2 of the pipeline):** the lead reads the fixer reply in context and verifies that each cited blocking finding is accounted for. If one or more findings are unmet (status missing, or `fixed` but the lead judges the explanation impossible, or the required `notes:` for `not-applicable` is absent or empty): send ONE corrective `SendMessage` (with `summary`) re-issuing only the unmet findings and instructing the fixer to address them. The redo reply re-enters the FULL pipeline from step (1): anchored gate → semantic finding-map check. If the redo still fails the semantic check → Step 8 teardown, then STOP (**"hyper-implement-loop fixer format, iter N"**), surfacing the unmet findings for manual triage. The loop does NOT auto-restore — the code tree is left as the fixer last touched it.

**Invalid-finding path:** a finding the fixer returns as `not-applicable` with a non-empty `notes:` reason is treated as **addressed** for gate purposes and does not block the loop. The next Codex re-review is the arbiter: if Codex drops the finding the loop continues normally; if Codex re-raises it, it re-enters the normal loop and counts toward the cap.

## §4 — Teardown recovery (Step 8 `TeamDelete` failure)

If `TeamDelete` fails because a member is still live: send `shutdown_request` once more, then retry `TeamDelete` a single time. If it STILL fails, STOP with a named-loop report (**"hyper-implement-loop teardown"**) surfacing the verbatim `TeamDelete` error and the run's team name, stating the team may still be live. Do NOT instruct manual deletion of internal team state (`~/.claude/teams/<team-name>/` is internal — unsupported, and deleting it does not terminate a live teammate).

## §5 — Anti-patterns (full list)

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the fixer fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Committing or pushing from the fixer. The fixer touches only the working tree; the orchestrating skill decides when to commit.
- Letting the fixer invoke codex or `scripts/codex-bridge.mjs`. The fixer never acts as reviewer.
- Varying the diff target across rounds — substituting `--commit <sha>`, or omitting/changing `--base main`. `--base main` is the fixed, invariant loop target every iteration (a changing `--commit` SHA breaks `--resume` identity).
- Reasserting a git-state / no-op gate. A stuck or no-change fixer is bounded by the Step 8 cap — a separate no-op detection path is an anti-pattern.
- Gating on label vocabulary instead of meaning. Fresh `code-review` is now templated and emits `### Findings` Blocker/Major/Minor bullets + `### Verdict`. Classify by MEANING regardless of label: a finding blocks if it concerns correctness, data loss, security, a broken build/tests, a regression, or missing required behavior, regardless of the severity label Codex assigned; pure style/nits do not block.
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the fixer is down. Shutdown first; `TeamDelete` fails while a member is live.
- Stopping silently at the cap. Always emit the named cap report (after teardown).
- Editing `hyper-implement` or `hyper-plan-loop`. This skill is purely additive.
- Treating a `resume-failed` or `fallback` round as invalid. Such a round is still a valid loop iteration and counts toward the cap, but it MUST be flagged in the final report so the human can assess continuity.
