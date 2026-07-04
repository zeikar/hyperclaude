---
name: hyper-interview
description: Use when starting from a vague or under-specified idea and want requirements clarified before planning — "interview me", "ask me what you need", "clarify requirements first", "I'm not sure exactly what I want", "make sure you understand before building". Also when the user invokes /hyperclaude:hyper-interview. Runs a short one-question-at-a-time interview and writes a spec to .hyperclaude/specs/ — the front-end input to /hyperclaude:hyper-research and /hyperclaude:hyper-plan. Distinct from /hyperclaude:hyper-plan, which decomposes an ALREADY-CLEAR task into tasks.
---

# hyper-interview

Requirements-clarification gate. Turns a vague idea into a clear spec through a short Socratic interview — one targeted question at a time, aimed at whichever requirement dimension is least clear — then writes the spec to `.hyperclaude/specs/<YYYYMMDD-HHMM>-<slug>.md`. The spec is the front-end input to `hyper-research` / `hyper-plan`; the slug it mints is derived from the idea text the same way those skills derive theirs, so handing the same idea forward keeps the `research → plan → plan-review` trace linked.

**Claude-only — no Codex.** Critique belongs downstream, where it has something concrete to critique (`hyper-plan-review` on the plan, `hyper-code-review` on the diff). This gate's job is *clarity*, not review: get the requirements right so the plan isn't built on guesses. Anything off in the spec is caught when the plan is reviewed.

This is the **light** interview — the brainstorming-style conversational flow with deep-interview's weakest-dimension targeting, minus the heavy machinery (no numeric ambiguity scoring, no topology/ontology bookkeeping, no challenge-mode state machine, no resume).

## When to use

- User typed `/hyperclaude:hyper-interview <idea>`.
- The idea is vague or under-specified and jumping straight to a plan would guess at scope ("interview me", "ask me what you need", "not sure exactly what I want", "make sure you understand before building").

Skip when:
- The request is already concrete (file paths, function names, acceptance criteria) — go to `hyper-plan`, or dispatch `implementer` for one step (pass `run_in_background: false` for the result inline).
- The user pasted a PRD / spec / plan and wants it executed — use `hyper-plan` / `hyper-implement`.
- The user says "just do it" / "skip the questions" — respect it. Don't interrogate; proceed to the work they asked for.

<HARD-GATE>
Do NOT write code, scaffold anything, or invoke an implementation skill until the spec is written AND the user approves it — however simple the idea looks. The interview's only outputs are the spec file and the handoff. "Simple" ideas are exactly where unexamined assumptions waste the most work.
</HARD-GATE>

## How to invoke

`--resume` is not supported. Refine *in place* during the session (Step 5 overwrites the file written in Step 4); a separate fresh run mints a new timestamped spec (same slug if the idea is unchanged) — there's no resume keyed on the path, so that's harmless.

**Invocation argument:** $ARGUMENTS

### Step 1 — Resolve the idea + project context

1. The idea is `$ARGUMENTS`. If empty, fall back to the user's most recent build/implement intent in this conversation; if none exists, ask "What do you want to build?" and stop.
2. **Greenfield vs brownfield.** Dispatch the `Explore` agent (read-only) ONCE with **`run_in_background: false`** (the greenfield/brownfield verdict and area map gate Step 2's questions, which cite Explore's findings; result awaited inline) to check whether the cwd has source code bearing on the idea:
   - Relevant code exists → **brownfield**: have Explore map the relevant area (paths, key symbols, patterns) so the questions can cite repo evidence instead of asking the user what the code already reveals.
   - Otherwise → **greenfield**.
   - Keep this to a single Explore dispatch; don't fan out. If exploration fails, proceed as greenfield and note the limitation.

### Step 2 — Interview loop (one question at a time)

Track clarity qualitatively across a few dimensions — **no numeric scoring**:

| Dimension | Clear once it can be stated as… |
|---|---|
| **Goal** | the core outcome in one sentence — the key noun and what happens to it |
| **Constraints** | the boundaries, environment, and explicit non-goals |
| **Success** | how to verify it's done — concrete, testable acceptance |
| **Context** *(brownfield only)* | how it fits the existing code without breaking it |

Each round:

1. **Target the weakest dimension.** Name it in one line first: *"Goal is clear; constraints are still fuzzy → next question targets constraints."*
2. **Ask exactly ONE question** via `AskUserQuestion`, with concrete options plus free-text. Aim it to **expose an assumption**, not to collect a feature list. (Brownfield: cite the file/symbol that prompted the question — *"I found JWT auth in `src/auth/`; extend it or diverge?"*)
3. **Fold the answer in** and re-judge that dimension.

When the idea is nearly clear, take **one simplifier pass**: *"What's the simplest version that's still valuable?"* / *"Is `<constraint>` a real requirement or an assumption?"* Then move to the spec.

