---
description: Cancel an active hyper-loop in this session. The UserPromptExpansion intake hook flips the state file's active flag; this command body only confirms the outcome.
argument-hint: "<plan-path>"
---

# /hyperclaude:hyper-loop-cancel

The UserPromptExpansion intake hook has already flipped the loop's `active` flag to `false` in `.hyperclaude/loops/<slug>__<session_id>.json` (if a matching state file existed). **Do not read the plan file. Do not touch `.hyperclaude/loops/` yourself.**

This is the **recovery path** — argument-presence only. The cancel command MUST work even when the plan file referenced in the loop state has been deleted or moved; that is precisely the scenario the Stop hook directs users to when the plan path becomes invalid. So this body does not read the plan file.

## Step 1 — Defensive argument-presence check

- If `$ARGUMENTS` is empty, print an error explaining the expected form (`/hyperclaude:hyper-loop-cancel <plan-path>`) and stop.
- Do NOT verify that the plan file exists. Cancel succeeds regardless.

## Step 2 — Confirm to the user

Print a one-line confirmation referencing the plan path the user passed. The intake hook's `additionalContext` already conveyed the precise outcome ("hyper-loop cancelled for …" or "no active hyper-loop found for … in this session"), so the body's confirmation is just a courtesy — keep it short.
