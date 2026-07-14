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

### Step 4 — Auto-recap, then compose the report

On a **clean composed exit** (guard below), FIRST run the terminal recap, THEN emit the composed report so the report can quote the actual written recap path. On any non-clean terminal the recap is skipped entirely.

**Clean-exit guard.** Auto-recap fires ONLY when ALL of these hold:
- plan-loop exited clean (Step 2's clean-exit branch — not cap/failure), AND
- implement-loop reached its Step 9 review-convergence report (not a Step 8 cap/failure STOP), AND
- that Step 9's `fix(review):` convergence commit reported SUCCESS (commit SHA + clean tree) OR SKIP (nothing staged, clean tree).

Non-clean terminals NEVER auto-run recap, and the deleted recap-recommendation bullet is NEVER re-introduced:
- (a) plan-loop cap/failure STOPs at Step 2 — no implement phase ran, no recap.
- (b) implement-loop cap/failure Step 8 STOP surfaces the loop's own Step 8 report (which carries no Step-9 recap bullet) — no recap.
- (c) a Step 9 whose `fix(review):` convergence commit FAILED (dirty tree / not-ready-to-push) surfaces the loop's Step 9 report with the recap-recommendation bullet STILL suppressed; hyper-auto REPLACES it with an explicit `auto-recap skipped — convergence commit failed, tree not clean; run /hyperclaude:hyper-recap <plan-path> manually after resolving` line — never the standalone recommendation.

**Terminal recap (clean exit only).** Invoke `/hyperclaude:hyper-recap <canonical-plan-path>` with the SAME plan path captured in Step 2 and passed to Step 3 (the active `.hyperclaude/plans/<basename>` path). `hyper-implement` archived that path to `plans/done/` on completion, and hyper-recap's path branch relocates the now-missing active path to its `done/` sibling — binding the recap to THIS exact cycle. Claude-only: no Codex, no agent dispatch, live context. NEVER invoke it no-arg (no-arg picks newest-by-mtime and can target the wrong cycle). This runs before the composed report.

**Composed report.** Relay both phases' Step 9 terminal facts so the user can audit the full chain. Do not paraphrase or invent fields — but apply TWO composed-flow exceptions:

1. **Suppress `hyper-plan-loop`'s "Next step: /hyperclaude:hyper-implement <plan path>" recommendation.** That line fires on a clean plan-loop exit; under `hyper-auto`, Step 3 has already executed the implement phase, so relaying it verbatim would tell the user to re-implement an already-implemented plan. Drop that bullet from the relayed plan-loop report.
2. **Suppress the implement-loop's `/hyperclaude:hyper-recap` recommendation bullet.** Under `hyper-auto` the recap is auto-run here (the terminal action above), so the report surfaces the ACTUAL recap path instead of a recommendation (mirrors the plan-loop Next-step suppression).

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

This "ALWAYS" scopes to the two Step-9-reaching exits only — Step 2 and Step 8 STOPs never reach the composed report; they surface the underlying loop report verbatim (Step 2, guard case (b)) and carry no recap-outcome line. For those two exits, the composed report ALWAYS ends with a hyper-auto recap-outcome line — never claiming an unwritten path:
- **Clean exit** → consume hyper-recap's terminal outcome: the exact written recap path on success, or its reported failure reason and NO path on any non-success terminal.
- **Step-9 failed-convergence exit** → the `auto-recap skipped (<reason>)` line from guard case (c).

## Anti-patterns

- Proceeding to implement-loop when plan-loop hit cap-reached ("revise loop" report). The plan still has unresolved blocking findings — the implement-loop is not the place to compensate.
- Calling this skill when a plan already exists. Use `hyper-implement-loop` directly; running plan-loop on a plan-shaped task description duplicates work.
- Hiding the intermediate plan-loop failure under a generic "auto failed" message — always surface the underlying terminal state so the user can diagnose.
- Modifying the plan between Step 1 and Step 3. The implement-loop receives the canonical plan-loop output as-is; out-of-band edits break the audit trail.
- Auto-running the terminal recap on any non-clean composed exit; re-introducing the standalone recap-recommendation bullet on a failed-convergence exit instead of the `auto-recap skipped (<reason>)` line; or invoking `hyper-recap` no-arg instead of with the captured canonical plan path.
