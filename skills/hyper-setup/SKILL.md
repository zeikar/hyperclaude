---
name: hyper-setup
description: Diagnose hyperclaude prerequisites and report fixes
allowed-tools: Bash(node:*), Read
disable-model-invocation: true
---

# hyper-setup

Run the doctor probe. Parse the JSON it emits and report per-check status plus the overall verdict.

Prerequisite probe: !`node "${CLAUDE_PLUGIN_ROOT}/scripts/setup-doctor.mjs"`

## What it checks

The probe emits one JSON line: `{ ok, checks: [{name, detected, required, status, severity, remediation}] }`.

The five checks:

1. **Node.js >= 18** — severity: hard. hyperclaude's bridge is stdlib Node; versions below 18 are unsupported.
2. **codex-cli >= 0.130.0 on PATH** — severity: hard. Version-floor check only (no capability probe). The bridge spawns `codex exec`; the tool must be present and at a known-good version.
3. **git on PATH** — severity: hard. The bridge reads git state for slug generation and diff targets.
4. **`codex --search` global flag (pre-subcommand)** — severity: hard. The bridge passes `--search` as a global flag before the subcommand on every Codex spawn; codex-cli must accept `codex --search exec --help` (exit 0).
5. **Claude Code >= 2.1.232** — severity: conditional. 2.1.232 is the known-good floor for the background-agent transport `hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`, and `hyper-auto` (which chains hyper-plan-loop → hyper-implement-loop) use to reach their agent. Surfaced, not gated: a below-floor or unknown version (`claude` off PATH, unparseable output) is a WARN that never flips the verdict and blocks nothing — the full research→plan→implement flow works regardless.

## Reporting directive

The inline probe above runs automatically; parse the single JSON line it emitted to stdout (do not run it again).

The JSON's shape picks the report. A `checks[]` array — including the normal `ok:false` "prerequisites failing" case — gets steps 1–3. Only a probe that itself failed (no parseable JSON, or an `{ok:false,error:...}` object with no `checks[]`) gets the step 4 fallback.

For the `checks[]` path:

1. Present a per-check table with columns: **Check**, **Detected**, **Required**, **Status**. One row per entry in `checks[]`.

2. For every check where `status` is not `PASS`, print the check's `remediation` field verbatim on its own line, prefixed with `Fix:`.

3. Conclude with an overall verdict line:
   - If `ok` is `true` (no hard FAIL): `All hard prerequisites met.`
   - If `ok` is `false` (one or more hard FAILs): `N hard prerequisite(s) failing — hyperclaude will not work until fixed.` (N = count of `checks[]` entries with `severity:"hard"` and `status:"FAIL"`).
   - The Claude Code version WARN must never flip the overall verdict to fail.

4. **Error fallback** — print exactly this, and nothing that reads as a pass: `Prerequisite probe could not complete: <error or "no parseable output">. hyperclaude prerequisites are UNKNOWN — re-run /hyperclaude:hyper-setup or run the doctor script directly.`

## Anti-patterns

- Do NOT spawn Codex, the bridge (`codex-bridge.mjs`), or any agent. This skill only runs the doctor probe.
- Do NOT auto-install missing tools or modify env variables. This skill is read-only; report-and-advise only.
- The `Bash(node:*)` filter permits arbitrary node scripts, so never edit this skill to invoke anything beyond the doctor probe — read-only is prompt-enforced, not tool-enforced.
- Do NOT treat the Claude Code version WARN as a hard failure.
- No npm dependencies.
- No manifest entry needed — Claude Code auto-discovers `skills/*/SKILL.md`. `disable-model-invocation: true` keeps this skill explicit-invoke-only (`/hyperclaude:hyper-setup`); it is never auto-triggered by its description.
- Do not widen `allowed-tools` beyond `Bash(node:*), Read`.
