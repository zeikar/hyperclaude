---
name: hyper-auto
description: Use when plan-harden → implement-harden should chain in one gesture — hyper-plan-loop produces a clean plan, then hyper-implement-loop executes and hardens it. Also when the user invokes /hyperclaude:hyper-auto. For manual control between phases use /hyperclaude:hyper-plan-loop, inspect the plan, then /hyperclaude:hyper-implement-loop. Inherits both loops' agent-teams requirement (`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`).
---

# hyper-auto — chain hyper-plan-loop into hyper-implement-loop

Single-gesture pipeline: `hyper-plan-loop` converges → `hyper-implement-loop` runs on the produced plan. Stops cleanly at any terminal state in between. No cron, no merge, no push, no autonomous follow-up rounds — just the two loops, chained.

## When to use

- User has a task description and wants the full plan-harden → implement-harden chain in one go.

## When to skip

- A plan already exists → use `/hyperclaude:hyper-implement-loop` directly.
- User wants to inspect / hand-edit the plan before implementing → use `/hyperclaude:hyper-plan-loop`, then decide.
- The experimental agent-teams feature is unavailable on this host (both inner loops require it; this skill inherits the requirement, not relaxes it).

## Procedure

### Step 1 — Run hyper-plan-loop

Invoke `/hyperclaude:hyper-plan-loop <task>` with the user's task description verbatim. Let it run to terminal state.

### Step 2 — Branch on plan-loop's terminal state

- **Clean exit** (no blocking findings — plan-loop converged) → capture the plan path from the loop's report, proceed to Step 3.
- **Cap reached** (plan-loop's "revise loop" report — blocking findings still open after the 10-review budget) → STOP. Surface plan-loop's terminal report verbatim. Do NOT proceed.
- **Any other terminal failure** (bridge failure, planner-write/format failure, reply-contract failure, unparseable review, etc.) → STOP, surface the underlying report verbatim.

Implementing on a plan with unresolved blocking findings wastes the implement-loop budget on a known-broken input — this is the safety boundary.

### Step 3 — Run hyper-implement-loop

Invoke `/hyperclaude:hyper-implement-loop <plan-path-from-Step-1>` with the canonical plan path captured from plan-loop's report. Let it run to terminal state.

### Step 4 — Report

Relay both phases' Step 9 terminal facts so the user can audit the full chain. Do not paraphrase or invent fields — but apply ONE composed-flow exception:

- **Suppress `hyper-plan-loop`'s "Next step: /hyperclaude:hyper-implement <plan path>" recommendation.** That line fires on a clean plan-loop exit; under `hyper-auto`, Step 3 has already executed the implement phase, so relaying it verbatim would tell the user to re-implement an already-implemented plan. Drop that bullet from the relayed plan-loop report.

**Plan-loop bullets to relay** (Step 9 of `hyper-plan-loop`, minus the suppressed Next-step):
- The plan path.
- Slug-source (research-reused vs freshly-derived).
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking findings (informational, never gating).

**Implement-loop bullets to relay** (Step 9 of `hyper-implement-loop`, verbatim):
- All `reviewArtifacts[]` paths.
- Review iterations consumed.
- The final Codex verdict.
- Residual non-blocking findings.
- Any `resume-failed` / `fallback` rounds noted.
- Branch / working-tree state + the implement-loop's own Next-step (this is the actionable user guidance for the composed flow's exit).
- The optional `/hyperclaude:hyper-recap` recommendation bullet (relay it verbatim — it surfaces exactly once via this relay; do NOT emit an additional recap line).

## Anti-patterns

- Proceeding to implement-loop when plan-loop hit cap-reached ("revise loop" report). The plan still has unresolved blocking findings — the implement-loop is not the place to compensate.
- Calling this skill when a plan already exists. Use `hyper-implement-loop` directly; running plan-loop on a plan-shaped task description duplicates work.
- Hiding the intermediate plan-loop failure under a generic "auto failed" message — always surface the underlying terminal state so the user can diagnose.
- Modifying the plan between Step 1 and Step 3. The implement-loop receives the canonical plan-loop output as-is; out-of-band edits break the audit trail.
