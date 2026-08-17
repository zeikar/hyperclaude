# hyper-docs-loop — failure & recovery protocol

Operational backstops for `hyper-docs-loop`. The shared cross-loop protocol (spawn contract, reply transport, corrective/transport-failure skeleton, shared anti-patterns) lives in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`. This file is the docs-loop's binding layer: the agent role (`documenter`), the structured per-finding reply schema, the schema-gate accept rule, the semantic finding-map post-acceptance validation, the named reports, what a transport failure preserves, and the docs-loop-specific anti-patterns. SKILL.md Step 0 Reads BOTH files.

## Binding declarations

- **Agent role:** `documenter` — spawned once at SKILL.md Step 5 as `subagent_type: "hyperclaude:documenter"`, lazily, on the FIRST round that carries blocking `### Findings`; every later round is addressed to the captured `agent_id`. A run Codex clears on its first review spawns none. It is the same agent `hyper-docs-sync` dispatches for UPDATE/CREATE mode; the loop's spawn-prompt contract overrides the dispatch context to this loop's structured-findings mode.
- **Reply shape:** the structured findings-map schema — for EVERY cited finding, its own `finding:` / `status:` / `files-changed:` / `verification:` / `notes:` block, delivered as the documenter's FINAL TEXT. There is no output file.
- **Accept rule (schema gate):** a documenter reply **FAILS** if any of the following are true:
  - It has no per-finding block (the structured-schema fields are entirely absent).
  - It is missing a block for any cited finding.
  - Any `status:` value is not exactly `fixed` or `not-applicable` (no synonyms, no extra words).
  - A `notes:` field is omitted when `status: not-applicable` (the reason is required; an empty or missing `notes:` fails the gate).

  Small extra prose (a one-line summary, a brief comment before or after the blocks) is tolerated and does not fail the gate. A diff dump, patch block, or verbatim source-body echo FAILS the gate **even when all required schema fields are present** — the documenter's "No diff dump" rule is enforced here, not weakened. There is no single output-file path to verify: the gate applies to the reply structure only, and the lead performs no filesystem existence check here.
- **Post-acceptance validation:** the semantic finding-map check below (every cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason).
- **Named-loop-report strings:** `hyper-docs-loop reply-contract failure`, `hyper-docs-loop documenter format, iter N`, `hyper-docs-loop unparseable review, iter N`, `hyper-docs-loop bridge failure, iter N`, `hyper-docs-loop fix loop`, `hyper-docs-loop transport failure`.
- **Transport failure:** binds the shared transport-failure skeleton. This loop commits nothing, so whatever a run produced lives only in the working tree. Under **"hyper-docs-loop transport failure"**: PRESERVE any uncommitted doc edits exactly as the documenter left them (no restore, no re-spawn), surface them (`git status --short`), and point the user at `/hyperclaude:hyper-docs-review` + manual edits to finish the job. The two halves differ only in what ran:
  - A Step 5 spawn that **returns no usable `agent_id`** (an ambiguous failure counts here), or a later round's **failed `SendMessage`**: the documenter ran — the lazy spawn's own prompt carries that round's findings, and later rounds follow earlier rounds' edits — so it may already have edited the cited docs. Treat the docs tree as potentially mutated and report the edits as potentially present. Never assume the tree is unmodified.
  - A Step 5 spawn that **fails outright** is the same STOP under the same report name, but nothing ran and so this run produced no doc edits: state that plainly instead of implying edits that cannot exist.

  SKILL.md's spawn and fix-round failure branches point here rather than restating either half.

## Schema-gate correctives

The schema gate (declared above, applied at SKILL.md Step 5) is the accept condition for EVERY documenter reply: the first fix round's spawn `<result>`, any corrective redo, and every later round's `<result>`.

On any gate failure, send ONE corrective:

```
SendMessage({
  to: "<agent_id>",
  summary: "Reply contract: structured schema only",
  message: "<re-state: for every cited finding emit finding:/status:/files-changed:/verification:/notes: fields on their own lines; status must be exactly 'fixed' or 'not-applicable'; notes: is required when status: not-applicable; no diff dump, no patch block, no source-body echo; a small prose summary is tolerated but must not replace the schema>"
})
```

