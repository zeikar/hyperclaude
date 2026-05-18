# Decisions

Non-obvious "why is X like this" notes. Read this when something looks off and you're tempted to "fix" it — chances are it's deliberate.

For active findings inside a session, use `.hyperclaude/` artifacts. This file is for cross-version decisions and deferrals.

---

## Active deferrals

Deliberate non-decisions. Each has an explicit trigger for when to revisit. **This list is the trigger-gated backlog — don't build an item until its trigger actually fires.**

### `UserPromptSubmit` nudge hook

**Deferred since v0.1. Trigger:** manual slash-command invocation becomes the friction users (or the author) hit daily.

v0.1's original design had a hook that auto-suggested the right gate from prompt content. Deferred for false-positive cost: a nudge that mis-fires is more annoying than the missing automation. Revisit when a clear matcher pattern emerges (e.g. "let's plan X" → offer research gate) — then it's a thin string matcher, not a model call.

### Recursive `--docs-dir` walk for `hyper-docs-review`

**Trigger:** a consumer project with `docs/` nested deeper than one level.

`--docs-dir <path>` reads only top-level `.md`; subdirs are ignored. The 200KB payload guard is the gating concern — recursion needs a per-file budget and "which subdir to skip" defaults. Workaround: invoke per subdir.

### Configurable default branch for `code-review` / `docs-sync`

**Trigger:** more than one consumer project on a `master`/`develop` trunk.

Both skills hardcode `main` as the implicit base; other trunks must pass `vs <ref>` (bridge flag `--base <ref>`). Deferred because the config knob is "one more place to look when behavior surprises you."

### Diff-base resolved-SHA capture in frontmatter

**Trigger:** a code/docs-review is re-evaluated after its base branch moved.

Frontmatter records `git-head` but not the resolved SHA of `--base`/`--diff-base`. Filename timestamp + `git-head` is enough for typical cases; resolved-base capture is a clean addition that solves a niche problem.

### Research resume

**Trigger:** explicit user request, or the dogfood cycle generating iterative research follow-ups often enough to be worth it.

Research is a single-pass gate. No natural resumed prompt exists without re-uploading the context resume is meant to avoid.

### Additional error-path coverage (EACCES, etc.)

**Trigger:** a specific error code shows up in a real bug report.

Coverage is uneven by intent: `ENOENT`/`EISDIR` are friendly-mapped only for the docs path/dir; task/plan-file reads use a generic `cannot read X` message; per-file `--docs-dir` reads propagate raw. Adding mappings for codes that haven't bitten anyone is YAGNI.

---

## Design decisions

### Research defaults to parallel Codex + Claude; `codex-version: claude` marks the Claude artifact

`hyper-research` runs **both** the Codex path and the Claude (`researcher` agent) path in parallel by default, producing two files; a single path runs only on explicit request. The bridge is intentionally untouched (it is the design invariant): the Codex artifact keeps the default `<ts>-<slug>.md`, the Claude one takes a `-claude` suffix, and both carry an identical frontmatter `slug:` — traceability is the shared slug, not the filename, so the "one slug per research→plan→plan-review trace" convention is unchanged.

Still additive, not a replacement: Codex always runs (the critic step holds the "Claude builds, Codex critiques" invariant); Claude is an extra lens. `codex-version: claude` distinguishes the Claude-authored artifact; both write the same always-present frontmatter keys so plan/plan-review treat either identically. Note: the `researcher` agent's `WebFetch` on known URLs is *not* parity with Codex's live `--search` crawl — the Claude path is for known-reference lookups, not open-ended search.

### Codex is always invoked with `--search`

Every Codex spawn unconditionally prepends the global `--search` flag (before the subcommand) — no opt-in, no toggle, hardcoded in `runCodexExec` in `scripts/codex/codex.mjs`. Always-on is simpler than conditional logic and lets Codex pull live docs/changelogs during every gate. `--search` does not relax `--sandbox read-only`; the filesystem-write invariant holds in all modes and across resume.

### Codex is `--sandbox read-only`, always

Every Codex spawn enforces read-only; the mechanism varies by subcommand:

- **Fresh `codex exec`** (research/plan-review/docs-review/code-review): `--sandbox read-only` flag.
- **`codex exec resume`**: no `--sandbox` flag exposed; passes `-c sandbox_mode=read-only` config override.

This is the core thesis ("Claude builds, Codex critiques") made enforceable: allowing Codex to author patches would collapse the role split and break user trust. Both argv shapes are explicit and auditable; a user-side `~/.codex/config.toml` default can't override either.

### Resume requires `-c sandbox_mode=read-only`

`runCodexResume` explicitly passes `-c sandbox_mode=read-only` on every `codex exec resume`. Verified empirically: `codex exec resume` does **not** inherit the original session's `--sandbox` flag — a read-only session resumed without it wrote files freely. The override preserves the never-writes-workspace contract across resume.