**Stop the loop** when every applicable dimension is clear enough to write testable acceptance criteria, OR the user says "enough / let's go / build it" (allow after ~2 rounds). On early exit, name in one line what's still fuzzy so the gap is on record.

**Soft cap:** if the loop reaches ~8 rounds without converging, summarize what's clear, flag what isn't, and ask whether to proceed or keep going. Don't loop forever.

### Step 3 — Approaches (only when there's a real fork)

If the idea has a genuine design fork (e.g. native app vs PWA, polling vs webhook), present **2–3 approaches with trade-offs and a recommendation** in one message, and let the user pick. Skip this entirely when the idea is a requirement to clarify rather than a design to choose.

Do NOT produce a task breakdown here — decomposition into `## Task N:` blocks is `hyper-plan`'s job. The spec states **what**, not the task list.

### Step 4 — Write the spec

1. **Derive the slug** from the idea, same rule as `hyper-plan` / `hyper-research`: lowercase, ASCII only, alphanumerics + hyphen, first 5 words of the idea joined by `-`. Example: "Add OAuth login to the API" → `add-oauth-login-to-the`.
   - **No-ASCII fallback** (e.g. an all-Korean idea): the filename is the timestamp only (`<timestamp>.md`), and the frontmatter `slug:` line is the bare key with an empty value: `slug: ` (key, colon, single space, nothing after — NOT `slug: ""`).
2. Resolve the path:
   ```bash
   mkdir -p .hyperclaude/specs
   date -u +%Y%m%d-%H%M
   ```
   Base path `.hyperclaude/specs/<timestamp>-<slug>.md`; if it exists, append `-2`, `-3`, … until free.
3. Write the spec with the **Write** tool. Author NO `plugin-version` line — the PostToolUse stamp hook adds it post-write. Frontmatter keys, in this order:

   ```
   ---
   mode: interview
   idea: |-
     <idea, each line 2-space indented>
   slug: <slug>
   generated: <ISO-8601 timestamp>
   type: greenfield|brownfield
   ---
   # Spec: <title>

   ## Goal
   <one crisp paragraph — the core outcome, covering the whole idea>

   ## Constraints
   - <constraint>

   ## Non-Goals
   - <explicitly excluded scope>

   ## Acceptance Criteria
   - [ ] <testable criterion>

   ## Assumptions Resolved
   | Assumption | Resolution |
   |---|---|
   | <what was assumed / surfaced> | <what was decided> |

   ## Context
   <brownfield: the cited code findings (paths/symbols) this builds on or diverges from.
   greenfield: technology choices and constraints. Omit this section if empty.>
   ```

   **Scale each section to the idea** — a small idea gets a few lines per section, not padding. The spec captures the interview's conclusions, not its transcript.

### Step 5 — User review + handoff

1. Tell the user the spec path and ask them to review it. **Wait for approval** (the HARD-GATE). If they request changes, revise the spec at the same path and re-confirm.
2. On approval, hand off — do NOT implement here. **Pass the ORIGINAL idea text as the task argument** — verbatim, the same text recorded in the spec's `idea:` frontmatter — NOT the reworded Goal. This is what keeps the slug aligned: `hyper-plan` / `hyper-research` derive their slug from `$ARGUMENTS` with the *same* rule used in Step 4, so the same idea text yields the same slug and the `research → plan → plan-review` trace stays linked. A reworded Goal would derive a *different* slug and silently break the trace. (`hyper-plan` does not read `specs/` — the slug match is what links them, plus the spec content you already hold in context.)
   - **Straight to planning** → `/hyperclaude:hyper-plan <original idea>`. The spec's resolved requirements (Goal / Constraints / Acceptance Criteria) are already in this conversation from Step 4 — feed them to the planner as context.
   - **Research first** (when prior-art / pitfalls matter) → `/hyperclaude:hyper-research <original idea>`, then `hyper-plan`.

   Default recommendation: `hyper-plan`; prepend `hyper-research` when the approach has real unknowns.

## Anti-patterns

- **Calling Codex / the bridge.** This gate is Claude-only; review is downstream (`hyper-plan-review`, `hyper-code-review`).
- **Numeric ambiguity scoring, topology/ontology bookkeeping, challenge-mode state machines, resume state.** Out of scope — this is the light interview, deliberately not deep-interview.
- **Batching questions.** One per round; multiple at once produces shallow answers and blurs which dimension is being improved.
- **Asking what the code already tells you.** Explore first (brownfield) and cite the evidence in the question.
- **Decomposing into tasks.** That's `hyper-plan`. The spec states *what* to build and how success is verified — not the ordered task list.
- **Implementing before spec approval.** The HARD-GATE is absolute regardless of perceived simplicity.
- **Hand-authoring a `<spec>-v2.md` sibling.** In-session revisions overwrite the Step-4 path in place (Step 5); a separate re-run getting a new timestamped path is expected, not something to encode by hand.
