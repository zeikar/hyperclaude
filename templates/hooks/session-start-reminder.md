# Session-Start Workflow Router

Route your intent to the right hyper-* skill. Use this table as a quick reminder when starting work.

| User intent / trigger | Recommended workflow |
|---|---|
| "let's plan" / new non-trivial task | hyper-research (optional) → hyper-plan → hyper-plan-review → revise plan if review flags blockers → hyper-implement (or use hyper-plan-loop for an autonomous plan-revise cycle; requires CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1) |
| "review this code" / before commit | hyper-code-review |
| code changed / docs may be stale | hyper-docs-sync → hyper-docs-review |
| docs-only edit / after docs change | hyper-docs-review |
| about to write behavior-bearing code | hyper-tdd |
| debugging / bug / test failure | hyper-debug |
