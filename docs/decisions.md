# Decisions

Non-obvious "why is X like this" notes. Read this when something looks off and you're tempted to "fix" it — chances are it's deliberate.

For active findings inside a session, use `.hyperclaude/` artifacts. This file is for cross-version decisions and deferrals.

---

## Active deferrals

Deliberate non-decisions. Each has an explicit trigger for when to revisit.

### `UserPromptSubmit` hook layer

**Status:** deferred since v0.1. **Trigger:** when manual slash-command invocation feels like the friction users keep complaining about (or own author hits it daily).

The original v0.1 design included a "nudge" / `UserPromptSubmit` hook layer that would auto-suggest the right gate based on prompt content. v0.1 shipped with skills + agents only — gates are user-triggered slash commands.

Why deferred: hook reliability and false-positive cost. A nudge that fires on every prompt (or fails to fire when it should) is more annoying than the missing automation. v0.3 dogfooding shows the explicit slash-command flow is acceptable; the hook layer's value-to-noise ratio is unproven.

When to revisit: a clear trigger pattern emerges (e.g. user always runs `hyper-research` before `planner`, so detect "let's plan X" and offer the research gate). At that point the hook is a thin matcher, not a model call.

### Recursive `--docs-dir` walk for `hyper-docs-review`

**Status:** deferred. **Trigger:** any consumer project with `docs/` nested deeper than one level.

Today `--docs-dir <path>` reads only top-level `.md` files in `<path>`. Subdirectories are ignored. The 200KB payload guard is the gating concern — recursion would need a per-file budget and meaningful "which subdir to skip" defaults.

Workaround: invoke `hyper-docs-review` per subdir. For most projects (commentarium-style flat `docs/`) this is fine.

When to revisit: a consumer project with deeply nested docs (`docs/api/v1/`, `docs/architecture/components/`, etc.) appears, and the per-subdir invocation pattern becomes annoying. At that point: glob with depth limit, surface skipped files in the report.

### Configurable default branch for `code-review` / `docs-sync`

**Status:** deferred. **Trigger:** consumer project that uses `master` / `develop` as the trunk and the manual `vs <ref>` form gets tedious.

Both skills hardcode `main` as the implicit base. Users on other trunk names must pass an explicit ref via the slash-command target form: `/hyperclaude:hyper-docs-sync vs master` or `/hyperclaude:hyper-code-review vs master`. (The underlying bridge flag for direct invocation is `--base master`.) The contract is documented but the default is opinionated.

Why deferred: most projects targeted today use `main`. Adding a config knob means another file to maintain, another precedence rule to remember.

When to revisit: more than one consumer project running into this. Implementation is small (read `.hyperclaude/config.json` or `git config init.defaultBranch`), but the *cost* is "one more place to look when behavior surprises you."

### Diff-base resolved-SHA capture in frontmatter

**Status:** deferred. **Trigger:** a code-review or docs-review output is later re-evaluated and the original branch has moved.

The `code-review` frontmatter records `git-head` (the SHA at review time) but not the resolved SHA of `--base` or `--diff-base`. If `main` advances after the review, re-reading the file later loses the exact pair of SHAs that the review covered.

Why deferred: the timestamp in the filename plus `git-head` is enough for typical cases. Resolved-base capture is a clean addition but solves a niche problem.

When to revisit: any time someone needs to re-run a historical review and finds the base has drifted.

### Research resume

**Status:** deferred. **Trigger:** explicit user request, or the dogfood cycle generating iterative research follow-ups frequently enough to make resumption practical.

Research today is a single-pass gate, not a "fix → re-review" workflow. There is no natural resumed prompt to construct without re-uploading context that the resume is supposed to avoid.

### Additional error-path coverage (EACCES, etc.)

**Status:** deferred. **Trigger:** real user runs into a rough error message in the wild.

Today's coverage:

- `ENOENT` is mapped to a friendly message only for the docs path/dir (`docs file not found: …` / `docs dir not found: …`).
- `EISDIR` is mapped only for `--docs-path` (steering the user to `--docs-dir`).
- Task-file and plan-file reads use a generic `cannot read X: <err.message>` and exit 1 for any error code.
- Per-file reads inside `--docs-dir` aren't wrapped at all — they propagate as a Node stack trace if a file disappears between the directory listing and the read.

Coverage is uneven by intent — adding mappings for codes that haven't actually bitten anyone is YAGNI.

When to revisit: a specific error code shows up in a bug report.

---

## Design decisions

### Codex is `--sandbox read-only`, always

**Decision:** every Codex spawn enforces read-only, but the mechanism varies by subcommand:

- **Fresh `codex exec`** (research / plan-review / docs-review): passes the `--sandbox read-only` flag.
- **`codex exec resume`** (plan-review / docs-review / code-review with `--resume`): no `--sandbox` flag is exposed; passes `-c sandbox_mode=read-only` as a config override.
- **`codex exec review`** (fresh code-review): no `--sandbox` flag; passes `-c sandbox_mode=read-only` as a config override.

