---
name: hyper-plan-loop
description: Use when a plan should be produced and critic-hardened in one gesture — plan → Codex review → revise, repeated until clean. Also when the user invokes /hyperclaude:hyper-plan-loop. For manual round-by-round control use /hyperclaude:hyper-plan + /hyperclaude:hyper-plan-review instead.
---

# hyper-plan-loop

Autonomous plan-hardening gate. Spawns the `planner` agent once, has it write its plan to `.hyperclaude/plans/<YYYYMMDD-HHMM>-<slug>.md`, runs Codex `plan-review` through the bridge, and revises via the still-live planner until Codex returns no blocking findings (judged by meaning, not Codex severity labels) or the cap is hit. The planner is spawned **once**; every revise round reuses its retained context. The reviewer is always the Codex bridge, never an agent — this preserves the "Claude builds, Codex reviews" invariant.

## When to use

- User typed `/hyperclaude:hyper-plan-loop <task>`.
- User wants an autonomous plan → review → revise cycle in a single gesture.

Skip when:
- The task is one step — dispatch the `implementer` agent directly (pass `run_in_background: false` for the result inline).
- You want hands-on control over each plan / review round — use `/hyperclaude:hyper-plan` + `/hyperclaude:hyper-plan-review` manually.

## Failure & recovery protocol — read first

`${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` carries the shared cross-loop protocol: **Spawn contract**, **Reply transport**, **Correctives and transport failures**, **Shared anti-patterns**. `references/failure-protocol.md` (sibling of this file) is the plan-loop binding layer: it names this loop's reply shape (`WROTE: <path>`), the exact-path accept rule, the post-acceptance file/structure validation, the named reports, and what a transport failure preserves. Step 0 makes Reading BOTH mandatory before the loop starts.

## Spawn & reply transport

