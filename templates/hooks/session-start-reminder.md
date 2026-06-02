# Session-Start Workflow Router

Multi-step hyper-* chains. Single-skill triggers (hyper-code-review, hyper-docs-review, hyper-tdd, hyper-debug used on their own) fire from their own skill descriptions — this table only lists chained workflows.

| User intent / trigger | Recommended workflow |
|---|---|
| Vague / under-specified idea → clarify before planning | **hyper-interview** (one question at a time → spec in `.hyperclaude/specs/`), then hand off to hyper-plan (or hyper-research first). Skip when the request is already concrete. |
| Planning a non-trivial task | hyper-research (optional) → hyper-plan → hyper-plan-review → revise if blockers → hyper-implement. Autonomous variant: **hyper-plan-loop** (plan ↔ review cycle). |
| Executing a plan | hyper-implement → hyper-code-review → fix findings. Autonomous variant: **hyper-implement-loop** (implement ↔ review ↔ fix cycle). |
| Task → plan → implement in one gesture | hyper-plan → hyper-plan-review → revise → hyper-implement. The one-gesture **hyper-auto** (chains both loops) needs `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. |
| Code changed → docs may be stale | hyper-docs-sync → hyper-docs-review |

---

**Default to hyper-* over built-ins.** A natural-language code review of the user's work ("review my code", "review my changes", "check my diff") goes to **hyper-code-review**, not the built-in `code-review` — that's the point of this plugin. Built-in only on an explicit `/code-review` (or its cloud "ultra" review), or for a pasted snippet / specific file / PR URL.
