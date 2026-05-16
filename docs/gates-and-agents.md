# Gates and agents

Reference for every skill, agent, and command in the plugin: what it does, when it fires, what it reads, what it writes.

For the underlying mechanics (sandbox, output paths, frontmatter), see [architecture.md](architecture.md). For the cycle that strings these together, see [workflow.md](workflow.md).

---

## Commands (1)

Commands are explicitly-invoked slash commands (`/hyperclaude:<name>`), distinct from description-triggered skills. They are auto-discovered from `commands/*.md`; no manifest entry is required.

### `hyper-setup` — prerequisite doctor

- **Slash:** `/hyperclaude:hyper-setup`
- **Mechanics:** a command (not a skill/gate) that runs one local Node probe (`scripts/setup-doctor.mjs`) via inline bash.
- **Reads:** host environment (Node.js version, `codex` on PATH, `git` on PATH, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` env var).
- **Writes:** nothing — report only, no `.hyperclaude/` artifact.
- **Use when:** before first use to verify that Node 18+, codex-cli >= 0.130.0, and git are installed; also surfaces whether `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set (required only by `hyper-plan-loop`).
- **Source:** [commands/hyper-setup.md](../commands/hyper-setup.md).

---

## Gate skills (7)

A gate skill mediates a step in the cycle that produces a canonical `.hyperclaude/` artifact (or, in the doc-sync case, the doc edits themselves). Four shell out to the Codex bridge directly; `hyper-plan` and `hyper-docs-sync` orchestrate Claude-side work — `hyper-plan` dispatches the `planner` agent, and `hyper-docs-sync` pairs with `hyper-docs-review` for the Codex critic step. `hyper-plan-loop` is a hybrid: it spawns a persistent `planner` teammate for Claude-side revision while calling the bridge directly for each Codex review turn.

### `hyper-research` — Codex pre-implementation research

- **Slash:** `/hyperclaude:hyper-research <task description>`
- **Mode:** `research` (Codex `exec`, read-only sandbox).
- **Reads:** the task text passed by the user (or read from a temp file).
- **Writes:** `.hyperclaude/research/<timestamp>-<slug>.md` — frontmatter + Codex's Prior Art / Pitfalls / Recommendations.
- **Use when:** about to design a non-trivial change and you want prior art / failure modes before committing to an approach.
- **Skip when:** the task is one-line / mechanical / well-trodden.
- **`--resume`:** not supported (research is not iterative).
- **Source:** [skills/hyper-research/SKILL.md](../skills/hyper-research/SKILL.md), template [templates/codex/research.md](../templates/codex/research.md).

### `hyper-plan` — Claude plan generator

- **Slash:** `/hyperclaude:hyper-plan [task]`
- **Mechanics:** *not* a Codex gate. The skill resolves the task (from `$ARGUMENTS`, or the latest research file's `task:` frontmatter), derives or reuses a slug, and dispatches the [`planner`](#planner) agent. The planner returns a multi-task markdown plan; the skill writes it verbatim to `.hyperclaude/plans/<timestamp>-<slug>.md`.
- **Writes:** `.hyperclaude/plans/<timestamp>-<slug>.md` — plain markdown (no frontmatter), with `## Task N: <title>` sections that `/hyperclaude:hyper-implement` consumes directly.
- **Slug:** reused from the matching `hyper-research` artifact's `slug:` when one exists, so the `research → plan → plan-review` trio shares one slug. Otherwise derived from task text (lowercase, ASCII, ≤5 words, kebab-case).
- **`--resume`:** not supported — re-plan by re-running with a refined task.
- **Use when:** about to start multi-task work and you want a plan `/hyperclaude:hyper-plan-review` can critique and `/hyperclaude:hyper-implement` can execute.
- **Skip when:** the task is one step (dispatch `implementer` directly); a recent plan already covers it.
- **Source:** [skills/hyper-plan/SKILL.md](../skills/hyper-plan/SKILL.md). No template — the skill prompts the agent inline.

### `hyper-plan-review` — Codex plan critique

- **Slash:** `/hyperclaude:hyper-plan-review [path/to/plan.md]`
  - `--resume` — resume the most recent matching prior review (auto-discovers newest artifact in `.hyperclaude/plan-reviews/` with same mode + cwd + plan-path; falls back to fresh run if none found, records `codex-resume-status: fallback`).
  - `--resume <prev-artifact-path>` — resume from an explicit prior review; validation fail → `ok:false`, no fresh run.
- **Mode:** `plan-review` (Codex `exec`, read-only sandbox).
- **Auto-discovers:** the most recent file under `.hyperclaude/plans/` if no path is passed.
- **Reads:** the plan markdown.
- **Writes:** `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` — Issues (Blocker / Major / Minor), Improvements, and Verdict. Frontmatter records `codex-resume-status`: one of `fresh | resumed | fallback | resume-failed`.
- **Slug:** reused from the plan filename, so the research → plan → plan-review trio shares one slug for traceability.
- **Use when:** Claude has written a plan and you want Codex to find blockers before execution.
- **Source:** [skills/hyper-plan-review/SKILL.md](../skills/hyper-plan-review/SKILL.md), template [templates/codex/plan-review.md](../templates/codex/plan-review.md).

### `hyper-plan-loop` — autonomous plan-revise loop

- **Slash:** `/hyperclaude:hyper-plan-loop [task]`
- **Mechanics:** team-based revise loop. The skill spawns the [`planner`](#planner) agent once as a persistent team teammate (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`). It then runs Codex `plan-review` directly via the bridge, sends the critique back to the planner teammate via SendMessage, and repeats until the review reports no Blocker or Major issues, or a 5-review cap is reached. The reviewer is always the Codex bridge — NOT a team agent — preserving the "Claude builds, Codex reviews" invariant.
- **Writes:** `.hyperclaude/plans/<timestamp>-<slug>.md` (same-path overwrite on each revise); `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` per iteration.
- **`--resume`:** `--resume auto` is passed to `plan-review` from iteration 2 onward (threads the Codex review session for token efficiency).
- **Use when:** you want a fully autonomous plan-research → plan → review → revise cycle in one gesture. Requires the experimental agent-teams Claude Code feature.
- **Skip when:** you prefer manual control over each revise turn (use `hyper-plan` + `hyper-plan-review` instead — both remain available and untouched).
- **Source:** [skills/hyper-plan-loop/SKILL.md](../skills/hyper-plan-loop/SKILL.md).

### `hyper-code-review` — Codex code review

- **Slash:** `/hyperclaude:hyper-code-review [target]`
  - Empty → branch diff vs `main`.
  - `uncommitted` → staged + unstaged + untracked.
  - 7–40 hex chars → that specific commit.
  - `vs <ref>` → branch diff vs that ref.
- **Mode:** `code-review` (Codex `exec review` subcommand — separate from `exec`; `--sandbox` not exposed because the subcommand is review-only by design).
- **Writes:** `.hyperclaude/code-reviews/<timestamp>-<slug>.md` — Codex's findings, with frontmatter recording `codex-thread-id`, `cwd`, `git-head`, and (depending on target) `base-ref`, `commit`, or the optional `title`. Frontmatter records `codex-resume-status` (one of `fresh | resumed | fallback | resume-failed`); on a successful resume, `codex-resumed-from` records the prior artifact path. The `uncommitted` target has no dedicated frontmatter field; it's identifiable from `slug: uncommitted` and the heading.
- **`--resume`:** auto-discovers the most recent matching prior review under `.hyperclaude/code-reviews/` (same base ref NAME / commit SHA / uncommitted state); explicit path validation enforces target identity match. Mismatch → `ok:false`, no fresh fallback. Status taxonomy: `fresh | resumed | fallback | resume-failed`. Note: `--base <ref>` matches by ref NAME (not resolved SHA; pinning SHA would force resume to review a stale diff). `--commit <sha>` matches by exact SHA. `--uncommitted` by symmetric absence of both `base-ref` and `commit` keys.
- **Use when:** post-implementation, before shipping a release, before opening a PR.
- **Source:** [skills/hyper-code-review/SKILL.md](../skills/hyper-code-review/SKILL.md). Fresh runs have no template — `codex exec review` owns its own prompt. Resumed runs use [templates/codex/code-review-resumed.md](../templates/codex/code-review-resumed.md) (substitutes `{{TARGET_INSTRUCTION}}` so the resumed `UserTurn` re-fetches the diff explicitly).

### `hyper-docs-sync` — Claude doc-sync orchestrator

- **Slash:** `/hyperclaude:hyper-docs-sync [target]` — same target contract as `hyper-code-review` (empty / `uncommitted` / commit SHA / `vs <ref>`).
- **Mechanics:** *not* a Codex gate. The skill resolves changed files via git, reads a `Code | Docs` mapping table from `CLAUDE.md` / `AGENTS.md` (or falls back to filename heuristics), aggregates per-doc, and dispatches the [`documenter`](#documenter) agent once per affected doc.
- **Writes:** the doc edits themselves (no `.hyperclaude/` artifact). New docs are scaffolded in CREATE mode; existing docs edited in UPDATE mode.
- **Use when:** after non-trivial implementation that changed documented behavior (API, schemas, CLI flags, architecture).
- **Confidence rule:** dispatches the agent only when the mapping table matches OR the changed file's stem appears in the doc filename. Lower-confidence candidates are surfaced in the report as "skipped — possible candidates" so the user can decide.
- **Source:** [skills/hyper-docs-sync/SKILL.md](../skills/hyper-docs-sync/SKILL.md).

### `hyper-docs-review` — Codex doc accuracy gate

- **Slash:** `/hyperclaude:hyper-docs-review [path] [--diff-base <ref>] [--resume [<artifact>]]` — argument order is `path → --diff-base → --resume`. `path` defaults to `docs/` when omitted, so `/hyperclaude:hyper-docs-review --diff-base main` is valid (reviews `docs/` against the diff).
  - Empty → top-level `.md` files in `docs/` (commentarium convention).
  - Single file → reviews that file.
  - Directory → reviews top-level `.md` files in that dir (recursion deferred — see [decisions.md](decisions.md)).
  - `--resume` — resume the most recent matching prior review (auto-discovers newest artifact in `.hyperclaude/docs-reviews/` with same docs-target + diff-base; falls back to fresh run if none found, records `codex-resume-status: fallback`).
  - `--resume <prev-artifact-path>` — resume from an explicit prior review; validation fail → `ok:false`, no fresh run. If docs payload exceeds 200KB on a resume run, bridge returns `ok:false` (no fallback — user must narrow scope).
- **Mode:** `docs-review` (Codex `exec`, read-only sandbox).
- **Writes:** `.hyperclaude/docs-reviews/<timestamp>-<slug>.md` — Findings, Gaps, Broken Or Suspect Links, Cross-Doc Inconsistencies, and Verdict. Scope is strict: *accuracy / drift / completeness / broken links / contradictions* (NOT prose / style — that is the documenter agent's job). Frontmatter records `codex-resume-status`: one of `fresh | resumed | fallback | resume-failed`.
- **Size guards:** docs payload ≤ 200KB; with `--diff-base`, diff ≤ 500KB.
- **Use when:** after `hyper-docs-sync`, or any time a documentation accuracy gate is wanted.
- **Source:** [skills/hyper-docs-review/SKILL.md](../skills/hyper-docs-review/SKILL.md), template [templates/codex/docs-review.md](../templates/codex/docs-review.md).

### Distinction at a glance

| Skill | Who acts | What is reviewed |
|---|---|---|
| `hyper-research` | Codex | (a future) task description |
| `hyper-plan` | Claude (via `planner` agent) | task → plan generation, no review |
| `hyper-plan-review` | Codex | Claude's plan |
| `hyper-plan-loop` | Claude (persistent planner teammate) + Codex (bridge) | autonomous plan-revise loop; reviewer is always Codex |
| `hyper-code-review` | Codex | a code diff |
| `hyper-docs-sync` | Claude (via `documenter` agent) | edits docs to match code |
| `hyper-docs-review` | Codex | docs (optionally with code-diff context) |

---

## Helper skills (3)

Helper skills shape Claude's behavior on tasks. They are not Codex gates themselves and don't directly produce `.hyperclaude/` artifacts. (`hyper-implement` may chain into `/hyperclaude:hyper-code-review` during its final pass — that nested gate writes a `.hyperclaude/code-reviews/` file via the regular gate path, but the helper skill itself doesn't.)

### `hyper-implement` — plan execution loop

- **Slash:** `/hyperclaude:hyper-implement [path/to/plan.md]`
- **What it does:** reads a plan, dispatches a fresh subagent per task, runs two reviews (spec compliance via a general-purpose subagent, then code quality via another), and only marks the task complete when both pass.
- **Agents used:** [`implementer`](#implementer), [`verifier`](#verifier) (for tests / acceptance), and ad-hoc general-purpose subagents for the two reviews.
- **Why fresh subagents:** v0.1 dogfooding (the 11-task plan that built v0.1, ~33 subagent dispatches) showed that reusing a single subagent across tasks pollutes context and degrades focus. The skill enforces fresh dispatch per task.
- **Final pass:** runs whatever the plan defines as final acceptance (e.g. `bash scripts/test/smoke.sh` for hyperclaude itself) and, if available, `/hyperclaude:hyper-code-review` after the last task.
- **Skip when:** the plan is one step, tasks are tightly coupled, or you're prototyping fast.
- **Source:** [skills/hyper-implement/SKILL.md](../skills/hyper-implement/SKILL.md).

### `hyper-tdd` — test-driven discipline

- **What it does:** enforces a tight TDD loop — fail first, minimal pass, refactor, repeat. Inspired by superpowers' `tdd` but tighter.
- **Use when:** about to write or modify behavior-bearing code (functions, modules, business logic).
- **Skip when:** pure config edits, doc-only changes, one-shot scripts where tests would not outlive the change.
- **Source:** [skills/hyper-tdd/SKILL.md](../skills/hyper-tdd/SKILL.md).

### `hyper-debug` — debugging discipline

- **What it does:** systematic debugging — reproduce, isolate, instrument, root-cause. Inspired by superpowers' `systematic-debugging` but tighter.
- **Use when:** something is unexpectedly broken and the cause is not obvious.
- **Skip when:** "I know what's wrong" one-line fixes.
- **Source:** [skills/hyper-debug/SKILL.md](../skills/hyper-debug/SKILL.md).

---

## Implementation-arm agents (4)

Agents are sub-Claude personas with restricted tool sets. They are dispatched by skills (or by Claude directly when the skill rules don't apply). Each `<name>.md` in [agents/](../agents/) carries the prompt and the allowed tool list.

### `planner`

- **Tools:** `Read, Glob, Grep, Bash, WebFetch`. Read-only — cannot edit code.
- **Job:** decompose a task into ordered, bite-sized steps with file paths and per-step verification checks. Produces a numbered plan, typically saved to `.hyperclaude/plans/<timestamp>-<slug>.md` for `hyper-plan-review` to consume.
- **Source:** [agents/planner.md](../agents/planner.md).

### `implementer`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** carry out one planned step. Returns a description of what was changed plus the diff. Used by `hyper-implement` once per task; can also be dispatched directly when the user already has a clear single step.
- **Source:** [agents/implementer.md](../agents/implementer.md).

### `verifier`

- **Tools:** `Read, Bash, Glob, Grep`. No edit tools — verifier never modifies files.
- **Job:** run tests, check the actual file/command output, report PASS / PARTIAL / FAIL with verbatim output. Used by `hyper-implement` after the implementer claims a step is done.
- **Source:** [agents/verifier.md](../agents/verifier.md).

### `documenter`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** edit a documentation file in-place to reflect code changes (UPDATE mode), or scaffold a new file from a code path (CREATE mode). Minimal edits, no scope creep, no prose polish. Receives target path, aggregated diff/excerpts, and mapping rationale from `hyper-docs-sync`.
- **Source:** [agents/documenter.md](../agents/documenter.md).

---

## When to dispatch what

| Situation | Use |
|---|---|
| First-time setup; want to verify prerequisites | `/hyperclaude:hyper-setup` |
| Starting a non-trivial task; want prior art | `/hyperclaude:hyper-research` |
| Need an ordered plan with verification per step | `/hyperclaude:hyper-plan` (wraps the `planner` agent) |
| Plan written; want Codex to critique it | `/hyperclaude:hyper-plan-review` |
| Want autonomous plan-revise loop in one gesture | `/hyperclaude:hyper-plan-loop` (requires experimental agent-teams) |
| Multi-task plan ready; want disciplined execution | `/hyperclaude:hyper-implement` |
| One concrete coded step, no plan needed | `implementer` agent directly |
| Need to confirm tests / build pass | `verifier` agent |
| Code change might affect docs | `/hyperclaude:hyper-docs-sync` |
| Docs need accuracy gate | `/hyperclaude:hyper-docs-review` |
| Code diff needs Codex review | `/hyperclaude:hyper-code-review` |
| About to write behavior-bearing code | apply `hyper-tdd` |
| Test failed unexpectedly | apply `hyper-debug` |
