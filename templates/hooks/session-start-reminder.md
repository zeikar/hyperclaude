# Session-Start Workflow Router

Multi-step hyper-* chains. Single-skill triggers (hyper-code-review, hyper-docs-review, hyper-tdd, hyper-debug used on their own) fire from their own skill descriptions — this table only lists chained workflows.

| User intent / trigger | Recommended workflow |
|---|---|
| Planning a non-trivial task | hyper-research (optional) → hyper-plan → hyper-plan-review → revise if blockers → hyper-implement. Autonomous variant: **hyper-plan-loop** (plan ↔ review cycle). |
| Executing a plan | hyper-implement → hyper-code-review → fix findings. Autonomous variant: **hyper-implement-loop** (implement ↔ review ↔ fix cycle). |
| Task → plan → implement in one gesture | **hyper-auto** (chains hyper-plan-loop → hyper-implement-loop; stops cleanly if plan-loop doesn't converge). |
| Code changed → docs may be stale | hyper-docs-sync → hyper-docs-review |
