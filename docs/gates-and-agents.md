# Gates and agents

Reference for every skill and agent in the plugin: what it does, when it fires, what it reads, what it writes.

For the underlying mechanics (sandbox, output paths, frontmatter), see [architecture.md](architecture.md). For the cycle that strings these together, see [workflow.md](workflow.md).

---

## Setup skill (1)

`hyper-setup` is an **invoke-only** skill (`disable-model-invocation: true`) — a plain slash entry point, not a description-triggered gate. Claude never auto-runs it or preloads it into subagents; it fires only on an explicit `/hyperclaude:hyper-setup`. (It was the plugin's one `commands/*.md` entry until Claude Code merged plugin commands into skills.)

### `hyper-setup` — prerequisite doctor

- **Slash:** `/hyperclaude:hyper-setup`
- **Mechanics:** an invoke-only skill (not a gate) that runs one local Node probe (`scripts/setup-doctor.mjs`) via inline bash (`` !`…` ``); `disable-model-invocation: true` keeps it explicit-invoke-only.
- **Reads:** host environment (Node.js version, `codex` on PATH, `git` on PATH, `claude --version`).
- **Writes:** nothing — report only, no `.hyperclaude/` artifact.
- **Use when:** before first use to verify that Node 18+, codex-cli >= 0.130.0, and git are installed; it also **reports** whether Claude Code is at `>= 2.1.232`, the known-good floor for the background-agent transport used by `hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`, and `hyper-auto` (which chains both loops). That check is `conditional` severity — a below-floor or unknown version is a WARN that never flips the verdict, and nothing in the plugin gates on it.
- **Source:** [skills/hyper-setup/SKILL.md](../skills/hyper-setup/SKILL.md).

---

## Gate skills (12)

A gate skill mediates a step in the cycle that produces a canonical `.hyperclaude/` artifact (or, in the doc-sync case, the doc edits themselves). Four shell out to the Codex bridge directly; `hyper-plan`, `hyper-docs-sync`, `hyper-interview`, and `hyper-recap` orchestrate Claude-side work — `hyper-plan` dispatches the `planner` agent, `hyper-docs-sync` pairs with `hyper-docs-review` for the Codex critic step, `hyper-interview` runs an interactive requirements interview in the lead thread (no Codex — its job is clarity, not review), and `hyper-recap` writes a human-readable cycle recap in the lead thread (no Codex — explaining a completed cycle, not reviewing it). `hyper-plan-loop` is a hybrid: it spawns a live `planner` agent for Claude-side revision while calling the bridge directly for each Codex review turn. `hyper-implement-loop` is also a hybrid: it runs `hyper-implement` (with its optional final code-review suppressed), then — only on the first review round that carries blocking findings — spawns a `fixer` agent that stays live for the rest of the run, and runs fix rounds against it while calling the bridge directly for each Codex code-review turn. `hyper-docs-loop` mirrors the same hybrid shape for docs: it reviews first and spawns a live `documenter` agent on the first blocking round, then alternates between Codex `docs-review` turns and findings-driven `SendMessage` rounds against it; only `### Findings` items gate fix rounds (the `### Gaps` / `### Broken Or Suspect Links` / `### Cross-Doc Inconsistencies` sections are reported but never auto-fixed). `hyper-auto` is the composition layer: it produces no artifact of its own, chaining `hyper-plan-loop` into `hyper-implement-loop` so the inner loops' artifacts (plans / plan-reviews / code-reviews) emerge from the run — on a clean composed exit it additionally delegates a terminal recap to `hyper-recap`, so that recap is `hyper-recap`'s artifact, not `hyper-auto`'s own. All three loops spawn with NO `name:` field and address the agent by the `agentId` the spawn returned; each round's reply arrives as that background task's notification `<result>`. `references/loop-protocol.md` is the single source for that spawn + reply-transport contract. The bridge's stdout JSON envelope, `--resume` semantics, and invocation mode, shared by the six review-mode callers (`hyper-plan-review`, `hyper-code-review`, `hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-review`, `hyper-docs-loop`), are single-sourced in [references/bridge-review-calls.md](../references/bridge-review-calls.md) — including the invocation-mode split (standalone gates background the spawn so the lead stays responsive; loops don't).

### `hyper-interview` — requirements clarification

- **Slash:** `/hyperclaude:hyper-interview <idea>`
- **Mechanics:** *not* a Codex gate. A short Socratic interview run in the lead thread via `AskUserQuestion` — one question per round, targeting whichever requirement dimension (goal / constraints / success / brownfield context) is least clear (qualitative, **no numeric scoring**). One `Explore` dispatch up front establishes greenfield vs brownfield so brownfield questions cite repo evidence (a file/symbol) rather than asking what the code already reveals. A `<HARD-GATE>` blocks any implementation until the user approves the spec. This is the **light** interview — brainstorming-style dialogue with deep-interview's weakest-dimension targeting, minus the ambiguity math / topology / ontology / challenge-mode state.
- **Writes:** `.hyperclaude/specs/<timestamp>-<slug>.md` — Goal, Constraints, Non-Goals, Acceptance Criteria, Assumptions Resolved, and (brownfield) Context. Frontmatter: `mode: interview`, `idea`, `slug`, `generated`, `type: greenfield|brownfield`; a PostToolUse stamp hook adds `plugin-version` post-write.
- **Slug:** minted from the idea text (lowercase, ASCII, ≤5 words, kebab-case) — the *same* rule `hyper-research` / `hyper-plan` use, so carrying the same idea forward keeps the `research → plan → plan-review` trace linked. A no-ASCII idea → timestamp-only filename + bare empty `slug:`.
- **`--resume`:** not supported. In-session revisions overwrite the spec in place; a separate fresh run mints a new timestamped spec (same slug if the idea is unchanged) — no resume keys on the path, so accumulating specs is harmless.
- **Use when:** the idea itself is vague / under-specified and jumping to a plan would guess at scope.
- **Skip when:** the request is already concrete (paths / function names / acceptance criteria) — use `hyper-plan`; or a PRD / plan already exists to execute.
- **Source:** [skills/hyper-interview/SKILL.md](../skills/hyper-interview/SKILL.md). No template — the skill runs the interview inline.

### `hyper-research` — pre-implementation research

- **Slash:** `/hyperclaude:hyper-research <task description>`
- **Paths:** two execution paths (Codex + Claude); selection is a plain-language rule — **not** a flag/token parser.
  - **Default — both in parallel:** a normal invocation runs the Codex `research` mode (Codex `exec`, read-only sandbox) AND dispatches the [`researcher`](#researcher) agent, producing two artifacts that share one frontmatter `slug:`. Both run backgrounded, so the lead stays responsive during the two multi-minute operations; the Claude-only path too.
  - **Single path:** only on an explicit request — "Codex only / no Claude" → Codex alone; "Claude only / Claude-native / no-Codex / second opinion" → Claude alone. The Claude path uses `WebFetch` on known URLs — it does NOT provide web-search parity with the Codex `--search` path.
- **Reads:** the task text passed by the user (or read from a temp file).
- **Writes:** by default a pair — `.hyperclaude/research/<timestamp>-<slug>.md` (Codex) + `.hyperclaude/research/<timestamp>-<slug>-claude.md` (Claude) — both with the same always-present frontmatter keys, the same `slug:`, and the same section structure (`Prior Art`, `Pitfalls`, `Recommendations`, `Open Questions`). The Claude artifact omits Codex-only conditional keys and records `codex-version: claude` to distinguish it from a Codex-authored artifact. A single-path run writes only the one corresponding file.
- **Use when:** about to design a non-trivial change and you want prior art / failure modes before committing to an approach.
- **Skip when:** the task is one-line / mechanical / well-trodden.
- **`--resume`:** not supported (research is not iterative).
- **Source:** [skills/hyper-research/SKILL.md](../skills/hyper-research/SKILL.md), template [templates/codex/research.md](../templates/codex/research.md).

### `hyper-plan` — Claude plan generator

- **Slash:** `/hyperclaude:hyper-plan [task]`
- **Mechanics:** *not* a Codex gate. The skill resolves the task (from `$ARGUMENTS`, or the latest research file's `task:` frontmatter), derives or reuses a slug, and dispatches the [`planner`](#planner) agent. The planner first assesses scope: a task that fits one cohesive plan (~≤10 tasks) yields a **detailed** `## Task N:` plan written verbatim to `.hyperclaude/plans/<timestamp>-<slug>.md`; an **oversized** task (would exceed ~10–12 tasks, or spans independent milestones) yields an **epic roadmap** of `## Milestone N:` chunks instead. For the epic case the skill prepends a `tier: epic` frontmatter block and writes the roadmap to `.hyperclaude/epics/<timestamp>-<slug>.md`, then dispatches the planner once more to expand **Milestone 1** into a detailed plan saved at the canonical `.hyperclaude/plans/<timestamp>-<slug>.md` (no `-mN` suffix — the roadmap's `epics/` location means no collision, so Milestone 1 keeps the shared slug). Mode is detected from the planner's heading style. Vocabulary: epic → milestone → task.
- **Writes:** detailed task plan → `.hyperclaude/plans/<timestamp>-<slug>.md` (plain markdown, no skill-authored frontmatter, `## Task N:` sections that `/hyperclaude:hyper-implement` consumes directly; a PostToolUse stamp hook adds a `plugin-version` line post-write). Oversized task → a `tier: epic` roadmap under `.hyperclaude/epics/<timestamp>-<slug>.md` PLUS a runnable `.hyperclaude/plans/<timestamp>-<slug>.md` detailed plan for Milestone 1 (canonical slug, so the `research → plan → plan-review` trace holds). The roadmap carries the only `tier:` frontmatter; the stamp hook adds `plugin-version` to both the roadmap and detailed plans, but no `tier:` marker ever lands on a detailed plan. `/hyperclaude:hyper-implement` refuses a `tier: epic` file, and the roadmap living outside `.hyperclaude/plans/` keeps it off the newest-plan auto-pick entirely. Later milestones are expanded with `/hyperclaude:hyper-plan milestone <K>` — epic-aware: it reads the newest `epics/` roadmap, carries Milestone K's `Depends on:` context, and writes a normal detailed plan slugged from the milestone's own title (no `-mN`/epic-slug encoding, so `slug.mjs` is untouched; the epic linkage rides in the plan content).
- **Slug:** reused from the matching `hyper-research` artifact's `slug:` when one exists, so the `research → plan → plan-review` trio shares one slug. Otherwise derived from task text (lowercase, ASCII, ≤5 words, kebab-case).
- **`--resume`:** not supported — re-plan by re-running with a refined task.
- **Use when:** about to start multi-task work and you want a plan `/hyperclaude:hyper-plan-review` can critique and `/hyperclaude:hyper-implement` can execute.
- **Skip when:** the task is one step (dispatch `implementer` directly with `run_in_background: false`); a recent plan already covers it.
- **Source:** [skills/hyper-plan/SKILL.md](../skills/hyper-plan/SKILL.md). No template — the skill prompts the agent inline.

### `hyper-plan-review` — Codex plan critique

- **Slash:** `/hyperclaude:hyper-plan-review [path/to/plan.md]`
  - `--resume` — resume the most recent matching prior review (auto-discovers newest artifact in `.hyperclaude/plan-reviews/` with same mode + cwd + plan-path + current `template-version`; falls back to fresh run if none found, records `codex-resume-status: fallback`).
  - `--resume <prev-artifact-path>` — resume from an explicit prior review; validation fail → `ok:false`, no fresh run.
- **Mode:** `plan-review` (Codex `exec`, read-only sandbox).
- **Auto-discovers:** the most recent file under `.hyperclaude/plans/` if no path is passed.
- **Reads:** the plan markdown.
- **Writes:** `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` — Issues (Blocker / Major / Minor), Improvements, and Verdict. Frontmatter records `codex-resume-status`: one of `fresh | resumed | fallback | resume-failed`. Frontmatter also records `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` (each emitted independently when its specific usage field was present; omitted when usage was absent).
- **Slug:** reused from the plan filename, so the research → plan → plan-review trio shares one slug for traceability.
- **`--review-brief` (allowed WITH `--resume`):** the skill composes and passes a brief of the user's stated requirements / approved decisions on every round for which it has an admissible source, so Codex does not flag approved asks as plan-scope creep; omitted when there is no such source. Shared rules: [references/review-brief.md](../references/review-brief.md).
- **Use when:** Claude has written a plan and you want Codex to find blockers before execution.
- **Source:** [skills/hyper-plan-review/SKILL.md](../skills/hyper-plan-review/SKILL.md), template [templates/codex/plan-review.md](../templates/codex/plan-review.md).

### `hyper-plan-loop` — autonomous plan-revise loop

- **Slash:** `/hyperclaude:hyper-plan-loop [task]`
- **Mechanics:** background-agent revise loop. At Step 2 the skill spawns the [`planner`](#planner) agent once with NO `name:` field and captures the returned `agentId`; every later round is a `SendMessage` to that id, and each round's reply arrives as that background task's notification `<result>`. The lead resolves the plan path and instructs the planner to write the plan file itself at that path (caller-directed write-file mode); the planner replies `WROTE: <path>` only and idles between turns. The lead then runs Codex `plan-review` directly via the bridge, sends the critique back to the still-live planner, and repeats until Codex returns no blocking findings (judged by meaning — plan-level correctness, wrong file paths, broken task ordering, unverifiable steps, missing required behavior — regardless of which severity label the template attached) or the 10-review cap is reached. Style nits, vague "consider X" suggestions, and prose-polish are reported but never drive revise rounds. The reviewer is always the Codex bridge — NOT an agent — preserving the "Claude builds, Codex reviews" invariant. (At Step 0 the lead Reads both the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — spawn contract, reply transport, correctives and transport failures, cross-loop anti-patterns — and the loop-specific `skills/hyper-plan-loop/references/failure-protocol.md` — `WROTE: <path>` reply shape, file/structure validation, plan-loop-specific anti-patterns.)
- **Writes:** `.hyperclaude/plans/<timestamp>-<slug>.md` (same-path overwrite on each revise); `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` per iteration.
- **`--resume`:** `--resume auto` is passed to `plan-review` from iteration 2 onward (threads the Codex review session for token efficiency).
- **`--review-brief`:** the lead passes a brief (user-stated requirements + approved decisions only — never the planner's just-revised plan) on each round for which it has an admissible source, re-supplied every round so a mid-loop user approval folds in and a supplied brief survives an `auto`→fresh fallback; omitted when there is no source. Rules: [references/review-brief.md](../references/review-brief.md).
- **Use when:** you want a fully autonomous plan → review → revise cycle in one gesture (prior research is inlined when available under `.hyperclaude/research/`).
- **Skip when:** you prefer manual control over each revise turn (use `hyper-plan` + `hyper-plan-review` instead — both remain available and untouched).
- **Source:** [skills/hyper-plan-loop/SKILL.md](../skills/hyper-plan-loop/SKILL.md).

### `hyper-implement-loop` — autonomous implement-hardening loop

- **Slash:** `/hyperclaude:hyper-implement-loop [path/to/plan.md]`
- **Mechanics:** background-agent implement-hardening loop. The skill runs `hyper-implement` to completion (Step 2, boundary A — full plan execution; hyper-implement's optional final code-review step is suppressed so the loop's first review is the single authoritative one), invokes Codex `code-review --base main` directly via the bridge for that first review (Step 3), and then — only on the first round that carries blocking findings (Step 5) — spawns the [`fixer`](#fixer) agent once with NO `name:` field, that spawn prompt already carrying the round's findings. A run Codex clears on its first review spawns no fixer at all; spawning earlier buys no context either, since hyper-implement builds with its own fresh subagents the fixer never observes. The lead captures the returned `agentId`, sends every later round's blocking findings to it via `SendMessage`, reads each reply from that round's notification `<result>`, and repeats until no blocking findings remain (judged semantically — correctness/data-loss/security/broken-build/regression/missing-behavior block; style/nits do not) or a 6-review cap is reached. On clean convergence the lead commits the fixer's uncommitted fix edits once (`fix(review): …`) on the feature branch — the fixer never commits (invariant) — leaving a clean tree; a cap-reached exit leaves them uncommitted for manual triage. The reviewer is always the Codex bridge — NOT an agent — preserving the "Claude builds, Codex reviews" invariant. (At Step 0 the lead Reads both the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — spawn contract, reply transport, correctives and transport failures, cross-loop anti-patterns — and the loop-specific `skills/hyper-implement-loop/references/failure-protocol.md` — structured-schema reply, semantic finding-map validation, implement-loop-specific anti-patterns.)
- **Writes:** implementation files (via `hyper-implement`); `.hyperclaude/code-reviews/<timestamp>-vs-main.md` per iteration (release-level slug derived from the diff target, not the plan).
- **`--resume`:** `--resume auto` is passed to `code-review` from iteration 2 onward.
- **`--review-brief`:** the lead passes a brief (user-stated requirements + approved decisions only — never the planner-authored plan) on each round for which it has an admissible source, re-supplied every round for the same fallback-survival + mid-loop-update reasons; omitted when there is no source. Rules: [references/review-brief.md](../references/review-brief.md).
- **Cap:** 6 total Codex reviews (1 fresh + at most 5 resumed fix rounds). On cap-reached with open findings, emits a named cap report.
- **Plan archival:** handled by the nested `hyper-implement` run at implementation completion (see its Final pass); the loop itself does not archive. The loop's review/fix rounds harden already-implemented code.
- **Fix-validation gate:** semantic finding-map check — every cited blocking finding must map to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason. No git-state / no-op gate (a stuck fixer is bounded by the cap).
- **Use when:** you want a fully autonomous implement → code-review → fix cycle in one gesture.
- **Skip when:** you prefer manual control over each implement / review round (use `hyper-implement` + `hyper-code-review` instead — both remain available and untouched); or the task is one step (use `hyper-implement` directly).
- **Source:** [skills/hyper-implement-loop/SKILL.md](../skills/hyper-implement-loop/SKILL.md).

### `hyper-auto` — chain plan-loop into implement-loop

- **Slash:** `/hyperclaude:hyper-auto <task>`
- **Mechanics:** thin orchestration over the two autonomous loops. Step 1 runs `/hyperclaude:hyper-plan-loop <task>` to terminal state; Step 2 branches on the loop's verdict — clean exit captures the canonical plan path and proceeds, while cap-reached (blocking findings still open) or any other terminal failure stops without entering the implement phase (the implement budget is never spent on a plan with unresolved blocking findings); Step 3 runs `/hyperclaude:hyper-implement-loop <plan-path>` against that captured path; Step 4 relays both phases' final-report facts (no invented fields) with one composed-flow exception — plan-loop's `Next step: /hyperclaude:hyper-implement <plan path>` recommendation is suppressed (the implement phase already ran in Step 3, so relaying that line verbatim would mis-direct the user to re-implement); the implement-loop's Step 7 next-step is the one surfaced as the composed flow's actionable exit. Step 4 also runs a terminal auto-recap, bound to the captured canonical plan path, before the final report — but ONLY on a clean composed exit (plan-loop clean AND implement-loop's Step 7 convergence commit SUCCESS/SKIP); a non-clean Step 7 exit emits an explicit `auto-recap skipped (<reason>)` note instead and never re-introduces the recap recommendation. This is a second composed-flow exception alongside the plan-loop Next-step suppression: the implement-loop's own `/hyperclaude:hyper-recap` recommendation bullet is dropped from the relayed report, replaced by the actual outcome of the terminal recap. No new bridge call — the terminal recap is Claude-only (no Codex, no agent dispatch) — the skill is otherwise a typed handoff between two existing loops.
- **Writes:** none of its own. The inner loops write their canonical artifacts (`.hyperclaude/plans/`, `.hyperclaude/plan-reviews/`, `.hyperclaude/code-reviews/`); on a clean composed exit, the terminal recap step delegates to `hyper-recap`, which writes `.hyperclaude/recaps/…`.
- **Use when:** you want plan-harden → implement-harden in one gesture without manually invoking each, and you accept the safety boundary that a non-converged plan blocks the implement phase.
- **Skip when:** a plan already exists (use `hyper-implement-loop` directly); you want to inspect / hand-edit the plan between phases (use `hyper-plan-loop`, then decide).
- **Source:** [skills/hyper-auto/SKILL.md](../skills/hyper-auto/SKILL.md).

### `hyper-code-review` — Codex code review

- **Slash:** `/hyperclaude:hyper-code-review [target]`
  - Empty → branch diff vs `main`.
  - `uncommitted` → staged + unstaged + untracked.
  - 7–40 hex chars → that specific commit.
  - `vs <ref>` → branch diff vs that ref.
- **Triggers:** explicit `/hyperclaude:hyper-code-review`, OR a natural-language code review of the user's work ("review my code", "review my changes", "check my diff"). This is the default over Claude Code's built-in `code-review` skill; the built-in is correct only for an explicit `/code-review` or its cloud multi-agent (ultra) review. Does NOT apply to a pasted snippet, a named file/range, or a PR URL.
- **Mode:** `code-review` (fresh: Codex `exec --sandbox read-only -` with a prompt template, same spawn shape as the other fresh modes; resumed: `codex exec resume … -c sandbox_mode=read-only`).
- **Review lens:** correctness, risk, and blast radius — AND **over-engineering** (speculative abstractions, unused flexibility, impossible-scenario defensive code, while-we're-here churn, single-use helpers, prose in the diff that qualifies an adjacent claim instead of correcting it) on the same severity scale, mirroring `hyper-plan-review`'s rubric so code is held to the same simplicity bar as the plan (`template-version: 5`; see [decisions.md](decisions.md)).
- **Writes:** `.hyperclaude/code-reviews/<timestamp>-<slug>.md` — Codex's findings (`### Findings` Blocker/Major/Minor + `### Verdict`), with frontmatter recording `codex-thread-id`, `template-version`, `cwd`, `git-head`, and (depending on target) `base-ref`, `commit`, or the optional `title`. Frontmatter records `codex-resume-status` (one of `fresh | resumed | fallback | resume-failed`); on a successful resume, `codex-resumed-from` records the prior artifact path. Frontmatter also records `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` (each emitted independently when its specific usage field was present; omitted when usage was absent). The `uncommitted` target has no dedicated frontmatter field; it's identifiable from `slug: uncommitted` and the heading.
- **Base target scope:** for `--base <ref>`, Codex reviews the *effective worktree vs base* — committed-since-base (`git diff <ref>...HEAD`) PLUS the uncommitted overlay (`git diff`, `git diff --cached`, untracked files). This is deliberate: `hyper-implement-loop` re-runs `code-review --base main --resume auto` after the fixer leaves edits uncommitted, so the base target must cover that overlay (see [decisions.md](decisions.md)). `--commit <sha>` reads the historical commit; `--uncommitted` reads the working-tree overlay only.
- **`--resume`:** auto-discovers the most recent matching prior review under `.hyperclaude/code-reviews/` (same base ref NAME / commit SHA / uncommitted state); explicit path validation enforces target identity match. Mismatch → `ok:false`, no fresh fallback. Status taxonomy: `fresh | resumed | fallback | resume-failed`. Note: `--base <ref>` matches by ref NAME (not resolved SHA; pinning SHA would force resume to review a stale diff). `--commit <sha>` matches by exact SHA. `--uncommitted` by symmetric absence of both `base-ref` and `commit` keys. Additionally, the prior artifact must carry a `template-version` matching the current code-review prompt: a legacy artifact from the old native `codex exec review` path is not resumable — `--resume auto` falls back to fresh (`fallback`), explicit `--resume <legacy-path>` returns `ok:false` with `resume rejected`.
- **`--background` (fresh runs only; mutually exclusive with `--resume`):** on a fresh invocation the skill composes an optional change-context summary and passes it to the Codex critic via the bridge's `--background` flag. The summary is NEUTRAL and strictly DESCRIPTIVE — it must NOT pre-judge, assign severities, or state what to flag (preserving builder/critic independence). Skipped entirely on any `--resume` invocation.
- **`--review-brief` (both review modes; allowed WITH `--resume`):** the skill composes a brief carrying ONLY the user's verbatim / clearly-cited requirements and explicitly-approved decisions — never plan/spec prose, builder rationale, or tracked-file policy — and passes it on every round for which it has an admissible source, so Codex stops flagging the user's own approved asks as scope creep. No admissible source → the flag is omitted. Bounded authority: scope only, never a correctness/security/data-loss waiver (the prompt's guardrail enforces this). Passed fresh AND resumed alike. Shared rules: [references/review-brief.md](../references/review-brief.md).
- **Use when:** post-implementation, before shipping a release, before opening a PR.
- **Source:** [skills/hyper-code-review/SKILL.md](../skills/hyper-code-review/SKILL.md). Fresh runs use [templates/codex/code-review.md](../templates/codex/code-review.md) (substitutes `{{TARGET_INSTRUCTION}}`; Codex runs the target git commands itself under the read-only sandbox). Resumed runs use [templates/codex/code-review-resumed.md](../templates/codex/code-review-resumed.md) (substitutes `{{TARGET_INSTRUCTION}}` so the resumed `UserTurn` re-fetches the diff explicitly).

### `hyper-docs-sync` — Claude doc-sync orchestrator

- **Slash:** `/hyperclaude:hyper-docs-sync [target]` — same target contract as `hyper-code-review` (empty / `uncommitted` / commit SHA / `vs <ref>`).
- **Mechanics:** *not* a Codex gate. The skill resolves changed files via git, reads a `Code | Docs` mapping table from `CLAUDE.md` / `AGENTS.md` (or falls back to filename heuristics), aggregates per-doc, and dispatches the [`documenter`](#documenter) agent once per affected doc, all in parallel (aggregation guarantees disjoint files), with a barrier before the report reads the tree.
- **Writes:** the doc edits themselves (no `.hyperclaude/` artifact). New docs are scaffolded in CREATE mode; existing docs edited in UPDATE mode.
- **Use when:** after non-trivial implementation that changed documented behavior (API, schemas, CLI flags, architecture).
- **Confidence rule:** dispatches the agent only when the mapping table matches OR the changed file's stem appears in the doc filename. Lower-confidence candidates are surfaced in the report as "skipped — possible candidates" so the user can decide.
- **Source:** [skills/hyper-docs-sync/SKILL.md](../skills/hyper-docs-sync/SKILL.md).

### `hyper-docs-review` — Codex doc accuracy gate

- **Slash:** `/hyperclaude:hyper-docs-review [path...] [--diff-base <ref>] [--resume [<artifact>]]` — argument order is `path → --diff-base → --resume`. `path` defaults to `docs/` when omitted, so `/hyperclaude:hyper-docs-review --diff-base main` is valid (reviews `docs/` against the diff).
  - Empty → top-level `.md` files in `docs/` (commentarium convention).
  - Single file → reviews that file.
  - Multiple files (space-separated, any type — e.g. `README.md` + `site/index.html`) → each maps to its own `--docs-path` flag (repeatable; appends).
  - Directory → reviews top-level `.md` files in that dir (recursion deferred — see [decisions.md](decisions.md)).
  - `--resume` — resume the most recent matching prior review (auto-discovers newest artifact in `.hyperclaude/docs-reviews/` matching on the docs-target SET — order-insensitive — plus diff-base and current `template-version`; falls back to fresh run if none found, records `codex-resume-status: fallback`).
  - `--resume <prev-artifact-path>` — resume from an explicit prior review; validation fail → `ok:false`, no fresh run. If docs payload exceeds 200KB on a resume run, bridge returns `ok:false` (no fallback — user must narrow scope).
- **Mode:** `docs-review` (Codex `exec`, read-only sandbox).
- **Writes:** `.hyperclaude/docs-reviews/<timestamp>-<slug>.md` — Findings, Gaps, Broken Or Suspect Links, Cross-Doc Inconsistencies, and Verdict. Scope is strict: *accuracy / drift / completeness / broken links / contradictions / redundancy* (in-doc duplicated or appended-beside claims, reported Minor; deliberate cross-doc propagation exempt; NOT prose / style — that is the documenter agent's job). Frontmatter records `codex-resume-status`: one of `fresh | resumed | fallback | resume-failed`. Frontmatter also records `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` (each emitted independently when its specific usage field was present; omitted when usage was absent).
- **Size guards:** docs payload ≤ 200KB; with `--diff-base`, diff ≤ 500KB.
- **Use when:** after `hyper-docs-sync`, or any time a documentation accuracy gate is wanted.
- **Source:** [skills/hyper-docs-review/SKILL.md](../skills/hyper-docs-review/SKILL.md), template [templates/codex/docs-review.md](../templates/codex/docs-review.md).

### `hyper-docs-loop` — autonomous docs-hardening loop

- **Slash:** `/hyperclaude:hyper-docs-loop [target]` — same target grammar as `hyper-docs-review` (empty → `docs/` directory; a file → single-file mode; multiple files → repeated `--docs-path`; existing directory → directory mode).
- **Mechanics:** background-agent docs-hardening loop. The skill invokes Codex `docs-review` directly via the bridge for the first review (Step 3), and — only on the first round that carries blocking `### Findings` (Step 5) — spawns the [`documenter`](#documenter) agent once with NO `name:` field, that spawn prompt already carrying the round's findings; a run Codex clears on its first review spawns no documenter at all. It is the same agent the `hyper-docs-sync` flow uses, dispatched here with a structured-findings reply contract (the agent stays loop-agnostic; the per-finding schema lives ONLY in the SKILL.md spawn-prompt, not in the agent file). The lead captures the returned `agentId`, sends every later round's blocking `### Findings` bullets to it via `SendMessage`, reads each reply from that round's notification `<result>`, and repeats until no blocking findings remain (judged semantically — accuracy / drift / actively misleading claims block; pure prose-polish nits and redundancy-only findings do not) or a 6-review cap is reached. Only the `### Findings` section is gating; `### Gaps`, `### Broken Or Suspect Links`, and `### Cross-Doc Inconsistencies` are reported in the Step 7 final summary but never auto-fixed (those sections need human judgment). The reviewer is always the Codex bridge — NOT an agent — preserving the "Claude builds, Codex reviews" invariant. (At Step 0 the lead Reads both the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — spawn contract, reply transport, correctives and transport failures, cross-loop anti-patterns — and the loop-specific `skills/hyper-docs-loop/references/failure-protocol.md` — structured-schema reply, semantic finding-map validation, docs-loop-specific anti-patterns.)
- **Writes:** the doc edits themselves (uncommitted), plus one `.hyperclaude/docs-reviews/<timestamp>-<slug>.md` per Codex review iteration.
- **No baseline sync:** docs-loop is review ↔ fix only. If you want code-change-driven syncing first, run `/hyperclaude:hyper-docs-sync` separately before invoking this skill (keeping the two flows separate avoids conflating the code-diff-driven sync with the docs-target-driven review).
- **Use when:** docs accuracy needs to converge in one gesture (after a non-trivial code change, or as a periodic accuracy check).
- **Skip when:** a single doc edit is enough (edit directly); or you want hands-on control over each review / fix round (use `/hyperclaude:hyper-docs-review` + manual edits).
- **Source:** [skills/hyper-docs-loop/SKILL.md](../skills/hyper-docs-loop/SKILL.md).

### `hyper-recap` — cycle recap

- **Slash:** `/hyperclaude:hyper-recap [plan-path|slug]`
- **Mechanics:** Claude-only — no Codex, no agent dispatch. Mediates the cycle's closing step, producing the canonical `.hyperclaude/recaps/` artifact for ONE completed detailed plan / milestone (archived under `.hyperclaude/plans/done/`). `context: live` when generated in the same session that ran the cycle (the verbatim request is available; judgments and rejected alternatives are included only when explicitly evidenced by the visible conversation or an artifact, not assumed recoverable merely because the session is live); `context: artifacts-only` in a fresh session, building a plan-scoped partial recap from discovered artifacts with an explicit "Unrecoverable gaps" note.
- **Writes:** `.hyperclaude/recaps/<timestamp>[-<slug>].md` — timestamp-only with a bare empty `slug:` for an empty-slug / no-ASCII cycle — with a `context:` marker; slug inherited from the resolved plan's filename. `recaps/` accumulates like `research/`, never archived.
- **Use when:** a cycle just completed (`implement` / `code-review` done, plan archived) and you want the why/how captured. `hyper-auto` auto-runs this as its terminal step on a clean composed exit — the sole auto-run carve-out; standalone it stays on-demand.
- **Skip when:** mid-cycle — the target plan is still active (completion gate stops it); or zero `.hyperclaude/plans/done/*.md` exist.
- **Source:** [skills/hyper-recap/SKILL.md](../skills/hyper-recap/SKILL.md).

### Distinction at a glance

| Skill | Who acts | What is reviewed |
|---|---|---|
| `hyper-interview` | Claude (interactive; optional `Explore`) | a vague idea → clarified spec; no review |
| `hyper-research` | Codex + Claude (`researcher` agent) in parallel by default; single path on explicit request | (a future) task description |
| `hyper-plan` | Claude (via `planner` agent) | task → plan generation, no review |
| `hyper-plan-review` | Codex | Claude's plan |
| `hyper-plan-loop` | Claude (live planner agent) + Codex (bridge) | autonomous plan-revise loop; reviewer is always Codex |
| `hyper-implement-loop` | Claude (`hyper-implement` + lazily spawned fixer agent) + Codex (bridge) | autonomous implement-hardening loop; reviewer is always Codex |
| `hyper-auto` | Orchestration only — composes `hyper-plan-loop` then `hyper-implement-loop` | full plan-harden → implement-harden chain; no new actor |
| `hyper-code-review` | Codex | a code diff |
| `hyper-docs-sync` | Claude (via `documenter` agent) | edits docs to match code |
| `hyper-docs-review` | Codex | docs (optionally with code-diff context) |
| `hyper-docs-loop` | Claude (lazily spawned documenter agent) + Codex (bridge) | autonomous docs-hardening loop; reviewer is always Codex |
| `hyper-recap` | Claude | one completed cycle → human-readable recap; no review |

---

## `hyper-memory` — repo-local knowledge extraction (1)

- **Slash:** `/hyperclaude:hyper-memory [--dry-run] [--root <path>]`
- **Mechanics:** orchestration-only — no Codex, no agent dispatch. The skill runs `scripts/memory/extract.mjs` via `Bash` and parses its one-line JSON summary. The script fully scans the accumulated `.hyperclaude/` corpus (`plans/done/`, `plan-reviews/` — ship-as-is verdicts only, `research/`) and, for each artifact, deterministically copies an exact span (a research bullet, a plan-review verdict line, or a plan's H1 title) into one candidate markdown file per span — no free-form summarization.
- **Writes:** `.hyperclaude/memory/candidates/<compound-key>.md`, one per candidate. Each candidate's frontmatter carries `plugin-version`, `type`, `source-artifact` (the `.hyperclaude/**` artifact the span was mined from — provenance), `anchors` (always `[]` at extraction — none of the three sources deterministically names a live canonical repo path), `mode`, `slug`, `git-head`, `generated`, `staleness`; the body is `## Claim` (a templated one-liner) and `## Evidence` (strictly the verbatim copied span).
- **Idempotency:** a candidate is skipped on re-run if its compound-key file already exists in EITHER `.hyperclaude/memory/candidates/` OR `.hyperclaude/memory/promoted/` — an already-promoted candidate is never resurrected.
- **Curation (human, out of band):** promote a candidate by adding at least one live, real repo source/doc path to its `anchors:` list, then plain `mv` it from `candidates/` to `.hyperclaude/memory/promoted/` (never `git mv` — `.hyperclaude/` is gitignored). `source-artifact:` provenance alone never satisfies the promotion gate. Reject by `rm`-ing the candidate file.
- **Use when:** a batch of work has accumulated in `.hyperclaude/` (several archived plans, plan-reviews, research artifacts) and it's worth mining for durable repo-local knowledge. Not part of the research → ship cycle — run on demand.
- **Skip when:** only a single small artifact exists since the last extraction; or you want the knowledge auto-injected into a session (v2 north star, not implemented).
- **Source:** [skills/hyper-memory/SKILL.md](../skills/hyper-memory/SKILL.md), module [scripts/memory/extract.mjs](../scripts/memory/extract.mjs).

---

## Helper skills (3)

Helper skills shape Claude's behavior on tasks. They are not Codex gates themselves and don't directly produce `.hyperclaude/` artifacts. (`hyper-implement` may chain into `/hyperclaude:hyper-code-review` during its final pass — that nested gate writes a `.hyperclaude/code-reviews/` file via the regular gate path, but the helper skill itself doesn't.)

### `hyper-implement` — plan execution loop

- **Slash:** `/hyperclaude:hyper-implement [path/to/plan.md]`
- **What it does:** reads a plan, dispatches a fresh subagent per task, runs two reviews (spec compliance via a general-purpose subagent, then code quality via another), and only marks the task complete when both pass. Every one of these dispatches — the initial per-task dispatches, the verifier dispatch, and any fix-loop re-dispatches — runs synchronously (`run_in_background: false`) so each gate sees the prior agent's result before proceeding (see [decisions.md](decisions.md) for why the pin is required).
- **Refuses epic roadmaps:** if the resolved plan opens with `tier: epic` frontmatter it is an epic roadmap (from `hyper-plan` on an oversized task; lives under `.hyperclaude/epics/`), not an executable plan — the skill STOPs before branching and tells the user to expand a milestone into a detailed plan first. `hyper-implement-loop` inherits this guard for free, since it runs `hyper-implement` to execute the plan.
- **Feature branch + per-task commits:** before the task loop it creates/switches to `hyper/<slug>` when on `main`/`master` (the protected default branch; an already-checked-out non-default branch is respected as-is). After both reviews pass, the **lead** (never the implementer) commits the task with the plan's per-task conventional-commit message. A task with no file changes is skipped (no empty commit). Everything is local — the skill never pushes the branch or a tag.
- **Agents used:** [`implementer`](#implementer), [`verifier`](#verifier) (for tests / acceptance), and ad-hoc general-purpose subagents for the two reviews.
- **Why fresh subagents:** v0.1 dogfooding (the 11-task plan that built v0.1, ~33 subagent dispatches) showed that reusing a single subagent across tasks pollutes context and degrades focus. The skill enforces fresh dispatch per task.
- **Final pass:** runs whatever the plan defines as final acceptance (e.g. `bash scripts/test/smoke.sh` for hyperclaude itself) and, if available, `/hyperclaude:hyper-code-review` after the last task. On full completion (all tasks executed + acceptance green) it archives the executed **canonical** plan (direct child of `.hyperclaude/plans/`) to `.hyperclaude/plans/done/` (plain `mv`) so it stops surfacing as the newest plan / SessionStart "Active plan". Archival is the plan-implemented signal — independent of the optional code-review's findings (review fixes are downstream hardening) — and applies in nested `hyper-implement-loop` runs too. Only `plans/` is archived (`research/` and `*-reviews/` stay put — `--resume` depends on prior review artifacts).
- **Skip when:** the plan is one step, tasks are tightly coupled, or you're prototyping fast.
- **Source:** [skills/hyper-implement/SKILL.md](../skills/hyper-implement/SKILL.md).

### `hyper-tdd` — test-driven discipline

- **What it does:** enforces a tight TDD loop — fail first, minimal pass, refactor, repeat.
- **Use when:** about to write or modify behavior-bearing code (functions, modules, business logic).
- **Skip when:** pure config edits, doc-only changes, one-shot scripts where tests would not outlive the change.
- **Source:** [skills/hyper-tdd/SKILL.md](../skills/hyper-tdd/SKILL.md).

### `hyper-debug` — debugging discipline

- **What it does:** systematic debugging — reproduce, isolate, instrument, root-cause.
- **Use when:** something is unexpectedly broken and the cause is not obvious.
- **Skip when:** "I know what's wrong" one-line fixes.
- **Source:** [skills/hyper-debug/SKILL.md](../skills/hyper-debug/SKILL.md).

---

## Implementation-arm agents (6)

Agents are sub-Claude personas with restricted tool sets. They are dispatched by skills (or by Claude directly when the skill rules don't apply). Each `<name>.md` in [agents/](../agents/) carries the prompt and the allowed tool list.

### `planner`

- **Tools:** `Read, Edit, Glob, Grep, Bash, WebFetch, Write`. In caller-directed write-file mode (used only by `hyper-plan-loop`), the planner writes the plan file itself at the lead-resolved path and replies `WROTE: <path>`; on a later revise round it may `Edit` that same file in place instead of re-writing it wholesale (the reply is still `WROTE: <path>` — `Edit` is an added capability, not a contract change). In the standard flow (`hyper-plan`), the planner returns the plan body and the skill owns the Write.
- **Job:** decompose a task into ordered, bite-sized steps with file paths and per-step verification checks. Produces a numbered plan, typically saved to `.hyperclaude/plans/<timestamp>-<slug>.md` for `hyper-plan-review` to consume. The plan is a task list, not an essay — long rationale belongs in a research artifact cited by path. Scope stops at the change itself: staging strategy, scratch-workspace lifecycles, `git status` assertions, and cleanup-ownership rules belong to the implementer, since a plan carrying them turns each review round into runbook hardening rather than change hardening.
- **Revise rounds:** the agent body requires re-reading the files, symbols, and commands a finding cites before editing (falling back to the cited task's own files and verification when a finding names only a plan section), fixing at the source rather than rewording, and keeping round-by-round changelogs and reviewer replies out of the plan. `hyper-plan-loop` repeats all three in its Step 6 revise message. Guidance only — the loop's `^## Task` check stays the sole mechanical gate, so the effect is measured by dogfooding, not enforced in-band.
- **Model:** `fable` — the strongest tier, chosen because plan quality compounds (a weak plan burns plan-review, implement, and code-review rounds downstream). It requires an org with 30-day data retention (configured below that, including zero-data-retention, the API rejects the request) and may need usage credits depending on the plan. If planning misbehaves on a fresh install, check that first; `opus` is the drop-back.
- **Source:** [agents/planner.md](../agents/planner.md).

### `implementer`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** carry out one planned step. Returns a description of what was changed plus the diff. Used by `hyper-implement` once per task; can also be dispatched directly when the user already has a clear single step.
- **Source:** [agents/implementer.md](../agents/implementer.md).

### `fixer`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** apply ONLY the Codex code-review findings explicitly cited in each `SendMessage` from the lead. Re-reads current diff/files each round (context may be stale across rounds), makes the minimum targeted fix per finding (a prose finding gets the wrong sentence revised, not a correct one added beside it), runs relevant verification, and replies with the structured per-finding schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:`) as its final text — which the harness delivers to the lead as that round's task-notification `<result>` (transport is skill-injected, not part of this agent definition). There is no canonical output file — the fixer edits in place.
- **Constraints:** fix ONLY cited findings — no opportunistic refactors, no scope expansion; NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; never act as reviewer. Spotting additional issues beyond the cited findings is noted in `notes:` only, not acted on.
- **Dispatched by:** `hyper-implement-loop` — spawned once (with no `name:`) on the first round that carries blocking findings; every later fix round reuses its retained context via a `SendMessage` to the returned `agentId`.
- **Source:** [agents/fixer.md](../agents/fixer.md).

### `verifier`

- **Tools:** `Read, Bash, Glob, Grep`. No edit tools — verifier never modifies files.
- **Job:** run tests, check the actual file/command output, report PASS / PARTIAL / FAIL with verbatim output. Used by `hyper-implement` after the implementer claims a step is done.
- **Source:** [agents/verifier.md](../agents/verifier.md).

### `documenter`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** edit a documentation file in-place to reflect code changes (UPDATE mode), or scaffold a new file from a code path (CREATE mode). Minimal edits, no scope creep, no prose polish. Receives target path, aggregated diff/excerpts, and mapping rationale from `hyper-docs-sync`.
- **Dispatched by:** `hyper-docs-sync` (one fresh dispatch per affected doc, UPDATE/CREATE mode, all affected docs concurrently) **and** `hyper-docs-loop` (spawned once, with no `name:`, on the first round that carries blocking findings; every later fix round reuses its retained context via a `SendMessage` to the returned `agentId`, and replies follow the loop's structured per-finding schema — that loop contract lives in the spawning skill's SKILL.md, not in this agent file).
- **Source:** [agents/documenter.md](../agents/documenter.md).

### `researcher`

- **Tools:** `Read, Glob, Grep, Bash, WebFetch`.
- **Job:** produce a Prior Art / Pitfalls / Recommendations research artifact for a task description, using `WebFetch` on known URLs. **Not** a web-search substitute — `WebFetch` fetches known URLs; it does not replicate the live crawl that Codex performs via `--search`. Writes the same always-present `.hyperclaude/research/` frontmatter keys and section structure as the Codex path, with `codex-version: claude` to mark it as Claude-authored.
- **Dispatched by:** `hyper-research` — on the default parallel run (alongside the Codex bridge) AND on an explicit Claude-only / no-Codex / second-opinion request; backgrounded either way.
- **Source:** [agents/researcher.md](../agents/researcher.md).

---

## When to dispatch what

| Situation | Use |
|---|---|
| First-time setup; want to verify prerequisites | `/hyperclaude:hyper-setup` |
| Idea is vague; want requirements clarified before planning | `/hyperclaude:hyper-interview` |
| Starting a non-trivial task; want prior art | `/hyperclaude:hyper-research` |
| Need an ordered plan with verification per step | `/hyperclaude:hyper-plan` (wraps the `planner` agent) |
| Plan written; want Codex to critique it | `/hyperclaude:hyper-plan-review` |
| Want autonomous plan-revise loop in one gesture | `/hyperclaude:hyper-plan-loop` |
| Multi-task plan ready; want disciplined execution | `/hyperclaude:hyper-implement` |
| Want autonomous implement → review → fix loop in one gesture | `/hyperclaude:hyper-implement-loop` |
| Want plan-loop → implement-loop chained end-to-end in one gesture | `/hyperclaude:hyper-auto` |
| One concrete coded step, no plan needed | `implementer` agent directly (`run_in_background: false`) |
| Need to confirm tests / build pass | `verifier` agent |
| Code change might affect docs | `/hyperclaude:hyper-docs-sync` |
| Docs need accuracy gate | `/hyperclaude:hyper-docs-review` |
| Want autonomous docs-review → fix loop in one gesture | `/hyperclaude:hyper-docs-loop` |
| Code diff needs Codex review | `/hyperclaude:hyper-code-review` |
| About to write behavior-bearing code | apply `hyper-tdd` |
| Test failed unexpectedly | apply `hyper-debug` |
| A batch of `.hyperclaude/` artifacts accumulated; want to mine durable repo-local knowledge | `/hyperclaude:hyper-memory` |