`code-review` was migrated from the bare `codex review` subcommand to `codex exec review` in v0.4. Same review-only behavior, but gains JSONL stream, thread-id capture, structured failure body, and shared spawn helper. Native review prompt is preserved (no positional prompt, no stdin pipe).

**Rejected alternative:** allow Codex to write patches in some modes. Lets Codex propose concrete edits.

**Why rejected:**
- The thesis is "Claude builds, Codex critiques." Allowing Codex to author patches collapses the role split.
- User trust depends on knowing Codex never mutates the workspace.
- The two argv shapes (`--sandbox read-only` for fresh exec; `-c sandbox_mode=read-only` for resume / exec review) are both explicit in argv and auditable; user-side `~/.codex/config.toml` defaults can't override either.

### Resume requires `-c sandbox_mode=read-only`

**Decision:** `runCodexResume` (defined in `scripts/codex/codex.mjs` and re-exported via `scripts/codex-bridge.mjs`) explicitly passes `-c sandbox_mode=read-only` on every `codex exec resume` call.

**Why:** `codex exec resume` does NOT inherit the original session's `--sandbox` flag. Verified empirically: a session originally spawned with `--sandbox read-only` then resumed without sandbox config wrote files freely (both `/tmp` and the workspace). Adding `-c sandbox_mode=read-only` to the resume argv enforces read-only correctly and preserves the bridge's hard contract — Codex never writes the workspace — across resume.

### Code-review resume: native framing preserved + ref-name validation

**Decision:** `code-review --resume` is supported with the same validation and fallback semantics as `plan-review --resume` and `docs-review --resume`.

**Implementation:**
- Native `exec review` framing is preserved across resume because the original thread carries review base instructions. The resumed `UserTurn` is generic, but the thread context maintains the review subagent persona.
- The resumed prompt is target-explicit: it includes the exact git command to re-fetch the diff (the `{{TARGET_INSTRUCTION}}` block from the template). This is mandatory because `codex exec resume` does not re-trigger native diff capture.
- Identity matching by target type: `--base <ref>` by ref NAME (not resolved SHA; pinning SHA would force resume to review a stale diff), `--commit <sha>` by exact SHA, `--uncommitted` by symmetric absence of both `base-ref` and `commit` keys in the prior artifact's frontmatter.

**Why:** `codex exec review` (fresh) internally captures the diff and uses a native review prompt. `codex exec resume` is generic exec continuation, so the bridge must provide the target command explicitly in the resumed prompt. Using ref NAME rather than SHA allows the review to track the logical target (e.g., the latest `main`) across the resume, not lock to the SHA at the original review's time.

### Resumed prompts are minimal follow-ups; bridge owns file list and size budgets, not Codex

**Decision:** the resumed prompt does NOT re-upload the original payload (docs, plan, or code diff). For `plan-review` and `docs-review` it names the changed file and asks Codex to re-read via the read-only sandbox; for `docs-review --docs-dir` it embeds the exact aggregated file list; for `code-review` it embeds explicit git commands (`{{TARGET_INSTRUCTION}}`) so the resumed `UserTurn` re-fetches the diff (since `codex exec resume` does not re-trigger native diff capture). Codex's prompt cache covers the original payload across the conversation.

**Why:** re-uploading defeats the token-savings purpose of resume. The trade-off is that the bridge re-runs the 200KB / 500KB size budgets on resume to ensure Codex isn't asked to re-read a payload that's now too large. If the budget is exceeded on resume, the bridge fails (not a silent fallback) because the user changed the situation.

### MIN_CODEX bumped to 0.130 (was 0.128)

**Decision:** the bridge's minimum required codex-cli version is 0.130.0.

**Why:** v0.4 depends on `codex exec review`, `codex exec resume`, and `-c sandbox_mode=read-only` config overrides. These were verified on codex-cli 0.130.0; older versions may lack the subcommands. The bridge fails fast at `getCodexVersion` startup with an upgrade hint. Smoke probes (`codex exec review --help`, `codex exec resume --help`, `codex exec review --base HEAD -c sandbox_mode=read-only --help`) catch surface drift earlier.

### Fresh subagent per task in `hyper-implement`

**Decision:** dispatch a new `implementer` subagent for every task in the plan. Don't reuse one across tasks.

**Why:** v0.1 dogfooding (the 11-task plan that built v0.1, ~33 subagent dispatches) showed that reusing a subagent across multiple tasks pollutes context with prior diffs and degrades focus. Fresh dispatch is cheap (Claude Code makes it free at the SDK level) and the focus benefit is large.

**Why two reviews per task (spec + quality):**
- Spec compliance review uses a *general-purpose* subagent (NOT `verifier` — verifier runs tests). It catches scope drift: implementer added unrequested features, missed a requirement.
- Code quality review (also general-purpose) catches clarity / YAGNI / test-quality issues with severity tagging.
- Skipping either lets bugs through. The v0.1 cycle caught two real bugs that the implementer's self-review missed.

### Slug propagation via filename suffix

**Decision:** plan files are named `<YYYYMMDD-HHMM>-<slug>.md`. The bridge's `extractSlugFromPlanFilename()` strips the timestamp and reuses the `<slug>` for the plan-review file.

