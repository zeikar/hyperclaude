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

### `--review-brief` third source: policy quoted from a tracked file

**Trigger:** dogfooding shows a real case where the user's conversation is genuinely insufficient and a tracked policy file is the only authority for an approved requirement.

A third admissible brief source — project policy quoted from a tracked file (e.g. `CLAUDE.md`) — was considered and deliberately CUT; the brief carries only what the user said in conversation. **Why:** it kept the caller surface small, and admitting tracked-file policy would drag in a pre-change-revision requirement — a builder could otherwise edit a policy file in the same change and cite its own freshly-added line as scope-authoritative — which in turn needs a per-target preimage rule to prove the quoted policy predated the change. Not worth that machinery absent a real need.

---

## Design decisions

### Research defaults to parallel Codex + Claude; `codex-version: claude` marks the Claude artifact

`hyper-research` runs **both** the Codex path and the Claude (`researcher` agent) path in parallel by default, producing two files; a single path runs only on explicit request. The bridge is intentionally untouched (it is the design invariant): the Codex artifact keeps the default `<ts>-<slug>.md`, the Claude one takes a `-claude` suffix, and both carry an identical frontmatter `slug:` — traceability is the shared slug, not the filename, so the "one slug per research→plan→plan-review trace" convention is unchanged.

Still additive, not a replacement: by default, Codex runs (the critic step holds the "Claude builds, Codex critiques" invariant); Claude is an extra lens. An explicit "Claude only / no-Codex" request skips Codex entirely. `codex-version: claude` distinguishes the Claude-authored artifact; both write the same always-present frontmatter keys so plan/plan-review treat either identically. Note: the `researcher` agent's `WebFetch` on known URLs is *not* parity with Codex's live `--search` crawl — the Claude path is for known-reference lookups, not open-ended search.

### `plugin-version` records the loaded copy, not the repo working tree

Every artifact's frontmatter carries `plugin-version` — the hyperclaude version that actually produced it. `getPluginVersion` (`scripts/codex/plugin.mjs`) reads `.claude-plugin/plugin.json` resolved *relative to its own file via `import.meta.url`*, NOT relative to `process.cwd()`. The distinction is the whole point: when dogfooding, the running bridge is often a different on-disk copy (e.g. the installed `~/.claude/plugins/cache/.../0.17.0/`) than the repo you're editing (`0.17.2`). cwd-relative resolution would record the repo's version and hide the mismatch; `import.meta.url`-relative records the code that ran. Read failures degrade to `"unknown"` rather than throwing — provenance is non-essential, so it must never break a gate.

### Claude-authored artifacts are stamped by a PostToolUse hook, not skill instructions

Bridge artifacts get `plugin-version` deterministically because the bridge writes their frontmatter in Node. Claude-authored artifacts (plans, epic roadmaps, the Claude research artifact) are written with the `Write` tool, so the only way to stamp them via skill text is to instruct the model to author the line — which is **non-deterministic** (the model can skip it, mistype the version, or misplace it) and **costs tokens** every run. Instead a `PostToolUse(Write)` hook ([hooks/stamp-artifact.mjs](../hooks/stamp-artifact.mjs)) injects the line after the write, reusing `getPluginVersion()` so the value matches the bridge's exactly. Chosen over the alternatives after a spike:

- **vs. a stamp-helper the skill pipes through** — still skill-invoked, so it inherits the same "did the model run the step" non-determinism. Rejected.
- **vs. a `PreToolUse` `updatedInput` rewrite** — would avoid the post-write mutation, but was unvalidated; the `PostToolUse` mutate-then-edit path was empirically verified (the harness detects the external change, re-syncs the file into context, and a subsequent `Edit` applies cleanly — no "modified since read" friction), so the proven path won.
- **Matcher is `Write` only** (not `Edit`) — the hook spawns a Node process per matched call, so scoping to `Write` keeps it off the far more frequent `Edit` path. Plans are created via `Write`; later `hyper-implement` checkbox edits don't re-trigger it.

Trade-off accepted: a detailed plan the planner authored frontmatter-free now carries a hook-added `plugin-version` block on disk. It's provenance only (no `tier:` marker), and `hyper-implement`'s epic guard keys on `tier: epic`, so the flip is invisible to execution. The hook is idempotent (skips files that already carry the key, so bridge artifacts and re-writes are no-ops) and fail-open.

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