If the next reply still fails the gate → STOP (**"hyper-docs-loop reply-contract failure"**).

## Fix-validation redo pipeline (SKILL.md Step 5 failure handling)

**The ordered pipeline** every documenter reply must pass (named inline in SKILL.md Step 5): (1) **schema gate** → (2) **semantic finding-map check**: the lead reads the documenter reply and confirms that EVERY cited blocking finding maps to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason. A corrective redo re-enters the pipeline from the schema gate — never "just the finding-map check". The budget is per stage: exactly ONE corrective redo each, then STOP.

There is **NO git-working-tree / no-op / `.bak` / restore mechanism**. A documenter that applies no real change is bounded by the Step 6 cap (the loop re-reviews and re-issues findings until convergence or the cap, then STOPs with the cap report) — reasserting a git-diff gate here is an anti-pattern and is intentionally not a separate failure path.

**Gate failure in Step 5:** apply the corrective + escalation above (escalating to **"hyper-docs-loop reply-contract failure"** if it still fails).

**Semantic finding-map check (stage 2 of the pipeline):** the lead reads the documenter reply in context and verifies that each cited blocking finding is accounted for. If one or more findings are unmet (status missing, or `fixed` but the lead judges the explanation impossible, or the required `notes:` for `not-applicable` is absent or empty): send ONE corrective `SendMessage` to `agent_id`, re-issuing only the unmet findings and instructing the documenter to address them. Its reply re-enters the FULL pipeline: schema gate → semantic finding-map check. If the redo still fails the semantic check → STOP (**"hyper-docs-loop documenter format, iter N"**), surfacing the unmet findings for manual triage. The loop does NOT auto-restore — the docs tree is left as the documenter last touched it.

**Invalid-finding path:** a finding the documenter returns as `not-applicable` with a non-empty `notes:` reason is treated as **addressed** for gate purposes and does not block the loop. The next Codex re-review is the arbiter: if Codex drops the finding the loop continues normally; if Codex re-raises it, it re-enters the normal loop and counts toward the cap.

## Anti-patterns (docs-loop specific)

The cross-loop anti-patterns (passing `name:` at spawn, re-spawning fresh each round, reviewer-as-agent, inlining the shared contract) live in `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md`.

Docs-loop-specific:

- Committing or pushing from the documenter. The documenter touches only the working tree; the orchestrating skill decides when to commit.
- Letting the documenter invoke codex or `scripts/codex-bridge.mjs`. The documenter never acts as reviewer.
- Letting the documenter edit source code, tests, scripts, or config files to make a doc claim "true". The doc is what changes; if the doc was actually right, the documenter reports `status: not-applicable` with a `notes:` reason.
- Changing `docs_target` mid-run — substituting one `--docs-path` for another, swapping `--docs-path` for `--docs-dir`, or omitting it on a resumed iteration. `docs_target` is the fixed, invariant loop target every iteration; the bridge requires it on resume too.
- Auto-fixing items from `### Gaps`, `### Broken Or Suspect Links`, or `### Cross-Doc Inconsistencies`. Only `### Findings` drives fix rounds; the other three sections are reported in the final Step 7 summary and resolved by the user manually. Sending those items to the documenter as if they were `### Findings` is a scope violation of this loop's contract.
- Reasserting a git-state / no-op gate. A stuck or no-change documenter is bounded by the Step 6 cap — a separate no-op detection path is an anti-pattern.
- Gating on label vocabulary instead of meaning. Classify by MEANING regardless of label: a `### Findings` item blocks if it concerns accuracy / drift / actively misleading claims, regardless of the severity label Codex assigned; pure style/nits do not block.
- Treating a `resume-failed` or `fallback` round as invalid. Such a round is still a valid loop iteration and counts toward the cap, but it MUST be flagged in the final report so the human can assess continuity.
- Editing `hyper-docs-review` or `hyper-docs-sync`. This skill is purely additive.
