# hyper-plan-loop — failure & recovery protocol

Operational backstops for `hyper-plan-loop`. SKILL.md carries the happy path and decision points; this file carries the recovery procedures invoked at those points. The lead Reads this file once at Step 0 so the full protocol is in context for the whole run. Follow each section exactly when its condition arises — these are load-bearing, not optional troubleshooting.

## §1 — Anchored reply gate: corrective + escalation

The anchored reply gate (SKILL.md Step 4) is the accept condition for EVERY planner reply in write-file mode (initial write, any retry, every Step 7 revise redo). The gate definition stays in SKILL.md; this section is the failure handling.

On any body echo, added prose, preamble, or a different path, send ONE corrective message:

```
SendMessage({
  to: "planner",
  summary: "Reply contract: WROTE: <path> only",
  message: "<re-state: use Write to write the full plan to the exact resolved path; reply with exactly 'WROTE: <that exact path>' and nothing else — no plan body, no prose, no preamble>"
})
```

If the next reply still fails the anchored gate → Step 8 teardown, then STOP (**"hyper-plan-loop reply-contract failure"**).

**File check failure (only reached after the gate passes):** if `[ -s "<resolved plan path>" ]` shows the file missing or empty, send ONE corrective `SendMessage` (with `summary`) instructing the planner to Write the exact resolved path again — its reply re-enters the same anchored gate above. If it is still missing or empty after that → Step 8 teardown, then STOP (**"hyper-plan-loop planner-write failure"**).

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

## §3 — Revise-validation redo pipeline (Step 7 failure handling)

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Preservation and validation are filesystem-level only.

**The ordered pipeline** every revise reply must pass (this order is named inline in SKILL.md Step 7): (1) **anchored reply gate** (§1) → (2) **`cmp -s` no-op compare vs `.bak`** → (3) **structure `ok`/`bad` check**. EVERY corrective redo in this step — the no-op corrective AND the `bad`/malformed corrective — re-enters this FULL pipeline from step (1) in this exact order. A redo is never "just the gate" or a partial check. The retry budget: exactly ONE corrective redo per failure kind, then STOP via Step 8 teardown — but that single redo must pass the full validation pipeline, not a partial check. Because `.bak` is only `rm`'d on the `ok` success path or after terminal teardown, it still exists on every redo path, so the `cmp -s` compare is valid for the redo too.

**Gate failure in Step 7:** apply §1 (initial corrective + escalation to **"hyper-plan-loop reply-contract failure"** via Step 8 teardown if it still fails).

**No-op revise (step 2 of the pipeline, after the gate passes):** `cmp -s "<resolved plan path>" "<resolved plan path>.bak"` exit 0 = byte-identical = the planner replied `WROTE:` but applied NO revision. On byte-identical, send ONE corrective:

```
SendMessage({ to: "planner", summary: "Revision not applied — file unchanged", message: "<you replied WROTE: but the plan file is byte-identical to before; actually apply the Blocker/Major revisions and re-Write the exact resolved plan path; reply with exactly 'WROTE: <that exact path>' and nothing else>" })
```

That corrective's reply re-enters the FULL pipeline from step (1): anchored reply gate → `cmp -s` no-op compare vs `.bak` → structure `ok`/`bad` check. If the redo is STILL byte-identical at the `cmp -s` step → this is a planner-write failure: Step 8 teardown, then STOP (**"hyper-plan-loop no-op revise"**). The `.bak` equals the canonical file so no restore is needed; `rm "<resolved plan path>.bak"` AFTER teardown to avoid stale-backup clutter (consistent with the terminal-cleanup rule).

Only when the file genuinely differs from `.bak` do you proceed to the structure check. A real change that is `bad`/malformed still follows the restore-from-`.bak` logic below.

**Structure check (step 3 of the pipeline):** the SKILL.md one-liner prints only `ok` or `bad`. The try/catch in it is load-bearing: any read failure (the planner deleted or clobbered the canonical path) prints `bad` instead of throwing — so a missing/unreadable file routes through the restore-from-`.bak` path here, not to teardown as an unexpected tool error that would leave the canonical file missing.

If `bad` (the planner clobbered the canonical path with malformed content, OR the file is missing/unreadable): restore via `cp "<resolved plan path>.bak" "<resolved plan path>"`, then send ONE corrective `SendMessage` (with `summary`) instructing the planner to redo the revision. That corrective's reply re-enters the FULL pipeline from step (1): anchored reply gate → `cmp -s` no-op compare vs `.bak` → structure `ok`/`bad` check. If the redo is still `bad` at the structure step → `cp "<resolved plan path>.bak" "<resolved plan path>"` again, then Step 8 teardown, then STOP (**"hyper-plan-loop planner format, iter N"**) with the canonical path holding the restored last-valid plan. On that terminal STOP-after-restore path, `rm "<resolved plan path>.bak"` only AFTER the restore `cp` has succeeded — never before the restore is confirmed.

Only Read the full file into lead context for human-facing failure diagnostics — never on the success path. (Residual risk: a transient malformed file exists on disk until the immediate `cp` restore — acceptable, since the lead never proceeds to review on a `bad` file.)

On `ok`: delete the backup (`rm "<resolved plan path>.bak"`) and continue Step 7's happy path (increment iteration, re-invoke the bridge with `--resume auto`).

## §4 — Teardown recovery (Step 8 `TeamDelete` failure)

If `TeamDelete` fails because a member is still live: send `shutdown_request` once more, then retry `TeamDelete` a single time. If it STILL fails, STOP with a named-loop report (**"hyper-plan-loop teardown"**) surfacing the verbatim `TeamDelete` error and the run's team name, stating the team may still be live. Do NOT instruct manual deletion of internal team state (`~/.claude/teams/<team-name>/` is internal — unsupported, and deleting it does not terminate a live teammate).

## §5 — Anti-patterns (full list)

- Making the reviewer a team agent. The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
- Re-spawning the planner fresh each iteration. Context-reuse via the live teammate is the entire reason this skill exists.
- Accepting an existing-plan-path argument. Not a v1 input mode — `$ARGUMENTS` is a task description only.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Reading the plan body into lead context each revise round. Use `cp` backup + the quiet `ok`/`bad` check — Read-caching the body reintroduces the token cost this skill removes.
- Accepting any non-`WROTE:` reply (body echo, prose, preamble, wrong path) as success. The anchored gate is exact-match only.
- Accepting a revise `WROTE:` whose file is byte-identical to the pre-revise `.bak` — the loop would re-review an unchanged plan until the cap; detect the no-op and treat it as a planner-write failure.
- Treating prompt-only idle discipline as sufficient. The lead-side unsolicited-message rule (§2) is mandatory.
- Proceeding to Codex review on a `bad` (malformed) just-written file instead of `cp`-restoring the last-valid plan first.
- Writing the wrong base path. The resolved plan path is a Step 1 concept; Step 2 is team creation only — never derive the path from Step 2.
- Treating Minor findings as blocking. Only Blocker/Major gate the loop.
- Omitting `--plan-path` or `--resume auto` on iteration 2+. `--plan-path` is required every iteration; `--resume auto` from iteration 2 onward.
- Stopping silently at the cap. Always emit the named cap report (after teardown).
- Skipping `shutdown_request` + `TeamDelete`, or calling `TeamDelete` before the teammate is down. Shutdown first; `TeamDelete` fails while a member is live.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
