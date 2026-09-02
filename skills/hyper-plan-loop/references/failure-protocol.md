# hyper-plan-loop — failure & recovery protocol

Operational backstops for `hyper-plan-loop`, and its complete binding layer: the planner backend, the reply shape (`WROTE: <path>`), the exact-path accept rule, the file/structure post-acceptance validation, the named reports, what a transport failure preserves, and the plan-loop-specific anti-patterns. SKILL.md Step 0 Reads this file alone — the cross-loop `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` governs the `Agent`-tool transport, which this loop no longer uses.

## Binding declarations

- **Planner backend:** a persistent `claude -p` session run through `scripts/planner-bridge.mjs`, keyed by the Step 1 plan-file stem (the resolved plan path minus `.md`; the bare slug collides across tasks). Started at SKILL.md Step 2 and resumed by every later call for that key — correctives included. The lead holds no session id; the bridge owns it, and Step 8 discards it with `--end`.
- **Reply shape:** exactly `WROTE: <path>` — a single line, nothing else.
- **Accept rule:** the trimmed reply must match `^WROTE: <exact resolved plan path from Step 1>\s*$` (path = the entire remaining string, verbatim) plus the no-prose / no-preamble / no-body-echo rule. On any body echo, added prose, preamble, or a different path → the corrective + escalation below.
- **Post-acceptance validation:** the file/structure check — `[ -s "<resolved plan path>" ]` for existence + the `node -e ...^##\s*Task\s` regex one-liner from SKILL.md Step 6.
- **Named-loop-report strings:** `hyper-plan-loop reply-contract failure`, `hyper-plan-loop planner-write failure`, `hyper-plan-loop planner format, iter N`, `hyper-plan-loop transport failure`.
- **Transport failure:** any `ok:false` envelope, non-zero bridge exit, or unparseable stdout. Always a STOP with **"hyper-plan-loop transport failure"**. What the report may claim is decided by the envelope's **`spawned`** field, NOT by which step failed — a non-zero exit, an `is_error` reply, or malformed JSON can all arrive *after* the planner has already written the plan in write-file mode.
  - **`spawned: true`** (or the field absent, which is treated as `true`) — the planner ran and the plan file may have been created or modified. Leave the FILE exactly as it is: no restore. Surface the resolved plan path from Step 1 so the user can inspect whatever was written. This covers every Step 6 failure and every Step 2 failure that got as far as running `claude`. A `resumed:false` on a Step 6 revise belongs here too: the session was lost, so the planner no longer holds the task.
  - **`spawned: false`** — the bridge never started `claude` (argv error, unreadable prompt file, `claude` not on PATH). Only here may the report state that nothing was written this run; name the manual fallback (`/hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review`) instead of surfacing a path this run did not produce.

  Unparseable stdout is the one case where `spawned` cannot be read. Treat it as `spawned: true` — assume the plan may have been touched.

  **A STOP ends the session** before reporting — with one exception, below:

  ```bash
  node "${CLAUDE_PLUGIN_ROOT}/scripts/planner-bridge.mjs" --workflow "<plan-file stem from Step 1>" --end
  ```

  The planning workflow is over either way, and a re-run resolves a new plan path — new timestamp, or a `-2` suffix — and therefore a new key, so a retained session is one nothing can ever resume. Report a non-`ok` `--end` alongside the STOP rather than suppressing it; it means the session file is still on disk.

  Whenever a failure envelope carries a **`cleanup`** field, surface it verbatim in the report: it means a session mapping the bridge tried to remove is still on disk, and a later run that resolves the same key will collide on it.

  **Exception — a STOP on a failed Step 2 `--start` never runs `--end`.** A `--start` fails either because the bridge already released the id it minted, or because the key was already taken — and in that second case the session belongs to a DIFFERENT run whose planner is still live. `--end` cannot tell the two apart (it holds no session id to check ownership against), so calling it there would delete the other workflow's mapping and strand its planner at its next round. Report the STOP and leave the key alone.

  SKILL.md's Step 2 and Step 6 failure branches point here rather than restating either half.

## Reply-contract correctives

The accept rule (declared above, applied at SKILL.md Step 3) is the accept condition for EVERY planner reply in write-file mode: the initial write, any redo, and every Step 6 revise.

On any body echo, added prose, preamble, or a different path, send ONE corrective:

```bash
PROMPT_FILE='<scratchpad path carrying the corrective, POSIX-escaped>'
node "${CLAUDE_PLUGIN_ROOT}/scripts/planner-bridge.mjs" --workflow "<plan-file stem from Step 1>" --prompt-file "$PROMPT_FILE"
```

