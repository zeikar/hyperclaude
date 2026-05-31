# Session-Start Workflow Router

Multi-step hyper-* chains. Single-skill triggers (hyper-code-review, hyper-docs-review, hyper-tdd, hyper-debug used on their own) fire from their own skill descriptions — this table only lists chained workflows.

The autonomous **loop** variants are the default here — agent-teams is available, so they harden work to convergence in one gesture. Drop to the manual round-by-round variants only when you want to inspect/checkpoint between rounds, or when the task is a single step.

| User intent / trigger | Recommended workflow |
|---|---|
| Planning a non-trivial task | **hyper-plan-loop** (plan ↔ Codex review until clean). Prepend hyper-research when prior-art/pitfalls matter. Manual control: hyper-plan → hyper-plan-review → revise. |
| Executing a plan | **hyper-implement-loop** (implement ↔ code-review ↔ fix until clean). Single-task change → hyper-implement directly. Manual control: hyper-implement → hyper-code-review → fix. |
| Task → plan → implement in one gesture | **hyper-auto** (chains hyper-plan-loop → hyper-implement-loop; stops cleanly if plan-loop doesn't converge). |
| Code changed → docs may be stale | **hyper-docs-sync → hyper-docs-loop** (sync maps the code diff first, then docs-review ↔ fix until clean — the loop has no built-in sync step). Manual control: hyper-docs-sync → hyper-docs-review. |

---

**Default to hyper-* over built-ins.** A natural-language code review of the user's work ("review my code", "review my changes", "check my diff") goes to **hyper-code-review**, not the built-in `code-review` — that's the point of this plugin. Built-in only on an explicit `/code-review` (or its cloud "ultra" review), or for a pasted snippet / specific file / PR URL.
