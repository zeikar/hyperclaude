---
name: codex-changelog
description: This skill should be used when the user asks to check for new Codex CLI (codex-cli) releases, "what changed in Codex", "any Codex updates", "check codex releases", "diff the codex version", or wants Codex CLI releases reviewed for changes relevant to THIS repo's Codex bridge. Reads a locally-stored last-checked codex-cli stable version, lists GitHub releases for openai/codex, reports changes relevant to the plugin's Codex integration (bridge argv, sandbox, exec/resume, JSONL output), and offers to advance the stored version.
---

# codex-changelog — Codex CLI release watch (hyperclaude bridge relevance)

Repo-local dev tool (NOT a plugin skill). Compare a stored "last-checked" codex-cli
STABLE version against the latest stable release, mine the release notes in between,
and report only what touches this repo's Codex bridge — then optionally advance the
stored version so the next run diffs from here.

The value is not "summarize Codex releases" — it is **mapping generic Codex CLI
changes onto the specific surface of the hyperclaude bridge** (the only Codex-spawning
code in the plugin) and verifying impact against the real bridge files.

## Source (differs from cc-changelog)

Codex's `CHANGELOG.md` only points at GitHub Releases — it is NOT a per-version file.
So the authoritative source is the **GitHub Releases of `openai/codex`**, read via `gh`
(already authed in this repo):
- `gh release list --repo openai/codex --limit <N>` — tags look like `rust-v0.142.5`
  (stable) and `rust-v0.143.0-alpha.NN` (pre-release). The row marked `Latest` is the
  current stable.
- `gh release view <tag> --repo openai/codex` — the per-release notes.

Fallback if `gh` is unavailable: `WebFetch https://github.com/openai/codex/releases`.

**Track STABLE, note alphas.** The plugin runs against the installed stable codex, so
the version diff gates on stable→stable. The alpha stream (`-alpha.NN`, many per week)
is NOT tracked per-release — but DO surface a one-line "N newer alphas exist (latest
`rust-v0.143.0-alpha.NN`)" so upcoming changes are visible without firehose noise.

## State file

`.claude/skills/codex-changelog/.last-checked-version` (sibling of this file,
gitignored): a single line with the last-reviewed codex-cli STABLE version, e.g.
`0.142.5`. It is the diff baseline; it advances only in Step 6.

## Procedure

### Step 1 — Read the stored baseline
Read `.claude/skills/codex-changelog/.last-checked-version`. Trim → `STORED`. If the
file is missing or empty, ask which stable version to baseline (or read the installed
one via `codex --version`), then continue.

### Step 2 — List releases + find the latest stable
`gh release list --repo openai/codex --limit 40`. Identify:
- `LATEST_STABLE` = the newest non-prerelease tag's version (strip the `rust-v` prefix;
  the row marked `Latest`).
- Any newer alphas between `STORED` and now — for the awareness note only.
If `gh` fails, WebFetch the releases page and read the same.

### Step 3 — Up-to-date short-circuit
If `LATEST_STABLE == STORED`, report "already current at `STORED`" (plus the
alpha-awareness note if newer alphas exist) and STOP. Do not rewrite the state file.

### Step 4 — Collect the in-between stable notes + map to the bridge
For each STABLE release with version `> STORED` and `<= LATEST_STABLE`, read its notes
(`gh release view rust-v<x> --repo openai/codex`). Classify each relevant item into one
of four buckets. **Report an item only if it lands on the bridge surface below**; never
assert impact without checking the anchor file.

Buckets:
- **🔧 Actionable** — needs a change in this repo (bridge argv, sandbox handling, parser).
- **✅ Favorable** — Codex now does natively what the bridge worked around; no action, note it.
- **🟢 Safe / no-op** — plausibly relevant but verified harmless for the bridge.
- **ℹ️ Informational** — worth knowing, behavior-neutral.

Bridge surface checklist (what to read to confirm impact):

| Surface | What to check | Repo anchors |
|---|---|---|
| Spawn argv | `codex exec --sandbox read-only -` (stdin prompt) shape; flag renames/removals/additions | `scripts/codex-bridge.mjs`, `scripts/codex/args.mjs`, `scripts/codex/codex.mjs` |
| Sandbox invariant | `--sandbox read-only` (fresh) + `-c sandbox_mode=read-only` (resume) semantics; whether resume inherits sandbox | `scripts/codex/*.mjs`, `CLAUDE.md` (Sandbox invariant) |
| exec / resume | `codex exec` + `codex exec resume` behavior; thread/session semantics; the removed native `exec review` subcommand | `scripts/codex/resume.mjs`, `docs/decisions.md` |
| Output parsing | stdout JSON/JSONL shape + fields the bridge parses (thread-id, token counts) | `scripts/codex/jsonl.mjs`, `scripts/codex/codex.mjs` |
| Config overrides | `-c key=value` behavior | `scripts/codex/args.mjs` |
| Min version / prereqs | codex-cli minimum-version requirement | `CLAUDE.md`, `scripts/setup-doctor.mjs` |

For any flagged-but-uncertain item, deepen (read the anchor file / the full release
note) before concluding.

### Step 5 — Report
Lead with a one-line TL;DR answering "does anything need action?". Then the four buckets
(omit empty ones or say "none"), plus the alpha-awareness line. Cite repo files as
clickable `[path](path)` links. Keep it tight — a bridge-maintainer triage, not a
release-notes reprint.

### Step 6 — Advance the baseline
After reporting, offer to update `.last-checked-version` to `LATEST_STABLE` (default:
yes). On confirmation, overwrite the file with `LATEST_STABLE` + newline. Skip the bump
if the user wants to keep the current baseline for re-review. Never bump before reporting.

## Notes
- Read-only + report only — never edits the bridge as a side effect. Any actionable
  finding is handed back to the user to act on (e.g. via hyper-plan).
- Companion to the `cc-changelog` skill (sibling under `.claude/skills/`) — same shape,
  different source (GitHub Releases via `gh` vs a raw `CHANGELOG.md`).
