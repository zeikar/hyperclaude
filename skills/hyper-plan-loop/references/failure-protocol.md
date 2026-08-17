# hyper-plan-loop — failure & recovery protocol

Operational backstops for `hyper-plan-loop`. The shared cross-loop protocol (spawn contract, reply transport, corrective/transport-failure skeleton, shared anti-patterns) lives in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`. This file is the plan-loop's binding layer: the agent role (`planner`), the reply shape (`WROTE: <path>`), the exact-path accept rule, the file/structure post-acceptance validation, the named reports, what a transport failure preserves, and the plan-loop-specific anti-patterns. SKILL.md Step 0 Reads BOTH files.

## Binding declarations

- **Agent role:** `planner` — spawned once at SKILL.md Step 2 as `subagent_type: "hyperclaude:planner"`; every later round is addressed to the captured `agent_id`.
- **Reply shape:** exactly `WROTE: <path>` — a single line, nothing else.
- **Accept rule:** the trimmed reply must match `^WROTE: <exact resolved plan path from Step 1>\s*$` (path = the entire remaining string, verbatim) plus the no-prose / no-preamble / no-body-echo rule. On any body echo, added prose, preamble, or a different path → the corrective + escalation below.
- **Post-acceptance validation:** the file/structure check — `[ -s "<resolved plan path>" ]` for existence + the `node -e ...^##\s*Task\s` regex one-liner from SKILL.md Step 6.
- **Named-loop-report strings:** `hyper-plan-loop reply-contract failure`, `hyper-plan-loop planner-write failure`, `hyper-plan-loop planner format, iter N`, `hyper-plan-loop transport failure`.
- **Transport failure:** covers both halves of the shared transport-failure rule, which differ only in what ran.
  - A Step 2 spawn that **returns no usable `agent_id`**, or a later round's **failed `SendMessage`**, is a STOP with **"hyper-plan-loop transport failure"**. The planner ran, so the plan is left exactly as it last wrote it — no restore, no re-spawn — and the report surfaces the resolved plan path from Step 1 so the user can inspect whatever was written.
  - A Step 2 spawn that **fails outright** is the same STOP under the same report name, but nothing was spawned and so nothing was written this run: state that plainly instead of surfacing a path this run did not produce, and name the manual fallback (`/hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review`).

  SKILL.md's spawn and revise failure branches point here rather than restating either half.

## Reply-contract correctives

The accept rule (declared above, applied at SKILL.md Step 3) is the accept condition for EVERY planner reply in write-file mode: the initial write, any redo, and every Step 6 revise.

On any body echo, added prose, preamble, or a different path, send ONE corrective:

```
SendMessage({
  to: "<agent_id>",
  summary: "Reply contract: WROTE: <path> only",
  message: "<re-state: use Write or Edit to update the plan at the exact resolved path; reply with exactly 'WROTE: <that exact path>' and nothing else — no plan body, no prose, no preamble>"
})
```

If the next reply still fails the accept rule → STOP (**"hyper-plan-loop reply-contract failure"**).

**File check failure (only reached after the accept rule passes):** if `[ -s "<resolved plan path>" ]` shows the file missing or empty, send ONE corrective:

```
SendMessage({
  to: "<agent_id>",
  summary: "File not written — re-Write at exact path",
  message: "<the file at <resolved plan path> is missing or empty; use Write to write the full plan to that exact path; reply with exactly 'WROTE: <that exact path>' and nothing else>"
})
```

Its reply re-enters the accept rule. If the file is still missing or empty after that → STOP (**"hyper-plan-loop planner-write failure"**).

## Revise-validation redo pipeline (SKILL.md Step 6 failure handling)

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

**The ordered pipeline** every revise reply must pass (named inline in SKILL.md Step 6): (1) **accept rule** → (2) **structure `ok`/`bad` check**. A corrective redo re-enters the FULL pipeline in that same order — never "just the structure check". The retry budget: exactly ONE corrective redo, then STOP — and that single redo must pass the full pipeline.

There is no no-op / unchanged-plan detection. A planner that replies `WROTE:` but applies no real revision is bounded by the Step 7 cap (the loop re-reviews and re-revises until convergence or the cap, then STOPs with the cap report) — this is intentionally not a separate failure path.

**Accept-rule failure in Step 6:** apply the corrective + escalation above (escalating to **"hyper-plan-loop reply-contract failure"** if it still fails).

**Structure check (step 2 of the pipeline):** the SKILL.md one-liner prints only `ok` or `bad`. The try/catch in it is load-bearing: any read failure (the planner deleted or clobbered the canonical path) prints `bad` instead of throwing — so a missing/unreadable file routes through the corrective path here, not out as an unexpected tool error.

If `bad` (the planner clobbered the canonical path with malformed content, OR the file is missing/unreadable): send ONE corrective `SendMessage` to `agent_id` instructing the planner to redo the revision and re-Write (or Edit) the exact resolved plan path, requiring a reply of exactly `WROTE: <that exact path>`. That corrective's reply re-enters the FULL pipeline: accept rule → structure `ok`/`bad` check. If the redo is still `bad` at the structure step → STOP (**"hyper-plan-loop planner format, iter N"**), surfacing the resolved plan path for manual triage. The loop does NOT auto-restore — the plan file is left as the planner last wrote it; `/hyperclaude:hyper-plan` regenerates it in one step. Only Read the full file into lead context for that human-facing failure diagnostic — never on the success path.

On `ok`: Step 6 increments the iteration, re-invokes the bridge with `--resume auto`, then loops back to Step 5.

## Anti-patterns (plan-loop specific)

The cross-loop anti-patterns (passing `name:` at spawn, re-spawning fresh each round, reviewer-as-agent, inlining the shared contract) live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`.

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
