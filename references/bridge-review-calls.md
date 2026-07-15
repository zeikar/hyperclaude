# Bridge review-call contract — shared reference

The shared bridge-invocation contract for every skill that invokes a review mode of the bridge (`plan-review` / `code-review` / `docs-review`): the stdout JSON envelope every review mode prints, and the `--resume` semantics common to every resumable mode. Each caller keeps its own literal bridge command and its own per-mode identity-check fields; only these two shared pieces live here.

This reference mirrors the bridge's runtime contract (`scripts/codex-bridge.mjs`) — the bridge parser is the true source of truth; an unknown flag is rejected at runtime.

## Stdout JSON envelope

The bridge prints exactly ONE JSON object on stdout.

- **Success:** `{"ok":true,"path":"...","slug":"...","threadId":"...","resumeStatus":"..."}` — read the artifact at `path` with the Read tool and present the findings.
- **Failure:** `{"ok":false,"error":"...","path":"...","resumeStatus":"...","threadId":"..."}` — surface the `error` verbatim; do not pretend a review happened. When `resumeStatus` is `resume-failed`, note that the prior context could not be used.

**Strict parse:** parse stdout as a single JSON object. Any extra non-whitespace before or after it → treat as a parse failure, surface the raw output verbatim, no best-effort scraping. Invoke the bridge via the Bash tool with `timeout: 600000`.

## Resume semantics

- `--resume <path>` (explicit): if validation fails, the bridge returns `ok:false`, runs NO fresh run — surface the error verbatim.
- `--resume` / `--resume auto`: if validation fails, the bridge falls back to a fresh run, writes the artifact with `codex-resume-status: fallback`, emits a stderr note.
- **`template-version` precondition** (shared by every resumable mode): the prior artifact must carry a `template-version` matching the CURRENT fresh template for that mode. A legacy artifact lacking it is not resumable — `--resume auto` falls back to fresh; explicit `--resume <legacy-path>` returns `ok:false` with `resume rejected` (surface verbatim, no fresh fallback).

The per-mode identity-check target fields (plan-path; base-ref NAME / commit SHA / uncommitted; docs-target) live in each caller's own dispatch reference/section.