The corrective text re-states: use Write or Edit to update the plan at the exact resolved path; reply with exactly `WROTE: <that exact path>` and nothing else — no plan body, no prose, no preamble.

If the next reply still fails the accept rule → STOP (**"hyper-plan-loop reply-contract failure"**).

**File check failure (only reached after the accept rule passes):** if `[ -s "<resolved plan path>" ]` shows the file missing or empty, send ONE corrective:

```bash
PROMPT_FILE='<scratchpad path carrying the corrective, POSIX-escaped>'
node "${CLAUDE_PLUGIN_ROOT}/scripts/planner-bridge.mjs" --workflow "<plan-file stem from Step 1>" --prompt-file "$PROMPT_FILE"
```

The corrective text states: the file at `<resolved plan path>` is missing or empty; use Write to write the full plan to that exact path; reply with exactly `WROTE: <that exact path>` and nothing else.

Its reply re-enters the accept rule. If the file is still missing or empty after that → STOP (**"hyper-plan-loop planner-write failure"**).

## Revise-validation redo pipeline (SKILL.md Step 6 failure handling)

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

**The ordered pipeline** every revise reply must pass (named inline in SKILL.md Step 6): (1) **accept rule** → (2) **structure `ok`/`bad` check**. A corrective redo re-enters the FULL pipeline in that same order — never "just the structure check". The retry budget: exactly ONE corrective redo, then STOP — and that single redo must pass the full pipeline.

There is no no-op / unchanged-plan detection. A planner that replies `WROTE:` but applies no real revision is bounded by the Step 7 cap (the loop re-reviews and re-revises until convergence or the cap, then STOPs with the cap report) — this is intentionally not a separate failure path.

**Accept-rule failure in Step 6:** apply the corrective + escalation above (escalating to **"hyper-plan-loop reply-contract failure"** if it still fails).

**Structure check (stage 2 of the pipeline):** the SKILL.md one-liner prints only `ok` or `bad`. The try/catch in it is load-bearing: any read failure (the planner deleted or clobbered the canonical path) prints `bad` instead of throwing — so a missing/unreadable file routes through the corrective path here, not out as an unexpected tool error.

If `bad` (the planner clobbered the canonical path with malformed content, OR the file is missing/unreadable): send ONE corrective through the bridge (same `--workflow`, a new `--prompt-file`) instructing the planner to redo the revision and re-Write (or Edit) the exact resolved plan path, requiring a reply of exactly `WROTE: <that exact path>`. That corrective's reply re-enters the FULL pipeline: accept rule → structure `ok`/`bad` check. If the redo is still `bad` at the structure step → STOP (**"hyper-plan-loop planner format, iter N"**), surfacing the resolved plan path for manual triage. The loop does NOT auto-restore — the plan file is left as the planner last wrote it; `/hyperclaude:hyper-plan` regenerates it in one step. Only Read the full file into lead context for that human-facing failure diagnostic — never on the success path.

On `ok`: Step 6 increments the iteration, re-invokes the bridge with `--resume auto`, then loops back to Step 5.

## Anti-patterns (plan-loop specific)

Two cross-loop anti-patterns still apply in their bridge form: starting a fresh planner session each round (the `--workflow` key is what keeps one session — never mint a second for the same workflow), and reviewer-as-planner (Codex reviews; the planner revises; never merge the roles).

Plan-loop-specific:

- Accepting an existing-plan-path argument. Not a v1 input mode — `$ARGUMENTS` is a task description only.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Reading the plan body into lead context each revise round. Use the quiet `ok`/`bad` check — Read-caching the body reintroduces the token cost this skill removes.
- Accepting any non-`WROTE:` reply (body echo, prose, preamble, wrong path) as success. The accept rule is exact-match only.
- Proceeding to Codex review on a `bad` (malformed) just-written file instead of running the revise-validation corrective + terminal STOP first.
- Writing the wrong base path. The resolved plan path is a Step 1 concept — the spawn passes it to the planner verbatim; never re-derive it in a later step.
- Treating non-blocking findings as revise targets. SKILL.md Step 5 classifies by **meaning** (correctness, wrong paths, broken ordering, unverifiable steps, missing required behavior) — pure style nits, vague "consider X" suggestions, and prose-polish do NOT gate the loop regardless of which severity word Codex attached. Trust the meaning judgment; do not invent revisions for non-blocking findings.
- Omitting `--plan-path` or `--resume auto` on iteration 2+. `--plan-path` is required every iteration; `--resume auto` from iteration 2 onward.
- Stopping silently at the cap. Always emit the named cap report.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
