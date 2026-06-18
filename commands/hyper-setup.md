---
description: Diagnose hyperclaude prerequisites and report fixes
allowed-tools: Bash(node:*), Read
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
5. **`CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`** — severity: conditional. Required by `hyper-plan-loop`, `hyper-implement-loop`, `hyper-docs-loop`, and `hyper-auto` (which chains hyper-plan-loop → hyper-implement-loop). Its absence is a WARN, never a hard failure — the full research→plan→implement flow works without it.

## Reporting directive

The inline probe above runs automatically; parse the single JSON line it emitted to stdout (do not run it again).

Distinguish by shape before deciding how to report:

- If the JSON has a `checks[]` array — render the per-check table and verdict. This includes the normal `ok:false` "prerequisites failing" case. Do NOT use the fallback for this shape.
- ONLY if there is no parseable JSON at all, or the JSON has an `error` key (the `{ok:false,error:...}` probe-failure shape with no usable `checks[]`) — use the fallback sentence below; never the fallback for a normal `ok:false` result that has `checks[]`.

For the `checks[]` path:

1. Present a per-check table with columns: **Check**, **Detected**, **Required**, **Status**. One row per entry in `checks[]`.

2. For every check where `status` is not `PASS`, print the check's `remediation` field verbatim on its own line, prefixed with `Fix:`.

3. Conclude with an overall verdict line:
   - If `ok` is `true` (no hard FAIL): `All hard prerequisites met.`
   - If `ok` is `false` (one or more hard FAILs): `N hard prerequisite(s) failing — hyperclaude will not work until fixed.` (N = count of `checks[]` entries with `severity:"hard"` and `status:"FAIL"`).
   - The agent-teams WARN must never flip the overall verdict to fail.

4. **Error fallback — ONLY when there is no parseable JSON, or the JSON has an `error` key (not merely `ok:false` with a `checks[]` array), the command MUST print verbatim:** `Prerequisite probe could not complete: <error or "no parseable output">. hyperclaude prerequisites are UNKNOWN — re-run /hyperclaude:hyper-setup or run the doctor script directly.` — and MUST NOT fabricate a pass.

## Anti-patterns

- Do NOT spawn Codex, the bridge (`codex-bridge.mjs`), or any agent. This command only runs the doctor probe.
- Do NOT auto-install missing tools or modify env variables. This command is read-only; report-and-advise only.
- The `Bash(node:*)` filter permits arbitrary node scripts, so never edit this command to invoke anything beyond the doctor probe — read-only is prompt-enforced, not tool-enforced.
- Do NOT treat the agent-teams WARN as a hard failure.
- No npm dependencies.
- No `commands` entry in `.claude-plugin/plugin.json` — Claude Code auto-discovers `commands/*.md`.
- Do not widen `allowed-tools` beyond `Bash(node:*), Read`.
