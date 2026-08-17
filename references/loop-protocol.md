# Loop protocol — shared reference

The cross-loop spawn and reply-transport contract, read at Step 0 by `hyper-plan-loop`, `hyper-implement-loop`, and `hyper-docs-loop` alongside each loop's own `failure-protocol.md`. Everything loop-bound — the agent role, the reply shape, the accept rule, the validation stages, the named reports, the review cap — is declared in that local file, never here.

## Spawn contract

Spawn with the `Agent` tool: `Agent({ subagent_type: "hyperclaude:<role>", prompt: <role contract + this round's work> })`. Pass NO `name:` field. Capture the returned `agentId` verbatim (never parse it) into run-state — each loop stores it as `agent_id` and addresses every later round with it. At most one spawn per run — some loops spawn lazily and a clean run may spawn none — and the same agent handles every later round.

**Why `name:` is forbidden.** A named spawn makes the agent a team member, and the harness then drops the plugin agent definition (anthropics/claude-code #78234 / #81746): the `tools:` allowlist is lost, an ~18KB skill listing is re-attached on every round, and the prompt cache is invalidated mid-array — so cost grows quadratically in round count. A spawn without `name:` keeps the definition and the cache.

`agent_id` is the only run-state this contract defines. `review_iteration` (bridge re-invocation count) and every other counter are loop-local, named in each SKILL.

## Reply transport

A spawn without `name:` runs as a background task, and the agent's FINAL TEXT is delivered to the lead as that task's notification `<result>`. That `<result>` is the reply — read it there.

- **Later rounds:** `SendMessage({ to: "<agent_id>", summary: <one line>, message: <the round's work> })`. `summary` is required whenever `message` is a string. The reply to that send is that round's `<result>`.
- **Context is preserved across rounds** — the agent is at rest between them and wakes with its history intact. That reuse is the reason these loops exist.
- **No teardown step.** No team is formed, so there is nothing to shut down; the background agent is cleaned up automatically on session exit.
- **There is no poll/wait tool.** The lead acts when a `<result>` is delivered, and never reports progress that no `<result>` has confirmed.
- **Version floor:** Claude Code >= 2.1.232 is the reported known-good floor for this transport. `/hyperclaude:hyper-setup` surfaces it — report-only, nothing gates on it.

## Correctives and transport failures

Each loop-bound validation stage (declared in the loop's local `failure-protocol.md`) gets exactly ONE corrective redo: a `SendMessage` to `agent_id` restating the reply contract for that stage. If the redo also fails the stage → STOP with the loop's named report. Budgets are per stage, not shared across stages.

Transport failures are defined STOPs, not retries:

- A spawn that fails, or returns no usable `agentId` → STOP with the loop's named report.
- Any later round's `SendMessage` that fails → STOP with the loop's named report.

On either STOP the agent may already have done mutating work — the spawn prompt itself carries a round's task. What each loop preserves and surfaces is declared in its local `failure-protocol.md`; the SKILL's failure branches point there rather than restating it.

## Shared anti-patterns

1. **Passing `name:` at spawn** — costs the agent definition, the tool allowlist, and the prompt cache (see the spawn contract above).
2. **Re-spawning the agent fresh each round** — context reuse via the one live agent is the entire reason every loop in this family exists.
3. **Making the reviewer an agent.** The Codex bridge IS the reviewer — this preserves the "Claude builds, Codex reviews" invariant.
4. **Inlining this contract into a SKILL.md.** SKILL.md is the always-loaded surface; a copy there bloats every trigger and the two copies drift. Point at this file instead.
