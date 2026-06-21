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
- **Use when:** before first use to verify that Node 18+, codex-cli >= 0.130.0, and git are installed; also surfaces whether `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1` is set (required by `hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`, and `hyper-auto` which chains both implement and plan loops).
- **Source:** [commands/hyper-setup.md](../commands/hyper-setup.md).

---

## Gate skills (11)

A gate skill mediates a step in the cycle that produces a canonical `.hyperclaude/` artifact (or, in the doc-sync case, the doc edits themselves). Four shell out to the Codex bridge directly; `hyper-plan`, `hyper-docs-sync`, and `hyper-interview` orchestrate Claude-side work — `hyper-plan` dispatches the `planner` agent, `hyper-docs-sync` pairs with `hyper-docs-review` for the Codex critic step, and `hyper-interview` runs an interactive requirements interview in the lead thread (no Codex — its job is clarity, not review). `hyper-plan-loop` is a hybrid: it spawns a persistent `planner` teammate for Claude-side revision while calling the bridge directly for each Codex review turn. `hyper-implement-loop` is also a hybrid: it confirms agent-teams availability via an env probe (a missing env var stops as a clean no-op before any tree mutation; a degrade at the fixer spawn — after hyper-implement has already committed — preserves the implementation and STOPs honestly), runs `hyper-implement` (with its optional final code-review suppressed), then spawns a persistent `fixer` teammate — only after implementation finishes — and runs fix rounds against the live `fixer` while calling the bridge directly for each Codex code-review turn. `hyper-docs-loop` mirrors the same hybrid shape for docs: it confirms agent-teams availability via an env probe (a missing env var stops as a clean no-op before any tree mutation), spawns a persistent `documenter` teammate, then alternates between Codex `docs-review` turns and findings-driven SendMessage rounds against the live documenter; only `### Findings` items gate fix rounds (the `### Gaps` / `### Broken Or Suspect Links` / `### Cross-Doc Inconsistencies` sections are reported but never auto-fixed). `hyper-auto` is the composition layer: it produces no artifact of its own, chaining `hyper-plan-loop` into `hyper-implement-loop` so the inner loops' artifacts (plans / plan-reviews / code-reviews) emerge from the run. Note: the loop skills rely on the real interactive-CLI persistent-teammate model; some harnesses (e.g. the VSCode SDK) may degrade teammates to one-shot subagents. The §A send-resolution main path routes by bare `teammate_name` — the live mailbox on every host. VSCode-degraded routing (`agent_id` fallback addressing), notification-reply driving (condition (2) re-scoped to deterministic DRIVING via §A-DEGRADE D2), and no-wait degrade teardown (D3) live in the removable `§A-DEGRADE` override in `references/loop-protocol.md`; they are a cleanly-removable layer when VSCode reaches live-mailbox parity.

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
  - **Default — both in parallel:** a normal invocation runs the Codex `research` mode (Codex `exec`, read-only sandbox) AND dispatches the [`researcher`](#researcher) agent (backgrounded), producing two artifacts that share one frontmatter `slug:`.
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
- **Skip when:** the task is one step (dispatch `implementer` directly); a recent plan already covers it.
- **Source:** [skills/hyper-plan/SKILL.md](../skills/hyper-plan/SKILL.md). No template — the skill prompts the agent inline.

### `hyper-plan-review` — Codex plan critique

- **Slash:** `/hyperclaude:hyper-plan-review [path/to/plan.md]`
  - `--resume` — resume the most recent matching prior review (auto-discovers newest artifact in `.hyperclaude/plan-reviews/` with same mode + cwd + plan-path; falls back to fresh run if none found, records `codex-resume-status: fallback`).
  - `--resume <prev-artifact-path>` — resume from an explicit prior review; validation fail → `ok:false`, no fresh run.
- **Mode:** `plan-review` (Codex `exec`, read-only sandbox).
- **Auto-discovers:** the most recent file under `.hyperclaude/plans/` if no path is passed.
- **Reads:** the plan markdown.
- **Writes:** `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` — Issues (Blocker / Major / Minor), Improvements, and Verdict. Frontmatter records `codex-resume-status`: one of `fresh | resumed | fallback | resume-failed`. Frontmatter also records `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` (each emitted independently when its specific usage field was present; omitted when usage was absent).
- **Slug:** reused from the plan filename, so the research → plan → plan-review trio shares one slug for traceability.
- **Use when:** Claude has written a plan and you want Codex to find blockers before execution.
- **Source:** [skills/hyper-plan-review/SKILL.md](../skills/hyper-plan-review/SKILL.md), template [templates/codex/plan-review.md](../templates/codex/plan-review.md).

### `hyper-plan-loop` — autonomous plan-revise loop

- **Slash:** `/hyperclaude:hyper-plan-loop [task]`
- **Mechanics:** team-based revise loop. The skill spawns the [`planner`](#planner) agent once as a persistent team teammate (requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`); every lead→teammate SendMessage (findings/revise, corrective, shutdown) runs the §A send-resolution procedure (bare `teammate_name` on the main path; `agent_id` fallback + notification-reply driving on degraded hosts via the removable `§A-DEGRADE` override — see `references/loop-protocol.md`). The lead resolves the plan path and instructs the planner teammate to write the plan file itself at that path (caller-directed write-file mode); the planner replies `WROTE: <reqid> <path>` only and idles between turns (the lead-owned per-request correlation id lets the lead reject stale replies — see [decisions.md](decisions.md#plan-loop-per-request-correlation-id-stale-reply-mis-attribution-fix)). The lead then runs Codex `plan-review` directly via the bridge, sends the critique back to the planner teammate via SendMessage, and repeats until Codex returns no blocking findings (judged by meaning — plan-level correctness, wrong file paths, broken task ordering, unverifiable steps, missing required behavior — regardless of which severity label the template attached) or the 10-review cap is reached. Style nits, vague "consider X" suggestions, and prose-polish are reported but never drive revise rounds. The reviewer is always the Codex bridge — NOT a team agent — preserving the "Claude builds, Codex reviews" invariant. (At Step 0 the lead Reads both the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — agent-teams contract, unsolicited-message protocol, teardown, abstract request-id state machine — and the loop-specific `skills/hyper-plan-loop/references/failure-protocol.md` — `WROTE: <id> <path>` reply shape, file/structure validation, plan-loop-specific anti-patterns.)
- **Writes:** `.hyperclaude/plans/<timestamp>-<slug>.md` (same-path overwrite on each revise); `.hyperclaude/plan-reviews/<timestamp>-<slug>.md` per iteration.
- **`--resume`:** `--resume auto` is passed to `plan-review` from iteration 2 onward (threads the Codex review session for token efficiency).
- **Use when:** you want a fully autonomous plan → review → revise cycle in one gesture (prior research is inlined when available under `.hyperclaude/research/`). Requires the experimental agent-teams Claude Code feature.
- **Skip when:** you prefer manual control over each revise turn (use `hyper-plan` + `hyper-plan-review` instead — both remain available and untouched).
- **Source:** [skills/hyper-plan-loop/SKILL.md](../skills/hyper-plan-loop/SKILL.md).

### `hyper-implement-loop` — autonomous implement-hardening loop

- **Slash:** `/hyperclaude:hyper-implement-loop [path/to/plan.md]`
- **Mechanics:** team-based implement-hardening loop. The skill confirms agent-teams availability via an env probe (`[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]`; a missing env var stops as a clean no-op before any tree mutation), then runs `hyper-implement` to completion (boundary A — full plan execution; hyper-implement's optional final code-review step is suppressed so the loop's first review is the single authoritative one), then — only after implementation finishes — spawns the [`fixer`](#fixer) agent once as a persistent teammate (spawning earlier buys no context, since hyper-implement builds with its own fresh subagents the fixer never observes); every lead→teammate SendMessage (findings, corrective, shutdown) runs the §A send-resolution procedure (bare `teammate_name` on the main path; `agent_id` fallback + notification-reply driving on degraded hosts via the removable `§A-DEGRADE` override). A degrade at the fixer spawn (condition (1)/(3) — no usable handle, per §A-DEGRADE) is NOT a clean no-op — `hyper-implement` has already committed the implementation; the loop preserves that implementation and STOPs with an honest report. Once the fixer is live, the lead invokes Codex `code-review --base main` directly via the bridge for that first review, sends blocking findings to the still-live fixer via SendMessage, and repeats until no blocking findings remain (judged semantically — correctness/data-loss/security/broken-build/regression/missing-behavior block; style/nits do not) or a 6-review cap is reached. On clean convergence the lead commits the fixer's uncommitted fix edits once (`fix(review): …`) on the feature branch — the fixer never commits (invariant) — leaving a clean tree; a cap-reached exit leaves them uncommitted for manual triage. The reviewer is always the Codex bridge — NOT a team agent — preserving the "Claude builds, Codex reviews" invariant. (At Step 0 the lead Reads both the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — agent-teams contract, unsolicited-message protocol, teardown, abstract request-id state machine — and the loop-specific `skills/hyper-implement-loop/references/failure-protocol.md` — structured-schema reply with `request-id: <id>` prefix, semantic finding-map validation, implement-loop-specific anti-patterns.)
- **Writes:** implementation files (via `hyper-implement`); `.hyperclaude/code-reviews/<timestamp>-vs-main.md` per iteration (release-level slug derived from the diff target, not the plan).
- **`--resume`:** `--resume auto` is passed to `code-review` from iteration 2 onward.
- **Cap:** 6 total Codex reviews (1 fresh + at most 5 resumed fix rounds). On cap-reached with open findings, emits a named cap report and tears down.
- **Plan archival:** handled by the nested `hyper-implement` run at implementation completion (see its Final pass); the loop itself does not archive. The loop's review/fix rounds harden already-implemented code.
- **Fix-validation gate:** semantic finding-map check — every cited blocking finding must map to `status: fixed` OR `status: not-applicable` with a non-empty `notes:` reason. No git-state / no-op gate (a stuck fixer is bounded by the cap).
- **Teardown:** mandatory on every exit path after teammate spawn — sends a `{ type: "shutdown_request" }` object to bare `teammate_name` (§A R1; teardown is id-exempt) best-effort once; the loop does not wait for confirmation (an at-rest teammate cannot confirm; team config is auto-cleaned on session exit); on a degraded host teardown follows §A-DEGRADE D3 (handles `resolved_handle == null` and skips teardown entirely when no usable handle exists — condition (1)/(3)).
- **Use when:** you want a fully autonomous implement → code-review → fix cycle in one gesture. Requires the experimental agent-teams Claude Code feature.
- **Skip when:** you prefer manual control over each implement / review round (use `hyper-implement` + `hyper-code-review` instead — both remain available and untouched); or the task is one step (use `hyper-implement` directly); or the experimental agent-teams feature is unavailable.
- **Source:** [skills/hyper-implement-loop/SKILL.md](../skills/hyper-implement-loop/SKILL.md).

### `hyper-auto` — chain plan-loop into implement-loop

- **Slash:** `/hyperclaude:hyper-auto <task>`
- **Mechanics:** thin orchestration over the two autonomous loops. Step 1 runs `/hyperclaude:hyper-plan-loop <task>` to terminal state; Step 2 branches on the loop's verdict — clean exit captures the canonical plan path and proceeds, while cap-reached (blocking findings still open) or any other terminal failure stops without entering the implement phase (the implement budget is never spent on a plan with unresolved blocking findings); Step 3 runs `/hyperclaude:hyper-implement-loop <plan-path>` against that captured path; Step 4 relays both phases' Step 9 facts (no invented fields) with one composed-flow exception — plan-loop's `Next step: /hyperclaude:hyper-implement <plan path>` recommendation is suppressed (the implement phase already ran in Step 3, so relaying that line verbatim would mis-direct the user to re-implement); the implement-loop's Step 9 next-step is the one surfaced as the composed flow's actionable exit. No new bridge call, no new agent — the skill is a typed handoff between two existing loops.
- **Writes:** none of its own. The inner loops write their canonical artifacts (`.hyperclaude/plans/`, `.hyperclaude/plan-reviews/`, `.hyperclaude/code-reviews/`).
- **Use when:** you want plan-harden → implement-harden in one gesture without manually invoking each, and you accept the safety boundary that a non-converged plan blocks the implement phase.
- **Skip when:** a plan already exists (use `hyper-implement-loop` directly); you want to inspect / hand-edit the plan between phases (use `hyper-plan-loop`, then decide); the experimental agent-teams feature is unavailable (both inner loops require it; this skill inherits the requirement).
- **Source:** [skills/hyper-auto/SKILL.md](../skills/hyper-auto/SKILL.md).

### `hyper-code-review` — Codex code review

- **Slash:** `/hyperclaude:hyper-code-review [target]`
  - Empty → branch diff vs `main`.
  - `uncommitted` → staged + unstaged + untracked.
  - 7–40 hex chars → that specific commit.
  - `vs <ref>` → branch diff vs that ref.
- **Triggers:** explicit `/hyperclaude:hyper-code-review`, OR a natural-language code review of the user's work ("review my code", "review my changes", "check my diff"). This is the default over Claude Code's built-in `code-review` skill; the built-in is correct only for an explicit `/code-review` or its cloud multi-agent (ultra) review. Does NOT apply to a pasted snippet, a named file/range, or a PR URL.
- **Mode:** `code-review` (fresh: Codex `exec --sandbox read-only -` with a prompt template, same spawn shape as the other fresh modes; resumed: `codex exec resume … -c sandbox_mode=read-only`).
- **Review lens:** correctness, risk, and blast radius — AND **over-engineering** (speculative abstractions, unused flexibility, impossible-scenario defensive code, while-we're-here churn, single-use helpers) on the same severity scale, mirroring `hyper-plan-review`'s rubric so code is held to the same simplicity bar as the plan (`template-version: 2`; see [decisions.md](decisions.md)).
- **Writes:** `.hyperclaude/code-reviews/<timestamp>-<slug>.md` — Codex's findings (`### Findings` Blocker/Major/Minor + `### Verdict`), with frontmatter recording `codex-thread-id`, `template-version`, `cwd`, `git-head`, and (depending on target) `base-ref`, `commit`, or the optional `title`. Frontmatter records `codex-resume-status` (one of `fresh | resumed | fallback | resume-failed`); on a successful resume, `codex-resumed-from` records the prior artifact path. Frontmatter also records `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` (each emitted independently when its specific usage field was present; omitted when usage was absent). The `uncommitted` target has no dedicated frontmatter field; it's identifiable from `slug: uncommitted` and the heading.
- **Base target scope:** for `--base <ref>`, Codex reviews the *effective worktree vs base* — committed-since-base (`git diff <ref>...HEAD`) PLUS the uncommitted overlay (`git diff`, `git diff --cached`, untracked files). This is deliberate: `hyper-implement-loop` re-runs `code-review --base main --resume auto` after the fixer leaves edits uncommitted, so the base target must cover that overlay (see [decisions.md](decisions.md)). `--commit <sha>` reads the historical commit; `--uncommitted` reads the working-tree overlay only.
- **`--resume`:** auto-discovers the most recent matching prior review under `.hyperclaude/code-reviews/` (same base ref NAME / commit SHA / uncommitted state); explicit path validation enforces target identity match. Mismatch → `ok:false`, no fresh fallback. Status taxonomy: `fresh | resumed | fallback | resume-failed`. Note: `--base <ref>` matches by ref NAME (not resolved SHA; pinning SHA would force resume to review a stale diff). `--commit <sha>` matches by exact SHA. `--uncommitted` by symmetric absence of both `base-ref` and `commit` keys. Additionally, the prior artifact must carry a `template-version` matching the current code-review prompt: a legacy artifact from the old native `codex exec review` path is not resumable — `--resume auto` falls back to fresh (`fallback`), explicit `--resume <legacy-path>` returns `ok:false` with `resume rejected`.
- **Use when:** post-implementation, before shipping a release, before opening a PR.
- **Source:** [skills/hyper-code-review/SKILL.md](../skills/hyper-code-review/SKILL.md). Fresh runs use [templates/codex/code-review.md](../templates/codex/code-review.md) (substitutes `{{TARGET_INSTRUCTION}}`; Codex runs the target git commands itself under the read-only sandbox). Resumed runs use [templates/codex/code-review-resumed.md](../templates/codex/code-review-resumed.md) (substitutes `{{TARGET_INSTRUCTION}}` so the resumed `UserTurn` re-fetches the diff explicitly).

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
- **Writes:** `.hyperclaude/docs-reviews/<timestamp>-<slug>.md` — Findings, Gaps, Broken Or Suspect Links, Cross-Doc Inconsistencies, and Verdict. Scope is strict: *accuracy / drift / completeness / broken links / contradictions* (NOT prose / style — that is the documenter agent's job). Frontmatter records `codex-resume-status`: one of `fresh | resumed | fallback | resume-failed`. Frontmatter also records `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` (each emitted independently when its specific usage field was present; omitted when usage was absent).
- **Size guards:** docs payload ≤ 200KB; with `--diff-base`, diff ≤ 500KB.
- **Use when:** after `hyper-docs-sync`, or any time a documentation accuracy gate is wanted.
- **Source:** [skills/hyper-docs-review/SKILL.md](../skills/hyper-docs-review/SKILL.md), template [templates/codex/docs-review.md](../templates/codex/docs-review.md).

### `hyper-docs-loop` — autonomous docs-hardening loop

- **Slash:** `/hyperclaude:hyper-docs-loop [target]` — same target grammar as `hyper-docs-review` (empty → `docs/` directory; `.md` file → single-file mode; existing directory → directory mode).
- **Mechanics:** team-based docs-hardening loop. The skill confirms agent-teams availability via an env probe (`[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]`; a missing env var stops as a clean no-op before any tree mutation), then spawns the [`documenter`](#documenter) agent once as a persistent teammate — same agent the `hyper-docs-sync` flow uses, dispatched in this loop with a structured-findings reply contract (the agent stays loop-agnostic; the per-finding schema and `request-id: <id>` prefix live ONLY in the SKILL.md spawn-prompt, not in the agent file); every lead→teammate SendMessage (findings, corrective, shutdown) runs the §A send-resolution procedure (bare `teammate_name` on the main path; `agent_id` fallback + notification-reply driving on degraded hosts via the removable `§A-DEGRADE` override). Then it invokes Codex `docs-review` directly via the bridge for that first review, sends blocking `### Findings` bullets to the still-live documenter via SendMessage, and repeats until no blocking findings remain (judged semantically — accuracy / drift / actively misleading claims block; pure prose-polish nits do not) or a 6-review cap is reached. Only the `### Findings` section is gating; `### Gaps`, `### Broken Or Suspect Links`, and `### Cross-Doc Inconsistencies` are reported in the final Step 9 summary but never auto-fixed (those sections need human judgment). The reviewer is always the Codex bridge — NOT a team agent — preserving the "Claude builds, Codex reviews" invariant. (At Step 0 the lead Reads both the shared `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` — agent-teams contract, unsolicited-message protocol, teardown, abstract request-id state machine — and the loop-specific `skills/hyper-docs-loop/references/failure-protocol.md` — structured-schema reply with `request-id: <id>` prefix, semantic finding-map validation, docs-loop-specific anti-patterns.)
- **Writes:** the doc edits themselves (uncommitted), plus one `.hyperclaude/docs-reviews/<timestamp>-<slug>.md` per Codex review iteration.
- **No baseline sync:** docs-loop is review ↔ fix only. If you want code-change-driven syncing first, run `/hyperclaude:hyper-docs-sync` separately before invoking this skill (keeping the two flows separate avoids conflating the code-diff-driven sync with the docs-target-driven review).
- **Use when:** docs accuracy needs to converge in one gesture (after a non-trivial code change, or as a periodic accuracy check).
- **Skip when:** a single doc edit is enough (edit directly); the experimental agent-teams feature is unavailable (skill stops with documented fallback message — use `/hyperclaude:hyper-docs-review` + manual edits).
- **Source:** [skills/hyper-docs-loop/SKILL.md](../skills/hyper-docs-loop/SKILL.md).

### Distinction at a glance

| Skill | Who acts | What is reviewed |
|---|---|---|
| `hyper-interview` | Claude (interactive; optional `Explore`) | a vague idea → clarified spec; no review |
| `hyper-research` | Codex + Claude (`researcher` agent) in parallel by default; single path on explicit request | (a future) task description |
| `hyper-plan` | Claude (via `planner` agent) | task → plan generation, no review |
| `hyper-plan-review` | Codex | Claude's plan |
| `hyper-plan-loop` | Claude (persistent planner teammate) + Codex (bridge) | autonomous plan-revise loop; reviewer is always Codex |
| `hyper-implement-loop` | Claude (`hyper-implement` + persistent fixer teammate) + Codex (bridge) | autonomous implement-hardening loop; reviewer is always Codex |
| `hyper-auto` | Orchestration only — composes `hyper-plan-loop` then `hyper-implement-loop` | full plan-harden → implement-harden chain; no new actor |
| `hyper-code-review` | Codex | a code diff |
| `hyper-docs-sync` | Claude (via `documenter` agent) | edits docs to match code |
| `hyper-docs-review` | Codex | docs (optionally with code-diff context) |
| `hyper-docs-loop` | Claude (persistent documenter teammate) + Codex (bridge) | autonomous docs-hardening loop; reviewer is always Codex |

---

## Helper skills (3)

Helper skills shape Claude's behavior on tasks. They are not Codex gates themselves and don't directly produce `.hyperclaude/` artifacts. (`hyper-implement` may chain into `/hyperclaude:hyper-code-review` during its final pass — that nested gate writes a `.hyperclaude/code-reviews/` file via the regular gate path, but the helper skill itself doesn't.)

### `hyper-implement` — plan execution loop

- **Slash:** `/hyperclaude:hyper-implement [path/to/plan.md]`
- **What it does:** reads a plan, dispatches a fresh subagent per task, runs two reviews (spec compliance via a general-purpose subagent, then code quality via another), and only marks the task complete when both pass.
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

- **Tools:** `Read, Edit, Glob, Grep, Bash, WebFetch, Write`. In caller-directed write-file mode (used only by `hyper-plan-loop`), the planner writes the plan file itself at the lead-resolved path and replies `WROTE: <reqid> <path>`, echoing the lead-supplied per-request id; on a later revise round it may `Edit` that same file in place instead of re-writing it wholesale (the reply is still `WROTE: <reqid> <path>` — `Edit` is an added capability, not a contract change). In the standard flow (`hyper-plan`), the planner returns the plan body and the skill owns the Write.
- **Job:** decompose a task into ordered, bite-sized steps with file paths and per-step verification checks. Produces a numbered plan, typically saved to `.hyperclaude/plans/<timestamp>-<slug>.md` for `hyper-plan-review` to consume.
- **Source:** [agents/planner.md](../agents/planner.md).

### `implementer`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** carry out one planned step. Returns a description of what was changed plus the diff. Used by `hyper-implement` once per task; can also be dispatched directly when the user already has a clear single step.
- **Source:** [agents/implementer.md](../agents/implementer.md).

### `fixer`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** apply ONLY the Codex code-review findings explicitly cited in each `SendMessage` from the lead. Re-reads current diff/files each round (context may be stale across rounds), makes the minimum targeted fix per finding, runs relevant verification, and replies with the structured per-finding schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:`); the spawning `hyper-implement-loop` skill directs that reply back to the lead via `SendMessage` (transport is skill-injected, not part of this agent definition). There is no canonical output file — the fixer edits in place.
- **Constraints:** fix ONLY cited findings — no opportunistic refactors, no scope expansion; NEVER commit or push; NEVER invoke codex or `scripts/codex-bridge.mjs`; never act as reviewer. Spotting additional issues beyond the cited findings is noted in `notes:` only, not acted on.
- **Dispatched by:** `hyper-implement-loop` — spawned once as a persistent team teammate; every fix round reuses its retained context via SendMessage.
- **Source:** [agents/fixer.md](../agents/fixer.md).

### `verifier`

- **Tools:** `Read, Bash, Glob, Grep`. No edit tools — verifier never modifies files.
- **Job:** run tests, check the actual file/command output, report PASS / PARTIAL / FAIL with verbatim output. Used by `hyper-implement` after the implementer claims a step is done.
- **Source:** [agents/verifier.md](../agents/verifier.md).

### `documenter`

- **Tools:** `Read, Edit, Write, Glob, Grep, Bash`.
- **Job:** edit a documentation file in-place to reflect code changes (UPDATE mode), or scaffold a new file from a code path (CREATE mode). Minimal edits, no scope creep, no prose polish. Receives target path, aggregated diff/excerpts, and mapping rationale from `hyper-docs-sync`.
- **Dispatched by:** `hyper-docs-sync` (one fresh dispatch per affected doc, UPDATE/CREATE mode) **and** `hyper-docs-loop` (spawned once as a persistent team teammate; every fix round reuses its retained context via SendMessage, replies follow the loop's structured per-finding schema with a `request-id: <id>` first-line prefix — that loop contract lives in the spawning skill's SKILL.md, not in this agent file).
- **Source:** [agents/documenter.md](../agents/documenter.md).

### `researcher`

- **Tools:** `Read, Glob, Grep, Bash, WebFetch`.
- **Job:** produce a Prior Art / Pitfalls / Recommendations research artifact for a task description, using `WebFetch` on known URLs. **Not** a web-search substitute — `WebFetch` fetches known URLs; it does not replicate the live crawl that Codex performs via `--search`. Writes the same always-present `.hyperclaude/research/` frontmatter keys and section structure as the Codex path, with `codex-version: claude` to mark it as Claude-authored.
- **Dispatched by:** `hyper-research` — on the default parallel run (backgrounded, alongside the Codex bridge) AND on an explicit Claude-only / no-Codex / second-opinion request.
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
| Want autonomous plan-revise loop in one gesture | `/hyperclaude:hyper-plan-loop` (requires experimental agent-teams) |
| Multi-task plan ready; want disciplined execution | `/hyperclaude:hyper-implement` |
| Want autonomous implement → review → fix loop in one gesture | `/hyperclaude:hyper-implement-loop` (requires experimental agent-teams) |
| Want plan-loop → implement-loop chained end-to-end in one gesture | `/hyperclaude:hyper-auto` (requires experimental agent-teams) |
| One concrete coded step, no plan needed | `implementer` agent directly |
| Need to confirm tests / build pass | `verifier` agent |
| Code change might affect docs | `/hyperclaude:hyper-docs-sync` |
| Docs need accuracy gate | `/hyperclaude:hyper-docs-review` |
| Want autonomous docs-review → fix loop in one gesture | `/hyperclaude:hyper-docs-loop` (requires experimental agent-teams) |
| Code diff needs Codex review | `/hyperclaude:hyper-code-review` |
| About to write behavior-bearing code | apply `hyper-tdd` |
| Test failed unexpectedly | apply `hyper-debug` |
