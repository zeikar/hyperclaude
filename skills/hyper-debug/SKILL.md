---
name: hyper-debug
description: Apply systematic debugging discipline when a test fails, code throws, or behavior diverges from expectation. Use the moment something is unexpectedly broken. Skip for "I know what's wrong" one-line fixes; this skill is for when the cause is not immediately obvious.
---

# hyper-debug

Debugging discipline tailored to this author's preferences. Inspired by superpowers' systematic-debugging but tighter.

## The cycle

1. **Reproduce.** Smallest possible repro. If you can't reproduce, you can't debug.
2. **State the expected vs actual.** Two sentences. "I expected X. I got Y."
3. **Hypothesize one cause.** One. Not five. Pick the most likely.
4. **Predict what would prove the hypothesis right or wrong** before running anything. "If hypothesis is correct, X should happen."
5. **Run the experiment.** Compare to prediction.
6. **If wrong, hypothesize again.** New hypothesis. Don't stack them.
7. **Once cause is confirmed, write a failing test that captures the bug** before fixing — so it doesn't regress silently later.
8. **Fix. Run. Commit.**

## Anti-patterns

- **Hypothesis stacking** — trying five "fixes" at once and not knowing which one worked.
- **Skipping the regression test** — "the fix is obvious, no test needed." Write the test.
- **Logging-only debugging** — endless `console.log` without forming hypotheses. Logs serve a hypothesis, not the other way around.
- **Reading code top-to-bottom** — start at the failing assertion and walk backward, not forward.

## When to escalate

If after 2-3 hypotheses you still don't know the cause, stop iterating. Re-read the error message slowly, check if your repro is actually exercising the buggy code, or take a 5-minute break — you have a wrong assumption somewhere upstream.