**Why:** the research → plan → plan-review trio is naturally linked by topic. Sharing a slug across the three artifacts (and not requiring a manifest file) keeps the metadata in the filenames where it's already visible.

**Rejected alternative:** a `.hyperclaude/manifest.json` tracking related artifacts. Adds a state file, adds parsing, adds a way to drift. Filenames are the simplest carrier.

### `code-review` and `docs-review` slugs are release-level, not feature-level

**Decision:** code-review slugs come from the diff target (`vs-main`, `uncommitted`, `commit-<sha7>`); docs-review slugs come from the docs target's basename. Neither inherits the feature slug.

**Why:** a single release-gate run reviews many features at once. Tying the review filename to one feature slug would be misleading. The release-level naming makes the artifact self-describing.

### Zero npm dependencies

**Decision:** the bridge uses Node 18+ stdlib only. No `package.json`, no `node_modules`.

**Why:**
- Plugins should be cheap to install and audit. A Claude Code user who runs `/plugin install hyperclaude` should not also need `npm install` for a plugin to work.
- The bridge code lives in `scripts/codex-bridge.mjs` (the CLI entry that owns mode dispatch) plus leaf modules under `scripts/codex/` (`args`, `paths`, `resume`, `templates`, `frontmatter`, `slug`, `git`, `codex`, `failure`). A YAML parser, a fancy CLI lib, a templating engine — none earn their weight here.
- Stdlib forces simpler design: regex slugs, tagged template strings instead of Handlebars, hand-rolled argv parsing instead of yargs.

**Cost accepted:** a custom argv parser that has to be tested per-mode (`ALLOWED_FLAGS_PER_MODE`); manual frontmatter rendering. Both are covered by unit tests.

### Size guards at 200KB / 500KB

**Decision:** `docs-review` rejects docs payloads `> 200KB` and `--diff-base` diffs `> 500KB`.

**Why:** Codex's actual context limits are higher, but failing fast at sane bridge-level limits is better than waiting 30s for Codex to choke on a megabyte of docs. The numbers are picked to comfortably fit 99% of real reviews while catching the "user pointed `--docs-dir` at the whole repo" mistake immediately.

When a real corpus needs more, narrow the scope (`--docs-path`, smaller `--docs-dir`) rather than raising the cap. If the cap genuinely needs raising, the per-file budget + recursion in the deferred items above is the right place to do it.

### `hyper-docs-sync` is Claude-side, not Codex-side

**Decision:** the docs-sync gate uses Claude (via the `documenter` agent) to *edit* docs. The Codex `docs-review` gate then *critiques* the result.

**Why:**
- Editing requires write tools. Codex must stay read-only (see "Codex is `--sandbox read-only`, always").
- Editing is mechanical (apply a diff to a doc). Critiquing for accuracy is judgment-heavy. The role split lines up: Claude does the mechanical edit, Codex does the judgment call.

The two skills are intentionally paired: `hyper-docs-sync` writes; `hyper-docs-review` gates.

### `hyper-plan-loop` keeps the planner as a live teammate but NOT the reviewer

**Decision:** `hyper-plan-loop` spawns the `planner` agent once as a persistent team teammate (retaining context across revise iterations), but the plan reviewer is always a direct Codex bridge call — not a team agent.

**Why persistent planner:** without a persistent teammate, each revise turn would re-spawn a fresh `planner` agent, which re-uploads the plan and research context from scratch every round. The context-reload cost grows with iteration count. Keeping the planner as a live teammate eliminates that overhead.

**Why reviewer stays a direct bridge call:**
- The "Claude builds, Codex reviews" invariant is the core thesis. Making the reviewer a Claude team agent would collapse the role split.
- The skills-call-bridge layer rule (skills shell out to the bridge; agents don't) must hold for the reviewer path.
- A Codex bridge call is auditable and sandbox-enforced; a Claude agent reviewer would bypass both.

**Why agent-teams is env-gated, not probed:**
- Agent teams is an experimental Claude Code feature. The skill requires `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`. On spawn failure the skill degrades gracefully rather than probing the environment variable, because the env probe itself is unreliable at skill-invocation time.
- Users who cannot set the env variable should use the manual `hyper-plan` + `hyper-plan-review` flow, which is untouched.

**Why existing-plan import is left out of v1:** importing an existing plan into the loop adds path-resolution and slug-continuity complexity that is not needed for the primary use case (research → loop). Deferred.

**Tradeoffs:**
- Pro: no per-iteration context reload; single capped gesture replaces the manual plan → review → revise cycle.
- Con: depends on experimental agent-teams (env-gated); the teammate lifecycle adds teardown burden; env-unavailable path requires the manual fallback; `hyper-plan` and `hyper-plan-review` remain the stable, unconditional path.

---

## Pointers (decisions documented elsewhere)

These have full coverage in other docs; listed here so they're discoverable from this entry point.

- **Bridge sandbox policy and CLI surface** — see [architecture.md](architecture.md#the-bridge).
- **What each skill / agent does** — see [gates-and-agents.md](gates-and-agents.md).
- **End-to-end cycle and skip rules** — see [workflow.md](workflow.md).
- **Template versioning** — see [development.md](development.md#templates).