### Resumed prompts are minimal follow-ups; the bridge owns file lists and size budgets

The resumed prompt never re-uploads the original payload (docs/plan/diff). It names the changed file (plan/docs-review), embeds the aggregated file list (`--docs-dir`), or embeds explicit git commands (`code-review`'s `{{TARGET_INSTRUCTION}}`, since `codex exec resume` does not re-run the fresh prompt's git-collection step). Codex's prompt cache covers the original payload. Trade-off: the bridge re-runs the 200KB/500KB budgets on resume and **fails** (not a silent fallback) if exceeded — the user changed the situation.

### Code-review resume: framing carried in-thread + ref-name identity

`code-review --resume` has the same validation/fallback as plan-review/docs-review, plus a `template-version` precondition. The fresh thread already carries the full `templates/codex/code-review.md` prompt, so the resumed `UserTurn` is a minimal target-explicit follow-up (it must restate the git command — resume doesn't re-run git collection). Identity matches by target type: `--base` by ref NAME (not resolved SHA — pinning SHA would review a stale diff), `--commit` by exact SHA, `--uncommitted` by symmetric absence of both keys. A prior artifact whose `template-version` mismatches is rejected (auto → fresh fallback; explicit → `resume rejected`).

### Fresh `code-review` uses a custom prompt + template, NOT native `codex exec review` (2026-05-18 reversal)

Fresh `code-review` spawns a regular `codex --search exec --sandbox read-only -` with the rendered `templates/codex/code-review.md` prompt — the same shape as research/plan-review/docs-review. **Do not re-migrate to native `codex exec review`:** the native subcommand owns its own prompt and diff-capture heuristics, which the bridge can't shape. The custom prompt controls (1) the severity vocabulary (`### Findings` Blocker/Major/Minor + `### Verdict`) the loops parse, and (2) exactly what Codex reads (bounded to the change, not a whole-repo scan). The prompt's `{{TARGET_INSTRUCTION}}` block has Codex run the git commands itself under read-only (the sandbox permits git, not writes). This supersedes the v0.4 "`codex review` → `codex exec review`" migration; the JSONL / thread-id / failure-body gains carried forward, only the native framing was dropped.

**Base target = committed-since-base PLUS uncommitted overlay:** for `--base <ref>` the target is the *effective worktree vs base* — `git diff <base>...HEAD` plus the uncommitted overlay (`git diff`, `--cached`, untracked). A commit-only diff was **rejected** because `hyper-implement-loop` re-runs `code-review --base main --resume auto` after the `fixer` leaves edits *uncommitted*; a commit-only base diff would hide them and the loop could never converge. (`--commit` reads the historical commit; `--uncommitted` the overlay only.)

Sub-decisions: **(a)** web search stays enabled (`--search` as in every mode); the template only *discourages* web use — no hermetic mode, filesystem read-only is the only hard sandbox. **(b)** `renderCodeReviewFrontmatter()` emits `template-version: 1` and resume enforces a `CODE_REVIEW_TEMPLATE_VERSION` match in `scripts/codex/resume.mjs`; legacy native artifacts carry no match and are not resumable. **(c)** `--title` is metadata only (frontmatter key + heading) — no longer an argv argument.

**Lock-step cost:** the code-review prompt has **three** version-coupled points — `templates/codex/code-review.md`, `template-version: 1` in `renderCodeReviewFrontmatter()`, `CODE_REVIEW_TEMPLATE_VERSION` in `scripts/codex/resume.mjs`. Bump all three together.

### MIN_CODEX is 0.130

The bridge depends on `codex exec resume`, the `-c sandbox_mode=read-only` override, and global `--search` placed before the subcommand — all verified on codex-cli 0.130.0. The bridge version-checks before spawning Codex on non-dry-run paths (docs-review validates input read + 200KB size first) and fails with an upgrade hint; smoke probes catch surface drift earlier.

### Fresh subagent per task in `hyper-implement`

Dispatch a new `implementer` per task — never reuse. v0.1 dogfooding (~33 dispatches over an 11-task plan) showed reuse pollutes context with prior diffs and degrades focus; fresh dispatch is free at the SDK level. Two reviews per task: a *general-purpose* spec-compliance review (NOT `verifier`, which runs tests) catches scope drift; a general-purpose quality review catches clarity/YAGNI. The v0.1 cycle caught two real bugs the implementer's self-review missed.

### Per-task commits on an auto-created feature branch in `hyper-implement`

`hyper-implement` commits once per task that produces file changes (after both reviews pass; a no-change task skips the commit) on a feature branch — `hyper/<slug>` created when the run starts on `main`/`master`, or the user's existing non-default branch left as-is. The **lead** commits, never the `implementer` (commit-free by invariant — "acceptable" is defined by the reviews only the lead orchestrates). Nothing is pushed. Granular history is bisectable and gives per-task rollback; it also makes `hyper-implement-loop`'s `code-review --base main` well-defined (committed tasks + the fixer's uncommitted fix-round on top still diff against `main`). A clean-tree preflight (Step 2.5) hard-stops if `git status --porcelain` is non-empty (`.hyperclaude/` exempt): per-task commits use `git add -A`, so a dirty start would sweep untracked secrets into the first commit. Unconditional, not opt-in.

### Slug propagation via filename suffix

Plan files are `<YYYYMMDD-HHMM>-<slug>.md`; `extractSlugFromPlanFilename()` strips the timestamp and reuses `<slug>` for the plan-review file. The research→plan→plan-review trio is naturally topic-linked; sharing a slug via filename (no manifest) keeps metadata where it's already visible. A `manifest.json` was rejected — a state file that adds parsing and a way to drift.

### `code-review` / `docs-review` slugs are release-level, not feature-level

code-review slugs come from the diff target (`vs-main`, `uncommitted`, `commit-<sha7>`); docs-review from the docs target basename. A single release-gate run reviews many features at once — tying the filename to one feature slug would mislead.

### Zero npm dependencies

Node 18+ stdlib only; no `package.json`, no `node_modules`. A `/plugin install` user shouldn't also need `npm install`. Stdlib forces simpler design (regex slugs, tagged-template strings, hand-rolled argv). Cost accepted: a per-mode-tested custom argv parser (`ALLOWED_FLAGS_PER_MODE`) and manual frontmatter rendering, both unit-covered.

### Size guards at 200KB / 500KB

`docs-review` rejects docs payloads >200KB and `--diff-base` diffs >500KB. Codex's real limits are higher, but failing fast beats waiting 30s for Codex to choke; the numbers fit 99% of real reviews while catching the "pointed `--docs-dir` at the whole repo" mistake. Narrow scope rather than raise the cap.

### `hyper-docs-sync` is Claude-side, not Codex-side

`hyper-docs-sync` uses Claude (the `documenter` agent) to *edit* docs; the Codex `docs-review` gate then *critiques*. Editing needs write tools (Codex must stay read-only) and is mechanical; critiquing for accuracy is judgment-heavy. The two skills are intentionally paired: sync writes, review gates.

### Loop skills keep the worker as a live teammate but the reviewer is always the bridge

`hyper-plan-loop` (persistent `planner`) and `hyper-implement-loop` (persistent `fixer`) spawn their worker once as a team teammate so context isn't re-uploaded every revise/fix round. The reviewer is **always** a direct Codex bridge call, never a team agent — making it a Claude agent would collapse the "Claude builds, Codex reviews" invariant and bypass the sandbox.

- **Plan-loop amendment — planner writes the plan file directly:** the lead resolves/owns the plan path and instructs the planner teammate to write it there; the planner replies `WROTE: <path>` and idles. Caller-directed write-file mode, scoped to the loop — it avoids per-iteration plan-body round-trips. Con: the planner has `Write` (mitigated: caller-directed, exact-path-bound, loop-scoped; stock `hyper-plan` still uses return-body mode, unchanged).
- **Implement-loop cap is 3, not 5:** code-review is costlier/noisier than plan-review; 3 rounds (1 fresh + 2 resumed) bound cost while giving the fixer two convergence chances. `--commit <sha>` is forbidden as a loop target — the loop's fixed `--base main` lets `--resume auto` re-match the prior artifact by ref NAME; a changing SHA would switch resume-identity class and lose thread continuity. Fix-validation is a semantic finding-map check (every blocking finding → `fixed` or `not-applicable` with notes), not a diff check. No separate no-op/git-state gate — the Step 8 cap already bounds a stuck fixer.
- **agent-teams is env-gated, not probed:** requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`; on spawn failure each skill degrades to its own manual fallback (plan-loop → `hyper-plan` + `hyper-plan-review`; implement-loop → `hyper-implement` + `hyper-code-review`) rather than probing the env var (unreliable at invocation time).

### Plan-loop applies one Minor-cleanup pass, then hard-stops (Option B)

The old two-branch gate dropped Minor cleanup that Codex Verdicts explicitly prescribed (dogfooded: building-placement-tool, simulation-tick-loop), so an *actionable* Minor now triggers exactly one planner revision + one resumed re-review then hard-stop — a third branch, not a recursive tracker; a vague "ship after small fixes" with no identifiable change stays branch (b). No recursion: one extra review (outside the 5 severity-gated cap) plus a guaranteed stop beat chasing Minor to zero. Accepted risk: the cleanup re-review may regress to a new Blocker/Major — the loop still hard-stops but Step 9 flags it and withholds the implement recommendation rather than ship silently.

---

## Pointers (decisions documented elsewhere)

- **Bridge sandbox policy and CLI surface** — [architecture.md](architecture.md#the-bridge).
- **What each skill / agent does** — [gates-and-agents.md](gates-and-agents.md).
- **End-to-end cycle and skip rules** — [workflow.md](workflow.md).
- **Template versioning** — [development.md](development.md#templates).
