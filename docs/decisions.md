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

`code-review --resume` has the same validation/fallback as plan-review/docs-review, plus a `template-version` precondition. The fresh thread already carries the full `templates/codex/code-review.md` prompt, so the resumed `UserTurn` is a minimal target-explicit follow-up (it must restate the git command — resume doesn't re-run git collection). Identity matches by target type: `--base` by ref NAME (not resolved SHA — pinning SHA would review a stale diff), `--commit` by exact SHA, `--uncommitted` by symmetric absence of both keys. A prior artifact whose `template-version` mismatches is rejected (auto → fresh fallback; explicit → `resume rejected`).

### Fresh `code-review` uses a custom prompt + template, NOT native `codex exec review` (2026-05-18 reversal)

Fresh `code-review` spawns a regular `codex --search exec --sandbox read-only -` with the rendered `templates/codex/code-review.md` prompt — the same shape as research/plan-review/docs-review. **Do not re-migrate to native `codex exec review`:** the native subcommand owns its own prompt and diff-capture heuristics, which the bridge can't shape. The custom prompt controls (1) the severity vocabulary (`### Findings` Blocker/Major/Minor + `### Verdict`) the loops parse, and (2) exactly what Codex reads (bounded to the change, not a whole-repo scan). The prompt's `{{TARGET_INSTRUCTION}}` block has Codex run the git commands itself under read-only (the sandbox permits git, not writes). This supersedes the v0.4 "`codex review` → `codex exec review`" migration; the JSONL / thread-id / failure-body gains carried forward, only the native framing was dropped.

**Base target = committed-since-base PLUS uncommitted overlay:** for `--base <ref>` the target is the *effective worktree vs base* — `git diff <base>...HEAD` plus the uncommitted overlay (`git diff`, `--cached`, untracked). A commit-only diff was **rejected** because `hyper-implement-loop` re-runs `code-review --base main --resume auto` after the `fixer` leaves edits *uncommitted*; a commit-only base diff would hide them and the loop could never converge. (`--commit` reads the historical commit; `--uncommitted` the overlay only.)

Sub-decisions: **(a)** web search stays enabled (`--search` as in every mode); the template only *discourages* web use — no hermetic mode, filesystem read-only is the only hard sandbox. **(b)** `templates/codex/code-review.md` declares its `template-version` in its own leading frontmatter; the bridge propagates it into artifact frontmatter and the resume gate enforces a match against the current template's declared version — legacy native artifacts carry no match and are not resumable. **(c)** `--title` is metadata only (frontmatter key + heading) — no longer an argv argument.

**Lock-step cost (resolved v0.16.0):** `template-version` previously lived in three places (prompt body, `renderCodeReviewFrontmatter()`, `CODE_REVIEW_TEMPLATE_VERSION` constant in `scripts/codex/resume.mjs`). It now lives in ONE place — the template file's own frontmatter — and is read via `readTemplateWithVersion()` everywhere it's needed.

### Code-review flags over-engineering (template-version 2)

`templates/codex/code-review.md` carries an explicit over-engineering lens (speculative abstractions, unused flexibility, impossible-scenario defensive code, while-we're-here churn, single-use helpers, hypothetical-edge-case tests) on the **same severity scale** as any other finding — mirroring the rubric `plan-review` has carried since v0.16.0. **Why:** the *plan* was already critiqued for over-engineering but the implemented *code* wasn't, yet the manual `hyper-code-review` is the authoritative gate before merge/ship — where catching it matters most; it also encodes the repo's simplicity-first value at the gate. Detection pairs with prevention — `agents/planner.md` and `agents/implementer.md` each carry a one-line "don't author over-engineering" constraint so less of it reaches review. The output contract (sections / severities) is unchanged, so loop parsing is unaffected. Adding the lens bumped the prompt `template-version` 1→2: a pre-change code-review artifact is not resumable across the change — by design, since resume would otherwise continue a Codex thread that never saw the new lens.

**Non-blocking in the autonomous loops (deliberate).** `hyper-implement-loop` / `hyper-auto` keep their blocking criteria scoped to correctness / data-loss / security / broken-build / regression / missing-behavior; over-engineering findings are **surfaced but not auto-sent to the fixer**. Simplification (deleting an abstraction, inlining a helper) is a higher-judgment edit than a bug fix — auto-applying it in a loop risks removing something load-bearing — so it's left to a human, mirroring how `hyper-docs-loop` keeps its Gaps / Links / Cross-Doc sections report-only. The lens's primary home is the human-in-the-loop manual `hyper-code-review`; the loops are intentionally not widened for it.

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
- **agent-teams is env-probed:** as of Claude Code v2.1.178, `TeamCreate`/`TeamDelete` no longer exist — teams auto-form on the first `Agent` teammate spawn and are auto-cleaned on session exit. Each loop's Step 2 therefore explicitly checks `[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]` before spawning; there is no longer a tool whose failure surfaces unavailability. On env-probe failure (or a degrade where a bare-name send fails and no fallback `teammate_id` was captured — condition (1) per §A-DEGRADE D1; see the 2026-06-20 and 2026-06-21 entries) each skill degrades to a deterministic STOP, with per-loop fallback guidance (plan-loop → `hyper-plan` + `hyper-plan-review`; implement-loop → `hyper-implement` + `hyper-code-review`; docs-loop → `hyper-docs-review` + manual edits). Lead→teammate sends run the §A send-resolution procedure (bare `teammate_name` on the main path; the `agent_id` fallback + notification-reply driving on degraded hosts are isolated in the removable §A-DEGRADE override); teardown on the main path is no-wait best-effort `{ type: "shutdown_request" }` to bare `teammate_name` (see the 2026-06-21 "§A(2) STOP→degraded-DRIVING re-scope" entry).

### Plan-loop severity gate: blocking-by-meaning, sibling-loop parity

Plan-loop's Step 6 severity gate now matches `hyper-implement-loop` and `hyper-docs-loop`: a finding gates the loop iff it concerns **plan-level correctness** (wrong file paths, broken task ordering, unverifiable steps, missing required behavior the implementer would inherit) — judged by meaning, not by the severity word Codex attached. Pure style nits, vague "consider X" suggestions, and prose-polish are reported in Step 9 but never trigger a revise round.

This replaces the earlier 3-branch design (branch (b) clean exit, branch (c) one-shot Minor-cleanup pass via a separate Step 7a, branch (a) Blocker/Major revise loop). The Step 7a cleanup was a bolted-on half-measure: it absorbed *actionable* Minor in one extra round but introduced a "revise regression" terminal state (when the cleanup re-review surfaced a new Blocker/Major the loop hard-stopped with no implement recommendation) and forced branch-conditional Step 9 reporting that diverged from the other loops. Letting blocking findings drive a normal revise round handles regressions naturally (a regression becomes the next round's blocking finding) and aligns the three autonomous loops on one mental model. The 10-review cap remains the divergence backstop; cap-reached always means blocking findings are still open (a non-blocking-only outcome at any iteration exits cleanly via Step 6 before the cap can trip), so cap-reached terminates in a manual-triage state, not a "ship anyway" state.

### Plan-loop per-request correlation id (stale-reply mis-attribution fix)

**Problem:** the lead could mis-attribute a stale planner write-confirmation to the current round, causing the loop to advance on a plan file that was NOT written for the current revision prompt.

**Root cause (four evidence classes):**

- **[official docs]** The agent-teams "Context and communication" section documents only "automatic message delivery" and idle notifications. It provides **no DOCUMENTED guarantee** of ordering, dedup, or request/reply-correlation for plain-text messages — so the gap is an absence of documentation, not an affirmative platform failure.
- **[observed behavior, from the SendMessage tool schema]** The `request_id` echo mechanism exists only for protocol messages: the live SendMessage tool schema's legacy `*_response` types (e.g. `shutdown_response`, `plan_approval_response`) echo a `request_id` back to the sender; plain-text write-confirmation replies carry no built-in correlation. This was read from the tool schema directly — NOT from either of the two cited URLs below, which do not describe this rule.
- **[observed behavior]** Three structural factors widen the window: (1) the in-place same-path overwrite rule makes a stale planner write-confirmation byte-identical to the next round's, so the old path-only Step 4 gate could not disambiguate; (2) §2's solicited/unsolicited heuristic was structurally blind in Step 7 because the lead DID solicit a reply there; (3) the long Codex plan-review Bash turn widens the race window. Reproduced while dogfooding the `20260519-1928-build-a-static-project-landing` run.
- **[external article]** The claudecodecamp under-the-hood writeup describes the filesystem inbox delivery mechanics and shows a `permission_request` carrying a `request_id`. Cited ONLY for the filesystem-inbox / fire-and-forget delivery characterization — NOT for any "shutdown_request / plan_approval_request only" rule (the article does not state that).

**Fix:** the lead mints a monotonic correlation id on EVERY solicitation — including BOTH §1 corrective prompts and the §3 redo. Each is a fresh solicitation; reusing an id across rounds reintroduces the blind spot. The new contract form the planner must echo is `WROTE: <reqid> <path>`. The id fixes WROTE-reply mis-attribution; the payload-less idle notification race is addressed separately by the `solicit_sent_at` stale-idle guard documented in the follow-up sub-record below. The empty-idle corrective round-trip remains the fallback for a true post-solicit silence (idle with `timestamp >= solicit_sent_at`), now id-carrying so that round-trip is also correlatable.

**Sources:**
- [official docs — delivery + idle behavior only] https://code.claude.com/docs/en/agent-teams
- [external article — filesystem-inbox delivery mechanics] https://www.claudecodecamp.com/p/claude-code-agent-teams-how-they-work-under-the-hood

### Plan-loop stale-idle guard (post-WROTE idle race follow-up)

**Problem:** even with the per-request id in place, a payload-less `idle_notification` queued from a PRIOR round can land between the current solicitation's send and the planner's reply — typically because the lead's previous turn ran Codex review for minutes and the planner's post-WROTE idle from that prior round was held until the next turn delivery. The pre-fix §6 Phase 2 rule treated any "reqid absent" wake as a contract failure and minted a fresh-id corrective; but the planner was still processing the prior solicitation, so it replied with a stale id, kicking off a perpetual 1-round-lag race that exhausted the loop until teardown.

Reproduced while dogfooding cimulity session `3d1e79c2-…` (2026-05-19, the v0.15.0 dogfood): planner replied `WROTE: 1` then idled (idle.timestamp 21:53:18); the lead ran Codex review for 3.5 min, then sent revise id=2 at 21:57:03; the queued 21:53:18 idle arrived 3 seconds later as the lead's next turn input; the lead correctly identified it was stale, but the protocol said to corrective anyway; planner→lead lagged one id per round until teardown at id=5 without applying revise findings.

**Fix:** the lead records `solicit_sent_at` IMMEDIATELY BEFORE each SendMessage (via `date -u +%FT%TZ` — NOT the assistant-turn start, which can predate the actual SendMessage by minutes inside a long turn and re-open the same window). In `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` §E Phase 2, a payload-less idle with `idle.timestamp < solicit_sent_at` is recognized as a stale prior-round artifact and ignored silently (stay awaiting `expected_request_id`); only an idle with `timestamp >= solicit_sent_at` is a true post-solicit silence and triggers the §1 corrective round-trip. MESSAGE ACCEPTED clears `solicit_sent_at` alongside the other awaiting-state fields.

**Limit:** the guard only catches idle notifications. A planner that truly hangs (no idle, no reply) is still undetectable — the lead would wait indefinitely. That tradeoff is intentional: in practice a real hang is rare AND undetectable from outside, while the stale-idle false-positive is common enough to have broken a real dogfood run.

### Loop-protocol skeleton extracted to a shared reference

The autonomous-loop family (`hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`) shares an abstract request-id state machine, an unsolicited-message protocol skeleton, a teardown procedure, and a set of cross-loop anti-patterns. We extracted those to `${CLAUDE_PLUGIN_ROOT}/references/loop-protocol.md` at the plugin root rather than under `skills/_shared/` (ambiguous ownership under the skill-discovery directory) or `templates/` (reserved for prompts rendered into Codex stdin). The shared file is intentionally ABSTRACT — it does NOT carry the `WROTE:` token, the exact-path regex, or any post-acceptance validation specifics. Each loop's local `failure-protocol.md` is the binding layer that fills in (i) the teammate role-name, (ii) the loop-bound reply-token shape, (iii) the loop-bound anchored-reply acceptance rule, and (iv) the post-MESSAGE-ACCEPTED validation stage. SKILL.md Step 0 in each binding loop Reads BOTH files. **Phase A** of this refactor binds `hyper-plan-loop` to the shared base. `hyper-implement-loop` binds in a follow-on phase (which also resolves the deferred memory entry `implement-loop-reqid-followup`). `hyper-docs-loop` is the third consumer of the shared base — it binds the documenter role plus the implement-loop-style reply contract (`request-id: <id>` prefix + per-finding structured schema), confirming that the binding-hole pattern carries cleanly to a third loop without changes to the shared file.

**Phase B: implement-loop protocol strictness delta.** Phase B (Tasks 9–10) binds `hyper-implement-loop` to the shared base AND promotes its lead↔fixer protocol to use shared §E's request-id state machine. The fixer must now prefix every reply with `request-id: <id>` (the lead is the SOLE id source; the fixer echoes); the lead mints and tracks ids and uses them to detect stale replies per shared §E Phase 1 / Phase 2 routing. This resolves the deferred `implement-loop-reqid-followup` memory entry (the same lead↔teammate solicit-reply race that plan-loop's per-request correlation id fix above closed). The strictness is INTERNAL to the loop's lead↔teammate protocol — no external skill surface, no artifact, no slug, no command, no frontmatter, no bridge subcommand changes. The user-visible behavior change is that stalls under heavy Codex-review latency stop happening; everything else is byte-equivalent. Implement-loop's binding declarations (reply-token shape, accept rule, post-acceptance validation stage) live in `skills/hyper-implement-loop/references/failure-protocol.md`.

**Docs-loop binding (no protocol-strictness delta).** `hyper-docs-loop` reuses implement-loop's exact reply contract — `request-id: <id>` first-line prefix + per-finding structured schema (`finding:` / `status:` / `files-changed:` / `verification:` / `notes:`) — for its documenter teammate. The contract is loop-injected via the Step 4 spawn prompt; `agents/documenter.md` stays loop-agnostic so the agent remains usable by `hyper-docs-sync` in its UPDATE/CREATE mode without drift. The docs-loop's gating choice is narrower than the other two: only `### Findings` drives fix rounds; `### Gaps`, `### Broken Or Suspect Links`, and `### Cross-Doc Inconsistencies` are reported in the final Step 9 summary but never sent to the documenter — those sections need human judgment.

### 2026-06-20 — `--model` / `--effort` bridge flags: dedicated flags, no default, override-aware resume

**(a) Dedicated flags, not generic `-c` passthrough.** A generic `-c key=value` passthrough would let callers bypass the sandbox by passing `-c sandbox_mode=write`, collapsing the read-only invariant that is the core thesis of the plugin ("Claude builds, Codex critiques"). Dedicated flags for model (`--model <name>`) and reasoning effort (`--effort <low|medium|high|xhigh>`) keep the allowed argv surface narrow and auditable; the bridge inserts them into the codex invocation AFTER the subcommand and BEFORE `--sandbox read-only` / `-c sandbox_mode=read-only`, so the sandbox flag always wins and cannot be overridden by the caller.

**(b) No bridge default.** When `--model` or `--effort` is omitted, the bridge passes neither flag to Codex. Codex inherits whatever `~/.codex/config.toml` specifies. Imposing a bridge default would silently override the user's own Codex configuration — a "surprising from a distance" side-effect without an obvious way to discover or clear it. Null = do not intervene.

**(c) Override-aware resume.** The bridge records `codex-model-requested` and `codex-effort-requested` in the artifact frontmatter when the flags are passed (omitted when not). On resume, the bridge compares the REQUESTED bridge overrides of the prior artifact against those of the current invocation: if both invocations were flagless the values match (both null); if one passed `--model gpt-5` and the other did not, the artifact is INELIGIBLE for resume. Under `--resume auto` the bridge skips the mismatched (newest) artifact and looks for an older matching one; only when NO candidate matches does it fall back to a fresh spawn recorded as `codex-resume-status: fallback`. An explicit `--resume <path>` to a mismatched artifact fails hard with a clear mismatch message. **Why separate from `template-version`:** the code-review `template-version` check guards against resuming a Codex thread that never saw the current prompt lens (prompt body changed). The override-aware check guards against resuming a thread seeded with a different model or effort level. Both are identity checks; they are evaluated independently and both must pass. **Scope limit:** the check compares only the values the bridge explicitly requested — two flagless runs both record null and match correctly; it does NOT detect `~/.codex/config.toml` drift (if the user changed their config between runs, the resume proceeds, since the bridge has no way to read or compare that config).

**(d) `none` and `minimal` excluded from `--effort`.** The Codex CLI's `--effort` / `-c model_reasoning_effort` parameter on `exec` accepts `low`, `medium`, `high`, and `xhigh`. `none` is plan-mode only in the Codex CLI and is not a valid exec reasoning level. `minimal` is not present in the local Codex reasoning-effort catalog. Both are rejected by the bridge's `parseArgs` at argv-parse time (exit 2) to fail fast rather than letting Codex surface an opaque error downstream.

### 2026-06-18 — agent-teams v2.1.178 contract migration

`TeamCreate` and `TeamDelete` were removed in Claude Code v2.1.178 (see the agent-teams docs Note box: https://code.claude.com/docs/en/agent-teams). Teams now auto-form on the first `Agent` teammate spawn (session-derived team, member addressable by name, `to:"team-lead"` routing intact) and are auto-cleaned on session exit. The `team_name` parameter was dropped from `Agent` spawns; teardown is collapsed to `SendMessage shutdown_request` → confirmed termination, where confirmed termination is an idle-termination notification or a `shutdown_response` with `approve: true`. Because `TeamCreate` was the probe whose failure had previously made an agent-teams-unavailable host surface unavailability, each loop's Step 2 now explicitly checks `[ "$CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS" = "1" ]` as the availability gate — the env probe replaces the TeamCreate-as-probe pattern. Dogfooded on Claude Code 2.1.181 (2026-06-18): the real interactive-CLI persistent-teammate model is intact — session-derived team auto-forms, member addressable by name, structured `shutdown_request` removes the member cleanly. Bump per pre-adoption policy: MINOR (behavioral surface change to the loop-start protocol). **Superseded in part** — the teardown shape (no-wait, degrade-path branch) and id-only addressing were revised in the 2026-06-20 id-only entry immediately below; the rejected-shutdown retry-once recovery described here is REMOVED. The id-only addressing from that 2026-06-20 entry was itself subsequently reversed — see the 2026-06-20 "addressing contract reversed" entry further below.

### 2026-06-20 — id-only teammate addressing, no-wait teardown, degrade-path branch (**Superseded-in-part** — addressing portion reversed; notification-reply-STOP in (d) re-scoped to deterministic DRIVING; "no agent_id at spawn → STOP" trigger in (d) superseded — see 2026-06-21 entry; "addressing contract reversed" entry below)

> **Addressing note:** the id-only routing decision in (a) below was reversed by the 2026-06-20 "addressing contract reversed: bare-name primary + agent_id fallback (host-portable)" entry. The no-wait teardown (b), degrade-path branch (d), and autonomous cleanup (e) remain current; the teardown shape was updated to the `{ type: "shutdown_request" }` object form in that same reversal entry. The notification-reply-STOP in (d) — the claim that a teammate replying via task-completion result triggers a STOP — was re-scoped to deterministic DRIVING by the 2026-06-21 entry (condition (2) now DRIVES via §A-DEGRADE D2). **Additionally superseded by the 2026-06-21 entry:** the "no `agent_id` in the `Agent` spawn result" trigger in (d) is no longer a spawn-time degrade or STOP — §A-DEGRADE D0 now captures `agent_id` opportunistically (absence at spawn is NOT a degrade signal); condition (1) in D1 fires only AFTER a bare-name send has actually failed and no fallback `teammate_id` was captured.

Three related decisions stemming from a 2026-06-20 dogfood run (`SendMessage{to:<agent_id>}` string routing produced "resumed from transcript"; name-based routing returned "not addressable"):

**(a) Id-only addressing.** At spawn the lead captures the `Agent` result's `agent_id` into a run-state field `teammate_id` — an opaque string, never parsed or reformatted. Every lead→teammate `SendMessage` (findings/revise, corrective, shutdown) addresses `to: teammate_id`. There is no name-based fallback. Rationale: the dogfood showed that `SendMessage{to:<agent_id>}` routes correctly while name-based routing can silently fail with "not addressable" in the same session.

**(b) No-wait teardown.** §C sends `shutdown_request` to `teammate_id` best-effort ONCE and does NOT wait for confirmation. Root cause: a `shutdown_request` message does not wake an at-rest teammate, so waiting for a termination notification or `shutdown_response` would block indefinitely. Team config is auto-cleaned on session exit regardless, so confirmation is not required for correctness. The rejected-shutdown retry-once recovery added in commit c540910 is REMOVED — it addressed a scenario (a live teammate rejecting shutdown) that no longer applies now that teardown is not waited on.

**(c) Narrow causal note.** Id-only addressing (A) and no-wait teardown (B) are two independent decisions that happen to reinforce each other at shutdown: sending a `shutdown_request` to an at-rest teammate via `teammate_id` (id-only) is correct but unobservable — hence no-wait. For normal mid-loop sends (findings, correctives), id-only addressing is the routing fix; no-wait is NOT a premise of those sends. B is caused by the at-rest-no-wake property, not by A.

**(d) ENV-DEGRADE = missing OR unusable `agent_id`.** Degrade triggers when: no `agent_id` in the `Agent` spawn result, OR a `SendMessage` to the captured `teammate_id` returns "not addressable". Either condition means no usable route exists. Degrade is a **deterministic STOP/fallback** — the loop stops immediately; each loop's pre-existing manual fallback is the documented alternative. A notification-reply mode (where the loop waits for `to:"team-lead"` replies from the teammate) is REJECTED as out-of-scope: it would require migrating the §E + anchored-gate + `to:"team-lead"` reply pipeline without the id-routing fix, adding complexity that is not warranted. **Degrade-path teardown branch:** when the loop degrades and no addressable `teammate_id` exists, it STOPs WITHOUT a teardown attempt (no `shutdown_request` is sent — there is no usable route). A teardown attempt is made only when a usable `teammate_id` was captured and is known to route. **Per-loop side-effect asymmetry on STOP:** docs-loop stops cleanly pre-side-effect (the documenter had not yet made edits, so no partial state); implement-loop preserves and reports the already-committed implementation (hyper-implement ran before the fixer spawn — the implementation is on the feature branch; it is NOT a clean no-op); plan-loop performs a post-write STOP with an honest report of the partial plan-artifact path (the plan file was written by the planner; the loop stops before the review/revise cycle completes).

**(e) No autonomous `~/.claude/teams/` cleanup.** Teams and their config are auto-cleaned by the Claude Code session runtime on session exit; the loops do not attempt manual `~/.claude/teams/` removal.

### 2026-06-20 — addressing contract reversed: bare-name primary + agent_id fallback (host-portable) (**Superseded-in-part** — the R1 resolved_handle cache, condition (2) STOP, and degrade-path machinery are now isolated in the removable §A-DEGRADE override; condition (2) re-scoped from STOP to deterministic DRIVING — see 2026-06-21 entry)

Two-host dogfood finding: host routing contracts are a MIRROR image.

- **VSCode-degraded host:** `SendMessage{to:<agent_id>}` routes correctly; bare-name form returns "No agent named X is currently addressable". The prior id-only entry (above) was derived on this host.
- **Terminal-CLI live-mailbox host:** `SendMessage{to:<bare_name>}` routes correctly; `agent_id` form returns "to must be a bare teammate name — there is only one team per session". This is the forward-correct host where persistent teammates are fully supported.

The two contracts are determined by host, not by session or loop logic. A host-detection branch would require detecting which error string appears (fragile, string-agnostic goal), and the routing decision must be made BEFORE the first send — so detect-then-route creates a mandatory speculative first-send just to probe. Instead: a single §A send-resolution procedure handles both without a host branch.

**Decision — §A send-resolution procedure:** two sub-rules:

**(R1) Handle resolution (ALL sends, including teardown).** On the FIRST send in a session: try the bare spawn `name`; if that send fails, try `agent_id` ONCE; whichever succeeds becomes the cached `resolved_handle` for all subsequent sends in this session. Once cached, `resolved_handle` is used directly — no further fallback. Error-string-agnostic: any failed send triggers the one fallback attempt (not just specific error messages). On a clean run where teardown is the FIRST send, teardown invokes R1 before sending `{ type: "shutdown_request" }`.

**(R2) Request-id / `solicit_sent_at` state (id-bearing solicitations only; teardown id-exempt).** For solicitations that carry a per-request id (findings/revise, correctives): mint the id FIRST (§E), then R1 delivers it; on a fallback delivery `solicit_sent_at` is recaptured immediately BEFORE the actually-delivered send (not the pre-fallback attempt timestamp, which would widen the stale-idle window).

**(a) Why bare name is primary.** Terminal-CLI live-mailbox is the forward-correct host — persistent teammates are fully operational there. VSCode degradation (teammates reduced to background subagents) is a host constraint expected to converge. Bare-name-first means the common future case is also the fast path; the `agent_id` fallback is a cleanly-removable dead path when VSCode converges.

**(b) No-wait best-effort retained.** From the prior id-only entry: teardown sends the object (not a string) and does not wait for confirmation. No change — the at-rest-no-wake property still applies.

**(c) Degrade-path branch retained.** When the loop degrades and no teammate is addressable (R1 exhausted both handles, both failed), it STOPs WITHOUT a teardown attempt — same as the prior entry's no-usable-route branch.

**(d) `{ type: "shutdown_request" }` object shape.** The teardown payload is always the structured object `{ type: "shutdown_request" }`, not a plain string `message`. A string `message` was empirically rejected ("summary is required"). The object form is the canonical shutdown shape.

**(e) Bump candidate.** PATCH per pre-adoption policy — behavioral surface change internal to the loop protocol; no bridge subcommand, no frontmatter key, no artifact path, no skill or command name changed.

### 2026-06-20 — Token usage recorded in artifact frontmatter; effective model/effort not recorded

**(a) Usage keys recorded from `turn.completed.usage`.** The bridge records Codex token usage as four flat scalar frontmatter keys — `codex-input-tokens`, `codex-cached-input-tokens`, `codex-output-tokens`, `codex-reasoning-output-tokens` — taken directly from the `turn.completed.usage` object in the `codex exec --json` event stream. There is no `codex-total-tokens` key; the source object has no `total_tokens` field.

**(b) Gate is per-field, not all-or-nothing.** Each key is written independently when ITS specific field in `turn.completed.usage` is non-null (`if (usage.input_tokens != null)` etc.), so a partial usage object yields only the keys whose fields were present. In practice codex-cli >= 0.130.0 emits all four fields together, but the contract is per-field — preserving 0 values while omitting absent ones. Keys are omitted entirely when `turn.completed.usage` was absent from the JSONL stream (typically when Codex exited before emitting `turn.completed`). A run that emitted usage but then failed (non-zero exit, timeout, etc.) WILL still record the applicable keys in its failure artifact — those tokens were genuinely spent and recording them aids cost tracking. This mirrors the existing `if (codexThreadId)` omit-when-absent pattern used for `codex-thread-id`.

**(c) Effective model and reasoning-effort are NOT recorded.** The `codex exec --json` event stream does not carry effective model or effort: `thread.started` carries only `thread_id`; `turn.completed` carries only `usage`; there is no `session_configured` or equivalent event. Recording effective model/effort would require either an extra `codex` spawn (rejected — doubles latency, doubles cost) or hardcoding the CLI's default (rejected — ties the bridge to Codex CLI internals that can change). The existing absence-means-flagless-invocation semantics of `codex-model-requested` / `codex-effort-requested` are unaffected — the resume contract is unchanged.

### 2026-06-20 — `planner` gains `Edit` for in-place plan revision; write-file reply contract unchanged

**(a) Why.** In caller-directed write-file mode the planner previously had only `Write`, so every `hyper-plan-loop` revise round re-emitted the entire plan. For large plans that wastes output tokens and risks the model unintentionally altering tasks the findings never touched. Adding `Edit` lets the planner patch the cited sections in place.

**(b) Contract unchanged — added capability, not a new mode.** The write-file reply token stays `WROTE: <reqid> <path>` whether the planner used `Write` (initial creation) or `Edit` (later revision). The anchored reply gate, the post-acceptance structure `ok`/`bad` check, the exact-path rule, and `--resume` keying are all unaffected — `Edit` and `Write` both land the same file at the same path. No new reply shape or output mode was introduced.

**(c) Scope.** `Edit` is for the planner's OWN plan artifact only — the agent still writes/edits no other file (code/tests/other docs remain the implementer's / fixer's / documenter's job). The initial write and the missing-file corrective still use `Write` (there is no file to edit yet); revise rounds and the gate/structure correctives may use either.

### 2026-06-21 — §A(2) STOP→degraded-DRIVING re-scope + isolated removable §A-DEGRADE override

**PATCH candidate v1.2.3** — no version bump in this change; doc-only plus protocol isolation. This entry supersedes the id-only-addressing and notification-reply-STOP portions of the 2026-06-20 "id-only teammate addressing" and "addressing contract reversed" entries (reference those headings; the entries are not deleted — they remain as historical record).

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

Token-reduction Level-1 refactor: triplicated SKILL boilerplate (agent-teams tool contract framing, Step 0 protocol-read, Step 2 agent-teams probe + stop message, Step 4a unsolicited-message handling, Step 8 teardown pointer, and degrade-condition pointers) was consolidated into a single new **§F shared loop skeleton** in `references/loop-protocol.md`; each of the three loop SKILL.md files now points at the named §F sub-blocks (F1–F6) by a one-liner rather than restating the prose. Literal prose restatements collapsed to single canonical + pointer — including the `review_iteration` independence sentence (state field lives once in §E). The documented agent-teams stop message now lives once in §F3 with a `<fallback-command>` binding hole that each loop fills with its own fallback command names. **No behavior or semantic change.** `[DEGRADE]` isolation + §E race-guards preserved. Reference the 2026-06-21 §A(2) STOP→degraded-DRIVING entry (immediately above) for the isolation this §A-DEGRADE layer preserves.

Verified on completion: `node --test` (4 suites) → tests 309 / fail 0, and `bash scripts/test/smoke.sh` → passed 164 / failed: 0 (incl. the §A-DEGRADE removal-simulation + dual-handle confinement assertions still green). Slimming: the three loop SKILL.md files dropped 4045→3644, 4138→3805, 4052→3722 words (−1064 total); `loop-protocol.md` grew +260 (the single §F copy absorbing the prose de-dups), for a net −804 across the seven files — the per-trigger win is modest by design, the structural win is one shared copy instead of three (drift eliminated).

---

## Pointers (decisions documented elsewhere)

- **Bridge sandbox policy and CLI surface** — [architecture.md](architecture.md#the-bridge).
- **What each skill / agent does** — [gates-and-agents.md](gates-and-agents.md).
- **End-to-end cycle and skip rules** — [workflow.md](workflow.md).
- **Template versioning** — [development.md](development.md#templates).
