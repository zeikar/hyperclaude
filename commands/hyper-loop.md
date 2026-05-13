---
description: Start a ralph-style plan loop. State is bound to this session by the UserPromptExpansion intake hook; the Stop hook drives continuation until the plan's checkboxes are all done.
argument-hint: "<plan-path> [--max=N]"
---

# /hyperclaude:hyper-loop

You are starting an unattended iteration loop over a plan in `.hyperclaude/plans/`. The UserPromptExpansion intake hook has already written the loop state file under `.hyperclaude/loops/` with the correct `session_id`. **Do not touch `.hyperclaude/loops/` yourself.** The Stop hook drives continuation; this command's job is only to validate inputs and kick off execution.

## Argument grammar

`$ARGUMENTS` is `<plan-path> [--max=N]`.

- `<plan-path>` — required, path to a markdown plan file under `.hyperclaude/plans/`.
- `--max=N` — optional, positive integer ≤ 1000. Default `10`. Caps the number of Stop-hook iterations before the loop self-terminates.

If the intake hook already blocked the prompt (missing plan, invalid `--max`, another loop already active in this session), you will not be running. If you ARE running, the state file exists and is consistent.

## Step 1 — Defensive re-validation

Belt-and-suspenders for the case the hook didn't fire (unusual setups):

- If `$ARGUMENTS` is empty, print an error and stop.
- Resolve the plan path. If the file does not exist, print an error and stop.
- If `--max=N` is present, confirm it parses as `/^[1-9]\d*$/` and `N ≤ 1000`. Otherwise error and stop.

## Step 2 — Dispatch hyper-implement, double-quoting the plan path

Use the **SlashCommand tool** to invoke `/hyperclaude:hyper-implement` with the plan path **always double-quoted**, so paths containing spaces survive intact. Embedded `"` and `\` in the path must be backslash-escaped before being placed inside the quotes.

Concretely:

- Take the resolved plan path.
- Build a quoted form: `"` + path.replace(/\\/g, `\\\\`).replace(/"/g, `\\"`) + `"`.
- Invoke the SlashCommand tool with the argument `/hyperclaude:hyper-implement <quoted-path>`.

Quotes are always applied — even when the path has no special characters — so the dispatched command is shape-consistent.

## Step 3 — Remind the user

After dispatch, print:

> Stop hook drives continuation; cancel anytime with `/hyperclaude:hyper-loop-cancel <plan-path>`.

Then proceed with executing the plan per the dispatched `/hyperclaude:hyper-implement` protocol. The Stop hook will re-fire the appropriate continuation prompt after each turn until the plan's checkboxes are all done, the iteration cap is hit, or the user cancels.
