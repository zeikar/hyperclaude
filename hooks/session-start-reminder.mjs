#!/usr/bin/env node
// SessionStart hook — inject hyper-* workflow skills list into user context.

const REMINDER = `Hyper-* workflow skills:

• hyper-research — Codex pre-implementation research (prior art, pitfalls, recommendations) before designing a non-trivial change.
• hyper-plan — Generate a multi-task plan via the planner agent (saves to .hyperclaude/plans/) before implementation.
• hyper-plan-review — Codex critique of an implementation plan before execution.
• hyper-code-review — Codex code review on the current branch, working tree, or a specific commit.
• hyper-docs-sync — Sync docs to reflect recent code changes (reads CLAUDE.md/AGENTS.md mapping, dispatches documenter per affected doc).
• hyper-docs-review — Codex accuracy review on documentation (drift, broken links, cross-doc consistency).
• hyper-implement — Execute a plan task-by-task with fresh subagents, spec + code reviews between tasks.
• hyper-tdd — Test-driven development discipline for behavior-bearing code.
• hyper-debug — Systematic debugging when a test fails or code throws unexpectedly.`;

async function main() {
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
    }
    JSON.parse(input);
    process.stdout.write(JSON.stringify({
      continue: true,
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: REMINDER,
      },
    }) + '\n');
  } catch {
    process.stdout.write(JSON.stringify({
      continue: true,
      suppressOutput: true,
    }) + '\n');
  }
}

main();