`code-review --resume` has the same validation/fallback as plan-review/docs-review, including the `template-version` precondition (originally code-review-only; since v1.5.0 one shared gate covers every resumable mode). The fresh thread already carries the full `templates/codex/code-review.md` prompt, so the resumed `UserTurn` is a minimal target-explicit follow-up (it must restate the git command — resume doesn't re-run git collection). Identity matches by target type: `--base` by ref NAME (not resolved SHA — pinning SHA would review a stale diff), `--commit` by exact SHA, `--uncommitted` by symmetric absence of both keys. A prior artifact whose `template-version` mismatches is rejected (auto → fresh fallback; explicit → `resume rejected`).

### Fresh `code-review` uses a custom prompt + template, NOT native `codex exec review` (2026-05-18 reversal)

Fresh `code-review` spawns a regular `codex --search exec --sandbox read-only -` with the rendered `templates/codex/code-review.md` prompt — the same shape as research/plan-review/docs-review. **Do not re-migrate to native `codex exec review`:** the native subcommand owns its own prompt and diff-capture heuristics, which the bridge can't shape. The custom prompt controls (1) the severity vocabulary (`### Findings` Blocker/Major/Minor + `### Verdict`) the loops parse, and (2) exactly what Codex reads (bounded to the change, not a whole-repo scan). The prompt's `{{TARGET_INSTRUCTION}}` block has Codex run the git commands itself under read-only (the sandbox permits git, not writes). This supersedes the v0.4 "`codex review` → `codex exec review`" migration; the JSONL / thread-id / failure-body gains carried forward, only the native framing was dropped.

**Base target = committed-since-base PLUS uncommitted overlay:** for `--base <ref>` the target is the *effective worktree vs base* — `git diff <base>...HEAD` plus the uncommitted overlay (`git diff`, `--cached`, untracked). A commit-only diff was **rejected** because `hyper-implement-loop` re-runs `code-review --base main --resume auto` after the `fixer` leaves edits *uncommitted*; a commit-only base diff would hide them and the loop could never converge. (`--commit` reads the historical commit; `--uncommitted` the overlay only.)

Sub-decisions: **(a)** web search stays enabled (`--search` as in every mode); the template only *discourages* web use — no hermetic mode, filesystem read-only is the only hard sandbox. **(b)** `templates/codex/code-review.md` declares its `template-version` in its own leading frontmatter; the bridge propagates it into artifact frontmatter and the resume gate enforces a match against the current template's declared version — legacy native artifacts carry no match and are not resumable. **(c)** `--title` is metadata only (frontmatter key + heading) — no longer an argv argument.

**Lock-step cost (resolved v0.16.0):** `template-version` previously lived in three places (prompt body, `renderCodeReviewFrontmatter()`, `CODE_REVIEW_TEMPLATE_VERSION` constant in `scripts/codex/resume.mjs`). It now lives in ONE place — the template file's own frontmatter — and is read via `readTemplateWithVersion()` everywhere it's needed.

### Code-review flags over-engineering (template-version 2)

`templates/codex/code-review.md` carries an explicit over-engineering lens (speculative abstractions, unused flexibility, impossible-scenario defensive code, while-we're-here churn, single-use helpers, hypothetical-edge-case tests) on the **same severity scale** as any other finding — mirroring the rubric `plan-review` has carried since v0.16.0. **Why:** the *plan* was already critiqued for over-engineering but the implemented *code* wasn't, yet the manual `hyper-code-review` is the authoritative gate before merge/ship — where catching it matters most; it also encodes the repo's simplicity-first value at the gate. Detection pairs with prevention — `agents/planner.md` and `agents/implementer.md` each carry a one-line "don't author over-engineering" constraint so less of it reaches review. The output contract (sections / severities) is unchanged, so loop parsing is unaffected. Adding the lens bumped the prompt `template-version` 1→2: a pre-change code-review artifact is not resumable across the change — by design, since resume would otherwise continue a Codex thread that never saw the new lens.

**Non-blocking in the autonomous loops (deliberate).** `hyper-implement-loop` / `hyper-auto` keep their blocking criteria scoped to correctness / data-loss / security / broken-build / regression / missing-behavior; over-engineering findings are **surfaced but not auto-sent to the fixer**. Simplification (deleting an abstraction, inlining a helper) is a higher-judgment edit than a bug fix — auto-applying it in a loop risks removing something load-bearing — so it's left to a human, mirroring how `hyper-docs-loop` keeps its Gaps / Links / Cross-Doc sections report-only. The lens's primary home is the human-in-the-loop manual `hyper-code-review`; the loops are intentionally not widened for it.

### Code-review `--background` change context (template-version 3)

`templates/codex/code-review.md` was bumped from version 2 to 3 to add a `--background` slot: a short author-supplied change context injected into every fresh code-review spawn. Four sub-decisions govern it.

**(a) Descriptive, not prescriptive.** The orchestrator (`hyper-code-review` skill) passes the change context via `--background`, but the content must be strictly descriptive — what changed, what it touches, intent — and must NOT tell Codex what to flag or pre-judge severities. **Why:** the builder/critic independence invariant requires the critic's rubric to remain deterministic and unsteered. A builder-authored severity hint would leak the builder's own blind spots into the review, defeating the gate.

**(b) Injection boundary (fence + semantic instruction).** `--background` is CLI/user-supplied text rendered into the Codex prompt, so it is treated as UNTRUSTED. It is rendered inside a fenced `### Change context` block with a triple-backtick (` ``` `) text fence. A fence-collision guard rewrites any run of N≥3 backticks in the supplied text so it cannot close the fence — the trailing "space + single backtick" makes the run invalid as a CommonMark closing fence. A static template sentence additionally instructs Codex to treat the block as author-supplied DATA, never as instructions, and to not alter the rubric, severities, or what is flagged based on it. **Why:** a header label alone is not a boundary; structural fence plus semantic instruction together prevent injected text from hijacking the review prompt.

**(c) Mutual exclusion with `--resume`.** The args parser rejects `--background` combined with ANY `--resume` value, including `--resume auto` — error: `"--background is only supported when --resume is omitted"`. **Why:** resumed sessions already carry the change context in the Codex thread; a silently-ignored flag would be worse than a hard error. Accepted limitation: a `--resume auto` run that falls back to a fresh spawn will NOT carry `--background` — this is intentional and safe, because `--background`'s value is highest on the first fresh review.

**(d) Rendering is inline.** The `--background` slot is rendered directly inside the fresh code-review spawn path; the resume path is untouched. Its fence-collision guard was later extracted into a shared `escapeCodeFence` helper now used by both this channel and `--review-brief`; the brief additionally carries its own `renderReviewBriefBlock` renderer — unlike `--background`, which lands on one fresh path, the brief renders on four prompt paths (fresh + resumed, both review modes), so a shared block renderer earns its keep.

**Template-version progression:** code-review prompt went 1 (initial) → 2 (over-engineering lens, see entry above) → 3 (this `--background` slot). The output contract (`### Findings` / `### Verdict` sections and severity vocabulary) is UNCHANGED, so loop parsing and the resume gate are unaffected.

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

`hyper-plan-loop` (persistent `planner`), `hyper-implement-loop` (persistent `fixer`), and `hyper-docs-loop` (persistent `documenter`) spawn their worker once as a team teammate so context isn't re-uploaded every revise/fix round. The reviewer is **always** a direct Codex bridge call, never a team agent — making it a Claude agent would collapse the "Claude builds, Codex reviews" invariant and bypass the sandbox.

- **Plan-loop amendment — planner writes the plan file directly:** the lead resolves/owns the plan path and instructs the planner teammate to write it there; the planner sends a write-confirmation reply echoing the lead-minted per-request id (`WROTE: <reqid> <path>`) and idles. Caller-directed write-file mode, scoped to the loop — it avoids per-iteration plan-body round-trips. Con: the planner has `Write` (mitigated: caller-directed, exact-path-bound, loop-scoped; stock `hyper-plan` still uses return-body mode, unchanged).
- **Implement-loop cap is 6, not 10:** code-review is costlier/noisier than plan-review; 6 rounds (1 fresh + 5 resumed) bound cost while giving the fixer five convergence chances. `--commit <sha>` is forbidden as a loop target — the loop's fixed `--base main` lets `--resume auto` re-match the prior artifact by ref NAME; a changing SHA would switch resume-identity class and lose thread continuity. Fix-validation is a semantic finding-map check (every blocking finding → `fixed` or `not-applicable` with notes), not a diff check. No separate no-op/git-state gate — the Step 8 cap already bounds a stuck fixer. On clean convergence the lead commits the fixer's uncommitted fix edits once (`fix(review): …`) on the feature branch: the fixer invariant holds (lead commits, never the fixer), and committing only *after* the final review keeps the per-round `--base main` overlay reasoning unchanged. A cap-reached exit (blockers still open) leaves them uncommitted for manual triage.
- **Docs-loop cap is 6, same shape as implement-loop:** 1 fresh + 5 resumed `docs-review` rounds. Same per-finding semantic-map check (the documenter replies with `finding:` / `status:` / `files-changed:` / `verification:` / `notes:` per cited bullet, prefixed by `request-id: <id>` per shared §E). Only the `### Findings` template section is gating; `### Gaps`, `### Broken Or Suspect Links`, and `### Cross-Doc Inconsistencies` are reported in Step 9 but never auto-fixed — those need human judgment (which gap is worth filling? is this link genuinely broken or just suspicious?) that the loop should not silently resolve. No baseline `hyper-docs-sync` step: docs-loop is review ↔ fix only, since the code-diff-driven `hyper-docs-sync` scope and the docs-target-driven `docs-review` scope are different argument domains; users run `hyper-docs-sync` separately if they want a baseline.
- **agent-teams is env-probed:** as of Claude Code v2.1.178, `TeamCreate`/`TeamDelete` no longer exist — teams auto-form on the first `Agent` teammate spawn and are auto-cleaned on session exit. Each loop's Step 2 therefore explicitly checks `[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]` before spawning; there is no longer a tool whose failure surfaces unavailability. On env-probe failure (or a degrade where a bare-name send fails and no fallback `teammate_id` was captured — condition (1) per §A-DEGRADE D1; see the agent-teams addressing + 2026-06-21 entries below) each skill degrades to a deterministic STOP, with per-loop fallback guidance (plan-loop → `hyper-plan` + `hyper-plan-review`; implement-loop → `hyper-implement` + `hyper-code-review`; docs-loop → `hyper-docs-review` + manual edits). Lead→teammate sends run the §A send-resolution procedure (bare `teammate_name` on the main path; the `agent_id` fallback + notification-reply driving on degraded hosts are isolated in the removable §A-DEGRADE override); teardown on the main path is no-wait best-effort `{ type: "shutdown_request" }` to bare `teammate_name` (see the 2026-06-21 "§A(2) STOP→degraded-DRIVING re-scope" entry).

### Plan-loop severity gate: blocking-by-meaning, sibling-loop parity

Plan-loop's Step 6 severity gate now matches `hyper-implement-loop` and `hyper-docs-loop`: a finding gates the loop iff it concerns **plan-level correctness** (wrong file paths, broken task ordering, unverifiable steps, missing required behavior the implementer would inherit) — judged by meaning, not by the severity word Codex attached. Pure style nits, vague "consider X" suggestions, and prose-polish are reported in Step 9 but never trigger a revise round.

This replaces the earlier 3-branch design (branch (b) clean exit, branch (c) one-shot Minor-cleanup pass via a separate Step 7a, branch (a) Blocker/Major revise loop). The Step 7a cleanup was a bolted-on half-measure: it absorbed *actionable* Minor in one extra round but introduced a "revise regression" terminal state (when the cleanup re-review surfaced a new Blocker/Major the loop hard-stopped with no implement recommendation) and forced branch-conditional Step 9 reporting that diverged from the other loops. Letting blocking findings drive a normal revise round handles regressions naturally (a regression becomes the next round's blocking finding) and aligns the three autonomous loops on one mental model. The 10-review cap remains the divergence backstop; cap-reached always means blocking findings are still open (a non-blocking-only outcome at any iteration exits cleanly via Step 6 before the cap can trip), so cap-reached terminates in a manual-triage state, not a "ship anyway" state.

### Plan-loop per-request correlation id (stale-reply mis-attribution fix)

**Problem:** the lead could mis-attribute a stale planner write-confirmation to the current round, advancing the loop on a plan file that was NOT written for the current revision prompt.

**Root cause:** agent-teams gives plain-text messages no documented ordering/dedup/request-reply correlation — the `request_id` echo exists only for protocol `*_response` types (e.g. `shutdown_response`), not plain-text replies. Three factors widen the race window: (1) the in-place same-path overwrite makes a stale write-confirmation byte-identical to the next round's, so a path-only gate can't disambiguate; (2) the old solicited/unsolicited heuristic was blind in Step 7, where the lead DID solicit a reply; (3) the long Codex plan-review turn widens the window. Reproduced dogfooding the `20260519-1928-build-a-static-project-landing` run.

**Fix:** the lead mints a monotonic correlation id on EVERY solicitation (both §1 correctives and the §3 redo — reusing an id across rounds reintroduces the blind spot); the planner echoes `WROTE: <reqid> <path>`. The id fixes WROTE-reply mis-attribution; the payload-less idle race is handled separately by the `solicit_sent_at` stale-idle guard below.

### Plan-loop stale-idle guard (post-WROTE idle race follow-up)

**Problem:** even with the per-request id in place, a payload-less `idle_notification` queued from a PRIOR round can land between the current solicitation's send and the planner's reply — typically because the lead's previous turn ran Codex review for minutes and the planner's post-WROTE idle from that prior round was held until the next turn delivery. The pre-fix §6 Phase 2 rule treated any "reqid absent" wake as a contract failure and minted a fresh-id corrective; but the planner was still processing the prior solicitation, so it replied with a stale id, kicking off a perpetual 1-round-lag race that exhausted the loop until teardown.

Reproduced dogfooding session `3d1e79c2` (2026-05-19, v0.15.0): a payload-less idle queued from a prior round arrived ~3 s after the next solicitation; the pre-fix rule fired a corrective anyway, lagging one id per round until teardown without applying revise findings.

**Fix:** the lead records `solicit_sent_at` IMMEDIATELY BEFORE each SendMessage (via `date -u +%FT%TZ` — NOT the assistant-turn start, which can predate the actual SendMessage by minutes inside a long turn and re-open the same window). In `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E Phase 2, a payload-less idle with `idle.timestamp < solicit_sent_at` is recognized as a stale prior-round artifact and ignored silently (stay awaiting `expected_request_id`); only an idle with `timestamp >= solicit_sent_at` is a true post-solicit silence and triggers the §1 corrective round-trip. MESSAGE ACCEPTED clears `solicit_sent_at` alongside the other awaiting-state fields.

**Limit:** the guard only catches idle notifications. A planner that truly hangs (no idle, no reply) is still undetectable — the lead would wait indefinitely. That tradeoff is intentional: in practice a real hang is rare AND undetectable from outside, while the stale-idle false-positive is common enough to have broken a real dogfood run.

### Loop-protocol skeleton extracted to a shared reference

The autonomous-loop family (`hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`) shares an abstract request-id state machine, an unsolicited-message protocol skeleton, a teardown procedure, and a set of cross-loop anti-patterns. We extracted those to `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` at the plugin root rather than under `skills/_shared/` (ambiguous ownership under the skill-discovery directory) or `templates/` (reserved for prompts rendered into Codex stdin). The shared file is intentionally ABSTRACT — it does NOT carry the `WROTE:` token, the exact-path regex, or any post-acceptance validation specifics. Each loop's local `failure-protocol.md` is the binding layer that fills in (i) the teammate role-name, (ii) the loop-bound reply-token shape, (iii) the loop-bound anchored-reply acceptance rule, and (iv) the post-MESSAGE-ACCEPTED validation stage. SKILL.md Step 0 in each binding loop Reads BOTH files. **Phase A** of this refactor binds `hyper-plan-loop` to the shared base. `hyper-implement-loop` binds in a follow-on phase (which also resolves the deferred memory entry `implement-loop-reqid-followup`). `hyper-docs-loop` is the third consumer of the shared base — it binds the documenter role plus the implement-loop-style reply contract (`request-id: <id>` prefix + per-finding structured schema), confirming that the binding-hole pattern carries cleanly to a third loop without changes to the shared file.

**Phase B: implement-loop protocol strictness delta.** Phase B (Tasks 9–10) binds `hyper-implement-loop` to the shared base AND promotes its lead↔fixer protocol to use shared §E's request-id state machine. The fixer must now prefix every reply with `request-id: <id>` (the lead is the SOLE id source; the fixer echoes); the lead mints and tracks ids and uses them to detect stale replies per shared §E Phase 1 / Phase 2 routing. This resolves the deferred `implement-loop-reqid-followup` memory entry (the same lead↔teammate solicit-reply race that plan-loop's per-request correlation id fix above closed). The strictness is INTERNAL to the loop's lead↔teammate protocol — no external skill surface, no artifact, no slug, no command, no frontmatter, no bridge subcommand changes. The user-visible behavior change is that stalls under heavy Codex-review latency stop happening; everything else is byte-equivalent. Implement-loop's binding declarations (reply-token shape, accept rule, post-acceptance validation stage) live in `skills/hyper-implement-loop/references/failure-protocol.md`.

**Docs-loop binding (no protocol-strictness delta).** `hyper-docs-loop` reuses implement-loop's exact reply contract — `request-id: <id>` first-line prefix + per-finding structured schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:`) — for its documenter teammate. The contract is loop-injected via the Step 4 spawn prompt; `agents/documenter.md` stays loop-agnostic so the agent remains usable by `hyper-docs-sync` in its UPDATE/CREATE mode without drift. The docs-loop's gating choice is narrower than the other two: only `### Findings` drives fix rounds; `### Gaps`, `### Broken Or Suspect Links`, and `### Cross-Doc Inconsistencies` are reported in the final Step 9 summary but never sent to the documenter — those sections need human judgment.

### 2026-06-20 — `--model` / `--effort` bridge flags: dedicated flags, no default, override-aware resume

**(a) Dedicated flags, not generic `-c` passthrough.** A generic `-c key=value` passthrough would let callers bypass the sandbox by passing `-c sandbox_mode=write`, collapsing the read-only invariant that is the core thesis of the plugin ("Claude builds, Codex critiques"). Dedicated flags for model (`--model <name>`) and reasoning effort (`--effort <low|medium|high|xhigh>`) keep the allowed argv surface narrow and auditable; the bridge inserts them into the codex invocation AFTER the subcommand and BEFORE `--sandbox read-only` / `-c sandbox_mode=read-only`, so the sandbox flag always wins and cannot be overridden by the caller.

**(b) No bridge default.** When `--model` or `--effort` is omitted, the bridge passes neither flag to Codex. Codex inherits whatever `~/.codex/config.toml` specifies. Imposing a bridge default would silently override the user's own Codex configuration — a "surprising from a distance" side-effect without an obvious way to discover or clear it. Null = do not intervene.

**(c) Override-aware resume.** The bridge records `codex-model-requested` and `codex-effort-requested` in the artifact frontmatter when the flags are passed (omitted when not). On resume, the bridge compares the REQUESTED bridge overrides of the prior artifact against those of the current invocation: if both invocations were flagless the values match (both null); if one passed `--model gpt-5` and the other did not, the artifact is INELIGIBLE for resume. Under `--resume auto` the bridge skips the mismatched (newest) artifact and looks for an older matching one; only when NO candidate matches does it fall back to a fresh spawn recorded as `codex-resume-status: fallback`. An explicit `--resume <path>` to a mismatched artifact fails hard with a clear mismatch message. **Why separate from `template-version`:** the shared resumable-mode `template-version` gate guards against resuming a Codex thread that never saw the current prompt lens (prompt body changed). The override-aware check guards against resuming a thread seeded with a different model or effort level. Both are identity checks; they are evaluated independently and both must pass. **Scope limit:** the check compares only the values the bridge explicitly requested — two flagless runs both record null and match correctly; it does NOT detect `~/.codex/config.toml` drift (if the user changed their config between runs, the resume proceeds, since the bridge has no way to read or compare that config).

**(d) `none` and `minimal` excluded from `--effort`.** The Codex CLI's `--effort` / `-c model_reasoning_effort` parameter on `exec` accepts `low`, `medium`, `high`, and `xhigh`. `none` is plan-mode only in the Codex CLI and is not a valid exec reasoning level. `minimal` is not present in the local Codex reasoning-effort catalog. Both are rejected by the bridge's `parseArgs` at argv-parse time (exit 2) to fail fast rather than letting Codex surface an opaque error downstream.

### agent-teams loop protocol — addressing, teardown, degrade (current contract)

Consolidates the 2026-06-18 v2.1.178 migration and the two 2026-06-20 addressing reversals (id-only → bare-name); the blow-by-blow reversal history lives in git. The two 2026-06-21 entries below carry the latest deltas — the §A(2) STOP→DRIVING re-scope + removable §A-DEGRADE isolation, and the shared §F loop skeleton.

**Platform (v2.1.178+).** `TeamCreate`/`TeamDelete` were removed: teams auto-form on the first `Agent` teammate spawn (session-derived, member addressable by name, `to:"team-lead"` routing intact) and auto-clean on session exit; the `team_name` param was dropped. Because `TeamCreate`-failure was the old availability probe, each loop's Step 2 now gates on `[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]`.

**Addressing — bare-name primary, `agent_id` fallback (host-portable).** Two-host dogfooding showed the routing contract is host-mirrored: terminal-CLI live-mailbox accepts only the bare `teammate_name` (the forward-correct host where persistent teammates fully work); the VSCode-degraded host accepts only `agent_id`. Rather than a fragile error-string host branch, the §A send-resolution procedure tries bare name first and falls back to `agent_id` once, caching the winner as `resolved_handle`. Bare-name is primary because terminal-CLI is forward-correct and VSCode degradation is expected to converge — making the `agent_id` fallback a cleanly-removable dead path, now isolated in the removable §A-DEGRADE layer (see the 2026-06-21 entry below).

**Teardown — no-wait, object shape.** Teardown sends the structured object `{ type: "shutdown_request" }` (a plain string `message` was empirically rejected — "summary is required") best-effort ONCE and does not wait: a `shutdown_request` does not wake an at-rest teammate, and team config auto-cleans on session exit, so confirmation is not required for correctness. No autonomous `~/.claude/teams/` cleanup is attempted.

**Degrade.** When no usable handle exists (§A-DEGRADE R1 exhausted both bare name and `agent_id`), the loop STOPs WITHOUT a teardown attempt (no route to send on) and points at the loop's manual fallback. Per-loop side-effect asymmetry on STOP: docs-loop stops clean pre-edit (the documenter had not written yet); implement-loop preserves and reports the already-committed implementation on the feature branch (not a clean no-op); plan-loop does a post-write STOP reporting the partial plan-artifact path.

### 2026-06-20 — Token usage recorded in artifact frontmatter; effective model/effort not recorded

**(a) Usage keys recorded from `turn.completed.usage`.** The bridge records Codex token usage as four flat scalar frontmatter keys — `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` — taken directly from the `turn.completed.usage` object in the `codex exec --json` event stream. There is no `codex-total-tokens` key; the source object has no `total_tokens` field.

**(b) Gate is per-field, not all-or-nothing.** Each key is written independently when ITS specific field in `turn.completed.usage` is non-null (`if (usage.input_tokens != null)` etc.), so a partial usage object yields only the keys whose fields were present. In practice codex-cli >= 0.130.0 emits all four fields together, but the contract is per-field — preserving 0 values while omitting absent ones. Keys are omitted entirely when `turn.completed.usage` was absent from the JSONL stream (typically when Codex exited before emitting `turn.completed`). A run that emitted usage but then failed (non-zero exit, timeout, etc.) WILL still record the applicable keys in its failure artifact — those tokens were genuinely spent and recording them aids cost tracking. This mirrors the existing `if (codexThreadId)` omit-when-absent pattern used for `codex-thread-id`.

**(c) Effective model and reasoning-effort are NOT recorded — deferred, not impossible.** The `codex exec --json` event stream does not carry them: `thread.started` has only `thread_id`, `turn.completed` only `usage`, and in `--json` mode stderr is empty (the human-readable `model:` header prints only in non-JSON mode). Three recovery paths were weighed: an extra `codex` spawn (rejected — doubles latency/cost), hardcoding the CLI default (rejected — couples to Codex internals AND isn't the truly-resolved value), and parsing the session rollout file `${CODEX_HOME:-~/.codex}/sessions/YYYY/MM/DD/rollout-*-<threadId>.jsonl`, whose `turn_context` event carries `"model"` (the resolved value, override or default). The rollout path is viable — the `thread_id` the bridge already captures from `thread.started` maps byte-for-byte to the rollout filename (verified 2026-06-24 on codex-cli 0.135.0) — but is DEFERRED: it reaches into Codex's undocumented internal rollout format (a version-fragile coupling) and no current consumer needs the effective model. **Trigger to revisit:** an artifact-level model-comparison workflow, OR making `--resume` model-aware (today the resume gate compares only the REQUESTED override, so two flagless runs both record null and match even if `~/.codex/config.toml`'s default changed between them). The absence-means-flagless-invocation semantics of `codex-model-requested` / `codex-effort-requested` are unchanged.

### 2026-06-20 — `planner` gains `Edit` for in-place plan revision; write-file reply contract unchanged

**(a) Why.** In caller-directed write-file mode the planner previously had only `Write`, so every `hyper-plan-loop` revise round re-emitted the entire plan. For large plans that wastes output tokens and risks the model unintentionally altering tasks the findings never touched. Adding `Edit` lets the planner patch the cited sections in place.

**(b) Contract unchanged — added capability, not a new mode.** The write-file reply token stays `WROTE: <reqid> <path>` whether the planner used `Write` (initial creation) or `Edit` (later revision). The anchored reply gate, the post-acceptance structure `ok`/`bad` check, the exact-path rule, and `--resume` keying are all unaffected — `Edit` and `Write` both land the same file at the same path. No new reply shape or output mode was introduced.

**(c) Scope.** `Edit` is for the planner's OWN plan artifact only — the agent still writes/edits no other file (code/tests/other docs remain the implementer's / fixer's / documenter's job). The initial write and the missing-file corrective still use `Write` (there is no file to edit yet); revise rounds and the gate/structure correctives may use either.

### 2026-06-21 — §A(2) STOP→degraded-DRIVING re-scope + isolated removable §A-DEGRADE override

**PATCH candidate v1.2.3** — no version bump in this change; doc-only plus protocol isolation. This entry carries the latest delta on top of the consolidated agent-teams addressing entry above: it re-scopes that entry's earlier condition-(2) STOP (a teammate replying via task-completion result) to deterministic DRIVING, and isolates the degraded-host machinery into the removable §A-DEGRADE layer.

**(a) Why agent-teams is retained as the main path.** `SendMessage` (resume a subagent by id) is gated behind `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. A "fresh-subagent-per-round" alternative escapes agent-teams but loses cross-round context-reuse — context-reuse is the entire reason the `*-loop` family exists. Keeping agent-teams is correct; isolating the degraded-host fallback is the surgical fix.

**(b) Condition (2) re-scoped from STOP to deterministic degraded-DRIVING.** Prior protocol: a teammate replying via task-completion result (condition (2)) triggered a STOP. Two confirmed sessions prove that was over-conservative:

- Session `da02dc51` (VSCode-degraded): the build loop DROVE past condition (2) by reading the reply text from the `Agent` spawn task-completion result, applying the same §E id-classification + anchored-reply gate, and continuing the loop. Delivery via task-completion result vs. mailbox `SendMessage` is a transport detail — verification is identical.
- Session `9a7f4dd8` (protocol-compliant agent following the prior STOP rule): stopped at §A(2) and left an unreviewed plan. The STOP was non-deterministic over-conservatism — it halted work that the loop could have completed.

Both are observed facts; `da02dc51` drove, `9a7f4dd8` STOPped. Condition (2) now deterministically DRIVES via §A-DEGRADE D2. Conditions (1) and (3) (no usable handle) remain genuine STOPs — there is no addressable teammate to send to.

**(c) §A-DEGRADE is a single cleanly-removable layer.** All degraded-host machinery is now isolated:

- In `references/loop-protocol.md`: the entire `## §A-DEGRADE` section (D0/D1/D2/D3) plus every physical line bearing the `[DEGRADE]` tag.
- In the six loop files (`skills/hyper-plan-loop/SKILL.md`, `skills/hyper-implement-loop/SKILL.md`, `skills/hyper-docs-loop/SKILL.md`, and their three `failure-protocol.md` files): every `[DEGRADE]`-tagged line.

The smoke removal-simulation (`scripts/test/smoke.sh`) proves this: strip the §A-DEGRADE section + every `[DEGRADE]` line and check that zero `[DEGRADE]` markers, zero `§A-DEGRADE` references, and zero `resolved_handle`/`teammate_id` mentions remain. The remaining main §A/§B/§C/§D/§E reads standalone with bare `teammate_name` throughout.

**(d) Precise doc-cleanup list for when §A-DEGRADE is removed** (separate from the smoke grep; recorded here for the future cleanup pass — this 2026-06-21 decisions entry stays as historical record):

- `docs/architecture.md` — the loop-paragraph §A send-resolution sentence (restore to pure bare-name, drop the §A-DEGRADE parenthetical) + the `references/` tree comment (drop the `§A-DEGRADE` annotation).
- `docs/gates-and-agents.md` — the host-mirror §A note (drop the `§A-DEGRADE override` clause) + the `§A-DEGRADE override` parentheticals in the `hyper-plan-loop` / `hyper-implement-loop` / `hyper-docs-loop` Mechanics bullets + the Teardown bullet's `§A-DEGRADE D3` clause.
- `docs/workflow.md` — the three autonomous-alternative paragraphs (`hyper-plan-loop` ~§3, `hyper-implement-loop` ~§4, `hyper-docs-loop` ~§7): drop the `§A-DEGRADE override` / `degraded hosts` / `agent_id fallback` / `notification-reply driving` / `no-wait degrade teardown` clauses and restore each paragraph to describe the bare-`teammate_name` contract only.
- `docs/development.md` — the smoke-description paragraph (~§A-DEGRADE contract assertions): drop the `§A-DEGRADE` isolation-check sentence and the `agent_id` fallback / condition (2) DRIVING / conditions (1)/(3) STOP references; restore to describe only the bare-name routing positive lock + teardown object-shape lock.
- `docs/decisions.md` — this 2026-06-21 entry stays as the historical record (do not delete it on removal).

### 2026-06-21 — shared loop-skeleton extraction + prose de-dup

Token-reduction Level-1 refactor: triplicated SKILL boilerplate (agent-teams tool contract framing, Step 0 protocol-read, Step 2 agent-teams probe + stop message, Step 4a unsolicited-message handling, Step 8 teardown pointer, and degrade-condition pointers) was consolidated into a single new **§F shared loop skeleton** in `references/loop-protocol.md`; each of the three loop SKILL.md files now points at the named §F sub-blocks (F1–F5) by a one-liner rather than restating the prose (§F6 is the skeleton's own degrade-condition pointer to §A-DEGRADE D1/D2/D3 — it is referenced from within §F itself, not by the SKILLs, which reference §A-DEGRADE directly via their [DEGRADE] lines). Literal prose restatements collapsed to single canonical + pointer — including the `review_iteration` independence sentence (state field lives once in §E). The documented agent-teams stop message now lives once in §F3 with a `<fallback-command>` binding hole that each loop fills with its own fallback command names. **No behavior or semantic change.** `[DEGRADE]` isolation + §E race-guards preserved. Reference the 2026-06-21 §A(2) STOP→degraded-DRIVING entry (immediately above) for the isolation this §A-DEGRADE layer preserves.

Verified green on completion (`node --test` + `bash scripts/test/smoke.sh`, incl. the §A-DEGRADE removal-simulation + dual-handle confinement assertions). Net effect: one shared §F copy instead of three restatements — the per-trigger token win is modest by design, the structural win is drift elimination.

### 2026-07-04 — subagents background-by-default (v2.1.198); non-loop gate dispatches pin `run_in_background: false`

Claude Code 2.1.198 flipped the platform default: `Agent`-tool subagents now run in the **background** unless the dispatch explicitly pins `run_in_background: false`. Under the old default, a caller that awaited the result inline still worked because the platform ran synchronously by default; under the new default, an un-annotated dispatch returns a task handle immediately and the very next gate step would race ahead of the agent's actual result.

The sequential / result-inline dispatches in `hyper-implement` (the initial per-task implementer/reviewer dispatches AND any fix-loop re-dispatch), `hyper-plan` (the `planner` dispatches, both fresh and Milestone-expansion), `hyper-docs-sync` (the per-doc `documenter` dispatch), `hyper-research` (the single-Claude path's `researcher` dispatch — NOT the default-parallel path, see below), and `hyper-interview` (the up-front `Explore` dispatch) now pin `run_in_background: false` so each of these gates keeps blocking on the prior agent's result — deterministic gating no longer relies on the old platform default.

`hyper-research`'s default-parallel path is the deliberate exception: its backgrounded `researcher` dispatch stays `run_in_background: true` by design — that dispatch is meant to overlap with the concurrent Codex-bridge call, not block on it.

**Loop teammate spawns are deliberately NOT annotated.** The persistent-teammate spawns in the `*-loop` skills — `hyper-plan-loop`'s `planner`, `hyper-implement-loop`'s `fixer`, `hyper-docs-loop`'s `documenter` — carry no `run_in_background` pin. Those spawns MUST stay background: the whole agent-teams / `SendMessage` model depends on the teammate running as a live, addressable background process across multiple lead turns. Pinning `run_in_background: false` there would block the lead on the teammate's first turn and break the persistent-teammate model entirely.

### 2026-07-09 — `commands/` folded into skills; `hyper-setup` is now an invoke-only skill

Claude Code merged plugin **commands into skills**: a `commands/<name>.md` and a `skills/<name>/SKILL.md` both produce the same plugin-namespaced slash command (here `/hyperclaude:<name>`) and behave the same; `commands/` still works but is legacy. `hyper-setup` was the plugin's one command — chosen as a command precisely because a setup probe must be **explicit-invoke-only and never auto-trigger**, which description-triggered skills couldn't guarantee at the time.

Skills now express that directly via **`disable-model-invocation: true`** frontmatter (the same guard the docs cite for `/deploy`, `/commit`). So `hyper-setup` moved to `skills/hyper-setup/SKILL.md` with that flag, and the `commands/` layer was removed entirely — everything is now a skill.

**The body is unchanged in mechanism.** The inline `` !`node …/setup-doctor.mjs` `` probe-expansion (`!`…`` runs at prompt-render before Claude sees the content) works **identically** in a `SKILL.md` invoked via `/<name>` — confirmed against the official Skills docs — so the migration only added two frontmatter lines (`name`, `disable-model-invocation`) and swapped "command"→"skill" wording; the probe invocation string and both error-fallback sentences (which the smoke test asserts) are preserved verbatim.

**Dependency note:** the invoke-only guard now relies on a Claude Code that honors `disable-model-invocation`. Its introduction version is undocumented; the earliest changelog mention is a v2.1.126 *fix* (so the feature predates it), and v2.1.196 added a further guard against scheduled-task firing. On an older host that ignores the flag, `hyper-setup` would become auto-triggerable by its description — accepted, because the plugin is pre-adoption and tracks recent Claude Code (as a command it carried zero auto-trigger risk on any version; this is the one capability traded away by the merge).

### 2026-07-12 — docs get an anti-bloat counter-pressure (documenter brevity rule; docs-review template v2 adds redundancy)

Docs edits were append-heavy with nothing pushing back: the documenter's constraints limited *where* it edits but not how long additions run, and docs-review explicitly excluded prose — so unlike code (which gets Codex simplification pressure every loop), doc verbosity was never flagged anywhere. Fix, split by ownership so it ships to plugin consumers (agent + template, not repo CLAUDE.md): the documenter agent carries an authoring-time brevity constraint (amend existing sentences over appending paragraphs), and the docs-review template (v2) adds **redundancy** — unnecessary repetition within one document, explicitly excluding deliberate cross-doc propagation (which CLAUDE.md's mapping table mandates) — to its strict scope as a **Minor** finding with its own two-location evidence schema. Style stays excluded, and hyper-docs-loop explicitly classifies redundancy-only findings as non-blocking (reported, never auto-fixed — collapsing repeats needs human judgment), so loop convergence is untouched. Because a resumed thread keeps the prior prompt's semantics while the artifact is stamped with the current version, every resumable mode's `--resume` (plan-review / docs-review / code-review — one shared gate in `resume.mjs`) now enforces a template-version match (older-version artifacts: auto → fresh fallback, explicit → rejected); research has no resume path.

### 2026-07-14 — hyper-auto auto-runs hyper-recap as its terminal step (interview-decision reversal)

The original `hyper-recap` interview decided recap is NEVER auto-run; this reverses that for the `hyper-auto` composed-clean-exit case ONLY — never mid-loop, never directly from `hyper-plan-loop` (which never surfaces recap) or `hyper-implement-loop` (which keeps its recommendation-only line). Evidence: a 2026-07-14 real dogfood exercised both `context: live` and `context: artifacts-only` modes at work, and the user requested automation because the Step-9 recommendation line alone did not suffice. Non-obvious why: the terminal recap costs no additional Codex call and reuses already-available in-session context (still consumes Claude time/tokens — not free), and that context is richest exactly at the composed terminal moment, right after both inner loops finish; standalone loops keep the recommendation-only line because they are not always a full cycle's end. The reversal is deliberate and settled — do not re-open.

### 2026-07-15 — `--review-brief`: caller-composed scope context for both review modes (plan-review v3, code-review v4)

The plan-review prompt asks Codex to judge whether every task traces to a stated requirement, but the bridge never shows it the conversation where the user stated those requirements. On the v1.7.0 recap-diagram work Codex flagged the user's own approved ask (add a diagram to the recap) as scope creep — fresh, then AGAIN on the resumed round — because the requirement lived only in the chat it couldn't see. `--review-brief` closes that blind spot: a caller-composed summary of what the user asked for, rendered into a `{{REVIEW_BRIEF}}` DATA slot on all four review prompts. Contract:

- **Both review modes, both prompt kinds** — plan-review (v2→3) and code-review (v3→4) each gained the slot; the two `*-resumed.md` prompts carry it too (they stay frontmatter-less, inheriting the fresh version).
- **Persist + auto-carry** — written as the `review-brief:` frontmatter scalar and re-read on `--resume` as `carried`, so a caller cannot silently forget it mid-loop; `effectiveBrief = (flag ?? carried)?.trim() || null`.
- **Allowed with `--resume`, flag-overrides-carried** — deliberately NOT rejected alongside `--resume` (the reverse of `--background` sub-decision (c)): the brief must reach the critic on resumed rounds. A re-supplied flag overrides the carried value — needed for (1) surviving a `--resume auto` → fresh fallback and (2) folding in a decision the user approves mid-loop.
- **Bounded normative authority** — the block may narrow what counts as scope creep ("this was requested") but each template's guardrail paragraph independently forbids it from waiving correctness / security / data-loss findings; it is DATA, never instructions.
- **Caller-composed provenance** — Claude writes it, NEVER labelled user-authored; its only admissible sources are what the user stated verbatim / clearly-cited or explicitly approved in conversation. No admissible source → omit the flag (never synthesize).
- **Not a resume-identity field** — `scripts/codex/resume.mjs` is untouched; a changed brief does not break resume continuity.

Rules live in `references/review-brief.md`; the four caller skills (`hyper-plan-review`, `hyper-code-review`, `hyper-plan-loop`, `hyper-implement-loop`) point at it rather than restating.

### 2026-07-15 — repeatable `--docs-path` for `docs-review`

`--docs-path` is now repeatable — each occurrence appends a file, so `docs-review` can target a caller-named set (e.g. `README.md`, `docs/workflow.md`, `site/index.html`) in one run instead of one file at a time. Deliberately scoped narrow: no glob or recursive-walk expansion for the list (same rationale as the existing [`--docs-dir` recursion deferral](#recursive---docs-dir-walk-for-hyper-docs-review) above — the 200KB payload guard needs an explicit file set, not an open-ended pattern), and no extension to `plan-review` / `code-review`, which have no analogous multi-target need. The multi-file slug (`<first-file-slug>-plus-<n-1>`) is a human-readable LABEL only, not a uniqueness key — two different file sets can collide on it when they share a first-file basename; the real guard against a wrong resume match is `resume.mjs`'s order-insensitive set-equality check over the full `docs-target` list, not the slug.

`docs-target` frontmatter now encodes as a JSON array in `--docs-path` list mode (vs. the pre-existing JSON string in `--docs-dir` mode); `resume.mjs`'s identity check normalizes both shapes — a legacy scalar string is wrapped to a 1-element array before the set comparison — so pre-existing single-string artifacts remain resumable without a migration.

---

## Pointers (decisions documented elsewhere)

- **Bridge sandbox policy and CLI surface** — [architecture.md](architecture.md#the-bridge).
- **What each skill / agent does** — [gates-and-agents.md](gates-and-agents.md).
- **End-to-end cycle and skip rules** — [workflow.md](workflow.md).
- **Template versioning** — [development.md](development.md#templates).