See `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Spawn contract** for the `Agent` / `SendMessage` argument shapes, **Reply transport** for how each round's reply reaches the lead. Loop-specific bindings:

- **Plan ownership:** the planner writes the canonical plan file itself via caller-directed write-file mode (its Step 2 prompt carries the exact resolved path). The lead never Writes or Reads the plan body on the normal path — it does only a quiet `ok`/`bad` structure check, and only Reads the body for human-facing failure diagnostics. Every write-file-mode reply (initial write, corrective redo, revise) is gated to `WROTE: <path>`-only (Step 3 accept rule).

The lead must retain the following run-state across turns:

- `plan_path` — the resolved canonical plan path from Step 1.
- `agent_id` — the id returned by the Step 2 spawn, captured verbatim; the address for every later round.
- `review_iteration` — the Codex bridge re-invocation count the Step 7 cap bounds.
- `review_brief_file` — the scratchpad path holding the composed review brief (Step 1), or `null` when no admissible source exists. Retained across turns; distinct from the shell variable `BRIEF_FILE` assigned from it in each Step 4/6 bridge Bash call.

## How to invoke

**Invocation argument:** $ARGUMENTS

`$ARGUMENTS` is a **task description only**. There is NO existing-plan-path input mode — revision happens inside the loop. Resolution (mirrors stock `hyper-plan`):

- `$ARGUMENTS` non-empty → that is the task.
- `$ARGUMENTS` empty → fall back to the newest `.hyperclaude/research/*.md` (its `task:` frontmatter), or the user's most recent build/implement intent in this conversation.
- Nothing found → ask the user and STOP.

### Step 0 — Read the failure & recovery protocol

Read BOTH files before spawning: `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` (the shared spawn + reply transport) AND `references/failure-protocol.md` (sibling of this file — the plan-loop binding: reply shape, accept rule, validation stages, named reports, transport-failure declaration).

### Step 1 — Resolve task + slug + plan path

Reuse the stock `hyper-plan` logic — see `skills/hyper-plan/SKILL.md` Steps 1–2; do not duplicate the rule text. In brief:

1. Derive the canonical slug deterministically (lowercase, ASCII, alphanumerics + hyphen, first 5 words of the task joined by `-`).
2. Scan **all** `.hyperclaude/research/*.md` frontmatter `slug:` fields (the canonical key — not the filename). If one OR MORE equals the derived slug (there may be a Codex + Claude pair), treat ALL matching files as the linked research artifacts and inline the full contents of ALL of them as context in Step 2.
3. Resolve the plan path:

   ```bash
   mkdir -p .hyperclaude/plans
   date +%Y%m%d-%H%M
   ```

   Base path: `.hyperclaude/plans/<timestamp>-<slug>.md`. If it exists, append `-2`, `-3`, … until free.

4. **Compose the review brief (or record `null`).** Compose per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`. The admissible source here is `$ARGUMENTS` (the user's own task text) and decisions the user explicitly approved in this conversation — **never** the planner's plan output (Step 6 revises the plan every round; re-deriving the brief from it would let the planner bless its own scope additions). Record the resulting scratchpad path as `review_brief_file`, or `null` if no admissible source exists.

### Step 2 — Spawn the planner

Use the Agent tool with NO `name:` field. The full contract text below goes in the `prompt:` string (a populated `prompt` field — not a separate message):

```
Agent({
  subagent_type: "hyperclaude:planner",
  prompt: "<the contract string assembled from the bullets below>"
})
```

The `prompt` string MUST contain:

- **Task** — verbatim.
- **Research context** — full contents of ALL matched research artifacts inline (there may be a Codex + Claude pair), if any were found in Step 1, each labelled with its exact repo path so the planner can cite it. Do not make the planner re-read them.
- **Output format** — a multi-task plan with `## Task N: <title>` headings. Each task block: **Files to create / modify** (exact paths), **Steps** (`[ ]`-checkboxes, 2–5 min each), **Verification** (a command or observable change), **Commit message** (one line, conventional-commits). No frontmatter — plan body only; the skill owns the file name.
- **Write-file mode** — the exact resolved plan path from Step 1, stated literally, with an explicit instruction: use the `Write` tool to write the full plan to THAT EXACT path yourself (never a different path, never a `-v2.md` sibling), then reply with exactly `WROTE: <that exact path>` as your FINAL TEXT and NOTHING else — no plan body, no summary of changes, no preamble. This applies identically to every later round's reply.
- State that the planner stays live between rounds, will receive Codex feedback in later turns, and must retain its full planning context.

**After the `Agent(...)` call** — capture the returned `agent_id` verbatim into run-state; it addresses every later round.

Failure handling:

- **Spawn fails** → nothing ran this round. STOP per the transport-failure declaration in `references/failure-protocol.md`.
- **Spawn returns no usable `agent_id`** → the planner may still have written the plan (the spawn prompted the write). STOP per that same declaration.

### Step 3 — Confirm the planner wrote the plan

The lead never Writes the plan — the planner writes the canonical file itself (caller-directed write-file mode, Step 2). The lead only verifies.

Read the reply from the spawn's `<result>` (on a later round, from that round's `<result>`).

**Accept rule** — applies to EVERY planner reply in write-file mode (the initial write, any corrective redo, and every Step 6 revise): the trimmed reply must match `^WROTE: <exact resolved plan path from Step 1>\s*$`, where the path is the entire remaining string, verbatim. Any body echo, added prose, preamble, or a different path → corrective + escalation per `references/failure-protocol.md` (**Reply-contract correctives**).

**File check (only after the accept rule passes):** confirm the file is non-empty via the Bash tool:

```bash
[ -s "<resolved plan path>" ]
```

If missing or empty → apply the file-check corrective + escalation in `references/failure-protocol.md` (**Reply-contract correctives**).

**In-place rule:** every later revision overwrites THIS SAME path; never a `-v2.md` (or any other) sibling — the bridge's `--resume` keys on the plan path, and a new path breaks resume continuity.

### Step 4 — Plan-review iteration 1 (fresh)

**Iteration counting:** the fresh review here is **iteration 1**. The Step 7 cap is **10 total reviews** (iter 1 fresh + at most **9 resumed revise rounds**).

Invoke via the Bash tool with `timeout: 600000`. If `review_brief_file` is non-null, assign it to `BRIEF_FILE` per the shell-safety recipe in `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md` and append `--review-brief "$(cat "$BRIEF_FILE")"`; omit both when `review_brief_file` is `null`:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<resolved path>" [--review-brief "$(cat "$BRIEF_FILE")"]
```

Parse the bridge's single stdout JSON envelope per `${CLAUDE_PLUGIN_ROOT}/references/bridge-review-calls.md` (envelope shape + strict-parse rule). On `ok:true`, read the artifact at `path` with the Read tool.

On any non-`ok:true`, Bash timeout, or JSON parse failure → STOP with a named-loop report (**"hyper-plan-loop bridge failure, iter N"**) surfacing `error` verbatim (or a short parser/timeout diagnostic if no `error` field) plus the artifact path if present. If the artifact `Read` itself fails → STOP with that same named report.

### Step 5 — Severity gate

Read the artifact body and judge by **meaning**, not regex. The plan-review template emits `### Issues` with `- **Blocker** — …` / `- **Major** — …` / `- **Minor** — …` bullets plus `### Verdict` — but classify by meaning, not by the severity word Codex attached: a finding **blocks** if it concerns **plan-level correctness, wrong file paths, broken task ordering, unverifiable steps, or missing required behavior the implementer would inherit** (regardless of severity label). Pure **style / "consider X" / "could be slightly clearer" / vague nits do NOT block.**

- Any blocking finding → revise (Step 6).
- No blocking findings (style/nits only, or an approving verdict) → exit the loop and report (Step 8). Non-blocking findings are reported, never gating.

**Conservative branch:** if severity cannot be confidently judged by meaning (no recognizable `### Issues` / `### Verdict` structure, truncated body, etc.) — do NOT assume "no blocking findings": instead STOP with a named-loop report (**"hyper-plan-loop unparseable review, iter N"**) surfacing the artifact path for manual triage.

### Step 6 — Revise via the live planner, then re-review

First check the cap: if the iteration counter is already at 10 (10 total Codex reviews consumed), do NOT send findings or revise — go directly to Step 7 (cap reached).

The lead never Reads the plan body into its context here (that would reintroduce the token cost this skill is designed to avoid). Validation is filesystem-level only.

Send the blocking findings to the still-live planner:

```
SendMessage({
  to: "<agent_id>",
  summary: "Revise plan from Codex findings",
  message: "<verbatim blocking findings + relevant ### Verdict text when it explains the required direction; instruct: first Read <the exact resolved plan path> to refresh, then re-read the files, symbols, and commands the findings cite (Read/Grep) — and for a finding that names none, the tasks it implicates and the code that would have to change — so each fix is checked against the tree rather than recalled, then revise THAT SAME path in place (Edit it, or re-Write it), fixing each finding at its source rather than rewording the sentence that triggered it, and without adding a changelog of the round or a reply to the reviewer; reply with exactly 'WROTE: <that exact path>' and nothing else — no plan body, no preamble>"
})
```

Read the reply from that round's `<result>`. A `SendMessage` that fails → STOP per the transport-failure declaration in `references/failure-protocol.md`.

Do NOT re-send the task or research — the planner still holds that context.

**Revise-validation** — every revise reply must pass, in order: (1) **accept rule** (Step 3) → (2) **structure `ok`/`bad` check**. The single-redo budget, corrective wording, and terminal STOP are specified in `references/failure-protocol.md` (**Revise-validation redo pipeline**) — follow it verbatim. The structure check is a one-liner that prints only `ok` or `bad`:

```bash
node -e 'try{process.stdout.write(/^##\s*Task\s/m.test(require("fs").readFileSync(process.argv[1],"utf8"))?"ok":"bad")}catch{process.stdout.write("bad")}' "<resolved plan path>"
```

`bad` → corrective + terminal handling per that pipeline. On `ok`, increment the iteration counter and re-invoke the bridge via the Bash tool with `timeout: 600000`. Same `review_brief_file`-gated `BRIEF_FILE` assignment + `--review-brief` token as Step 4 — per `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`'s two re-supply reasons (fallback survival on an `auto`→fresh fallback, and mid-loop updates), re-pass it on every round; never regenerate `review_brief_file` from the planner's just-revised plan (that would let the planner bless its own scope additions) — only a NEW user decision may update it:

```bash
node "${CLAUDE_PLUGIN_ROOT}/scripts/codex-bridge.mjs" plan-review --plan-path "<same path>" --resume auto [--review-brief "$(cat "$BRIEF_FILE")"]
```

`--plan-path` is REQUIRED on every iteration including resumes (`plan-review --resume auto` alone is invalid). Always pass `--resume auto` from iteration 2 onward. Re-parse per Step 4's JSON rules, then loop back to Step 5.

### Step 7 — Cap

Cap at **10 total reviews** (iter 1 fresh + at most 9 resumed revise rounds).

On cap-reached, emit the named-loop report (**"hyper-plan-loop revise loop"**) directly, carrying the iterations consumed, the residual blocking findings from the latest review, and the plan path left in its latest revised state: the loop ran out of rounds before Codex stopped flagging plan-level correctness/path/ordering/missing-behavior issues. The plan path needs manual triage.

(Cap is only reachable via Step 6, which only runs when the latest review had blocking findings — so cap-reached always means "blocking findings still open." A run where Codex returns non-blocking-only at any iteration exits cleanly via Step 5 before the cap can trip.)

### Step 8 — Final report

Report:

- The plan path.
- Whether the slug was reused from research artifact(s) or freshly derived.
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking findings (informational, never gating).
- **Next step:**
  - Clean exit (loop converged) → recommend: `Next step: /hyperclaude:hyper-implement <plan path>`.
  - Cap-reached (blocking findings still open) → do NOT recommend implementation. Direct the user to inspect the plan path and decide whether to revise manually (via `/hyperclaude:hyper-plan` + `/hyperclaude:hyper-plan-review`) or re-run `/hyperclaude:hyper-plan-loop` with the original task description (this skill takes a task description, not an existing plan path).

## Anti-patterns

Cross-loop invariants (passing `name:` at spawn, re-spawning each round, reviewer-as-agent, inlining the shared contract): see `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — **Shared anti-patterns**. Plan-loop-specific:

- Reading the plan body into lead context each revise round, or accepting any non-`WROTE:` reply as success.
- Writing `<plan>-v2.md` (or any) sibling files. Always overwrite the same plan path; `--resume` keys on it.
- Treating non-blocking findings as revise targets. Step 5 classifies by **meaning** — style nits, vague "consider X" suggestions, and pure prose-polish do NOT block, regardless of what severity label Codex attached. Only plan-level correctness / wrong paths / broken ordering / unverifiable steps / missing required behavior gate the loop.
- Editing `hyper-plan` or `hyper-plan-review`. This skill is purely additive.
- Restating `${CLAUDE_PLUGIN_ROOT}/references/review-brief.md`'s rules inside this SKILL.md instead of pointing at it; fabricating `review_brief_file` from the planner's plan prose; or letting a brief ask Codex to suppress correctness / security / data-loss findings.
