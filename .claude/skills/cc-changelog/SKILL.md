---
name: cc-changelog
description: This skill should be used when the user asks to check for new Claude Code releases, "what changed in Claude Code", "any Claude Code updates", "check the changelog", "diff the Claude Code version", or wants the Claude Code changelog reviewed for changes relevant to THIS repo (the hyperclaude plugin). Reads a locally-stored last-checked version, fetches the official changelog, reports plugin-relevant changes grouped by actionability, and offers to advance the stored version.
---

# cc-changelog — Claude Code changelog watch (hyperclaude relevance)

Repo-local dev tool (NOT a plugin skill). Compare a stored "last-checked" Claude Code
version against the current latest, mine the official changelog for everything in
between, and report only what actually touches this repo's surfaces — then optionally
advance the stored version so the next run diffs from here.

The value is not "summarize the changelog" — it is **mapping generic Claude Code
changes onto the specific surfaces of the hyperclaude plugin** and verifying impact
against the real repo files, exactly as a human maintainer would.

## State file

`.claude/skills/cc-changelog/.last-checked-version` (sibling of this file, gitignored):
a single line holding the last version the maintainer reviewed, e.g. `2.1.201`. It is
the diff baseline; it advances only in Step 6.

## Procedure

### Step 1 — Read the stored baseline
Read `.claude/skills/cc-changelog/.last-checked-version`. Trim whitespace → `STORED`.
If the file is missing or empty, ask the user which version to treat as the baseline
(do not invent one), then continue.

### Step 2 — Fetch the latest changelog
`WebFetch` `https://raw.githubusercontent.com/anthropics/claude-code/main/CHANGELOG.md`
with a prompt that asks for: (a) the single latest version number (topmost `## X.Y.Z`),
and (b) every entry whose version is strictly greater than `STORED`, with bullets
verbatim. Note the changelog skips numbers (e.g. 2.1.182→2.1.183), so select by
version-ordering ("> STORED"), never by increment. Call the latest `LATEST`.

### Step 3 — Up-to-date short-circuit
If `LATEST == STORED` (or nothing is newer), report "already current at `STORED`,
nothing new" and STOP. Do not rewrite the state file.

### Step 4 — Map each entry to a hyperclaude surface
For every entry newer than `STORED`, decide which surface (if any) it touches, then
classify into one of four buckets. **Report a change only if it lands on a surface**;
drop pure end-user-UI/terminal/voice items unless they affect this repo.

Buckets:
- **🔧 Actionable** — needs a change in this repo (a skill/agent/hook/doc edit).
- **✅ Favorable** — the platform now does natively what the plugin did manually; no
  action, but note it as a future-simplification candidate.
- **🟢 Safe / no-op** — plausibly relevant but verified harmless for this repo.
- **ℹ️ Informational** — worth knowing, behavior-neutral.

Surface checklist (what to grep/read to confirm impact — never assert impact without
checking the actual file):

| Surface | What to check | Repo anchors |
|---|---|---|
| Hooks | `hooks.json` matcher semantics (hyphen/comma/regex), SessionStart & PostToolUse events, hook stderr/exit-code behavior | `hooks/hooks.json`, `hooks/*.mjs` |
| Agent-teams loop protocol | `SendMessage` routing/name-reuse, idle & `Notification` semantics, teammate lifecycle/failure, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS` | `references/loop-protocol.md`, `skills/hyper-*-loop/**` |
| Agent dispatch (non-loop) | `run_in_background` default, subagent depth cap, `Agent(type)` deny/allow rules, subagent model inheritance | `skills/hyper-implement/SKILL.md`, `skills/hyper-plan`, `hyper-tdd`, `hyper-debug`, `hyper-research`, `hyper-docs-sync` |
| Skill/agent/command frontmatter | `name`/`description`/`metadata.*` parsing, kebab/snake/camel, malformed-YAML handling, slash-command loading | `skills/**/SKILL.md`, `agents/*.md`, `commands/*.md` |
| Codex bridge / Bash spawn | anything changing how `Bash` spawns or sandboxes child processes (Codex is external, but the bridge is spawned via Bash) | `scripts/codex-bridge.mjs`, `scripts/codex/*.mjs` |
| Plugin manifest / validate / release | `claude plugin validate`, `plugin.json`, marketplace/rename behavior | `.claude-plugin/plugin.json`, `docs/development.md` |
| Overlapping built-ins | built-in `/code-review`, `/agents` wizard, default model, `/review` — usually informational, but flag stale **doc references** | `docs/**`, `README.md` |

For any flagged-but-uncertain item, deepen before concluding: consult
`https://docs.claude.com/en/docs/claude-code` (WebFetch) or `WebSearch`, and grep/read
the anchor files to confirm the actual impact.

### Step 5 — Report
Lead with a one-line TL;DR answering "does anything need action?". Then the four
buckets (omit empty ones or say "none"). Cite repo files as clickable
`[path](path)` links. Keep it tight — this mirrors a maintainer triage, not a full
changelog reprint.

### Step 6 — Advance the baseline
After reporting, offer to update `.last-checked-version` to `LATEST` (default: yes).
On confirmation, overwrite the file with `LATEST` + newline. Skip the bump if the user
wants to keep the current baseline for re-review. Never bump before reporting.

## Notes
- Primary source is the CHANGELOG (authoritative per-version); official docs are a
  secondary deepening source for a specific flagged feature.
- This skill only reads and reports — it never edits plugin code as a side effect.
  Any actionable finding is handed back to the user to act on (e.g. via hyper-plan).
