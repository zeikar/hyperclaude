#!/usr/bin/env node
// SessionStart hook — inject hyper-* workflow skills list into user context.

const REMINDER = `Hyper-* workflow skills:

• hyper-research — Codex pre-implementation research (prior art, pitfalls, recommendations).
• hyper-plan — Generate a multi-task plan via the planner agent (saves to .hyperclaude/plans/).
• hyper-plan-review — Codex critique of an implementation plan before execution.
• hyper-implement — Execute a plan task-by-task with fresh subagents, spec + code reviews.
• hyper-code-review — Codex code review on the current branch, working tree, or commit.
• hyper-docs-sync — Sync docs to reflect recent code changes (reads CLAUDE.md/AGENTS.md).
• hyper-docs-review — Codex accuracy review on documentation (drift, broken links, consistency).`;

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
