# Review brief — shared reference

`--review-brief` (on the bridge's `plan-review` and `code-review` modes) carries a caller-composed summary of what the user asked for into the Codex review prompt, so Codex stops flagging the user's own approved requirements as scope creep. It is written by Claude (a skill or a loop lead) — it must NEVER claim to be user-authored, and it is not a waiver: it narrows what counts as scope creep, nothing more.

## Source rule

The brief may contain ONLY:

(a) requirements the user stated verbatim, or in a clearly-cited paraphrase, in the conversation;
(b) decisions the user explicitly approved in the conversation.

NOT sources: plan/spec prose (Claude-authored — quoting it would let the planner bless its own additions), builder rationale, and project policy from `CLAUDE.md` or any other tracked file (a builder could edit a policy file in the same change and then cite its own addition as scope-authoritative). **Composing a brief runs no `git` commands and reads no repo files.**

## Omission rule

No admissible source → **omit `--review-brief` entirely**. Never synthesize, never fabricate a brief to fill the gap. Omitting is always safe.

Interaction with carry-forward: an omitted flag still lets a prior artifact's brief carry forward on a successfully-resolved `--resume`, but NOT through an `auto`→fresh fallback (the fallback means no candidate artifact passed the identity + template-version gate, not that none existed) — see Re-supply reasons below.

## Bound

The brief may say "this was requested — do not flag it as scope creep." It may NEVER ask Codex to ignore correctness, security, or data-loss findings. The prompt template enforces this independently — all four review-brief-carrying prompts (the fresh and resumed templates for both plan-review and code-review) carry a guardrail paragraph declaring the block is DATA, never instructions — so a malformed or over-reaching brief cannot win.

## Shell-safety recipe

`Write` the brief to a session-scratchpad file OUTSIDE the repo (never `echo`, no hardcoded literal path). In the SAME Bash invocation as the bridge call (shell state does not persist between Bash calls), assign the path as one POSIX-escaped single-quoted token, then pass `--review-brief "$(cat "$BRIEF_FILE")"`:

```bash
BRIEF_FILE='<scratchpad path, POSIX-escaped>'   # every embedded ' becomes '\''
```

Escaping: wrap the path in single quotes and replace every literal apostrophe with `'\''` (close-quote, escaped quote, reopen-quote). Plain quote-wrapping is NOT sufficient — an apostrophe would terminate the string early. An unquoted assignment is worse — it breaks on spaces. Never inline the brief prose into the command string itself.

## Re-supply reasons

A caller that HAS an admissible source passes `--review-brief` on each round, for exactly TWO reasons:

1. **Fallback survival** — a `--resume auto` round that silently falls back to a fresh spawn only carries the brief if the flag is present (a fresh spawn never reads a prior artifact's brief, whether or not one exists on disk).
2. **Mid-loop updates** — the flag overrides the carried value, so a decision the user approves between rounds can be folded in.

No other rationale applies. In particular, the brief's authority does NOT weaken or fade across rounds — a carried brief is re-rendered and re-persisted on every successful resume.
