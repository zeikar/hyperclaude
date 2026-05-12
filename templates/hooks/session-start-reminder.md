# Session-Start Workflow Router

Route your intent to the right hyper-* skill. Use this table as a quick reminder when starting work.

| User intent / trigger | Recommended workflow |
|---|---|
| plan 짜줘 / non-trivial task 시작 | hyper-research (optional) → hyper-plan → hyper-plan-review → revise plan if review flags blockers → hyper-implement |
| code review / commit 직전 | hyper-code-review |
| code changed / docs may be stale | hyper-docs-sync → hyper-docs-review |
| docs-only edit / 문서 수정 후 | hyper-docs-review |
| 테스트 짜야 함 | hyper-tdd |
| 디버깅 / 버그 / test failure | hyper-debug |
